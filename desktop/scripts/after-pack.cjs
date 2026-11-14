// macOS: when no Apple Developer certificate is configured, give the app an ad-hoc code signature.
// Apple Silicon Macs refuse to launch apps with no signature at all (they show "NullChat is damaged").
// With a real certificate (CSC_LINK / Keychain identity) electron-builder signs and notarizes instead.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const hasCert = !!(process.env.CSC_LINK || process.env.CSC_NAME) && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
  if (hasCert) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
