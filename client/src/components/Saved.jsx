// The "Saved" list: messages you bookmarked, with their reminders. Shown in the Inbox and from the Home sidebar.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../lib/state.js';
import { api } from '../lib/api.js';
import { on } from '../lib/gateway.js';
import { toastError } from '../lib/toast.js';
import { formatFull } from '../lib/utils.js';
import { goToMessage, unsaveMessage, timeUntil } from '../lib/saved.js';
import { Button, Modal, Spinner, openModal, openContextMenu } from './ui.jsx';
import { Message } from './Messages.jsx';
import { reminderMenuItems, openReminderPicker } from './Reminder.jsx';
import { Icon } from './icons.jsx';

export function SavedList({ onNavigate }) {
  const [items, setItems] = useState(null);
  const guilds = useStore((s) => s.guilds);
  const channels = useStore((s) => s.channels);
  const load = useCallback(() => api.get('/users/@me/saved').then((r) => setItems(r.items)).catch((e) => { setItems([]); toastError(e); }), []);
  useEffect(() => {
    load();
    const offs = [on('SAVED_UPDATE', load), on('REMINDER', load)];
    return () => offs.forEach((off) => off());
  }, [load]);

  if (!items) return <Spinner />;
  if (!items.length) {
    return (
      <div className="empty-state small">
        <Icon name="bookmark" size={40} />
        <p className="muted">Nothing saved yet. Right-click a message (or use its ⋯ menu) and choose <b>Save for Later</b>. You can add a reminder too.</p>
      </div>
    );
  }
  return items.map((it) => {
    const ch = channels[it.channelId];
    const where = ch?.guildId ? `${guilds[ch.guildId]?.name || 'Server'} › #${ch.name}` : ch ? 'Direct message' : '';
    const asMsg = { id: it.messageId, channelId: it.channelId, guildId: it.guildId, ...it.message };
    return (
      <div key={it.messageId} className="result-card saved-card" data-saved-id={it.messageId}
        onClick={() => { onNavigate?.(); goToMessage(it.channelId, it.messageId, it.guildId); }}>
        {where && <div className="result-channel">{where}</div>}
        <Message message={asMsg} channel={ch} preview />
        <div className="saved-meta">
          {it.remindAt ? (
            <button type="button" className="saved-chip due" title={formatFull(it.remindAt)} onClick={(e) => { e.stopPropagation(); openReminderPicker(asMsg); }}>
              <Icon name="clock" size={13} /> Reminds you {timeUntil(it.remindAt)}
            </button>
          ) : it.reminded ? <span className="tiny muted"><Icon name="check" size={12} /> Reminder sent</span> : null}
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); openContextMenu(e, reminderMenuItems(asMsg)); }}><Icon name="clock" size={14} /> {it.remindAt ? 'Change' : 'Remind me'}</Button>
          <button type="button" className="icon-btn small" aria-label="Remove from Saved" data-tooltip="Remove" onClick={(e) => { e.stopPropagation(); unsaveMessage(asMsg); }}><Icon name="x" size={16} /></button>
        </div>
      </div>
    );
  });
}

export function openSavedModal() {
  openModal(({ close }) => (
    <Modal title="Saved messages" subtitle="Only you can see this list." size="md" onClose={close}>
      <div className="saved-modal-list"><SavedList onNavigate={close} /></div>
    </Modal>
  ));
}
