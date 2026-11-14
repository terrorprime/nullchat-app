// Two things you can do with someone else's message: report it, or forward it to another conversation.
import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { store, useStore, displayName, authorName, channelPermissions } from '../lib/state.js';
import { toast, toastError } from '../lib/toast.js';
import { navigate } from '../lib/router.jsx';
import { cx } from '../lib/utils.js';
import { toPlainText } from '../lib/markdown.jsx';
import { ChannelType, P, has, isTextLike } from '../../../shared/permissions.js';
import { REPORT_REASONS } from '../../../shared/reports.js';
import { Avatar, Button, Field, Modal, RadioGroup, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';

const MAX_FORWARD_TARGETS = 5;

// ================================================================ report
export function openReport(message, channel) {
  openModal(({ close }) => <ReportModal message={message} channel={channel} close={close} />);
}

function ReportModal({ message, channel, close }) {
  const guild = useStore((s) => (channel?.guildId ? s.guilds[channel.guildId] : null));
  const author = useStore((s) => authorName(s, message.author, channel?.guildId));
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  // Direct messages, and anything the server's owner wrote, can only be judged by the people who run this NullChat: its admin and its site mods.
  const toSite = !guild || guild.ownerId === message.author.id;
  const who = toSite ? 'the admin and moderators of this NullChat' : `the moderators of ${guild.name}, and to the admin and moderators of this NullChat`;
  const needsDetails = reason === 'other';
  const ready = reason && (!needsDetails || details.trim());

  const submit = async (e) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await api.post(`/channels/${message.channelId}/messages/${message.id}/report`, { reason, details: details.trim() });
      setSent(true);
    } catch (err) {
      if (err.code === 'already_reported') setSent(true);
      else setError(err.message || 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <Modal title="Thanks for telling us" onClose={close} size="sm" footer={<Button onClick={close}>Done</Button>}>
        <p>Your report went to {who}. They will look at the message and decide what to do. {author} won’t be told it was you.</p>
        <p className="muted small">If someone is in immediate danger, contact your local emergency services. Reports aren’t watched around the clock.</p>
      </Modal>
    );
  }
  return (
    <Modal title="Report this message" subtitle={`by ${author}`} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" disabled={!ready} loading={busy} onClick={submit}>Send report</Button></>}>
      <form onSubmit={submit}>
        <RadioGroup value={reason} onChange={setReason} options={REPORT_REASONS} />
        <Field label={needsDetails ? 'What is wrong?' : 'Anything else we should know?'} required={needsDetails} hint={`${details.length}/500`} className="report-details">
          <textarea className="input" rows={3} maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} placeholder={needsDetails ? 'Tell them in a few words' : 'Optional'} />
        </Field>
        {error && <div className="notice error">{error}</div>}
        <p className="muted small report-privacy">
          {toSite && !guild
            ? <>This is a private message. Sending the report lets {who} read <b>this message</b> (not the rest of the conversation) and see that it came from you.</>
            : <>{who[0].toUpperCase() + who.slice(1)} will see this message, what you write here, and that it came from you. {author} won’t be told.</>}
        </p>
      </form>
    </Modal>
  );
}

// ================================================================ forward
export function openForward(message) {
  openModal(({ close }) => <ForwardModal message={message} close={close} />);
}

/** Everywhere this person can send a message, newest conversations first. */
function useDestinations(needsFiles) {
  const s = useStore((x) => x);
  return useMemo(() => {
    const out = [];
    const sendable = (id) => {
      const perms = channelPermissions(s, id);
      if (!has(perms, P.VIEW_CHANNEL) || !has(perms, P.SEND_MESSAGES)) return 'You can’t send messages here';
      if (needsFiles && !has(perms, P.ATTACH_FILES)) return 'Files aren’t allowed here';
      return null;
    };
    const dms = s.privateChannelIds.map((id) => s.channels[id]).filter(Boolean)
      .sort((a, b) => (BigInt(b.lastMessageId || 0) > BigInt(a.lastMessageId || 0) ? 1 : -1));
    for (const c of dms) {
      const isDM = c.type === ChannelType.DM;
      const label = isDM ? displayName(s, c.recipients[0]) : c.name || c.recipients.map((r) => displayName(s, r)).join(', ');
      out.push({ key: `c${c.id}`, kind: isDM ? 'dm' : 'group', channelId: c.id, label, sub: isDM ? s.users[c.recipients[0]]?.username : 'Group', user: isDM ? s.users[c.recipients[0]] : null, blocked: sendable(c.id) });
    }
    const haveDM = new Set(dms.filter((c) => c.type === ChannelType.DM).map((c) => c.recipients[0]));
    for (const r of Object.values(s.relationships)) {
      if (r.type !== 1 || haveDM.has(r.id)) continue;
      out.push({ key: `u${r.id}`, kind: 'friend', userId: r.id, label: displayName(s, r.id), sub: s.users[r.id]?.username, user: s.users[r.id], blocked: null });
    }
    for (const g of Object.values(s.guilds)) {
      for (const id of s.guildChannels[g.id] || []) {
        const c = s.channels[id];
        if (!c || !isTextLike(c.type)) continue;
        const blocked = sendable(id);
        if (blocked && !has(channelPermissions(s, id), P.VIEW_CHANNEL)) continue; // hidden channels aren't listed at all
        out.push({ key: `c${id}`, kind: 'channel', channelId: id, label: c.name, sub: g.name, guild: g, blocked });
      }
    }
    return out;
  }, [s, needsFiles]);
}

