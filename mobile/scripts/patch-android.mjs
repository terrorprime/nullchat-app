// Finishes the Android project that `cap add android` made (run by the npm scripts, safe to run again):
//   - permissions for the microphone, camera and notifications, and the notification icon
//   - NullChat's app icon, launch screen and name
//   - version numbers, and release signing from environment variables (when you provide a keystore)
//   - your Firebase file, if you provide one, which is what lets the app receive notifications
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOBILE_DIR, copyTree, isMain, mustReplace, runCli, xmlEscape } from './lib.mjs';

const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',          // voice
  'android.permission.CAMERA',                // video and taking photos
  'android.permission.MODIFY_AUDIO_SETTINGS', // lets a call use the earpiece / speaker
  'android.permission.ACCESS_NETWORK_STATE',  // lets calls notice when the phone switches between wifi and mobile data
  'android.permission.POST_NOTIFICATIONS',    // Android 13+: asked for when the person turns notifications on
];
const FEATURES = ['android.hardware.camera', 'android.hardware.microphone']; // not "required": phones without them can still install the app

const SIGNING = `    // NullChat: sign the release build with your own key when NULLCHAT_KEYSTORE (the path to a .jks file) is set.
    signingConfigs {
        nullchatRelease {
            def keystore = System.getenv('NULLCHAT_KEYSTORE')
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv('NULLCHAT_KEYSTORE_PASSWORD')
                keyAlias System.getenv('NULLCHAT_KEY_ALIAS')
                keyPassword System.getenv('NULLCHAT_KEY_PASSWORD')
            }
        }
    }
`;
const SIGN_RELEASE = `            if (System.getenv('NULLCHAT_KEYSTORE')) {
                signingConfig signingConfigs.nullchatRelease
            }
`;

export function patchManifest(xml) {
  let out = xml;
  const missing = (name) => !out.includes(`android:name="${name}"`);
  const anchor = /([ \t]*)<uses-permission android:name="android.permission.INTERNET"\s*\/>/;
  out = mustReplace(out, anchor, (all, indent) => {
    const lines = [all.trimStart()];
    for (const p of PERMISSIONS) if (missing(p)) lines.push(`<uses-permission android:name="${p}" />`);
    for (const f of FEATURES) if (missing(f)) lines.push(`<uses-feature android:name="${f}" android:required="false" />`);
    return lines.map((l) => indent + l).join('\n');
  }, 'the INTERNET permission in AndroidManifest.xml');
  if (missing('com.google.firebase.messaging.default_notification_icon')) {
    out = mustReplace(out, /([ \t]*)<\/application>/, (all, indent) =>
      `${indent}    <!-- NullChat: the small white icon in the status bar next to a notification, and its tint -->\n` +
      `${indent}    <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_nullchat" />\n` +
      `${indent}    <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/nullchat_notification" />\n` +
      all, '</application> in AndroidManifest.xml');
  }
  return out;
}

export function patchGradle(gradle, app) {
  let out = gradle;
  out = mustReplace(out, /versionCode\s+\d+/, `versionCode ${app.versionCode}`, 'versionCode in app/build.gradle');
  out = mustReplace(out, /versionName\s+"[^"]*"/, `versionName "${app.versionName}"`, 'versionName in app/build.gradle');
  if (!out.includes('nullchatRelease')) {
    out = mustReplace(out, /^([ \t]*)buildTypes\s*\{/m, (all) => SIGNING + all, 'buildTypes in app/build.gradle');
    out = mustReplace(out, /(^[ \t]*release\s*\{\n)/m, (all) => all + SIGN_RELEASE, 'the release build type in app/build.gradle');
  }
  return out;
}

/** Which appId was the project created with? (`cap add` writes it into app/build.gradle.) */
export const projectAppId = (gradle) => /applicationId\s+"([^"]+)"/.exec(gradle)?.[1] || null;

export function patchAndroid(androidDir, app, { resourcesDir = join(MOBILE_DIR, 'resources'), env = process.env, mobileDir = MOBILE_DIR } = {}) {
  const appDir = join(androidDir, 'app');
  const gradlePath = join(appDir, 'build.gradle');
  const manifestPath = join(appDir, 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(gradlePath) || !existsSync(manifestPath)) {
    throw new Error('There is no android/ project yet. Run `npm run android:add` first (it creates the project and runs this step).');
  }
  const notes = [];

  const gradle = readFileSync(gradlePath, 'utf8');
  const had = projectAppId(gradle);
  if (had && had !== app.appId) {
    throw new Error(`The Android project was created for "${had}" but nullchat-app.json now says "${app.appId}". Delete the android folder and run \`npm run android:add\` again (or put the old appId back).`);
  }
  writeFileSync(gradlePath, patchGradle(gradle, app));
  notes.push(`Android: version ${app.versionName} (build ${app.versionCode}), release signing ${env.NULLCHAT_KEYSTORE ? 'ON (using your keystore)' : 'off (no keystore given: the release build will be unsigned)'}`);

  writeFileSync(manifestPath, patchManifest(readFileSync(manifestPath, 'utf8')));
  notes.push('Android: microphone, camera and notification permissions added');

  const res = join(appDir, 'src', 'main', 'res');
  const copied = copyTree(join(resourcesDir, 'android'), res);
  mkdirSync(join(res, 'values'), { recursive: true });
  writeFileSync(join(res, 'values', 'ic_launcher_background.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#060608</color>\n</resources>\n');
  writeFileSync(join(res, 'values', 'nullchat_colors.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="nullchat_notification">#C2FF3D</color>\n</resources>\n');
  notes.push(`Android: NullChat icon, launch screen and notification icon in place (${copied} images)`);

  // The name under the icon (cap add set it once; this keeps it right if you change appName later).
  const stringsPath = join(res, 'values', 'strings.xml');
  if (existsSync(stringsPath)) {
    const name = xmlEscape(app.appName);
    const s = readFileSync(stringsPath, 'utf8')
      .replace(/(<string name="app_name">)[^<]*(<\/string>)/, (_, a, b) => a + name + b)
      .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, (_, a, b) => a + name + b);
    writeFileSync(stringsPath, s);
  }

  // Firebase: the file from your Firebase project (mobile/google-services.json, or the path in GOOGLE_SERVICES_JSON).
  const gs = env.GOOGLE_SERVICES_JSON || join(mobileDir, 'google-services.json');
  if (existsSync(gs) && readFileSync(gs, 'utf8').trim()) {
    const raw = readFileSync(gs, 'utf8');
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`${gs} isn't valid JSON. Download google-services.json again from your Firebase project (Project settings → Your apps → Android app).`); }
    const ids = (json.client || []).map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
    if (!ids.includes(app.appId)) {
      throw new Error(`google-services.json is for ${ids.length ? ids.map((i) => `"${i}"`).join(', ') : 'no Android app'}, but this app's appId is "${app.appId}". In Firebase, add an Android app with exactly that package name and download the file again.`);
    }
    copyFileSync(gs, join(appDir, 'google-services.json'));
    notes.push('Android: google-services.json found, notifications will work (your server also needs its Firebase key: see docs/PHONE_APPS.md)');
  } else {
    notes.push('Android: no google-services.json, so this build will NOT receive notifications (everything else works). See docs/PHONE_APPS.md, step "Android notifications".');
  }
  return notes;
}

if (isMain(import.meta.url)) runCli((app) => patchAndroid(join(MOBILE_DIR, 'android'), app));
