// Login, registration, two-factor, password recovery and public invite pages.
import { useEffect, useState } from 'react';
import { api, setToken, getToken } from '../lib/api.js';
import { finishAddAccount, addingFrom, endAddAccount, switchToAccount, listAccounts } from '../lib/accounts.js';
import { connect } from '../lib/gateway.js';
import { navigate, Link, useSearch } from '../lib/router.jsx';
import { useT } from '../lib/i18n.js';
import { inNativeApp } from '../lib/native.js';
import { Button, Field, Spinner, GuildIcon, Avatar } from './ui.jsx';
import { Logo, Icon } from './icons.jsx';
import { toast } from '../lib/toast.js';
import { isStandalone, desktop } from '../lib/install.js';
import { SuspendedNotice } from './Appeals.jsx';

export function AuthShell({ children, wide }) {
  return (
    <div className="auth-page">
      <div className="auth-bg" aria-hidden="true"><span /><span /><span /></div>
      <div className="auth-brand"><Logo size={56} /><span>null<b>chat</b><i className="cursor" aria-hidden="true" /></span></div>
      <p className="auth-tag">// say something. or nothing.</p>
      <div className={'auth-card' + (wide ? ' wide' : '')}>{children}</div>
    </div>
  );
}

/** Desktop app only: which server is this app talking to? Accounts live on one server, so an account made in a
 *  browser on nullchat.fly.dev is not found if the app was set to a different server (or to "host on this computer"). */
function DesktopServerNote() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { desktop?.info().then(setInfo).catch(() => {}); }, []);
  if (!desktop || !info || info.locked) return null; // a locked app can only use its own server, so there is nothing to choose
  const host = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const here = info.mode === 'host' ? 'a server on this computer' : host(info.url || location.origin);
  const mismatch = !!info.bakedServer && (info.mode === 'host' || (!!info.url && info.url !== info.bakedServer));
  const useBaked = async () => {
    setBusy(true); setError('');
    const r = await desktop.connect(info.bakedServer);
    if (!r?.ok) { setError(r?.error || 'Could not connect.'); setBusy(false); }
  };
  return (
    <div className={'server-note' + (mismatch ? ' warn' : '')}>
      {mismatch ? (
        <>
          <p>This app is connected to <b>{here}</b>, which keeps its own separate accounts, so an account you made in your browser won’t be found here. Your server is <b>{host(info.bakedServer)}</b>.</p>
          <Button type="button" variant="secondary" loading={busy} onClick={useBaked} className="full">Use {host(info.bakedServer)}</Button>
          {error && <p className="small server-note-error">{error}</p>}
        </>
      ) : <p>Server: <b>{here}</b></p>}
      {mismatch && <button type="button" className="link-btn" onClick={() => desktop.switchServer()}>Switch server…</button>}
    </div>
  );
}

// `lounge` is only sent when an account has just been created: it lands in the Nullspace lounge's #general
// (unless a link they came from said otherwise).
function afterLogin(token, remember, lounge, user) {
  setToken(token, remember);
  finishAddAccount(user, token);   // (when this sign-in was started by "Add Account" in the status menu, the account is remembered)
  connect();
  const redirect = new URLSearchParams(location.search).get('redirect');
  const home = lounge?.guildId ? `/channels/${lounge.guildId}${lounge.channelId ? `/${lounge.channelId}` : ''}` : '/channels/@me';
  navigate(redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : home, { replace: true });
}

