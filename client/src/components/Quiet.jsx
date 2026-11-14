// Quiet replies: a reply in a channel that only the people you pick can see (server/src/routes/quiet.js).
// This file has the composer's part (the "Quiet" switch on the reply bar and the list of who will see it) and the note under a
// quiet reply in the message list.
import { useMemo, useState } from 'react';
import { useStore, store, displayName } from '../lib/state.js';
import { setReply } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { P, has, ChannelType, computeChannelPermissions } from '../../../shared/permissions.js';
import { Avatar, openPopout, Switch } from './ui.jsx';
import { Icon } from './icons.jsx';

export const MAX_QUIET_VIEWERS = 10;

/** Can quiet replies be used in this channel at all? (Not in a one-to-one DM: that is already private.) */
export function quietAllowed(channel) {
  return !!channel && [ChannelType.TEXT, ChannelType.ANNOUNCEMENT, ChannelType.THREAD, ChannelType.GROUP_DM].includes(channel.type);
}

/** The people who can be shown a quiet reply in this channel: everyone who can see it, except you and bots. */
export function quietCandidates(s, channel) {
  const me = s.me?.id;
  if (!channel) return [];
  if (!channel.guildId) return (channel.recipients || []).filter((id) => id !== me && !s.users[id]?.bot);
  const permChannel = channel.type === ChannelType.THREAD ? s.channels[channel.parentId] || channel : channel;
  const g = s.guilds[channel.guildId];
  if (!g) return [];
  return Object.values(s.members[channel.guildId] || {})
    .filter((m) => m.userId !== me && s.users[m.userId] && !s.users[m.userId].bot && has(computeChannelPermissions(g, m, permChannel), P.VIEW_CHANNEL))
    .map((m) => m.userId);
}

/** Who a quiet reply to this message goes to before you change anything: its author (and, answering a quiet reply, the others who saw it). */
export function defaultQuietViewers(message, myId) {
  const ids = [message.author?.id, ...(message.quiet?.viewers || []).map((u) => u.id)];
  return [...new Set(ids)].filter((id) => id && id !== myId && id !== '0' && !message.author?.webhook);
}

/** Start (or change to) a quiet reply to a message. */
export function startQuietReply(message) {
  const s = store.get();
  const ch = s.channels[message.channelId];
  const ok = new Set(quietCandidates(s, ch));
  setReply(message.channelId, { ...message, mention: true, quietTo: defaultQuietViewers(message, s.me.id).filter((id) => ok.has(id)) });
  window.dispatchEvent(new CustomEvent('nullchat:focus-composer'));
}

/** The second row of the reply bar while a quiet reply is being written: who will see it, and a way to add or take away people. */
export function QuietRow({ channelId, reply, guildId }) {
  const channel = useStore((s) => s.channels[channelId]);
  const names = useStore((s) => (reply.quietTo || []).map((id) => displayName(s, id, guildId)).join('\u0000'));
  const list = reply.quietTo || [];
  // Answering a quiet reply: only the people who can see that one can be picked (the server checks the same thing).
  const limitTo = reply.quiet ? new Set([reply.author?.id, ...reply.quiet.viewers.map((u) => u.id)]) : null;
  const set = (ids) => setReply(channelId, { ...reply, quietTo: ids });
  const labels = names ? names.split('\u0000') : [];
  return (
    <div className="quiet-row" data-quiet-row>
      <Icon name="eyeOff" size={14} />
      <span className="quiet-row-label">Only visible to</span>
      <div className="quiet-chips">
        {list.map((id, i) => (
          <span className="quiet-chip" key={id} data-quiet-viewer={id}>
            <Avatar userId={id} size={16} />
            <span className="truncate">{labels[i]}</span>
            <button type="button" aria-label={`Remove ${labels[i]}`} onClick={() => set(list.filter((x) => x !== id))}><Icon name="x" size={12} /></button>
          </span>
        ))}
        {!list.length && <span className="quiet-none">nobody yet: add someone</span>}
        {list.length < MAX_QUIET_VIEWERS && (
          <button type="button" className="quiet-add" aria-label="Choose who can see this reply"
            onClick={(e) => openPopout(e.currentTarget, ({ close }) => <ViewerPicker channel={channel} picked={list} limitTo={limitTo} onChange={set} onClose={close} />, { placement: 'top', key: 'quiet-viewers' })}>
            <Icon name="plus" size={12} /> Add people
          </button>
        )}
      </div>
    </div>
  );
}

