// Finishes the iPhone project that `cap add ios` made (run by the npm scripts, safe to run again):
//   - the microphone and camera descriptions iOS shows when a call asks for them
//   - the notification entitlement and the few lines of code Capacitor needs to get the phone's notification token
//   - NullChat's app icon, launch screen and name, and the version numbers
// This can only be tested for real on a Mac; the checks that run here are on the generated files (see docs/PHONE_APPS.md).
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOBILE_DIR, isMain, mustReplace, runCli, xmlEscape } from './lib.mjs';

const USAGE = {
  NSMicrophoneUsageDescription: 'NullChat uses the microphone for voice and video calls and for videos you record to send.',
  NSCameraUsageDescription: 'NullChat uses the camera for video calls and to take photos or videos to send.',
};
const ENTITLEMENTS_FILE = 'App.entitlements'; // lives next to Info.plist
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- "development" is what Xcode writes here; when you archive for TestFlight or the App Store it signs the app with "production" automatically. -->
	<key>aps-environment</key>
	<string>development</string>
</dict>
</plist>
`;
const PUSH_HOOKS = `
    // NullChat: hand the phone's notification token to Capacitor's push plugin (without these two methods, turning notifications on never finishes).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;

export function patchInfoPlist(plist, app) {
  let out = plist;
  for (const [key, text] of Object.entries(USAGE)) {
    if (out.includes(`<key>${key}</key>`)) continue;
    out = mustReplace(out, /([ \t]*)<\/dict>\s*<\/plist>/, (all, indent) => `\t<key>${key}</key>\n\t<string>${xmlEscape(text)}</string>\n${all}`, 'the end of Info.plist');
  }
  // The name under the icon (cap add set it once; this keeps it right if you change appName later).
  const name = xmlEscape(app.appName);
  return mustReplace(out, /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, (_, a, b) => a + name + b, 'CFBundleDisplayName in Info.plist');
}

export function patchPbxproj(pbx, app) {
  let out = pbx;
  out = mustReplace(out, /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${app.appId};`, 'the bundle identifier');
  out = mustReplace(out, /MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${app.versionName};`, 'MARKETING_VERSION');
  out = mustReplace(out, /CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${app.versionCode};`, 'CURRENT_PROJECT_VERSION');
  if (!out.includes('CODE_SIGN_ENTITLEMENTS')) {
    // One line in each build configuration of the App target (Debug and Release), next to the Info.plist setting.
    out = mustReplace(out, /^([ \t]*)INFOPLIST_FILE = App\/Info\.plist;/gm, (all, indent) => `${all}\n${indent}CODE_SIGN_ENTITLEMENTS = App/${ENTITLEMENTS_FILE};`, 'INFOPLIST_FILE in the Xcode project');
  }
  return out;
}

export function patchAppDelegate(swift) {
  if (swift.includes('capacitorDidRegisterForRemoteNotifications')) return swift;
  const end = swift.lastIndexOf('}');
  if (end < 0) throw new Error('AppDelegate.swift looks empty, so the notification hooks can\'t be added to it.');
  return swift.slice(0, end).replace(/\s*$/, '\n') + PUSH_HOOKS + swift.slice(end);
}

export function patchIos(iosDir, app, { resourcesDir = join(MOBILE_DIR, 'resources') } = {}) {
  const appDir = join(iosDir, 'App');
  const target = join(appDir, 'App');
  const files = {
    plist: join(target, 'Info.plist'),
    pbx: join(appDir, 'App.xcodeproj', 'project.pbxproj'),
    delegate: join(target, 'AppDelegate.swift'),
  };
  for (const f of Object.values(files)) {
    if (!existsSync(f)) throw new Error('There is no ios/ project yet. Run `npm run ios:add` first on a Mac (it creates the project and runs this step).');
  }
  const notes = [];

  writeFileSync(files.plist, patchInfoPlist(readFileSync(files.plist, 'utf8'), app));
  notes.push('iPhone: microphone and camera descriptions added');

  writeFileSync(join(target, ENTITLEMENTS_FILE), ENTITLEMENTS);
  writeFileSync(files.pbx, patchPbxproj(readFileSync(files.pbx, 'utf8'), app));
  writeFileSync(files.delegate, patchAppDelegate(readFileSync(files.delegate, 'utf8')));
  notes.push(`iPhone: bundle id ${app.appId}, version ${app.versionName} (build ${app.versionCode}), notification entitlement and hooks added`);

  const assets = join(target, 'Assets.xcassets');
  copyFileSync(join(resourcesDir, 'ios', 'AppIcon-512@2x.png'), join(assets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    copyFileSync(join(resourcesDir, 'ios', n), join(assets, 'Splash.imageset', n));
  }
  notes.push('iPhone: NullChat icon and launch screen in place');
  return notes;
}

if (isMain(import.meta.url)) runCli((app) => patchIos(join(MOBILE_DIR, 'ios'), app));
