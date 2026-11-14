// The list of reported messages, for server moderators (Server Settings → Reports) and for the site admin and site mods (Admin Panel / Mod Panel → Reports).
// A report keeps a copy of the message as it was when it was reported, so it still makes sense after it is edited or deleted.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/state.js';
import { toastError } from '../lib/toast.js';
import { navigate } from '../lib/router.jsx';
import { closeSettings } from '../lib/ui.js';
import { channelPath, jumpToMessage } from '../lib/actions.js';
import { cx, relativeTime, formatFull, formatBytes } from '../lib/utils.js';
import { Avatar, Button, EmptyState, Spinner, Tabs, confirmDialog } from './ui.jsx';
import { Icon } from './icons.jsx';

/** Reports for one server (moderators). */
export function ServerReports({ guild }) {
  return <ReportList path={`/guilds/${guild.id}/reports`} where="server" count={useStore((s) => s.reportCounts?.guilds?.[guild.id] || 0)} />;
}

/** Every report on this NullChat, for the site admin and site mods: direct messages, things a server's owner wrote, and messages in any server. */
export function SiteReports({ openAccount }) {
  return <ReportList path="/admin/reports" where="site" count={useStore((s) => s.reportCounts?.site || 0)} openAccount={openAccount} />;
}

function ReportList({ path, where, count, openAccount }) {
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tick = useStore((s) => s.reportsTick);

  const load = useCallback(async (before) => {
    setBusy(true); setError('');
    try {
      const r = await api.get(`${path}?status=${status}${before ? `&before=${before}` : ''}`);
      setItems((cur) => (before ? [...(cur || []), ...r.items] : r.items));
      setMore(r.more);
    } catch (e) { setError(e.message || 'Couldn’t load reports.'); } finally { setBusy(false); }
  }, [path, status]);
  // A different list (Open / Handled): start over. A new report arriving (tick) refreshes quietly, so cards stay put and a
  // note someone is typing in one is not lost.
  useEffect(() => { setItems(null); load(); }, [load]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } load(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const replace = (updated) => setItems((cur) => (cur || []).flatMap((x) => (x.id !== updated.id ? [x] : (updated.status === 'open') === (status === 'open') ? [updated] : [])));

  return (
    <>
      <h2>Reports</h2>
      <p className="muted small report-intro">
        {where === 'site'
          ? <>Every message reported on this NullChat: direct messages, messages a server’s owner wrote, and messages in servers (their moderators see those too). You see the reported message only, never the rest of the conversation.</>
          : <>Messages that members reported in this server. Only people who can manage messages see this page. The person who wrote a message never sees reports about it.</>}
      </p>
      <Tabs className="report-tabs" value={status} onChange={setStatus} tabs={[{ value: 'open', label: 'Open', badge: count || 0 }, { value: 'closed', label: 'Handled' }]} />
      {error && <div className="notice error">{error}</div>}
      {!items && !error && <div className="admin-loading"><Spinner /></div>}
      {items && !items.length && (
        status === 'open'
          ? <EmptyState icon="shield" title="No open reports">When someone reports a message, it shows up here.</EmptyState>
          : <EmptyState icon="check" title="Nothing handled yet">Reports you resolve or dismiss are kept here for 90 days.</EmptyState>
      )}
      <div className="report-list">
        {(items || []).map((r) => <ReportCard key={r.id} r={r} where={where} onChange={replace} openAccount={openAccount} />)}
      </div>
      {more && <div className="report-more"><Button variant="secondary" loading={busy} onClick={() => load(items[items.length - 1].id)}>Show more</Button></div>}
    </>
  );
}

function Who({ u }) {
  if (!u) return <b>someone</b>;
  return <span className="report-who">{u.id && <Avatar user={u} size={18} />}<b>{u.displayName || u.username}</b></span>;
}

function ReportCard({ r, where, onChange, openAccount }) {
  const [mode, setMode] = useState(null); // null | 'resolved' | 'dismissed'
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const snap = r.snapshot || {};
  const channel = useStore((s) => s.channels[r.channelId]);
  const canOpen = where === 'server' && !!channel && r.messageExists;
  const open = r.status === 'open';

  const set = async (status, text) => {
    setBusy(true);
    try { onChange(await api.post(`/reports/${r.id}/status`, { status, note: text?.trim() || undefined })); setMode(null); setNote(''); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const jump = () => { closeSettings(true); navigate(channelPath(channel)); setTimeout(() => jumpToMessage(r.channelId, r.messageId), 50); };
  const remove = async () => {
    const ok = await confirmDialog({ title: 'Delete this message?', body: <>It will be removed for everyone. The report keeps a copy so you can still see what it said.</>, confirmText: 'Delete message', danger: true });
    if (!ok) return;
    try { await api.del(`/channels/${r.channelId}/messages/${r.messageId}`); onChange({ ...r, messageExists: false }); setMode('resolved'); setNote('Deleted the message.'); }
    catch (e) { toastError(e); }
  };

  const place = snap.channelName ? `#${snap.channelName}${snap.guildName ? ` in ${snap.guildName}` : ''}` : 'a direct message';
  return (
    <article className={cx('report-card', !open && 'closed')} aria-label={`Report: ${r.reasonLabel}`}>
      <header className="report-head">
        <span className="pill warn">{r.reasonLabel}</span>
        <span className="muted tiny" title={formatFull(r.createdAt)}>{relativeTime(r.createdAt)}</span>
        {!open && <span className="pill">{r.status === 'resolved' ? 'Resolved' : 'Dismissed'}</span>}
      </header>
      <div className="report-meta small muted">
        <Who u={r.reporter} /> reported a message by <Who u={r.reported} /> in {place}
      </div>
      {r.details && <p className="report-note"><span className="muted tiny">What {r.reporter ? (r.reporter.displayName || r.reporter.username) : 'they'} wrote</span>{r.details}</p>}
      <div className="report-snapshot" title={snap.createdAt ? `Sent ${formatFull(snap.createdAt)}` : undefined}>
        {snap.forwarded && <div className="tiny muted report-fwd"><Icon name="forward" size={12} /> Forwarded from {snap.forwarded.author || 'someone'}{snap.forwarded.content ? `: ${snap.forwarded.content}` : ''}</div>}
        {snap.content ? <div className="report-text">{snap.content}</div> : !snap.attachments?.length && !snap.forwarded && <i className="muted">(no text)</i>}
        {snap.attachments?.length > 0 && (
          <ul className="report-files">{snap.attachments.map((a, i) => <li key={i} className="tiny"><Icon name="file" size={12} /> {a.filename} <span className="muted">({formatBytes(a.size)})</span></li>)}</ul>
        )}
        {snap.embeds > 0 && <div className="tiny muted">{snap.embeds} link {snap.embeds === 1 ? 'preview' : 'previews'}</div>}
        {snap.editedAt && <div className="tiny muted">(it was edited before it was reported)</div>}
      </div>
      {where === 'server' && !r.messageExists && <div className="tiny muted report-gone"><Icon name="trash" size={12} /> This message has been deleted. The copy above is what it said when it was reported.</div>}

      {open && !mode && (
        <div className="report-actions">
          {canOpen && <Button size="sm" variant="secondary" onClick={jump}>Jump to message</Button>}
          {canOpen && <Button size="sm" variant="secondary" onClick={remove}>Delete message</Button>}
          {openAccount && r.reported?.id && <Button size="sm" variant="secondary" onClick={() => openAccount(r.reported.id)}>View account</Button>}
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => setMode('dismissed')}>Dismiss</Button>
          <Button size="sm" onClick={() => setMode('resolved')}>Resolve</Button>
        </div>
      )}
      {open && mode && (
        <form className="report-confirm" onSubmit={(e) => { e.preventDefault(); set(mode, note); }}>
          <input className="input" autoFocus maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note (optional)" placeholder={mode === 'resolved' ? 'What did you do? (optional note for the log)' : 'Why not? (optional note for the log)'} />
          <Button size="sm" variant="link" onClick={() => { setMode(null); setNote(''); }}>Back</Button>
          <Button size="sm" type="submit" loading={busy}>{mode === 'resolved' ? 'Mark resolved' : 'Dismiss report'}</Button>
        </form>
      )}
      {!open && (
        <div className="report-actions">
          <span className="small muted">{r.status === 'resolved' ? 'Resolved' : 'Dismissed'}{r.resolvedBy ? ` by ${r.resolvedBy}` : ''}{r.resolvedAt ? ` · ${relativeTime(r.resolvedAt)}` : ''}{r.note ? ` — ${r.note}` : ''}</span>
          <span className="grow" />
          <Button size="sm" variant="secondary" loading={busy} onClick={() => set('open')}>Reopen</Button>
        </div>
      )}
    </article>
  );
}

