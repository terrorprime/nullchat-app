// "Open NullChat when my computer starts" on Linux.
// Electron's setLoginItemSettings does nothing on Linux, so this writes the standard autostart entry by hand
// (~/.config/autostart/nullchat.desktop, which GNOME, KDE, XFCE, Cinnamon, MATE and friends all read).
// Kept free of Electron so it can be tested on its own.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function autostartFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'nullchat.desktop');
}

/** Turn the entry on (pointing at `exec`, started with --hidden) or off. Returns true when the file is as asked. */
function applyLinuxAutostart({ enabled, exec, file = autostartFile() }) {
  try {
    if (!enabled) { fs.rmSync(file, { force: true }); return true; }
    // The Exec line is parsed by the desktop; refuse anything that would need escaping rather than guess.
    if (!exec || /["`$\\\r\n%]/.test(String(exec))) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=NullChat',
      'Comment=Chat, voice and video',
      `Exec="${exec}" --hidden`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
    return true;
  } catch { return false; }
}

module.exports = { applyLinuxAutostart, autostartFile };
