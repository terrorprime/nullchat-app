// Mod Panel (and, for a Dev Jr, the Dev Jr Panel): for site staff below the site admin (see server/src/lib/admin.js and routes/mod.js).
// A mod handles every report on this NullChat (direct messages, things a server's owner wrote, messages in any server) and suspends or restores ordinary
// accounts. A mod never sees an email or an address, and can't touch an admin, a Dev Jr or another mod. A Dev Jr gets the same panel plus emails, one-time
// password reset links and the site's numbers, and also acts on mods. The admin hands both roles out in Admin Panel → Users.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, relativeTime, formatBytes, copyText } from '../lib/utils.js';
import { Avatar, Button, EmptyState, Field, Modal, Spinner, Tabs, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';
import { store, useStore } from '../lib/state.js';
import { SiteReports } from './Reports.jsx';
import { AppealsTab } from './Appeals.jsx';
import { useDebounced } from './AdminPanel.jsx';

const ACTION_LABELS = {
  suspend_user: 'Suspended',
  restore_user: 'Restored',
  report_resolve: 'Resolved a report about',
  report_dismiss: 'Dismissed a report about',
  report_reopen: 'Reopened a report about',
  appeal_approve: 'Approved an appeal from',
  appeal_deny: 'Turned down an appeal from',
  reset_link: 'Made a password reset link for',
};

export function ModPanel() {
  // (arriving from a "new report" notice opens straight on the Reports tab)
  const [tab, setTab] = useState(() => { const t = store.get().modTab; if (t) store.set({ modTab: null }); return t || 'overview'; });
  const waiting = useStore((s) => s.reportCounts?.site || 0);
  const appeals = useStore((s) => s.reportCounts?.appeals || 0);
  const isDevJr = useStore((s) => !!s.me?.isDevJr);
  const [rev, setRev] = useState(0);   // bumped after every change so the visible list reloads
  const bump = () => setRev((n) => n + 1);
  return (
    <>
      <h2>{isDevJr ? 'Dev Jr Panel' : 'Mod Panel'} <span className="pill mod-pill admin-pill">{isDevJr ? 'Dev Jr' : 'Moderator'}</span></h2>
      <p className="muted small admin-intro">
        {isDevJr ? (
          <>
            You handle reports, suspend or restore mods and ordinary accounts, see their emails, and make one-time password reset links for people who are locked out.
            You can’t read messages (except a message that was reported to you), and you can’t act on admins or other Dev Jrs. Everything you do is written to the log,
            and admins can read it.
          </>
        ) : (
          <>
            You handle reports and suspend or restore ordinary accounts. You can’t see anyone’s email or messages (except a message that was reported to you),
            and you can’t act on admins or other mods. Everything you do is written to the log, and admins can read it.
          </>
        )}
      </p>
      <Tabs
        className="admin-tabs" value={tab} onChange={setTab}
        tabs={[{ value: 'overview', label: 'Overview' }, { value: 'reports', label: 'Reports', badge: waiting }, { value: 'appeals', label: 'Appeals', badge: appeals }, { value: 'users', label: 'Users' }, { value: 'log', label: 'Activity' }]}
      />
      {tab === 'overview' && <Overview rev={rev} goReports={() => setTab('reports')} goAppeals={() => setTab('appeals')} />}
      {tab === 'reports' && <SiteReports openAccount={(id) => openModUser(id, bump)} />}
      {tab === 'appeals' && <AppealsTab openAccount={(id) => openModUser(id, bump)} onChange={bump} />}
      {tab === 'users' && <UsersTab rev={rev} bump={bump} />}
      {tab === 'log' && <LogTab rev={rev} />}
    </>
  );
}

// ================================================================ Overview
function Stat({ label, value, tone, onClick }) {
  const body = (<><div className="admin-stat-value">{value}</div><div className="admin-stat-label">{label}</div></>);
  return onClick
    ? <button type="button" className={cx('admin-stat', 'admin-stat-btn', tone)} onClick={onClick}>{body}</button>
    : <div className={cx('admin-stat', tone)}>{body}</div>;
}

function Overview({ rev, goReports, goAppeals }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/mod/overview').then((x) => alive && setD(x)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [rev]);
  if (err) return <div className="notice error">{err}</div>;
  if (!d) return <div className="admin-loading"><Spinner /></div>;
  const n = (x) => x.toLocaleString();
  return (
    <div className="admin-stats">
      <Stat label={d.openReports === 1 ? 'Report waiting' : 'Reports waiting'} value={n(d.openReports)} tone={d.openReports ? 'red' : 'green'} onClick={goReports} />
      <Stat label={d.openAppeals === 1 ? 'Appeal waiting' : 'Appeals waiting'} value={n(d.openAppeals || 0)} tone={d.openAppeals ? 'red' : 'green'} onClick={goAppeals} />
      <Stat label="Suspended accounts" value={n(d.suspended)} />
      <Stat label="Accounts" value={n(d.users)} />
      <Stat label="Joined in the last 24h" value={n(d.newToday)} />
      <Stat label="Online right now" value={n(d.online)} tone="green" />
      {d.messages != null && <Stat label="Messages" value={n(d.messages)} />}
      {d.guilds != null && <Stat label="Servers" value={n(d.guilds)} />}
      {d.channels != null && <Stat label="Channels" value={n(d.channels)} />}
      {d.uploadBytes != null && <Stat label="Uploads on disk" value={formatBytes(d.uploadBytes)} />}
      {d.dbBytes != null && <Stat label="Database size" value={formatBytes(d.dbBytes)} />}
      {d.runtime && <Stat label="Node version" value={d.runtime.node} />}
    </div>
  );
}

// ================================================================ Users
function UsersTab({ rev, bump }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState(null);
  const dq = useDebounced(q);
  const isDevJr = useStore((s) => !!s.me?.isDevJr);

  const load = async (offset) => {
    const params = new URLSearchParams({ q: dq, limit: '50', offset: String(offset) });
    if (filter !== 'all') params.set('filter', filter);
    const res = await api.get(`/mod/users?${params}`);
    setTotal(res.total);
    setRows((cur) => (offset ? [...cur, ...res.users] : res.users));
  };
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    load(0).catch((e) => alive && setErr(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, filter, rev]);

  const loadMore = async () => {
    setMore(true);
    try { await load(rows.length); } catch (e) { toastError(e); } finally { setMore(false); }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <div className="input-with-icon admin-search">
          <Icon name="search" size={16} />
          <input className="input" value={q} placeholder={isDevJr ? 'Search name, username or email' : 'Search name or username'} aria-label="Search users" onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input select admin-filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter users">
          <option value="all">All accounts</option>
          <option value="reported">Reported (open reports)</option>
          <option value="banned">Suspended only</option>
        </select>
      </div>
      {err && <div className="notice error">{err}</div>}
      {loading ? <div className="admin-loading"><Spinner /></div> : (
        <>
          <div className="tiny muted admin-count">{total.toLocaleString()} {total === 1 ? 'account' : 'accounts'}</div>
          {rows.length === 0 ? <EmptyState icon="search" title="Nobody found">{filter === 'reported' ? 'No account has an open report right now.' : 'Try a different search.'}</EmptyState> : (
            <ul className="admin-list">
              {rows.map((u) => (
                <li key={u.id}>
                  <button type="button" className="admin-row" onClick={() => openModUser(u.id, bump)}>
                    <Avatar user={{ ...u, avatarDecoration: null }} size={40} />
                    <span className="admin-row-main">
                      <span className="admin-row-title">
                        <b>{u.displayName || u.username}</b>
                        {u.isAdmin && <span className="pill green">Admin</span>}
                        {u.isDevJr && <span className="pill mod-pill">Dev Jr</span>}
                        {u.isMod && <span className="pill mod-pill">Mod</span>}
                        {u.banned && <span className="pill admin-pill-red">Suspended</span>}
                        {u.online && !u.banned && <span className="admin-online" title="Online now" />}
                      </span>
                      <span className="admin-row-sub">@{u.username}{u.email ? ` · ${u.email}` : ''}</span>
                    </span>
                    <span className="admin-row-meta tiny muted">
                      <span>Joined {formatDate(u.createdAt)}</span>
                      <span>{u.lastActive ? `Active ${relativeTime(u.lastActive)}` : 'Never signed in'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rows.length < total && <div className="admin-more"><Button variant="secondary" loading={more} onClick={loadMore}>Show more</Button></div>}
        </>
      )}
    </div>
  );
}

/** Open one account (also used by "View account" on a report). */
export function openModUser(id, onChanged) {
  openModal(({ close }) => <ModUserModal id={id} close={close} onChanged={onChanged} />);
}

function ModUserModal({ id, close, onChanged }) {
  const [u, setU] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [resetting, setResetting] = useState(false); // the "reset password" box is open
  const [link, setLink] = useState(null);             // { url, expiresAt } once a reset link has been made

  const load = () => api.get(`/mod/users/${id}`).then(setU).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const suspend = async () => {
    if (reason.trim().length < 3) return;
    setBusy(true);
    try {
      await api.post(`/mod/users/${id}/ban`, { reason: reason.trim() });
      toast(`${u.username} is suspended and logged out everywhere.`, 'success');
      setSuspending(false); setReason('');
      await load(); onChanged?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true);
    try {
      await api.post(`/mod/users/${id}/unban`);
      toast(`${u.username} can log in again.`, 'success');
      await load(); onChanged?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const makeLink = async () => {
    setBusy(true);
    try { setLink(await api.post(`/mod/users/${id}/reset-link`, {})); onChanged?.(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const copyLink = async () => { await copyText(link.url); toast('Link copied. Send it to them privately.', 'success'); };

  const me = store.get().me;
  return (
    <Modal title={u ? (u.displayName || u.username) : 'Account'} subtitle={u ? `@${u.username}` : undefined} onClose={close} size="md" className="admin-modal">
      {err && <div className="notice error">{err}</div>}
      {!u && !err && <div className="admin-loading"><Spinner /></div>}
      {u && (
        <>
          <div className="admin-user-head">
            <Avatar user={{ ...u, avatarDecoration: null }} size={64} />
            <div className="admin-user-pills">
              {u.isAdmin && <span className="pill green">Site admin</span>}
              {u.isDevJr && <span className="pill mod-pill">Dev Jr</span>}
              {u.isMod && <span className="pill mod-pill">Mod</span>}
              {u.banned && <span className="pill admin-pill-red">Suspended</span>}
              {u.online && <span className="pill green">Online</span>}
            </div>
          </div>
          {u.banned && (
            <div className="notice error">
              Suspended {u.bannedAt ? relativeTime(u.bannedAt) : ''}{u.bannedReason ? <> — “{u.bannedReason}”</> : null}. They can’t log in until someone restores them.
            </div>
          )}
          <dl className="admin-facts">
            {u.email != null && <div><dt>Email</dt><dd className="mono tiny">{u.email}</dd></div>}
            <div><dt>Joined</dt><dd>{formatDate(u.createdAt)}</dd></div>
            <div><dt>Last active</dt><dd>{u.lastActive ? relativeTime(u.lastActive) : 'Never signed in'}</dd></div>
            <div><dt>Messages sent</dt><dd>{u.messages.toLocaleString()}</dd></div>
            <div><dt>In servers</dt><dd>{u.servers.toLocaleString()}</dd></div>
            {u.reports && <div><dt>Reports about them</dt><dd>{u.reports.open ? <b>{u.reports.open} open</b> : 'None open'} · {u.reports.total} in all</dd></div>}
            <div><dt>Account ID</dt><dd className="mono tiny">{u.id}</dd></div>
          </dl>

          {!u.canAct ? (
            <div className="notice warn admin-locked">
              {u.id === me?.id ? 'This is your own account.' : u.isAdmin ? 'This account is a site admin, so you can’t act on it.' : u.isDevJr ? 'This account is a Dev Jr, so only an admin can act on it.' : 'This account is a moderator, so only an admin can act on it.'}
            </div>
          ) : (
            <div className="admin-actions">
              {resetting ? (
                <div className="admin-suspend-box admin-reset-box">
                  {!link ? (
                    <>
                      <p className="small admin-reset-text">
                        This makes a one-time link that lets <b>@{u.username}</b> choose a new password. Send it to them yourself (a private message, for example). Anyone who has the
                        link can take over the account until it expires after one hour, and using it signs them out everywhere. It’s recorded in the log with your name.
                      </p>
                      <div className="row gap">
                        <Button variant="link" onClick={() => setResetting(false)}>Cancel</Button>
                        <Button variant="primary" loading={busy} onClick={makeLink}>Make reset link</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label={`Reset link for @${u.username}`}>
                        <input className="input mono" readOnly value={link.url} aria-label="Password reset link" onFocus={(e) => e.target.select()} />
                      </Field>
                      <p className="tiny muted admin-reset-text">Works once and expires {relativeTime(link.expiresAt)}. If they use two-factor sign-in, they will still need their code.</p>
                      <div className="row gap">
                        <Button variant="link" onClick={() => { setResetting(false); setLink(null); }}>Done</Button>
                        <Button variant="primary" onClick={copyLink}><Icon name="copy" size={16} /> Copy link</Button>
                      </div>
                    </>
                  )}
                </div>
              ) : suspending ? (
                <div className="admin-suspend-box">
                  <Field label="Why? (they will see this when they try to log in, and admins can read it in the log)">
                    <input className="input" autoFocus maxLength={200} value={reason} placeholder="For example: sending spam in direct messages" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') suspend(); }} />
                  </Field>
                  <div className="row gap">
                    <Button variant="link" onClick={() => setSuspending(false)}>Cancel</Button>
                    <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={suspend}>Suspend account</Button>
                  </div>
                </div>
              ) : u.banned
                ? <Button variant="secondary" loading={busy} onClick={restore}>Restore account</Button>
                : <Button variant="secondary" onClick={() => setSuspending(true)}><Icon name="ban" size={16} /> Suspend…</Button>}
              {u.canReset && !suspending && !resetting && (
                <Button variant="secondary" onClick={() => { setLink(null); setResetting(true); }}><Icon name="lock" size={16} /> Reset password…</Button>
              )}
            </div>
          )}
          {u.canAct && !suspending && !resetting && (
            <p className="tiny muted admin-hint">
              <b>Suspend</b> logs them out everywhere and blocks login until they are restored. Their messages stay.
              {u.canReset && <> <b>Reset password</b> gives you a link to send them if they’re locked out.</>} It’s recorded in the log with your name.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

// ================================================================ Activity
function LogTab({ rev }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/mod/log?limit=200').then((r) => alive && setRows(r.entries)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [rev]);
  if (err) return <div className="notice error">{err}</div>;
  if (!rows) return <div className="admin-loading"><Spinner /></div>;
  if (!rows.length) return <EmptyState icon="shield" title="Nothing yet">Suspensions, restores and handled reports by mods will show up here.</EmptyState>;
  return (
    <ul className="admin-log">
      {rows.map((e) => (
        <li key={e.id} className={cx('admin-log-row', e.action)}>
          <span className="admin-log-what"><b>{ACTION_LABELS[e.action] || e.action}</b> {e.target}</span>
          <span className="admin-log-detail muted small">{e.detail || ''}</span>
          <span className="admin-log-when tiny muted">{e.by}{e.role === 'devjr' ? ' (Dev Jr)' : ''} · {relativeTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
