// A server's moderation file on one member: their warnings and the moderators' notes about them (server/src/routes/modfile.js).
// Opened from a member's right-click menu ("Warn …" and "Warnings and Notes"). Only this server's moderators ever see it.
// The other half lives at the bottom: the window a member gets when they have been warned.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { on } from '../lib/gateway.js';
import { store, useStore, displayName } from '../lib/state.js';
import { toast, toastError } from '../lib/toast.js';
import { formatTimestamp } from '../lib/utils.js';
import { P, has } from '../../../shared/permissions.js';
import { Modal, Button, Avatar, Spinner, GuildIcon, openModal, confirmDialog, spellDuration } from './ui.jsx';
import { Icon } from './icons.jsx';

/** May this person see moderation files here? Anyone who can time out, kick or ban members, or manage the server. */
export const isModeratorHere = (perms) => has(perms, P.MODERATE_MEMBERS) || has(perms, P.KICK_MEMBERS) || has(perms, P.BAN_MEMBERS) || has(perms, P.MANAGE_GUILD);

export function openModFile(guildId, userId, { warn = false } = {}) {
  openModal(({ close }) => <ModFile guildId={guildId} userId={userId} warn={warn} close={close} />);
}

function ModFile({ guildId, userId, warn, close }) {
  const me = useStore((s) => s.me.id);
  const name = useStore((s) => displayName(s, userId, guildId));
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const load = () => api.get(`/guilds/${guildId}/members/${userId}/modfile`).then(setFile).catch((e) => setError(e.message || 'Could not load this member’s file.'));
  useEffect(() => { load(); }, [guildId, userId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const users = Object.fromEntries((file?.users || []).map((u) => [u.id, u]));
  const who = (id) => (id ? users[id]?.displayName || users[id]?.username || 'Someone' : 'Someone who has left');
  const title = users[userId]?.displayName || users[userId]?.username || name;

  const giveWarning = async () => {
    setBusy('warn');
    try {
      const r = await api.post(`/guilds/${guildId}/members/${userId}/warnings`, { reason: reason.trim() });
      setReason('');
      toast(r.timeoutUntil ? `${title} was warned and timed out (${r.recent} warnings in 30 days).` : `${title} was warned.`, 'success');
      await load();
    } catch (e) { toastError(e); } finally { setBusy(null); }
  };
  const removeWarning = async (w) => {
    if (!(await confirmDialog({ title: 'Remove this warning?', body: 'It will no longer count toward an automatic timeout. A timeout that already started stays.', confirmText: 'Remove', danger: true }))) return;
    try { await api.del(`/guilds/${guildId}/warnings/${w.id}`); await load(); } catch (e) { toastError(e); }
  };
  const addNote = async () => {
    setBusy('note');
    try { await api.post(`/guilds/${guildId}/members/${userId}/notes`, { text: note.trim() }); setNote(''); await load(); }
    catch (e) { toastError(e); } finally { setBusy(null); }
  };
  const removeNote = async (n) => {
    if (!(await confirmDialog({ title: 'Delete this note?', body: 'The other moderators won’t be able to read it any more.', confirmText: 'Delete', danger: true }))) return;
    try { await api.del(`/guilds/${guildId}/notes/${n.id}`); await load(); } catch (e) { toastError(e); }
  };

  return (
    <Modal title={`Warnings and notes: ${title}`} subtitle="Only this server’s moderators can open this." onClose={close} size="md" className="modfile" bodyClass="modfile-body">
      {error ? <p className="error-text">{error}</p> : !file ? <Spinner /> : (
        <>
          {!file.inServer && <p className="notice small">This person is not in the server right now. Their history is kept in case they come back.</p>}
          <section data-modfile-warnings>
            <h3 className="section-label">Warnings — {file.warnings.length}</h3>
            {file.limit > 0 && (
              <p className="muted small" data-warn-standing>
                {file.recent} of {file.limit} in the last 30 days. At {file.limit}, they are timed out for {spellDuration(file.timeout)} automatically.
              </p>
            )}
            {file.canWarn && (
              <div className="modfile-form">
                <textarea className="input" rows={2} maxLength={512} autoFocus={warn} placeholder="What is the warning for? The member will read this." value={reason} onChange={(e) => setReason(e.target.value)} data-warn-reason />
                <Button variant="danger" loading={busy === 'warn'} disabled={!reason.trim()} onClick={giveWarning} data-warn-give>Give Warning</Button>
              </div>
            )}
            {file.warnings.length === 0 ? <p className="muted small">No warnings.</p> : (
              <ul className="modfile-list">
                {file.warnings.map((w) => (
                  <li key={w.id} data-warning>
                    <Icon name="shield" size={18} className="modfile-icon warn" />
                    <div className="grow">
                      <div className="modfile-text">{w.reason}</div>
                      <div className="tiny muted">By {who(w.moderatorId)} · {formatTimestamp(w.createdAt)} · {w.seen ? 'Read by the member' : 'Not read yet'}</div>
                    </div>
                    {(w.moderatorId === me || file.canManage) && <button className="icon-btn small" aria-label="Remove warning" data-tooltip="Remove" onClick={() => removeWarning(w)}><Icon name="trash" size={16} /></button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section data-modfile-notes>
            <h3 className="section-label">Moderator notes — {file.notes.length}</h3>
            <p className="muted small">The member never sees these.</p>
            <div className="modfile-form">
              <textarea className="input" rows={2} maxLength={1000} placeholder="Add a note for the other moderators" value={note} onChange={(e) => setNote(e.target.value)} data-note-text />
              <Button loading={busy === 'note'} disabled={!note.trim()} onClick={addNote} data-note-add>Add Note</Button>
            </div>
            {file.notes.length > 0 && (
              <ul className="modfile-list">
                {file.notes.map((n) => (
                  <li key={n.id} data-note>
                    <Avatar user={users[n.authorId]} userId={n.authorId} size={24} />
                    <div className="grow">
                      <div className="modfile-text">{n.text}</div>
                      <div className="tiny muted">{who(n.authorId)} · {formatTimestamp(n.createdAt)}</div>
                    </div>
                    {(n.authorId === me || file.canManage) && <button className="icon-btn small" aria-label="Delete note" data-tooltip="Delete" onClick={() => removeNote(n)}><Icon name="trash" size={16} /></button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- the warned member's side
// A warning is shown once, in a window the member closes with "I understand" (that is what marks it read for the moderators).
// It appears the moment it is given, or the next time NullChat is opened.
const showing = new Map();   // warning id → close()

function WarningNotice({ w, close }) {
  const guild = useStore((s) => s.guilds[w.guildId]);
  const ok = () => { api.post('/users/@me/warnings/seen', { ids: [w.id] }).catch(() => {}); close(); };
  return (
    <Modal title="You got a warning" size="sm" className="warning-notice"
      footer={<Button onClick={ok} data-warning-ok>I understand</Button>}>
      <div className="warning-where">
        <GuildIcon guild={guild || { id: w.guildId, name: w.guildName, icon: w.guildIcon }} size={40} />
        <div><b>{w.guildName}</b><div className="tiny muted">{formatTimestamp(w.createdAt)}</div></div>
      </div>
      <p className="muted small">A moderator of this server warned you:</p>
      <blockquote className="warning-reason" data-warning-reason>{w.reason}</blockquote>
      {w.timeoutUntil
        ? <p className="small">You are timed out in this server until {formatTimestamp(w.timeoutUntil)}. Until then you can’t send messages, react or speak there.</p>
        : w.limit > 0 && <p className="muted small">This is warning {Math.min(w.count, w.limit)} of {w.limit} in 30 days. At {w.limit} you are timed out automatically.</p>}
    </Modal>
  );
}

function show(w) {
  if (!w || w.seen || showing.has(w.id)) return;
  openModal(({ close }) => {
    showing.set(w.id, close);
    return <WarningNotice w={w} close={() => { showing.delete(w.id); close(); }} />;
  }, { onClose: () => showing.delete(w.id) });
}
const dismiss = (id) => { const close = showing.get(id); if (close) { showing.delete(id); close(); } };

on('READY', () => { if (!store.get().me?.bot) api.get('/users/@me/warnings').then((r) => r.warnings.forEach(show)).catch(() => {}); });
on('WARNING_CREATE', show);
on('WARNING_DELETE', (d) => dismiss(d.id));                    // taken back before it was read
on('WARNING_SEEN', (d) => (d.ids || []).forEach(dismiss));     // read on another device
