// Choosing when to be reminded about a saved message.
import { useState } from 'react';
import { store } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import { reminderPresets, saveMessage, timeUntil } from '../lib/saved.js';
import { Button, Field, Modal, openModal } from './ui.jsx';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Saves the message (if it isn't already) and sets the reminder. */
export async function remindMeAt(m, at) {
  if (await saveMessage(m, at)) toast(`Okay. I’ll remind you ${timeUntil(at)}.`, 'success', 2800);
}

export function openReminderPicker(m) {
  openModal(({ close }) => <ReminderPicker message={m} close={close} />);
}

function ReminderPicker({ message, close }) {
  const [value, setValue] = useState(toLocalInput(Date.now() + 60 * 60_000));
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    const at = new Date(value).getTime();
    if (!Number.isFinite(at)) { setError('Pick a date and time.'); return; }
    if (at < Date.now() + 10_000) { setError('Pick a time in the future.'); return; }
    close();
    await remindMeAt(message, at);
  };
  return (
    <Modal title="Remind me" subtitle="You’ll get a notification when it’s time, and the message stays in your Saved list." size="sm" onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={submit}>Set reminder</Button></>}>
      <form onSubmit={submit}>
        <Field label="Date and time" error={error}>
          <input className="input" type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(e) => { setValue(e.target.value); setError(''); }} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

/** Items for the "Remind Me" submenu of a message's context menu. */
export function reminderMenuItems(m) {
  const cur = store.get().saved[m.id];
  return [
    ...reminderPresets().map((p) => ({ label: p.label, onClick: () => remindMeAt(m, p.at) })),
    { label: 'Pick a time…', onClick: () => openReminderPicker(m) },
    cur?.remindAt && { type: 'separator' },
    cur?.remindAt && { label: 'Clear reminder', danger: true, onClick: () => saveMessage(m, null) },
  ].filter(Boolean);
}
