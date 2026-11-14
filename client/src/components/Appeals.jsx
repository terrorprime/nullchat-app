// Appeals of suspended accounts.
//   SuspendedNotice - what the person sees instead of a dead end when they try to log in to a suspended account
//   AppealsTab      - the queue for site staff (Admin Panel and Mod Panel → Appeals)
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/state.js';
import { toastError, toast } from '../lib/toast.js';
import { cx, relativeTime, formatFull } from '../lib/utils.js';
import { Avatar, Button, EmptyState, Field, Spinner, Tabs } from './ui.jsx';
import { Icon } from './icons.jsx';

const MIN = 10, MAX = 1000;
const daysUntil = (t) => Math.max(1, Math.ceil((t - Date.now()) / 86400_000));

// ================================================================ the person
/** Shown after a login to a suspended account. `info` is the login answer: { message, reason, appeal, appealTicket }. */
export function SuspendedNotice({ info, onBack }) {
  const [state, setState] = useState(info.appeal || { status: 'none', canAppeal: true });
  const [reason, setReason] = useState(info.reason || null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [lifted, setLifted] = useState(false);
  const left = MAX - text.length;
  const short = text.trim().length < MIN;

  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/auth/appeal/status', { ticket: info.appealTicket }, { noAuthRedirect: true });
      if (!r.suspended) setLifted(true);
      else { setState(r.appeal); setReason(r.reason || null); }
    } catch (e) { if (e.code === 'appeal_expired') setExpired(true); else setError(e.message); } finally { setBusy(false); }
  };
  const send = async (e) => {
    e.preventDefault();
    if (short) { setError(`Write at least ${MIN} characters, so a person can understand what happened.`); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post('/auth/appeal', { ticket: info.appealTicket, message: text.trim() }, { noAuthRedirect: true });
      setState(r.appeal); setText('');
    } catch (err) {
      if (err.code === 'appeal_expired') setExpired(true);
      else if (err.code === 'not_suspended') setLifted(true);
      else { setError(err.errors?.message || err.message); if (err.code === 'appeal_open' || err.code === 'appeal_cooldown') refresh(); }
    } finally { setBusy(false); }
  };

  if (lifted) {
    return (
      <div className="auth-form appeal-form">
        <div className="auth-icon"><Icon name="check" size={36} /></div>
        <h1>You’re back</h1>
        <p className="muted center">Your account is active again.</p>
        <Button className="full" size="lg" onClick={onBack}>Log in</Button>
      </div>
    );
  }
  if (expired) {
    return (
      <div className="auth-form appeal-form">
        <div className="auth-icon"><Icon name="clock" size={36} /></div>
        <h1>This page timed out</h1>
        <p className="muted center">Log in again to see your appeal or send a new one.</p>
        <Button className="full" size="lg" onClick={onBack}>Back to login</Button>
      </div>
    );
  }

  return (
    <div className="auth-form appeal-form">
      <div className="auth-icon"><Icon name="shield" size={36} /></div>
      <h1>This account is suspended</h1>
      {reason
        ? <div className="notice warn appeal-reason"><span className="tiny muted">Reason given</span>{reason}</div>
        : <p className="muted center">No reason was written down.</p>}

      {state.status === 'open' && (
        <>
          <div className="notice appeal-waiting" role="status">
            <b>Your appeal is waiting.</b> A moderator will read it and the answer shows up here. Come back and check, or wait for an email if you gave one when you signed up.
          </div>
          <div className="appeal-quote"><span className="tiny muted">What you wrote · {relativeTime(state.filedAt)}</span>{state.message}</div>
          <Button variant="secondary" className="full" loading={busy} onClick={refresh}>Check again</Button>
        </>
      )}

      {state.status === 'denied' && (
        <div className="notice error appeal-answer" role="status">
          <b>Your appeal was turned down.</b>
          {state.note && <span className="appeal-note">{state.note}</span>}
          {!state.canAppeal && <span className="tiny muted">You can send another in {daysUntil(state.retryAt)} day{daysUntil(state.retryAt) === 1 ? '' : 's'}.</span>}
        </div>
      )}

      {(state.status === 'none' || (state.status === 'denied' && state.canAppeal)) && (
        <form onSubmit={send} className="appeal-compose">
          <Field label={state.status === 'denied' ? 'Send another appeal' : 'Think this was a mistake? Tell us what happened.'} error={error || null}>
            <textarea className="input appeal-text" rows={5} maxLength={MAX} value={text} onChange={(e) => { setText(e.target.value); setError(''); }}
              placeholder="Explain in your own words. A real person reads this." aria-describedby="appeal-count" />
          </Field>
          <div className="appeal-foot">
            <span id="appeal-count" className={cx('tiny', left < 100 ? 'warn-text' : 'muted')}>{short ? `${MIN} characters at least` : `${left} left`}</span>
            <Button type="submit" loading={busy} disabled={short}>Send appeal</Button>
          </div>
        </form>
      )}
      {error && state.status !== 'none' && !(state.status === 'denied' && state.canAppeal) && <div className="notice error" role="alert">{error}</div>}
      <button type="button" className="link-btn" onClick={onBack}>Back to login</button>
    </div>
  );
}

