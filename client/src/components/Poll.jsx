// Polls: the card shown inside a message, and the "Create poll" dialog.
import { useEffect, useRef, useState } from 'react';
import { useStore, store, handleEvent, displayName, channelPermissions } from '../lib/state.js';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { cx, plural } from '../lib/utils.js';
import { P, has } from '../../../shared/permissions.js';
import { Avatar, Button, Field, Modal, Switch, openModal, confirmDialog } from './ui.jsx';
import { Icon } from './icons.jsx';

const MAX_OPTIONS = 10;
const DURATIONS = [
  { value: 0, label: 'Until I end it' },
  { value: 1, label: '1 hour' },
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '1 week' },
];

/** Re-render every `ms` (0 = never) so countdowns and "ended" flip on their own. */
function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function timeLeft(endsAt, now) {
  const ms = endsAt - now;
  if (ms <= 0) return 'ended';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${plural(min, 'minute')} left`;
  const hr = Math.ceil(ms / 3_600_000);
  if (hr < 48) return `${plural(hr, 'hour')} left`;
  return `${plural(Math.ceil(ms / 86_400_000), 'day')} left`;
}

const liveMessage = (m) => store.get().messages[m.channelId]?.list.find((x) => x.id === m.id) || m;

/** Cast / change / withdraw a vote. The card updates immediately and is corrected by the server's answer. */
export async function castVote(message, optionId) {
  const m = liveMessage(message);
  const poll = m.poll;
  if (!poll) return;
  const me = store.get().me.id;
  const mine = poll.options.filter((o) => o.voters.includes(me)).map((o) => o.id);
  const next = poll.multi ? (mine.includes(optionId) ? mine.filter((x) => x !== optionId) : [...mine, optionId]) : (mine.includes(optionId) ? [] : [optionId]);
  const optimistic = {
    ...m,
    poll: { ...poll, options: poll.options.map((o) => ({ ...o, voters: next.includes(o.id) ? (o.voters.includes(me) ? o.voters : [...o.voters, me]) : o.voters.filter((v) => v !== me) })) },
  };
  handleEvent('MESSAGE_UPDATE', optimistic);
  try {
    handleEvent('MESSAGE_UPDATE', await api.put(`/channels/${m.channelId}/messages/${m.id}/poll/votes`, { optionIds: next }));
  } catch (e) {
    handleEvent('MESSAGE_UPDATE', m);
    toastError(e);
  }
}

async function endPoll(m) {
  const ok = await confirmDialog({ title: 'End this poll?', body: <p className="muted">Nobody will be able to vote any more. The results stay visible.</p>, confirmText: 'End poll', danger: true });
  if (!ok) return;
  try { handleEvent('MESSAGE_UPDATE', await api.post(`/channels/${m.channelId}/messages/${m.id}/poll/end`, {})); } catch (e) { toastError(e); }
}

export function PollCard({ message, channel, own, perms, preview = false }) {
  const poll = message.poll;
  const myId = useStore((s) => s.me.id);
  const guildId = channel?.guildId;
  const now = useNow(poll.endsAt && !poll.closed ? 15_000 : 0);
  const ended = poll.closed || (poll.endsAt != null && poll.endsAt <= now);
  const voters = new Set(poll.options.flatMap((o) => o.voters));
  const total = voters.size;
  const canVote = !preview && !ended && !message.pending && has(perms, P.ADD_REACTIONS);
  const canEnd = !preview && !ended && !message.pending && (own || (channel?.guildId && has(perms, P.MANAGE_MESSAGES)));
  const top = Math.max(0, ...poll.options.map((o) => o.voters.length));
  const names = (o) => {
    const s = store.get();
    const list = o.voters.slice(0, 12).map((id) => displayName(s, id, guildId));
    return list.length ? `${list.join(', ')}${o.voters.length > 12 ? ` and ${o.voters.length - 12} more` : ''}` : 'No votes yet';
  };
  return (
    <div className={cx('poll', ended && 'ended')} role="group" aria-label="Poll">
      <div className="poll-head"><Icon name="poll" size={14} /><span>{poll.multi ? 'Poll · pick any' : 'Poll · pick one'}</span></div>
      <div className="poll-options" role={poll.multi ? 'group' : 'radiogroup'} aria-label="Poll options">
        {poll.options.map((o) => {
          const mine = o.voters.includes(myId);
          const pct = total ? Math.round((o.voters.length / total) * 100) : 0;
          return (
            <button key={o.id} type="button" className={cx('poll-option', mine && 'mine', ended && o.voters.length === top && top > 0 && 'winner')}
              disabled={!canVote} onClick={() => castVote(message, o.id)} title={names(o)} role={poll.multi ? 'checkbox' : 'radio'} aria-checked={mine}>
              <span className="poll-bar" style={{ width: `${pct}%` }} />
              <span className="poll-mark">{mine ? <Icon name="check" size={13} strokeWidth={3} /> : null}</span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-count">{o.voters.length} · {pct}%</span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        {total > 0 && !preview
          ? <button type="button" className="link-btn" onClick={() => openVoters(message)}>{plural(total, 'person', 'people')} voted</button>
          : <span>{plural(total, 'person', 'people')} voted</span>}
        <span>·</span>
        <span>{ended ? 'Poll ended' : poll.endsAt ? timeLeft(poll.endsAt, now) : 'Open'}</span>
        {!canVote && !preview && !ended && !message.pending && <span className="muted">· You can’t vote here</span>}
        <span className="grow" />
        {canEnd && <button type="button" className="link-btn" onClick={() => endPoll(message)}>End poll</button>}
      </div>
    </div>
  );
}

// ================================================================ who voted
function openVoters(m) {
  openModal(({ close }) => <VotersModal messageId={m.id} channelId={m.channelId} close={close} />);
}

function VotersModal({ messageId, channelId, close }) {
  // Read the live message so the list keeps up with votes while it is open.
  const msg = useStore((s) => s.messages[channelId]?.list.find((x) => x.id === messageId));
  const guildId = useStore((s) => s.channels[channelId]?.guildId);
  const names = useStore((s) => Object.fromEntries((msg?.poll?.options || []).flatMap((o) => o.voters).map((id) => [id, displayName(s, id, guildId)])));
  const poll = msg?.poll;
  return (
    <Modal title="Who voted" subtitle={msg?.content} size="sm" onClose={close}>
      {!poll ? <p className="muted">This poll is no longer available.</p> : (
        <div className="poll-voters">
          {poll.options.map((o) => (
            <div key={o.id} className="poll-voters-group">
              <div className="poll-voters-head"><b>{o.text}</b><span className="muted tiny">{plural(o.voters.length, 'vote')}</span></div>
              {o.voters.length === 0 ? <div className="tiny muted">No votes yet</div> : o.voters.map((id) => (
                <div key={id} className="row gap poll-voter"><Avatar userId={id} size={24} /><span className="truncate">{names[id]}</span></div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ================================================================ creating a poll
export function openPollModal(channelId) {
  openModal(({ close }) => <PollModal channelId={channelId} close={close} />);
}

function PollModal({ channelId, close }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const qRef = useRef(null);
  useEffect(() => { qRef.current?.focus(); }, []);
  const canSend = useStore((s) => has(channelPermissions(s, channelId), s.channels[channelId]?.type === 11 ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES));

  const setOpt = (i, v) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  const clean = options.map((o) => o.trim()).filter(Boolean);
  const dupe = new Set(clean.map((o) => o.toLowerCase())).size !== clean.length;
  const problem = !question.trim() ? 'Ask a question.' : clean.length < 2 ? 'Add at least two options.' : dupe ? 'Every option must be different.' : !canSend ? 'You can’t send messages here.' : '';

  const submit = async (e) => {
    e?.preventDefault();
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      await api.post(`/channels/${channelId}/messages`, { content: question.trim(), poll: { options: clean, multi, durationHours: duration || null } });
      close();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal title="Create a poll" subtitle="Everyone in the channel can vote. People can change their vote until the poll ends." onClose={close} size="sm"
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={submit} loading={busy}>Post poll</Button></>}>
      <form className="poll-form" onSubmit={submit}>
        <Field label="Question">
          <input ref={qRef} className="input" value={question} maxLength={300} placeholder="What should we do on Friday?" onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <Field label="Options">
          <div className="poll-edit-list">
            {options.map((o, i) => (
              <div key={i} className="row gap poll-edit-row">
                <input className="input grow" value={o} maxLength={100} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} onChange={(e) => setOpt(i, e.target.value)} />
                {options.length > 2 && <button type="button" className="icon-btn small" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>}
              </div>
            ))}
            {options.length < MAX_OPTIONS && <button type="button" className="link-btn left" onClick={() => setOptions((x) => [...x, ''])}>+ Add an option</button>}
          </div>
        </Field>
        <div className="row-between">
          <span>Allow picking more than one answer</span>
          <Switch checked={multi} onChange={setMulti} label="Allow multiple answers" />
        </div>
        <Field label="Ends">
          <select className="input select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </Field>
        {error && <div className="notice error" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** "/poll Question | Option 1 | Option 2"  — with nothing after it, opens the dialog. */
export async function pollCommand(args, channel) {
  if (!args) { openPollModal(channel.id); return; }
  const parts = args.split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) throw new Error('Use /poll Question | Option 1 | Option 2 (or just /poll for the form).');
  const [question, ...options] = parts;
  await api.post(`/channels/${channel.id}/messages`, { content: question, poll: { options, multi: false } });
}