function ForwardModal({ message, close }) {
  const needsFiles = !!message.attachments?.length;
  const dests = useDestinations(needsFiles);
  const author = useStore((s) => authorName(s, message.author, message.guildId));
  const text = useStore((s) => toPlainText(message.forward ? message.forward.content : message.content, s, null));
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]); // keys
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);

  const list = useMemo(() => {
    const query = q.trim().toLowerCase().replace(/^[#@]/, '');
    const found = query ? dests.filter((d) => d.label.toLowerCase().includes(query) || (d.sub || '').toLowerCase().includes(query)) : dests;
    return found.slice(0, 60);
  }, [dests, q]);
  const byKey = useMemo(() => Object.fromEntries(dests.map((d) => [d.key, d])), [dests]);
  const toggle = (d) => {
    if (d.blocked) return;
    setPicked((p) => (p.includes(d.key) ? p.filter((k) => k !== d.key) : p.length >= MAX_FORWARD_TARGETS ? p : [...p, d.key]));
  };

  const send = async () => {
    if (!picked.length || busy) return;
    setBusy(true); setProblems([]);
    const failed = []; const done = [];
    for (const key of picked) {
      const d = byKey[key]; if (!d) continue;
      try {
        let channelId = d.channelId;
        if (!channelId) channelId = (await api.post('/users/@me/channels', { recipientId: d.userId })).id;
        await api.post(`/channels/${channelId}/messages`, { content: comment.trim(), forward: { channelId: message.channelId, messageId: message.id } });
        done.push({ d, channelId });
      } catch (e) { failed.push({ key, label: d.label, message: e.message || 'It didn’t send.' }); }
    }
    setBusy(false);
    if (!failed.length) {
      close();
      const first = done[0];
      toast(done.length === 1 ? `Forwarded to ${first.d.kind === 'channel' ? '#' : ''}${first.d.label}` : `Forwarded to ${done.length} places`, 'success', 4000, done.length === 1 ? {
        actionLabel: 'Open',
        onClick: () => { const ch = store.get().channels[first.channelId]; navigate(ch?.guildId ? `/channels/${ch.guildId}/${ch.id}` : `/channels/@me/${first.channelId}`); },
      } : {});
    } else {
      // keep the ones that failed selected so one tap tries again; the rest went through
      setPicked(failed.map((f) => f.key));
      setProblems(failed);
      if (done.length) toast(`Forwarded to ${done.length}. ${failed.length} didn’t go through.`, 'info', 5000);
    }
  };

  const attachCount = message.attachments?.length || 0;
  return (
    <Modal title="Forward message" onClose={close} size="sm" className="forward-modal"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button disabled={!picked.length} loading={busy} onClick={send}>{picked.length > 1 ? `Send to ${picked.length}` : 'Send'}</Button></>}>
      <input className="input" autoFocus placeholder="Search people and channels" aria-label="Search people and channels" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="fwd-list" role="listbox" aria-multiselectable="true" aria-label="Where to send it">
        {list.map((d) => {
          const on = picked.includes(d.key);
          const full = !on && picked.length >= MAX_FORWARD_TARGETS;
          return (
            <button key={d.key} type="button" role="option" aria-selected={on} aria-disabled={!!d.blocked || full} className={cx('fwd-dest', on && 'on', (d.blocked || full) && 'off')} onClick={() => toggle(d)} title={d.blocked || (full ? `You can pick up to ${MAX_FORWARD_TARGETS}` : undefined)}>
              <span className="fwd-icon">
                {d.user ? <Avatar user={d.user} size={28} /> : d.kind === 'channel' ? <Icon name="hash" size={18} /> : <Icon name="friends" size={18} />}
              </span>
              <span className="fwd-name truncate">{d.label}</span>
              <span className="fwd-sub tiny muted truncate">{d.blocked || d.sub}</span>
              <span className="fwd-check" aria-hidden="true">{on && <Icon name="check" size={14} />}</span>
            </button>
          );
        })}
        {!list.length && <div className="muted small fwd-none">{q ? 'No one matches that.' : 'There’s nowhere to send it yet.'}</div>}
      </div>
      {picked.length > 0 && <div className="fwd-picked tiny muted" aria-live="polite">To: {picked.map((k) => (byKey[k] ? `${byKey[k].kind === 'channel' ? '#' : ''}${byKey[k].label}` : '')).filter(Boolean).join(', ')}</div>}
      {problems.length > 0 && (
        <div className="notice error" role="alert">
          {problems.map((p) => <div key={p.key}><b>{p.label}:</b> {p.message}</div>)}
        </div>
      )}
      <div className="fwd-preview">
        <div className="fwd-preview-head tiny muted"><Icon name="forward" size={13} /> Forwarding a message by <b>{message.forward ? message.forward.author?.name || author : author}</b></div>
        <div className="fwd-preview-text">{text ? text.slice(0, 280) : <i className="muted">{attachCount ? `${attachCount} ${attachCount === 1 ? 'file' : 'files'}` : 'Link preview'}</i>}{text && attachCount > 0 && <span className="muted"> + {attachCount} {attachCount === 1 ? 'file' : 'files'}</span>}</div>
      </div>
      <input className="input" placeholder="Add a comment (optional)" aria-label="Add a comment" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && picked.length) { e.preventDefault(); send(); } }} />
    </Modal>
  );
}