// ================================================================ the staff
/** The appeals queue for the Admin Panel and the Mod Panel. */
export function AppealsTab({ openAccount, onChange }) {
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const count = useStore((s) => s.reportCounts?.appeals || 0);
  const tick = useStore((s) => s.appealsTick);

  const load = useCallback(async () => {
    setError('');
    try { setItems((await api.get(`/mod/appeals?status=${status}`)).appeals); } catch (e) { setError(e.message || 'Couldn’t load appeals.'); }
  }, [status]);
  useEffect(() => { setItems(null); load(); }, [load]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } load(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const decided = (a) => { setItems((cur) => (cur || []).filter((x) => x.id !== a.id)); onChange?.(); };

  return (
    <>
      <h2>Appeals</h2>
      <p className="muted small report-intro">
        People who were suspended can write to you from the login screen. Approving restores the account straight away. If you turn one down, the person reads your note, and can try again in a week.
      </p>
      <Tabs className="report-tabs" value={status} onChange={setStatus} tabs={[{ value: 'open', label: 'Waiting', badge: count }, { value: 'closed', label: 'Decided' }]} />
      {error && <div className="notice error">{error}</div>}
      {!items && !error && <div className="admin-loading"><Spinner /></div>}
      {items && !items.length && (status === 'open'
        ? <EmptyState icon="check" title="No appeals waiting">When a suspended person writes to you, it shows up here.</EmptyState>
        : <EmptyState icon="check" title="Nothing decided yet">Appeals you approve or turn down are kept here.</EmptyState>)}
      <div className="report-list">
        {(items || []).map((a) => <AppealCard key={a.id} a={a} onDecided={decided} openAccount={openAccount} />)}
      </div>
    </>
  );
}

function AppealCard({ a, onDecided, openAccount }) {
  const [mode, setMode] = useState(null);   // null | 'approve' | 'deny'
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = a.status === 'open';
  const name = a.user?.displayName || a.user?.username || 'Someone';

  const decide = async (e) => {
    e.preventDefault();
    if (mode === 'deny' && note.trim().length < 3) { setErr('Say why, so the person knows what to expect.'); return; }
    setBusy(true); setErr('');
    try {
      await api.post(`/mod/appeals/${a.id}/${mode}`, { note: note.trim() || undefined });
      toast(mode === 'approve' ? `${name} can log in again.` : 'Appeal turned down.', 'success');
      onDecided(a);
    } catch (e2) { setErr(e2.message); if (e2.code === 'already_decided') onDecided(a); else toastError(e2); } finally { setBusy(false); }
  };

  return (
    <article className={cx('report-card appeal-card', !open && 'closed')} aria-label={`Appeal from ${name}`}>
      <header className="report-head">
        {a.user && <span className="report-who"><Avatar user={a.user} size={20} /><b>{name}</b> <span className="muted tiny">@{a.user.username}</span></span>}
        {a.user?.isDevJr && <span className="pill mod-pill">Dev Jr</span>}
        {a.user?.isMod && <span className="pill mod-pill">Moderator</span>}
        {a.earlier > 0 && <span className="pill">{a.earlier} earlier appeal{a.earlier === 1 ? '' : 's'}</span>}
        <span className="grow" />
        <span className="muted tiny" title={formatFull(a.createdAt)}>{relativeTime(a.createdAt)}</span>
        {!open && <span className={cx('pill', a.status === 'denied' && 'warn')}>{a.status === 'approved' ? 'Approved' : 'Turned down'}</span>}
      </header>
      {a.suspensionReason && <div className="small muted appeal-why">Suspended for: <span className="appeal-why-text">{a.suspensionReason}</span></div>}
      <div className="appeal-quote"><span className="tiny muted">What they wrote</span>{a.message}</div>
      {!open && (
        <div className="small muted">{a.status === 'approved' ? 'Approved' : 'Turned down'}{a.decidedBy ? ` by ${a.decidedBy}` : ''}{a.decidedAt ? ` · ${relativeTime(a.decidedAt)}` : ''}{a.note ? ` — “${a.note}”` : ''}</div>
      )}
      {open && !a.user?.suspended && <div className="tiny muted">This account is no longer suspended.</div>}

      {open && !mode && (
        <div className="report-actions">
          {openAccount && a.user && <Button size="sm" variant="secondary" onClick={() => openAccount(a.user.id)}>View account</Button>}
          <span className="grow" />
          {a.canDecide
            ? (<><Button size="sm" variant="secondary" onClick={() => setMode('deny')}>Turn down…</Button><Button size="sm" onClick={() => setMode('approve')}>Approve…</Button></>)
            : <span className="tiny muted">An admin decides this one.</span>}
        </div>
      )}
      {open && mode && (
        <form className="report-confirm appeal-confirm" onSubmit={decide}>
          <input className="input" autoFocus maxLength={300} value={note} onChange={(e) => { setNote(e.target.value); setErr(''); }}
            aria-label={mode === 'deny' ? 'Note the person will read' : 'Note (optional)'}
            placeholder={mode === 'deny' ? 'Why? The person will read this' : 'Optional note the person will read'} />
          <Button size="sm" variant="link" onClick={() => { setMode(null); setNote(''); setErr(''); }}>Back</Button>
          <Button size="sm" type="submit" loading={busy} variant={mode === 'deny' ? 'danger' : 'primary'}>{mode === 'deny' ? 'Turn down appeal' : 'Approve and restore'}</Button>
          {err && <div className="notice error appeal-err" role="alert">{err}</div>}
        </form>
      )}
    </article>
  );
}