export function LoginPage() {
  const t = useT();
  const search = useSearch();
  const [form, setForm] = useState({ login: '', password: '' });
  const [remember, setRemember] = useState(true);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [suspended, setSuspended] = useState(null);   // a suspended account: what the person needs to appeal
  const [adding, setAdding] = useState(() => addingFrom());   // signing in to one more account (from "Add Account"): the one to go back to
  const saved = useState(() => listAccounts())[0];             // accounts already signed in on this device
  const keptName = saved.find((a) => a.id === adding);
  const cancelAdd = () => { if (!switchToAccount(adding)) { endAddAccount(); setAdding(null); } };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setErrors({});
    try {
      const res = await api.post('/auth/login', form, { noAuthRedirect: true });
      if (res.mfa) { setMfa(res.ticket); return; }
      afterLogin(res.token, remember, undefined, res.user);
    } catch (err) {
      if (err.code === 'account_suspended' && err.data?.appealTicket) { setSuspended({ ...err.data, message: err.message }); return; }
      setErrors(Object.keys(err.errors).length ? err.errors : { login: err.message });
    } finally { setLoading(false); }
  };
  const submitMfa = async (e) => {
    e.preventDefault();
    setLoading(true); setErrors({});
    try {
      const res = await api.post('/auth/mfa', { ticket: mfa, code }, { noAuthRedirect: true });
      afterLogin(res.token, remember, undefined, res.user);
    } catch (err) {
      if (err.code === 'account_suspended' && err.data?.appealTicket) { setMfa(null); setCode(''); setSuspended({ ...err.data, message: err.message }); return; }
      if (err.status === 401) { setMfa(null); toast(err.message, 'error'); }
      setErrors({ code: err.errors.code || err.message });
    } finally { setLoading(false); }
  };

  if (suspended) {
    return <AuthShell><SuspendedNotice info={suspended} onBack={() => { setSuspended(null); setForm((f) => ({ ...f, password: '' })); }} /></AuthShell>;
  }
  if (mfa) {
    return (
      <AuthShell>
        <form onSubmit={submitMfa} className="auth-form">
          <div className="auth-icon"><Icon name="shield" size={36} /></div>
          <h1>Two-factor authentication</h1>
          <p className="muted center">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
          <Field label="Code" error={errors.code} required>
            <input className="input" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </Field>
          <Button type="submit" loading={loading} className="full">Log In</Button>
          <button type="button" className="link-btn" onClick={() => setMfa(null)}>Go back to login</button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="auth-form">
        <h1>{t('welcomeBack')}</h1>
        <p className="muted center">{t('excitedToSeeYou')}</p>
        {adding && (
          <div className="notice account-adding">
            Adding another account{keptName ? <>. <b>{keptName.displayName || keptName.username}</b> stays signed in on this device</> : null}.{' '}
            <button type="button" className="link-btn" onClick={cancelAdd}>Cancel</button>
          </div>
        )}
        {!adding && saved.length > 0 && (
          <div className="account-continue" role="group" aria-label="Accounts on this device">
            {saved.map((a) => (
              <button key={a.id} type="button" className="account-continue-btn" onClick={() => switchToAccount(a.id)}>
                <Avatar user={a} size={32} />
                <span className="account-continue-names"><b className="truncate">Continue as {a.displayName || a.username}</b><span className="tiny muted truncate">{a.username}</span></span>
              </button>
            ))}
          </div>
        )}
        {search.get('reset') && <div className="notice success">Your password was changed. Log in with your new password.</div>}
        <Field label={t('emailOrUsername')} error={errors.login} required>
          <input className="input" autoFocus autoComplete="username" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
        </Field>
        <Field label={t('password')} error={errors.password && errors.password !== errors.login ? errors.password : null} required>
          <input className="input" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <div className="auth-row">
          <label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
          <Link to="/forgot-password" className="link">{t('forgotPassword')}</Link>
        </div>
        <Button type="submit" loading={loading} className="full" size="lg">{t('login')}</Button>
        <p className="small muted">{t('needAccount')} <Link to={`/register${location.search}`} className="link">{t('register')}</Link></p>
        {!window.nullchatDesktop && !isStandalone() && <p className="small muted"><Link to="/install" className="link">Get the NullChat app</Link></p>}
        <DesktopServerNote />
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const t = useT();
  const [form, setForm] = useState({ email: '', displayName: '', username: '', password: '', dob: '' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [cfg, setCfg] = useState(null);
  useEffect(() => { api.get('/config').then(setCfg).catch(() => {}); }, []);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (form.password.length < 8) errs.password = 'Must be at least 8 characters.';
    if (!form.dob) errs.dateOfBirth = 'Required.';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setLoading(true); setErrors({});
    try {
      const res = await api.post('/auth/register', {
        email: form.email, username: form.username, password: form.password, displayName: form.displayName || null, dateOfBirth: form.dob,
      }, { noAuthRedirect: true });
      afterLogin(res.token, true, res.lounge, res.user);
    } catch (err) {
      setErrors(Object.keys(err.errors).length ? err.errors : { _: err.message });
    } finally { setLoading(false); }
  };

  if (cfg && !cfg.registrationOpen) {
    return <AuthShell><div className="auth-form"><h1>Registration closed</h1><p className="muted center">New sign-ups are currently disabled on this NullChat server.</p><Link to="/login" className="link center">Back to login</Link></div></AuthShell>;
  }
  const maxDob = new Date(); maxDob.setFullYear(maxDob.getFullYear() - 13);
  return (
    <AuthShell>
      <form onSubmit={submit} className="auth-form">
        <h1>{t('createAccount')}</h1>
        {errors._ && <div className="notice error">{errors._}</div>}
        <Field label={t('email')} error={errors.email} required>
          <input className="input" type="email" autoFocus autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label={t('displayName')} error={errors.displayName} hint="This is how others see you. You can use special characters and emoji.">
          <input className="input" maxLength={32} value={form.displayName} onChange={set('displayName')} />
        </Field>
        <Field label={t('username')} error={errors.username} required hint="Letters, numbers, underscores and periods only.">
          <input className="input" autoComplete="username" maxLength={32} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/\s/g, '') })} />
        </Field>
        <Field label={t('password')} error={errors.password} required>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
          <PasswordStrength value={form.password} />
        </Field>
        <Field label={t('dateOfBirth')} error={errors.dateOfBirth} required>
          <input className="input" type="date" max={maxDob.toISOString().slice(0, 10)} value={form.dob} onChange={set('dob')} />
        </Field>
        <Button type="submit" loading={loading} className="full" size="lg">{t('continue')}</Button>
        <p className="tiny muted">By registering, you agree to be excellent to each other.</p>
        <Link to={`/login${location.search}`} className="link small">{t('alreadyHaveAccount')}</Link>
        <DesktopServerNote />
      </form>
    </AuthShell>
  );
}