function ViewerPicker({ channel, picked: initial, limitTo, onChange, onClose }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(initial);
  const all = useStore((s) => quietCandidates(s, channel).filter((id) => !limitTo || limitTo.has(id)).join(','));
  const rows = useMemo(() => {
    const s = store.get();
    const needle = q.trim().toLowerCase();
    return (all ? all.split(',') : [])
      .map((id) => ({ id, name: displayName(s, id, channel?.guildId), username: s.users[id]?.username || '' }))
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.username.toLowerCase().includes(needle))
      .sort((a, b) => (picked.includes(b.id) - picked.includes(a.id)) || a.name.localeCompare(b.name))
      .slice(0, 50);
  }, [all, q, channel?.guildId]);   // (the order is not reshuffled while you tick people)
  const full = picked.length >= MAX_QUIET_VIEWERS;
  const toggle = (id) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : full ? picked : [...picked, id];
    setPicked(next); onChange(next);
  };
  return (
    <div className="quiet-picker" role="dialog" aria-label="Who can see this reply">
      <div className="quiet-picker-head">
        <b>Who can see this reply</b>
        <span className="tiny muted">{picked.length}/{MAX_QUIET_VIEWERS}</span>
      </div>
      <input autoFocus className="quiet-picker-search" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
      <div className="quiet-picker-list scroller">
        {rows.map((r) => {
          const on = picked.includes(r.id);
          return (
            <button type="button" key={r.id} className={cx('quiet-picker-row', on && 'on')} disabled={!on && full} onClick={() => toggle(r.id)} role="checkbox" aria-checked={on} data-pick={r.id}>
              <Avatar userId={r.id} size={24} />
              <span className="truncate grow">{r.name}</span>
              <span className="tiny muted truncate">@{r.username}</span>
              <span className={cx('quiet-check', on && 'on')}>{on && <Icon name="check" size={12} />}</span>
            </button>
          );
        })}
        {!rows.length && <div className="tiny muted quiet-picker-empty">{limitTo ? 'Only the people who can see that quiet reply can be picked.' : 'Nobody here matches.'}</div>}
      </div>
      <div className="quiet-picker-foot"><button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button></div>
    </div>
  );
}

/** The "Quiet" switch on the reply bar. */
export function QuietSwitch({ channelId, reply }) {
  const on = !!reply.quietTo;
  const turn = (v) => {
    if (!v) { const { quietTo, ...rest } = reply; setReply(channelId, rest); return; }
    startQuietReply(reply);
  };
  // Answering a quiet reply is always quiet: an ordinary reply would show everyone that there was something to answer.
  if (reply.quiet) return <span className="reply-mention quiet-switch"><span className="on"><Icon name="eyeOff" size={13} /> Quiet</span></span>;
  return (
    <label className="reply-mention quiet-switch" data-tooltip={on ? 'Only the people you pick will see this reply' : 'Reply so that only the people you pick can see it'}>
      <span className={cx(on ? 'on' : 'off')}><Icon name="eyeOff" size={13} /> Quiet</span>
      <Switch checked={on} onChange={turn} />
    </label>
  );
}

/** Under a quiet reply in the message list: who can see it, and what you can do with it. */
export function QuietNote({ message, guildId, canSend }) {
  const myId = useStore((s) => s.me.id);
  const own = message.author.id === myId;
  const others = message.quiet.viewers.filter((u) => u.id !== myId);
  const names = useStore((s) => others.map((u) => displayName(s, u.id, guildId) || u.displayName || u.username).join('\u0000'));
  const list = names ? names.split('\u0000') : [];
  const who = own ? list : [displayName(store.get(), message.author.id, guildId), ...list];
  const text = who.length <= 3 ? who.join(', ') : `${who.slice(0, 2).join(', ')} and ${who.length - 2} more`;
  const del = () => api.del(`/channels/${message.channelId}/quiet-replies/${message.id}`).catch(toastError);
  return (
    <div className="ephemeral-note quiet-note" data-quiet-note>
      <Icon name="eyeOff" size={13} />
      <span title={who.join(', ')}>Quiet reply · only visible to you{who.length ? ` and ${text}` : ''}</span>
      {canSend && <> · <button className="link-btn" onClick={() => startQuietReply(message)}>Reply quietly</button></>}
      {own && <> · <button className="link-btn" onClick={del}>Delete</button></>}
    </div>
  );
}
