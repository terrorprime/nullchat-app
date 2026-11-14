// The Inbox: mentions, unread channels and saved messages. Shown as a popout in the channel header on large
// screens and as a window from the Home sidebar (the header button is hidden on phones).
import { useEffect, useState } from 'react';
import { useStore, store, isChannelUnread, isChannelMuted } from '../lib/state.js';
import { api } from '../lib/api.js';
import { jumpToMessage, ackChannel, channelPath } from '../lib/actions.js';
import { navigate } from '../lib/router.jsx';
import { ChannelType, isVoiceLike } from '../../../shared/permissions.js';
import { Button, Modal, Spinner, Tabs, openModal } from './ui.jsx';
import { Message } from './Messages.jsx';
import { SavedList } from './Saved.jsx';
import { ScheduledList } from './Schedule.jsx';
import { Icon } from './icons.jsx';

export function InboxContent({ close, initialTab = 'mentions' }) {
  const [tab, setTab] = useState(initialTab);
  const [mentions, setMentions] = useState(null);
  const unreads = useStore((s) => Object.values(s.channels).filter((c) => c.guildId && !isVoiceLike(c.type) && c.type !== ChannelType.CATEGORY && !isChannelMuted(s, c) && !s.guildSettings[c.guildId]?.muted && isChannelUnread(s, c.id))
    .sort((a, b) => (b.lastMessageId || '').localeCompare(a.lastMessageId || '')).slice(0, 30));
  const guilds = useStore((s) => s.guilds);
  const scheduledCount = useStore((s) => Object.keys(s.scheduled).length);
  const scheduledFailed = useStore((s) => Object.values(s.scheduled).some((x) => x.error));
  useEffect(() => { if (tab === 'mentions') api.get('/users/@me/mentions').then(setMentions).catch(() => setMentions([])); }, [tab]);
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'mentions', label: 'Mentions' }, { value: 'unreads', label: 'Unreads', badge: unreads.length || null }, { value: 'saved', label: 'Saved' }, ...(scheduledCount || tab === 'scheduled' ? [{ value: 'scheduled', label: 'Scheduled', badge: scheduledCount || null, className: scheduledFailed ? 'tab-alert' : undefined }] : [])]} />
      <div className="popout-panel-body">
        {tab === 'mentions' && (!mentions ? <Spinner /> : !mentions.length ? (
          <div className="empty-state small"><Icon name="at" size={40} /><p className="muted">You’re all caught up! Mentions of you will show up here.</p></div>
        ) : mentions.map((m) => {
          const ch = store.get().channels[m.channelId];
          return (
            <div key={m.id} className="result-card" onClick={() => { close(); if (ch) navigate(channelPath(ch)); setTimeout(() => jumpToMessage(m.channelId, m.id), 50); }}>
              <div className="result-channel">{guilds[m.guildId]?.name} › #{m.channelName}</div>
              <Message message={m} channel={ch} preview />
            </div>
          );
        }))}
        {tab === 'unreads' && (!unreads.length ? <div className="empty-state small"><Icon name="check" size={40} /><p className="muted">No unread channels. Nice!</p></div>
          : unreads.map((c) => (
            <div key={c.id} className="unread-row">
              <button className="grow left" onClick={() => { close(); navigate(channelPath(c)); }}><b>#{c.name}</b><div className="tiny muted">{guilds[c.guildId]?.name}</div></button>
              <Button size="sm" variant="secondary" onClick={() => ackChannel(c.id, true)}>Mark Read</Button>
            </div>
          )))}
        {tab === 'saved' && <SavedList onNavigate={close} />}
        {tab === 'scheduled' && <ScheduledList onNavigate={close} />}
      </div>
    </>
  );
}

/** The Inbox as a window (used on phones, where the header button is hidden). */
export function openInboxModal(initialTab = 'mentions') {
  openModal(({ close }) => (
    <Modal title="Inbox" size="md" onClose={close} bodyClass="inbox-modal">
      <InboxContent close={close} initialTab={initialTab} />
    </Modal>
  ));
}