export function PasswordStrength({ value }) {
  if (!value) return null;
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  const labels = ['Very weak', 'Weak', 'Okay', 'Good', 'Strong', 'Very strong'];
  return (
    <div className={`pw-strength s${score}`}>
      <div className="pw-bar"><span style={{ width: `${(score / 5) * 100}%` }} /></div>
      <span>{labels[score]}</span>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [devMail, setDevMail] = useState(false);
  useEffect(() => { api.get('/config').then((c) => setDevMail(c.devMail)).catch(() => {}); }, []);
  const submit = async (e) => {
    e.preventDefault(); setLoading(true); setError(null);
    try { await api.post('/auth/forgot-password', { email }, { noAuthRedirect: true }); setSent(true); }
    catch (err) { setError(err.errors.email || err.message); }
    finally { setLoading(false); }
  };
  return (
    <AuthShell>
      <form onSubmit={submit} className="auth-form">
        <div className="auth-icon"><Icon name="lock" size={36} /></div>
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <p className="muted center">If an account exists for <b>{email}</b>, we sent a link to reset your password. It expires in 1 hour.</p>
            {devMail && <div className="notice">Development mode: no email server is configured. Open the link printed in the server terminal, or view it at <a className="link" href="/api/dev/outbox" target="_blank" rel="noreferrer">/api/dev/outbox</a>.</div>}
          </>
        ) : (
          <>
            <p className="muted center">Enter the email address you registered with and we’ll send you a reset link.</p>
            <Field label="Email" error={error} required><input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Button type="submit" loading={loading} className="full" size="lg">Send Reset Link</Button>
          </>
        )}
        <Link to="/login" className="link small">Back to login</Link>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const search = useSearch();
  const token = search.get('token') || '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== pw2) { setErrors({ password2: 'Passwords do not match.' }); return; }
    setLoading(true); setErrors({});
    try {
      await api.post('/auth/reset-password', { token, password: pw }, { noAuthRedirect: true });
      setToken(null);
      navigate('/login?reset=1', { replace: true });
    } catch (err) { setErrors(Object.keys(err.errors).length ? err.errors : { _: err.message }); }
    finally { setLoading(false); }
  };
  return (
    <AuthShell>
      <form onSubmit={submit} className="auth-form">
        <h1>Choose a new password</h1>
        {errors._ && <div className="notice error">{errors._} <Link to="/forgot-password" className="link">Request a new link</Link></div>}
        <Field label="New Password" error={errors.password} required>
          <input className="input" type="password" autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <PasswordStrength value={pw} />
        </Field>
        <Field label="Confirm New Password" error={errors.password2} required>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <Button type="submit" loading={loading} className="full" size="lg">Change Password</Button>
        <p className="tiny muted">Changing your password logs you out of every device.</p>
      </form>
    </AuthShell>
  );
}

