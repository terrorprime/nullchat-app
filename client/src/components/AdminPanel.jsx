// Site admin panel: see every account and server on this installation, suspend or remove people.
// Only shown to site admins (see server/src/lib/admin.js). Message contents are never shown here, except a message that
// someone reported (Reports tab): direct messages and things a server's owner wrote have no one else to judge them.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, relativeTime, formatBytes, copyText } from '../lib/utils.js';
import { Avatar, Button, EmptyState, Field, GuildIcon, Modal, Spinner, Switch, Tabs, confirmDialog, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';
import { navigate } from '../lib/router.jsx';
import { closeSettings } from '../lib/ui.js';
import { store, useStore } from '../lib/state.js';
import { SiteReports } from './Reports.jsx';
import { AppealsTab } from './Appeals.jsx';
import { ServerTag } from './ServerTag.jsx';

const ACTION_LABELS = {
  suspend_user: 'Suspended',
  restore_user: 'Restored',
  mod_add: 'Made a mod',
  mod_remove: 'Removed a mod',
  devjr_add: 'Made a Dev Jr',
  devjr_remove: 'Removed a Dev Jr',
  reset_link: 'Made a password reset link',
  delete_user: 'Deleted account',
  delete_server: 'Deleted server',
  hide_app: 'Hid an app from the directory',
  show_app: 'Showed an app in the directory',
  delete_app: 'Deleted app',
  backup_create: 'Made a backup',
  backup_download: 'Downloaded a backup',
  announcement_set: 'Posted an announcement',
  announcement_clear: 'Removed the announcement',
  registration_set: 'Changed sign-ups',
  lounge_set: 'Changed the lounge',
  lounge_create: 'Created the lounge',
  report_resolve: 'Resolved a report about',
  report_dismiss: 'Dismissed a report about',
  report_reopen: 'Reopened a report about',
  appeal_approve: 'Approved an appeal from',
  appeal_deny: 'Turned down an appeal from',
};

/** Runs `fn` after the person stops typing for a moment. */
export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export function AdminPanel() {
  // (arriving from a "new report" notice opens straight on the Reports tab)
  const [tab, setTab] = useState(() => { const t = store.get().adminTab; if (t) store.set({ adminTab: null }); return t || 'overview'; });
  const waiting = useStore((s) => s.reportCounts?.site || 0);
  const appeals = useStore((s) => s.reportCounts?.appeals || 0);
  // Bumped after every change so the visible list reloads.
  const [rev, setRev] = useState(0);
  const bump = () => setRev((n) => n + 1);
  return (
    <>
      <h2>Admin Panel <span className="pill green admin-pill">Site admin</span></h2>
      <p className="muted small admin-intro">
        You can see every account and server on this NullChat. You can’t read anyone’s messages from here, except a message someone reports to you.
        Everything you do is written to the Activity log.
      </p>
      <Tabs
        className="admin-tabs" value={tab} onChange={setTab}
        tabs={[{ value: 'overview', label: 'Overview' }, { value: 'users', label: 'Users' }, { value: 'servers', label: 'Servers' }, { value: 'apps', label: 'Apps' }, { value: 'reports', label: 'Reports', badge: waiting }, { value: 'appeals', label: 'Appeals', badge: appeals }, { value: 'site', label: 'Site' }, { value: 'backups', label: 'Backups' }, { value: 'log', label: 'Activity' }]}
      />
      {tab === 'overview' && <Overview rev={rev} />}
      {tab === 'users' && <UsersTab rev={rev} bump={bump} />}
      {tab === 'servers' && <ServersTab rev={rev} bump={bump} />}
      {tab === 'apps' && <AppsTab rev={rev} bump={bump} openAccount={(id) => openUser(id, bump)} />}
      {tab === 'reports' && <SiteReports openAccount={(id) => openUser(id, bump)} />}
      {tab === 'appeals' && <AppealsTab openAccount={(id) => openUser(id, bump)} onChange={bump} />}
      {tab === 'site' && <SiteTab />}
      {tab === 'backups' && <BackupsTab rev={rev} bump={bump} />}
      {tab === 'log' && <LogTab rev={rev} />}
    </>
  );
}

// ================================================================ Overview
function Stat({ label, value, tone }) {
  return (
    <div className={cx('admin-stat', tone)}>
      <div className="admin-stat-value">{value}</div>
      <div className="admin-stat-label">{label}</div>
    </div>
  );
}

function Overview({ rev }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/admin/overview').then((x) => alive && setD(x)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [rev]);
  if (err) return <div className="notice error">{err}</div>;
  if (!d) return <div className="admin-loading"><Spinner /></div>;
  const n = (x) => x.toLocaleString();
  return (
    <>
    <div className="admin-stats">
      <Stat label="Accounts" value={n(d.users)} />
      <Stat label="Joined in the last 24h" value={n(d.newToday)} />
      <Stat label="Online right now" value={n(d.online)} tone="green" />
      {d.openAppeals > 0 && <Stat label={d.openAppeals === 1 ? 'Appeal waiting' : 'Appeals waiting'} value={n(d.openAppeals)} tone="red" />}
      <Stat label="Suspended" value={n(d.banned)} tone={d.banned ? 'red' : undefined} />
      <Stat label="Moderators" value={n(d.mods || 0)} />
      <Stat label="Dev Jr" value={n(d.devjrs || 0)} />
      <Stat label="Servers" value={n(d.guilds)} />
      <Stat label="Channels" value={n(d.channels)} />
      <Stat label="Messages" value={n(d.messages)} />
      <Stat label="Uploaded files" value={formatBytes(d.uploadBytes)} />
      <Stat label="Database size" value={formatBytes(d.dbBytes)} />
    </div>
    {d.runtime && <p className="muted small admin-runtime">Running on Node {d.runtime.node} · {d.runtime.dbDriver}{d.runtime.sqlite ? `, SQLite ${d.runtime.sqlite}` : ''}</p>}
    {d.bigCalls && <p className="muted small admin-bigcalls">{d.bigCalls.enabled ? `Voice channels use your LiveKit server (${d.bigCalls.host}), so big calls and screen shares work.` : 'Voice channels connect people directly (best up to about 8 people). To support bigger calls, connect a LiveKit server: see docs/BIG_CALLS.md.'}</p>}
    {d.phoneApps && <p className="muted small admin-phoneapps">{d.phoneApps.android || d.phoneApps.ios
      ? `Phone app notifications: ${[d.phoneApps.android && `Android on (${d.phoneApps.androidDevices} ${d.phoneApps.androidDevices === 1 ? 'phone' : 'phones'})`, d.phoneApps.ios && `iPhone on (${d.phoneApps.iosDevices} ${d.phoneApps.iosDevices === 1 ? 'phone' : 'phones'})`].filter(Boolean).join(', ')}.`
      : 'Phone app notifications are off. If you build the phone apps, see docs/PHONE_APPS.md to turn them on.'}</p>}
    </>
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

  const load = async (offset) => {
    const params = new URLSearchParams({ q: dq, limit: '50', offset: String(offset) });
    if (filter !== 'all') params.set('filter', filter);
    const res = await api.get(`/admin/users?${params}`);
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
          <input className="input" value={q} placeholder="Search name, username or email" aria-label="Search users" onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input select admin-filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter users">
          <option value="all">All accounts</option>
          <option value="banned">Suspended only</option>
          <option value="mods">Mods only</option>
          <option value="devjr">Dev Jr only</option>
        </select>
      </div>
      {err && <div className="notice error">{err}</div>}
      {loading ? <div className="admin-loading"><Spinner /></div> : (
        <>
          <div className="tiny muted admin-count">{total.toLocaleString()} {total === 1 ? 'account' : 'accounts'}</div>
          {rows.length === 0 ? <EmptyState icon="search" title="Nobody found">Try a different search.</EmptyState> : (
            <ul className="admin-list">
              {rows.map((u) => (
                <li key={u.id}>
                  <button type="button" className="admin-row" onClick={() => openUser(u.id, bump)}>
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
                      <span className="admin-row-sub">@{u.username} · {u.email}</span>
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

function openUser(id, onChanged) {
  openModal(({ close }) => <UserModal id={id} close={close} onChanged={onChanged} />);
}

function UserModal({ id, close, onChanged }) {
  const [u, setU] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [resetting, setResetting] = useState(false); // the "reset password" box is open
  const [link, setLink] = useState(null);             // { url, expiresAt } once a reset link has been made

  const load = () => api.get(`/admin/users/${id}`).then(setU).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const suspend = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/users/${id}/ban`, reason.trim() ? { reason: reason.trim() } : {});
      toast(`${u.username} is suspended and logged out everywhere.`, 'success');
      setSuspending(false); setReason('');
      await load(); onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/users/${id}/unban`);
      toast(`${u.username} can log in again.`, 'success');
      await load(); onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const makeLink = async () => {
    setBusy(true);
    try { setLink(await api.post(`/admin/users/${id}/reset-link`, {})); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const copyLink = async () => { await copyText(link.url); toast('Link copied. Send it to them privately.', 'success'); };
  // Make someone a Dev Jr (a level between mod and admin), or take it back. Asks first, and says plainly what a Dev Jr can and cannot do.
  const toggleDevJr = async () => {
    const making = !u.isDevJr;
    const ok = await confirmDialog({
      title: making ? `Make @${u.username} a Dev Jr?` : `Remove @${u.username} as a Dev Jr?`,
      body: making
        ? <>They get a <b>Dev Jr Panel</b> in their settings. A Dev Jr can do everything a mod can, and also <b>see people’s email addresses</b>, find people by email, <b>make password reset links</b> (which lets them take over an ordinary account, so only give this to someone you trust) and read the site’s numbers. A Dev Jr can’t touch admins or other Dev Jrs, can’t delete accounts or servers, make backups or change site settings, and can’t see anyone’s messages (except a message that was reported). Everything they do is written to the log.{u.isMod && <> They are a mod now; this replaces that.</>}</>
        : <>They lose the Dev Jr Panel and everything that comes with it, right away. They become a normal member (not a mod).</>,
      confirmText: making ? 'Make Dev Jr' : 'Remove Dev Jr',
      danger: !making,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.put(`/admin/users/${id}/devjr`, { devjr: making });
      toast(making ? `@${u.username} is now a Dev Jr.` : `@${u.username} is no longer a Dev Jr.`, 'success');
      await load(); onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  // Make someone a mod, or take it back. Asks first, and says plainly what a mod can and cannot do.
  const toggleMod = async () => {
    const making = !u.isMod;
    const ok = await confirmDialog({
      title: making ? `Make @${u.username} a mod?` : `Remove @${u.username} as a mod?`,
      body: making
        ? <>They get a <b>Mod Panel</b> in their settings. A mod can handle all reports on this NullChat (messages reported in servers and in direct messages, but only the reported message), and suspend or restore ordinary accounts. A mod can’t see emails, reset passwords, delete accounts or servers, change site settings, or act on admins and other mods. Everything they do is written to the Activity log. You can take it back whenever you like.</>
        : <>They lose the Mod Panel and everything that comes with it, right away. They stay a normal member.</>,
      confirmText: making ? 'Make mod' : 'Remove mod',
      danger: !making,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.put(`/admin/users/${id}/mod`, { mod: making });
      toast(making ? `@${u.username} is now a mod.` : `@${u.username} is no longer a mod.`, 'success');
      await load(); onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const del = () => openModal(({ close: closeDel }) => (
    <DeleteUserModal user={u} close={closeDel} onDone={() => { closeDel(); close(); onChanged(); }} />
  ));

  const locked = u && (u.isAdmin);
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
              Suspended {u.bannedAt ? relativeTime(u.bannedAt) : ''}{u.bannedReason ? <> — “{u.bannedReason}”</> : null}. They can’t log in until you restore them.
            </div>
          )}
          <dl className="admin-facts">
            <div><dt>Email</dt><dd>{u.email}</dd></div>
            <div><dt>Joined</dt><dd>{formatDate(u.createdAt)}</dd></div>
            <div><dt>Last active</dt><dd>{u.lastActive ? relativeTime(u.lastActive) : 'Never signed in'}</dd></div>
            <div><dt>Messages sent</dt><dd>{u.messages.toLocaleString()}</dd></div>
            <div><dt>Account ID</dt><dd className="mono tiny">{u.id}</dd></div>
          </dl>

          <h4 className="admin-h">Servers ({u.servers.length})</h4>
          {u.servers.length === 0 ? <p className="muted small">Not in any servers.</p> : (
            <ul className="admin-chips">
              {u.servers.map((s) => <li key={s.id} className="admin-chip">{s.owner && <Icon name="crown" size={13} />}{s.name}</li>)}
            </ul>
          )}

          <h4 className="admin-h">Recent sign-ins</h4>
          {u.sessions.length === 0 ? <p className="muted small">No active sessions.</p> : (
            <ul className="admin-sessions">
              {u.sessions.map((s, i) => (
                <li key={i}><span>{s.ip || 'unknown IP'}</span><span className="muted tiny">{shortAgent(s.userAgent)} · {relativeTime(s.lastUsed)}</span></li>
              ))}
            </ul>
          )}

          {locked ? (
            <div className="notice warn admin-locked">This account is a site admin, so it can’t be suspended or deleted from here. To change that, remove them from the <code>ADMIN_USERS</code> setting.</div>
          ) : (
            <div className="admin-actions">
              {resetting ? (
                <div className="admin-suspend-box admin-reset-box">
                  {!link ? (
                    <>
                      <p className="small admin-reset-text">
                        This makes a one-time link that lets <b>@{u.username}</b> choose a new password. Send it to them yourself (a private message, for example). Anyone who has the link can take over the account until it expires after one hour, and using it signs them out everywhere. Making a new link cancels the old one.
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
                  <Field label="Reason (they will see this when they try to log in)">
                    <input className="input" autoFocus maxLength={200} value={reason} placeholder="Optional" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') suspend(); }} />
                  </Field>
                  <div className="row gap">
                    <Button variant="link" onClick={() => setSuspending(false)}>Cancel</Button>
                    <Button variant="danger" loading={busy} onClick={suspend}>Suspend account</Button>
                  </div>
                </div>
              ) : (
                <>
                  {!u.isDevJr && (u.isMod || !u.banned) && <Button variant="secondary" loading={busy} onClick={toggleMod}><Icon name="shield" size={16} /> {u.isMod ? 'Remove mod' : 'Make mod'}</Button>}
                  {(u.isDevJr || !u.banned) && <Button variant="secondary" loading={busy} onClick={toggleDevJr}><Icon name="shield" size={16} /> {u.isDevJr ? 'Remove Dev Jr' : 'Make Dev Jr'}</Button>}
                  {u.banned
                    ? <Button variant="secondary" loading={busy} onClick={restore}>Restore account</Button>
                    : <Button variant="secondary" onClick={() => setSuspending(true)}><Icon name="ban" size={16} /> Suspend</Button>}
                  <Button variant="secondary" onClick={() => { setLink(null); setResetting(true); }}><Icon name="lock" size={16} /> Reset password…</Button>
                  <Button variant="danger" onClick={del}><Icon name="trash" size={16} /> Delete account…</Button>
                </>
              )}
            </div>
          )}
          {!locked && !suspending && !resetting && (
            <p className="tiny muted admin-hint">
              <b>Make mod</b> gives them the Mod Panel (reports and suspensions, below you). <b>Make Dev Jr</b> is a step up: the same panel plus emails and password reset links. <b>Reset password</b> gives you a link to send them if they’re locked out. <b>Suspend</b> logs them out and blocks login, and you can undo it. <b>Delete</b> is permanent; their old messages stay and show as “Deleted User”.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function shortAgent(ua) {
  if (!ua) return 'unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function DeleteUserModal({ user, close, onDone }) {
  const owned = user.servers.filter((s) => s.owner);
  const [name, setName] = useState('');
  const [alsoServers, setAlsoServers] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ready = name.trim() === user.username && (!owned.length || alsoServers);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await api.del(`/admin/users/${user.id}`, { confirmUsername: name.trim(), deleteServers: owned.length ? alsoServers : undefined });
      toast(`${user.username} was deleted.`, 'success');
      onDone();
    } catch (e) { setErr(e.errors?.confirmUsername || e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      title="Delete this account?" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" disabled={!ready} loading={busy} onClick={go}>Delete forever</Button></>}
    >
      <div className="notice error">
        This permanently deletes <b>@{user.username}</b> ({user.email}). It can’t be undone. Their messages stay and show as “Deleted User”.
      </div>
      {owned.length > 0 && (
        <label className="admin-check">
          <input type="checkbox" checked={alsoServers} onChange={(e) => setAlsoServers(e.target.checked)} />
          <span>
            Also delete the {owned.length === 1 ? 'server' : `${owned.length} servers`} they own: <b>{owned.map((s) => s.name).join(', ')}</b>.
            {' '}Every channel, message and member in {owned.length === 1 ? 'it' : 'them'} is lost.
          </span>
        </label>
      )}
      <Field label={`Type ${user.username} to confirm`} error={err}>
        <input className="input" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ready) go(); }} />
      </Field>
    </Modal>
  );
}

// ================================================================ Site (announcement + sign-ups)
const LEVELS = [{ value: 'info', label: 'Notice' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Urgent' }];

function SiteTab() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState('');
  const [level, setLevel] = useState('info');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get('/admin/site').then((x) => { if (!alive) return; setD(x); if (x.announcement) { setText(x.announcement.text); setLevel(x.announcement.level); } }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);
  if (err) return <div className="notice error">{err}</div>;
  if (!d) return <div className="admin-loading"><Spinner /></div>;
  const post = async () => {
    setBusy(true);
    try { setD(await api.put('/admin/site/announcement', { text, level })); toast('Announcement is live for everyone.', 'success'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { setD(await api.del('/admin/site/announcement')); setText(''); toast('Announcement removed.', 'success'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const setSignups = async (open) => {
    try { setD(await api.put('/admin/site/registration', { open })); toast(open === null ? 'Sign-ups follow the server setting again.' : open ? 'Sign-ups are open.' : 'Sign-ups are closed.', 'success'); } catch (e) { toastError(e); }
  };
  const setLounge = async (autoJoin) => {
    try { setD(await api.put('/admin/site/lounge', { autoJoin })); toast(autoJoin ? 'New accounts will be added to the lounge.' : 'New accounts will no longer be added to the lounge.', 'success'); } catch (e) { toastError(e); }
  };
  const makeLounge = async () => {
    setBusy(true);
    try { setD(await api.post('/admin/site/lounge/create', {})); toast('The lounge is ready.', 'success'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const openLounge = () => { if (!closeSettings()) return; navigate(`/channels/${lounge.guild.id}${lounge.guild.channelId ? `/${lounge.guild.channelId}` : ''}`); };
  const reg = d.registration;
  const live = d.announcement;
  const lounge = d.lounge;
  return (
    <div className="admin-site">
      <section className="admin-card">
        <h3>New accounts</h3>
        <div className="row-between">
          <div>
            <div><b>{reg.open ? 'Anyone can sign up' : 'Sign-ups are closed'}</b></div>
            <div className="muted small">
              {reg.open ? 'Close them to stop new accounts. People who already have one are not affected, and invite links to servers still work for them.' : 'The Create account page tells visitors that sign-ups are off. Existing accounts keep working.'}
            </div>
          </div>
          <Switch checked={reg.open} onChange={setSignups} label="Allow new sign-ups" />
        </div>
        {reg.source === 'admin' && (
          <p className="tiny muted mt">
            Set here. The server&rsquo;s own setting (REGISTRATION_OPEN) is <b>{reg.configDefault ? 'open' : 'closed'}</b>.{' '}
            <button type="button" className="link-btn" onClick={() => setSignups(null)}>Use the server setting</button>
          </p>
        )}
      </section>
      <section className="admin-card admin-lounge">
        <h3>Lounge server</h3>
        <p className="muted small">A server called <b>Nullspace</b> that every new account is added to, so people have somewhere to meet each other. It has a read-only #welcome, #introductions, #general, #off-topic and a voice room. Accounts that already exist are not added; invite them like to any server.</p>
        <div className="row-between">
          <div>
            <div><b>Add new accounts to the lounge</b></div>
            <div className="muted small">{lounge.autoJoin ? 'On: new accounts open straight into its #general.' : 'Off: new accounts start with no servers.'}</div>
          </div>
          <Switch checked={lounge.autoJoin} onChange={setLounge} label="Add new accounts to the lounge" />
        </div>
        <div className="row gap mt lounge-status">
          {lounge.guild ? (
            <>
              <span className="grow"><b>{lounge.guild.name}</b> <span className="muted small">· {lounge.guild.members} {lounge.guild.members === 1 ? 'member' : 'members'}</span></span>
              <Button variant="secondary" onClick={openLounge}>Open</Button>
            </>
          ) : (
            <>
              <span className="grow muted small">{lounge.deleted ? 'The lounge was deleted, so nobody is being added to one.' : 'There is no lounge yet.'}</span>
              <Button onClick={makeLounge} loading={busy}>{lounge.deleted ? 'Create it again' : 'Create the lounge'}</Button>
            </>
          )}
        </div>
      </section>
      <section className="admin-card">
        <h3>Announcement</h3>
        <p className="muted small">A bar at the top of NullChat for everyone, for things like “Maintenance tonight at 10 PM”. It appears right away, and people can close it. Posting a new one shows it to everyone again.</p>
        {live && <div className={`announce-live level-${live.level}`}><b>Live now:</b> {live.text}</div>}
        <Field label="Message" hint={`${text.length}/${d.maxAnnouncement}`}>
          <textarea className="input" rows={3} value={text} maxLength={d.maxAnnouncement} placeholder="What should everyone know?" onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="row gap">
          <div className="segmented" role="radiogroup" aria-label="Importance">
            {LEVELS.map((l) => (
              <button key={l.value} type="button" role="radio" aria-checked={level === l.value} className={cx('seg', level === l.value && 'active')} onClick={() => setLevel(l.value)}>{l.label}</button>
            ))}
          </div>
          <span className="grow" />
          {live && <Button variant="ghost" onClick={remove} disabled={busy}>Remove</Button>}
          <Button onClick={post} loading={busy} disabled={!text.trim()}>{live ? 'Update' : 'Post'}</Button>
        </div>
      </section>
    </div>
  );
}

// ================================================================ Backups
function BackupsTab({ rev, bump }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get('/admin/backups').then((x) => alive && setD(x)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [rev]);
  const makeOne = async () => {
    setBusy(true);
    try { setD(await api.post('/admin/backups', {})); toast('Backup saved.', 'success'); bump(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  if (err) return <div className="notice error">{err}</div>;
  if (!d) return <div className="admin-loading"><Spinner /></div>;
  return (
    <div className="admin-backups">
      <div className="notice warn">
        <b>Treat these files like a key to the whole site.</b> A backup is a copy of the database: every account, server, <b>private message</b> and password
        fingerprint (hash). Keep downloaded files somewhere private and never share them. Uploaded pictures and files are not inside; Fly&rsquo;s daily disk snapshots cover those.
      </div>
      <div className="row-between mb">
        <span className="muted small">
          {d.enabled ? <>Automatic backups run every {d.everyHours} hours and the newest {d.keep} are kept.</> : <>Automatic backups are switched off on this server.</>}
        </span>
        <Button onClick={makeOne} loading={busy}><Icon name="download" size={16} /> Back up now</Button>
      </div>
      {!d.files.length ? (
        <EmptyState icon="download" title="No backups yet">The first automatic backup is made a couple of minutes after the server starts, or press “Back up now”.</EmptyState>
      ) : (
        <ul className="admin-backup-list">
          {d.files.map((f) => (
            <li key={f.name} className="admin-backup-row" data-backup={f.name}>
              <Icon name="file" size={20} />
              <div className="grow">
                <div className="mono small truncate">{f.name}</div>
                <div className="tiny muted">{relativeTime(f.createdAt)} · {formatBytes(f.size)}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => openModal(({ close }) => <DownloadBackupModal file={f} close={close} onDone={bump} />)}>
                <Icon name="download" size={14} /> Download
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny muted mt">To restore a backup, follow “Restoring a backup” in SETUP-FLY.md (included with your project).</p>
    </div>
  );
}

function DownloadBackupModal({ file, close, onDone }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const { url } = await api.post(`/admin/backups/${encodeURIComponent(file.name)}/ticket`, { password });
      const a = document.createElement('a');
      a.href = url; a.download = file.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Your download is starting.', 'success');
      onDone(); close();
    } catch (e) { setErr(e.errors?.password || e.message); setBusy(false); }
  };
  return (
    <Modal title="Download this backup?" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button onClick={go} loading={busy} disabled={!password}>Download</Button></>}>
      <p className="muted small">{file.name} · {formatBytes(file.size)}. It contains everything on this server, including private messages. Enter your password to confirm it’s you.</p>
      <Field label="Your password" error={err}>
        <input className="input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && password) go(); }} />
      </Field>
    </Modal>
  );
}

// ================================================================ Servers
function ServersTab({ rev, bump }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => {
    let alive = true;
    setErr(null);
    api.get(`/admin/guilds?q=${encodeURIComponent(dq)}`).then((r) => alive && setRows(r.guilds)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [dq, rev]);
  return (
    <div>
      <div className="admin-toolbar">
        <div className="input-with-icon admin-search">
          <Icon name="search" size={16} />
          <input className="input" value={q} placeholder="Search servers" aria-label="Search servers" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {err && <div className="notice error">{err}</div>}
      {!rows && !err && <div className="admin-loading"><Spinner /></div>}
      {rows && (rows.length === 0 ? <EmptyState icon="search" title="No servers found" /> : (
        <ul className="admin-list">
          {rows.map((g) => (
            <li key={g.id} className="admin-row static">
              <GuildIcon guild={g} size={40} />
              <span className="admin-row-main">
                <span className="admin-row-title"><b>{g.name}</b>{g.tag && <ServerTag tag={g.tag} plain />}</span>
                <span className="admin-row-sub">Owner: {g.ownerName ? `@${g.ownerName}` : 'unknown'} · {g.members} {g.members === 1 ? 'member' : 'members'} · {g.channels} channels</span>
              </span>
              <span className="admin-row-meta tiny muted"><span>Created {formatDate(g.createdAt)}</span></span>
              {g.tag && <Button variant="secondary" size="sm" onClick={() => removeTag(g, bump)} aria-label={`Remove the tag of ${g.name}`}>Remove tag</Button>}
              <Button variant="danger" size="sm" onClick={() => openDeleteServer(g, bump)} aria-label={`Delete ${g.name}`}><Icon name="trash" size={14} /> Delete</Button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

async function removeTag(g, onChanged) {
  if (!(await confirmDialog({ title: `Remove the tag of ${g.name}?`, body: `The tag ${g.tag.text} and its badge picture are removed, and everyone who wears it stops. The server can set a new one. This goes in the log.`, confirmText: 'Remove tag', danger: true }))) return;
  try { await api.del(`/admin/guilds/${g.id}/tag`); toast('Tag removed', 'success', 2000); onChanged(); } catch (e) { toastError(e); }
}

function openDeleteServer(g, onChanged) {
  openModal(({ close }) => <DeleteServerModal g={g} close={close} onDone={() => { close(); onChanged(); }} />);
}

function DeleteServerModal({ g, close, onDone }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ready = name.trim() === g.name;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await api.del(`/admin/guilds/${g.id}`, { confirmName: name.trim() });
      toast(`${g.name} was deleted.`, 'success');
      onDone();
    } catch (e) { setErr(e.errors?.confirmName || e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      title="Delete this server?" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" disabled={!ready} loading={busy} onClick={go}>Delete forever</Button></>}
    >
      <div className="notice error">
        This permanently deletes <b>{g.name}</b> with all {g.channels} channels, its messages, files and {g.members} {g.members === 1 ? 'member' : 'members'}. It can’t be undone.
      </div>
      <Field label={`Type ${g.name} to confirm`} error={err}>
        <input className="input" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ready) go(); }} />
      </Field>
    </Modal>
  );
}

// ================================================================ Apps
/** Apps (bots) that people can add to their servers: the ones listed in the App Directory or shared by link, and the ones staff have hidden. */
function AppsTab({ rev, bump, openAccount }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => {
    let alive = true;
    setErr(null);
    api.get(`/admin/apps?q=${encodeURIComponent(dq)}`).then((r) => alive && setRows(r.apps)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [dq, rev]);
  const toggle = async (a) => {
    const hide = !a.hidden;
    if (hide && !(await confirmDialog({ title: `Hide ${a.name}?`, body: 'It disappears from Discover → Apps and nobody else can add it, even with its link. Servers that already have it keep it. You can show it again whenever you like. This goes in the log.', confirmText: 'Hide app', danger: true }))) return;
    try { await api.put(`/admin/apps/${a.id}/hidden`, { hidden: hide }); toast(hide ? `${a.name} is hidden.` : `${a.name} is shown again.`, 'success', 2000); bump(); } catch (e) { toastError(e); }
  };
  const del = async (a) => {
    if (!(await confirmDialog({ title: `Delete ${a.name}?`, body: `${a.name} leaves ${a.installs === 1 ? 'its server' : `all ${a.installs} servers`} that ${a.installs === 1 ? 'has' : 'have'} it, its token stops working and it can’t be added again. Its owner is not notified. This can’t be undone and goes in the log.`, confirmText: 'Delete app', danger: true }))) return;
    try { await api.del(`/admin/apps/${a.id}`); toast(`${a.name} was deleted.`, 'success', 2000); bump(); } catch (e) { toastError(e); }
  };
  return (
    <div data-testid="admin-apps">
      <p className="small muted">Apps that people can add to their own servers. Private apps aren’t shown here.</p>
      <div className="admin-toolbar">
        <div className="input-with-icon admin-search">
          <Icon name="search" size={16} />
          <input className="input" value={q} placeholder="Search apps or owners" aria-label="Search apps" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {err && <div className="notice error">{err}</div>}
      {!rows && !err && <div className="admin-loading"><Spinner /></div>}
      {rows && (rows.length === 0 ? <EmptyState icon="bot" title="No shared apps">{dq ? 'Nothing matches that.' : 'When somebody lists an app or shares its link it shows up here.'}</EmptyState> : (
        <ul className="admin-list">
          {rows.map((a) => (
            <li key={a.id} className="admin-row static" data-app={a.id}>
              <Avatar src={a.avatar} name={a.name} userId={a.id} size={40} />
              <span className="admin-row-main">
                <span className="admin-row-title"><b>{a.name}</b><span className="bot-tag">BOT</span>
                  <span className={cx('pill', a.visibility === 'listed' && !a.hidden && 'green', a.hidden && 'warn')}>{a.hidden ? 'Hidden' : a.visibility === 'listed' ? 'Listed' : 'Link only'}</span></span>
                <span className="admin-row-sub">{a.ownerName ? <button type="button" className="link-btn" onClick={() => openAccount(a.ownerId)}>@{a.ownerName}</button> : 'Owner left'} · in {a.installs} {a.installs === 1 ? 'server' : 'servers'}{a.description ? ` · ${a.description}` : ''}</span>
              </span>
              <span className="admin-row-meta tiny muted"><span>Made {formatDate(a.createdAt)}</span></span>
              <Button variant="secondary" size="sm" onClick={() => toggle(a)} aria-label={`${a.hidden ? 'Show' : 'Hide'} ${a.name}`}>{a.hidden ? 'Show' : 'Hide'}</Button>
              <Button variant="danger" size="sm" onClick={() => del(a)} aria-label={`Delete ${a.name}`}><Icon name="trash" size={14} /> Delete</Button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

// ================================================================ Activity log
function LogTab({ rev }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/admin/log?limit=200').then((r) => alive && setRows(r.entries)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [rev]);
  if (err) return <div className="notice error">{err}</div>;
  if (!rows) return <div className="admin-loading"><Spinner /></div>;
  if (!rows.length) return <EmptyState icon="shield" title="Nothing yet">Suspensions, restores and deletions will show up here.</EmptyState>;
  return (
    <ul className="admin-log">
      {rows.map((e) => (
        <li key={e.id} className={cx('admin-log-row', e.action, (e.role === 'mod' || e.role === 'devjr') && 'by-mod')}>
          <span className="admin-log-what"><b>{ACTION_LABELS[e.action] || e.action}</b> {e.target}</span>
          <span className="admin-log-detail muted small">{e.detail || ''}</span>
          <span className="admin-log-when tiny muted">{e.admin}{e.role === 'mod' && <span className="pill mod-pill">Mod</span>}{e.role === 'devjr' && <span className="pill mod-pill">Dev Jr</span>} · {relativeTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
