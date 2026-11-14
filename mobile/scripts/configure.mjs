// Writes capacitor.config.json (and the small page the app shows when it can't reach your server) from mobile/nullchat-app.json.
// The npm scripts run this first, every time, so changing the app name or server address is: edit nullchat-app.json, run the script again.
import { loadAppConfig, writeProjectFiles } from './lib.mjs';

try {
  const app = loadAppConfig();
  writeProjectFiles(app);
  console.log(`NullChat phone app: "${app.appName}" (${app.appId}) v${app.versionName} (${app.versionCode}) opens ${app.serverUrl}`);
} catch (e) {
  console.error('\n' + e.message + '\n');
  process.exit(1);
}
