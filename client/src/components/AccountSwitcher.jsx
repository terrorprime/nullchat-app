// "Switch Account" in the status menu: the other accounts signed in on this device, and a way to add one more.
import { useState } from 'react';
import { useStore } from '../lib/state.js';
import { leaveVoice } from '../lib/voice.js';
import { toastError, toast } from '../lib/toast.js';
import { listAccounts, otherAccounts, switchToAccount, beginAddAccount, removeAccount, MAX_ACCOUNTS } from '../lib/accounts.js';
import { Avatar, confirmDialog } from './ui.jsx';
import { Icon } from './icons.jsx';

export function AccountSwitcher({ close }) {
  const me = useStore((s) => s.me);
  const [others, setOthers] = useState(() => otherAccounts(me.id));
  const full = listAccounts().length >= MAX_ACCOUNTS && !listAccounts().some((a) => a.id === me.id);

  // (the page starts over for the other account, so a call in progress is left first)
  const go = async (fn) => { close(); try { await leaveVoice({ silent: true }); } catch { /* not in a call */ } fn(); };
  const add = () => {
    if (listAccounts().length >= MAX_ACCOUNTS && !listAccounts().some((a) => a.id === me.id)) { toast(`You can have up to ${MAX_ACCOUNTS} accounts on this device.`, 'error'); return; }
    go(() => { if (!beginAddAccount(me)) toastError(new Error('This device can’t remember accounts (its storage is turned off).')); });
  };
  const remove = async (a) => {
    const name = a.displayName || a.username;
    if (!(await confirmDialog({ title: `Log out of ${name}?`, body: 'This ends that account’s sign-in on this device. You’ll need its password to sign in again.', confirmText: 'Log out', danger: true }))) return;
    await removeAccount(a.id);
    setOthers(otherAccounts(me.id));
  };

  return (
    <div className="account-switcher">
      <div className="menu-sep" />
      <div className="account-switcher-title tiny muted">Switch Account</div>
      {others.map((a) => (
        <div key={a.id} className="account-row">
          <button className="status-option account-pick" onClick={() => go(() => switchToAccount(a.id))} aria-label={`Switch to ${a.displayName || a.username}`}>
            <Avatar user={a} size={28} />
            <div className="account-names"><div className="truncate">{a.displayName || a.username}</div><div className="muted tiny truncate">{a.username}</div></div>
          </button>
          <button className="icon-btn small" aria-label={`Log out of ${a.displayName || a.username}`} data-tooltip="Log out of this account" onClick={() => remove(a)}><Icon name="x" size={14} /></button>
        </div>
      ))}
      <button className="status-option" disabled={full} onClick={add}><Icon name="plus" size={16} /><div>Add Account{full ? <div className="muted tiny">Up to {MAX_ACCOUNTS} accounts on this device.</div> : null}</div></button>
    </div>
  );
}
