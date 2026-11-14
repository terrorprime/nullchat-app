// The "new version" bar. Shows an Update button in the browser, the installed web app and the desktop app.
import { Icon } from './icons.jsx';
import { Spinner, confirmDialog } from './ui.jsx';
import { useUpdates, applyUpdate, dismissUpdate, installShellUpdate, inVoiceCall } from '../lib/updates.js';
import { cx } from '../lib/utils.js';

async function okToInterrupt() {
  if (!inVoiceCall()) return true;
  return confirmDialog({ title: 'Update NullChat?', body: 'You’re in a voice call. Updating reloads NullChat and will disconnect you.', confirmText: 'Update anyway' });
}
/** Reload into the newest version of the site. */
export async function updateNow() { if (await okToInterrupt()) applyUpdate(); }
/** Desktop app: restart into the downloaded app update. */
export async function restartForUpdate() { if (await okToInterrupt()) installShellUpdate(); }

/** floating = a fixed bar for screens without the app layout (login, invite pages). */
export function UpdateBanner({ floating = false }) {
  const u = useUpdates();
  const shell = u.shell;
  let text = null; let action = null; let busy = false; let key = null;

  if (shell?.state === 'ready') {
    key = `shell:${shell.version}`;
    text = `NullChat ${shell.version || ''} is ready to install.`.replace('  ', ' ');
    action = { label: 'Restart to update', run: restartForUpdate };
  } else if (shell?.state === 'available') {
    key = `shell:${shell.version}`;
    text = `NullChat ${shell.version || 'update'} is available.`;
    action = { label: 'Get it', run: () => installShellUpdate() };
  } else if (shell?.state === 'downloading') {
    text = `Downloading update${shell.percent ? ` · ${Math.round(shell.percent)}%` : '…'}`;
    busy = true;
  } else if (u.web === 'available' && u.serverBuild) {
    key = u.serverBuild;
    text = 'A new version of NullChat is ready.';
    action = { label: 'Update', run: updateNow };
  }
  if (!text || (key && u.dismissed === key)) return null;

  return (
    <div className={cx('notice-banner install-banner update-banner', floating && 'floating')} role="status" aria-live="polite">
      {busy ? <Spinner size={14} /> : <Icon name="download" size={18} />}
      <span className="install-banner-text">{text}</span>
      {action && <button className="banner-btn" onClick={action.run}>{action.label}</button>}
      {key && <button className="banner-close" aria-label="Later" data-tooltip="Later" onClick={dismissUpdate}><Icon name="x" size={16} /></button>}
    </div>
  );
}