export function InvitePage({ code, source }) {
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  const [paused, setPaused] = useState(null);   // the server is not taking new members right now: { message }
  const loggedIn = !!getToken();
  const here = `/invite/${code}${source ? `/${source}` : ''}`;   // (this page again, with its "joined from" label, for after logging in)
  useEffect(() => {
    api.get(`/invites/${encodeURIComponent(code)}`, { noAuthRedirect: true }).then((x) => { setInv(x); if (x.paused) setPaused({ message: 'This server isn’t taking new members right now. Try again later, or ask someone in it.' }); }).catch((e) => setError(e.message));
  }, [code]);
  const accept = async () => {
    if (!loggedIn) { navigate(`/login?redirect=${encodeURIComponent(here)}`); return; }
    setJoining(true);
    try {
      const res = await api.post(`/invites/${encodeURIComponent(code)}`, source ? { source } : undefined);
      navigate(`/channels/${res.guildId}${res.channelId ? `/${res.channelId}` : ''}`, { replace: true });
    } catch (e) {
      setJoining(false);
      if (e.code === 'invites_paused') setPaused({ message: e.message });   // (it was paused after the page loaded: keep the invite on screen and say why)
      else setError(e.message);
    }
  };
  return (
    <AuthShell>
      <div className="auth-form invite-card">
        {!inv && !error && <Spinner size={40} />}
        {error && <><div className="auth-icon bad"><Icon name="link" size={32} /></div><h1>Invite Invalid</h1><p className="muted center">{error}</p>
          <Button className="full" onClick={() => navigate(loggedIn ? '/channels/@me' : '/login')}>Continue to NullChat</Button></>}
        {inv && !error && (
          <>
            <GuildIcon guild={inv.guild} size={72} />
            <p className="muted small">{inv.inviter ? <><b>{inv.inviter.displayName || inv.inviter.username}</b> invited you to join</> : 'You’ve been invited to join'}</p>
            <h1>{inv.guild.name}</h1>
            {inv.guild.description && <p className="muted center small">{inv.guild.description}</p>}
            <div className="invite-counts">
              <span><i className="dot online" /> {inv.onlineCount} Online</span>
              <span><i className="dot" /> {inv.memberCount} Members</span>
            </div>
            {paused && <div className="notice warn invite-paused" role="status">{paused.message}</div>}
            <Button className="full" size="lg" loading={joining} disabled={!!paused} onClick={accept}>{loggedIn ? 'Accept Invite' : 'Log in to Accept'}</Button>
            {!loggedIn && <Link className="link small" to={`/register?redirect=${encodeURIComponent(here)}`}>Need an account? Register</Link>}
            {!window.nullchatDesktop && !inNativeApp() && <a className="link small" href={`nullchat://invite/${encodeURIComponent(code)}${source ? `/${encodeURIComponent(source)}` : ''}`}>Open in the NullChat app</a>}
          </>
        )}
      </div>
    </AuthShell>
  );
}
