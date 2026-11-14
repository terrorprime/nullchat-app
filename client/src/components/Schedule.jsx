// "Send later": picking a time for the message you've typed, and the list of what's waiting to be sent.
import { useState } from 'react';
import { useStore } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import {
  schedulePresets, scheduleMessage, rescheduleMessage, editScheduledText, retryScheduled, cancelScheduled, sendScheduledNow,
  sortedScheduled, describeTime, MAX_SCHEDULED, pendingCount,
} from '../lib/scheduled.js';
import { timeUntil } from '../lib/saved.js';
import { Button, Field, Modal, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * Opens the time picker for a message. `onScheduled` runs after it has been scheduled (the composer clears itself there).
 * `existing` = an item already scheduled: pick a new time for it instead of creating one.
 */
export function openSchedulePicker({ channelId, content, replyTo = null, silent = false, onScheduled, existing = null }) {
  openModal(({ close }) => <SchedulePicker {...{ channelId, content, replyTo, silent, onScheduled, existing, close }} />);
}

function SchedulePicker({ channelId, content, replyTo, silent, onScheduled, existing, close }) {
  const presets = schedulePresets();
  const [value, setValue] = useState(toLocalInput(existing ? existing.sendAt : Date.now() + 60 * 60_000));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const scheduled = useStore((s) => s.scheduled);
  const full = !existing && pendingCount(scheduled) >= MAX_SCHEDULED;

  const go = async (at) => {
    if (!Number.isFinite(at)) { setError('Pick a date and time.'); return; }
    if (at < Date.now() + 10_000) { setError('Pick a time in the future.'); return; }
    if (at > Date.now() + 30 * 24 * 3600e3) { setError('You can schedule up to 30 days ahead.'); return; }
    setBusy(true);
    const ok = existing ? await rescheduleMessage(existing.id, at) : await scheduleMessage(channelId, content, at, { replyTo, silent });
    setBusy(false);
    if (!ok) return;
    close();
    toast(`Scheduled. It will be sent ${timeUntil(at)}.`, 'success', 3500);
    onScheduled?.(ok);
  };
  const preview = existing ? existing.content : content;
  return (
    <Modal title={existing ? 'Change send time' : 'Schedule message'} subtitle="Only you can see it until it’s sent." size="sm" onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={busy || full} onClick={() => go(new Date(value).getTime())}>{existing ? 'Save time' : 'Schedule'}</Button></>}>
      {preview && <div className="schedule-preview" aria-label="Message to schedule">{preview.length > 240 ? preview.slice(0, 240) + '…' : preview}</div>}
      {full && <div className="notice error">You already have {MAX_SCHEDULED} scheduled messages. Send or cancel one first.</div>}
      <div className="schedule-presets" role="group" aria-label="Quick times">
        {presets.map((p) => (
          <button key={p.label} type="button" className="schedule-preset" disabled={busy || full} onClick={() => go(p.at)}>
            <Icon name="clock" size={16} /> {p.label}
          </button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); go(new Date(value).getTime()); }}>
        <Field label="Or pick a time" error={error}>
          <input className="input" type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(e) => { setValue(e.target.value); setError(''); }} />
        </Field>
      </form>
    </Modal>
  );
}

function openEditText(item) {
  openModal(({ close }) => <EditScheduledText item={item} close={close} />);
}

function EditScheduledText({ item, close }) {
  const [text, setText] = useState(item.content);
  const [error, setError] = useState('');
  const save = async () => {
    if (!text.trim()) { setError('Write a message to schedule.'); return; }
    if (text.length > 4000) { setError('Messages can be at most 4000 characters.'); return; }
    if (await editScheduledText(item.id, text)) { close(); toast('Updated.', 'success', 1800); }
  };
  return (
    <Modal title="Edit scheduled message" size="sm" onClose={close} footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <Field label="Message" error={error}>
        <textarea className="input" rows={5} value={text} maxLength={4100} autoFocus onChange={(e) => { setText(e.target.value); setError(''); }} />
      </Field>
    </Modal>
  );
}

/** The Scheduled tab: everything waiting to be sent. */
export function ScheduledList({ onNavigate }) {
  const map = useStore((s) => s.scheduled);
  const items = sortedScheduled(map);
  if (!items.length) {
    return (
      <div className="empty-state small">
        <Icon name="clock" size={40} />
        <p className="muted">Nothing scheduled. Type a message, then use the <b>clock</b> button next to Send (or <b>/schedule</b>) to send it later.</p>
      </div>
    );
  }
  return items.map((it) => (
    <div key={it.id} className={`result-card scheduled-card${it.error ? ' failed' : ''}`} data-scheduled-id={it.id}>
      <div className="result-channel">{it.guildName ? `${it.guildName} › #${it.channelName}` : it.channelName ? `#${it.channelName}` : 'Direct message'}</div>
      <div className="scheduled-text">{it.content.length > 400 ? it.content.slice(0, 400) + '…' : it.content}</div>
      {it.error
        ? <div className="notice error scheduled-error"><b>Couldn’t be sent:</b> {it.error}</div>
        : <div className="scheduled-when"><Icon name="clock" size={13} /> Sends {describeTime(it.sendAt)}{it.silent ? ' · silent' : ''}</div>}
      <div className="saved-meta scheduled-actions">
        {it.error
          ? <Button size="sm" onClick={() => retryScheduled(it.id)}><Icon name="refresh" size={14} /> Try again</Button>
          : <Button size="sm" variant="secondary" onClick={() => sendScheduledNow(it.id).then((ok) => ok && toast('Sent.', 'success', 1500))}><Icon name="send" size={14} /> Send now</Button>}
        {!it.error && <Button size="sm" variant="secondary" onClick={() => openSchedulePicker({ existing: it })}><Icon name="clock" size={14} /> Change time</Button>}
        <Button size="sm" variant="secondary" onClick={() => openEditText(it)}><Icon name="edit" size={14} /> Edit</Button>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Cancel scheduled message" data-tooltip="Cancel" onClick={() => cancelScheduled(it.id).then((ok) => ok && toast('Cancelled.', 'success', 1500))}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  ));
}
