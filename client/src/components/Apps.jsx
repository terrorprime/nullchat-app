// The App Directory (Discover → Apps) and the page of one app, with "Add to server".
// An app is a bot that its owner has chosen to share: anyone who manages a server can add it there, and sees first what it will be allowed to do.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { navigate, Link } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, copyText, plural, debounce } from '../lib/utils.js';
import { openUserSettings, closeSettings } from '../lib/ui.js';
import { PERMISSION_INFO, P, has } from '../../../shared/permissions.js';
import { Button, Modal, openModal, Avatar, GuildIcon, Spinner, EmptyState, Select } from './ui.jsx';
import { openCreateServer } from './modals.jsx';
import { MobileNavButton } from './Chat.jsx';
import { Icon } from './icons.jsx';

const NAMES = new Map(PERMISSION_INFO.flatMap((g) => g.items.map(([key, label, description]) => [key, { label, description }])));
/** The permissions in a bit field, by name. Administrator stands for all of them. */
export function permissionsIn(bits) {
  if (has(bits, P.ADMINISTRATOR)) return [{ key: 'ADMINISTRATOR', ...NAMES.get('ADMINISTRATOR') }];
  return PERMISSION_INFO.flatMap((g) => g.items.map(([key]) => key)).filter((key) => P[key] && has(bits, P[key])).map((key) => ({ key, ...NAMES.get(key) }));
}

const BLOCKED = {
  installed: 'Already added',
  full: 'This server already has 25 bots',
  roles: 'This server has no room for another role',
  permissions: 'Needs a permission you don’t have here',
};

export const appLink = (id) => `${location.origin}/apps/${id}`;
const nameOf = (a) => a.name || a.user?.displayName || a.user?.username || 'App';

/** Discover has two halves: servers and apps. */
export function DiscoverTabs({ active }) {
  return (
    <nav className="discover-tabs" aria-label="Discover">
      <Link to="/discovery" className={cx('tab', active === 'servers' && 'active')} aria-current={active === 'servers' ? 'page' : undefined}>Servers</Link>
      <Link to="/apps" className={cx('tab', active === 'apps' && 'active')} aria-current={active === 'apps' ? 'page' : undefined}>Apps</Link>
    </nav>
  );
}

export function AppDirectoryPage({ botId }) {
  return botId ? <AppPage botId={botId} /> : <AppDirectory />;
}

// ---------------------------------------------------------------- the list
function AppDirectory() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('popular');
  const [data, setData] = useState(null);       // { apps, hasMore }
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const load = useMemo(() => debounce((query, order) => {
    const mine = ++seq.current;
    api.get(`/apps?q=${encodeURIComponent(query)}&sort=${order}`).then((r) => { if (mine === seq.current) setData(r); }).catch((e) => { if (mine === seq.current) { toastError(e); setData({ apps: [], hasMore: false }); } });
  }, 250), []);
  useEffect(() => { load(q, sort); }, [q, sort, load]);
  const showMore = async () => {
    setMore(true);
    const mine = ++seq.current;
    try {
      const r = await api.get(`/apps?q=${encodeURIComponent(q)}&sort=${sort}&offset=${data.apps.length}`);
      if (mine === seq.current) setData((d) => ({ apps: [...d.apps, ...r.apps], hasMore: r.hasMore }));
    } catch (e) { toastError(e); }
    setMore(false);
  };
  return (
    <section className="discovery apps-page" data-testid="app-directory">
      <header className="chat-header">
        <MobileNavButton /><Icon name="compass" size={22} className="header-icon" /><h1 className="header-title">Discover</h1>
        <DiscoverTabs active="apps" />
      </header>
      <div className="discovery-scroll">
        <div className="discovery-hero">
          <h1>Add an app to your server</h1>
          <p>Bots that moderate, welcome people, run games and more. You see what an app can do before you add it.</p>
          <div className="discovery-search"><input placeholder="Search apps" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} /><Icon name="search" size={20} /></div>
        </div>
        <div className="row-between apps-bar">
          <h2 className="section-title">{q ? `Results for “${q}”` : 'Apps'}</h2>
          <Select className="apps-sort" value={sort} onChange={setSort} options={[{ value: 'popular', label: 'Most added' }, { value: 'new', label: 'Newest' }, { value: 'name', label: 'A to Z' }]} />
        </div>
        {!data ? <Spinner /> : !data.apps.length ? (
          <EmptyState icon="bot" title={q ? 'No apps match that' : 'No apps are listed yet'}>
            {q ? 'Try another word, or clear the search.' : 'Built a bot? In User Settings → Developer Portal you can list it here so other servers can add it.'}
            <br /><br />{!q && <Button onClick={() => openUserSettings('developer')}>Open the Developer Portal</Button>}
          </EmptyState>
        ) : (
          <>
            <div className="apps-grid">{data.apps.map((a) => <AppCard key={a.id} app={a} />)}</div>
            {data.hasMore && <div className="apps-more"><Button variant="secondary" loading={more} onClick={showMore}>Show more</Button></div>}
          </>
        )}
      </div>
    </section>
  );
}

function AppCard({ app }) {
  const open = () => navigate(`/apps/${app.id}`);
  return (
    <div className="app-card" role="link" tabIndex={0} data-testid="app-card" data-app-id={app.id} onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
      <div className="app-card-head">
        <Avatar userId={app.id} user={app.user} size={48} />
        <div className="app-card-title">
          <div className="row gap-sm"><b className="truncate">{nameOf(app)}</b><span className="bot-tag">BOT</span></div>
          {app.owner && <div className="tiny muted truncate">by {app.owner.displayName}</div>}
        </div>
      </div>
      <p className="small muted clamp-3 app-card-desc">{app.description || 'No description.'}</p>
      <div className="app-card-foot">
        <span className="tiny muted">{plural(app.installCount, 'server')}{app.commandCount ? ` · ${plural(app.commandCount, 'command')}` : ''}</span>
        <Button size="sm" onClick={(e) => { e.stopPropagation(); openAddToServer(app.id); }}>Add</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one app
function AppPage({ botId }) {
  const [app, setApp] = useState(undefined);   // undefined: loading, null: not available
  const load = useCallback(() => api.get(`/apps/${encodeURIComponent(botId)}`).then(setApp).catch(() => setApp(null)), [botId]);
  useEffect(() => { setApp(undefined); load(); }, [load]);
  return (
    <section className="discovery apps-page" data-testid="app-page">
      <header className="chat-header">
        <MobileNavButton /><Icon name="compass" size={22} className="header-icon" /><h1 className="header-title">Discover</h1>
        <DiscoverTabs active="apps" />
      </header>
      <div className="discovery-scroll">
        <div className="app-page">
          <Link to="/apps" className="link small app-back"><Icon name="chevronLeft" size={14} /> All apps</Link>
          {app === undefined ? <Spinner /> : app === null ? (
            <EmptyState icon="bot" title="That app isn’t available">It may have been removed, or its owner hasn’t shared it. Ask whoever sent you the link.<br /><br /><Button onClick={() => navigate('/apps')}>Browse apps</Button></EmptyState>
          ) : <AppDetails app={app} />}
        </div>
      </div>
    </section>
  );
}

function AppDetails({ app }) {
  const perms = permissionsIn(app.permissions);
  const admin = has(app.permissions, P.ADMINISTRATOR);
  return (
    <>
      <div className="app-hero">
        <Avatar userId={app.id} user={app.user} size={80} />
        <div className="app-hero-main">
          <h2 className="app-name"><span className="truncate">{nameOf(app)}</span><span className="bot-tag">BOT</span></h2>
          <div className="small muted">
            {app.owner ? `Made by ${app.owner.displayName}` : 'Made by someone who has left'} · {plural(app.installCount, 'server')}
            {app.online && <span className="pill green app-online">Online</span>}
          </div>
        </div>
        <div className="app-hero-actions">
          <Button onClick={() => openAddToServer(app.id)}><Icon name="plus" size={16} /> Add to Server</Button>
          <Button variant="secondary" onClick={() => { copyText(appLink(app.id)); toast('Link copied', 'success', 1500); }}><Icon name="link" size={16} /> Copy Link</Button>
        </div>
      </div>
      {app.access === 'manage' && (
        <div className="notice app-own">
          You made this app. {app.visibility === 'listed' ? 'It is listed in the directory.' : app.visibility === 'link' ? 'Only people with this link can add it; it isn’t in the directory.' : 'Only you can add it right now.'}{' '}
          {app.hidden && <b>Staff have hidden it from the directory. </b>}
          <button type="button" className="link-btn" onClick={() => openUserSettings('developer')}>Open the Developer Portal</button>
        </div>
      )}
      <h3 className="app-h">About</h3>
      <p className={cx('app-about', !app.description && 'muted')}>{app.description || 'The person who made this app didn’t write a description.'}</p>
      <h3 className="app-h">What it will be allowed to do</h3>
      <p className="small muted">These are the permissions its role gets in the server you add it to. You can change them afterwards in Server Settings → Roles.</p>
      <PermissionList perms={perms} admin={admin} />
      <h3 className="app-h">Slash commands</h3>
      {app.commands.length ? (
        <ul className="app-commands">{app.commands.map((c) => <li key={c.name}><code>/{c.name}</code> <span className="muted">{c.description}</span></li>)}</ul>
      ) : <p className="small muted">It hasn’t registered any, or its program hasn’t started yet.</p>}
    </>
  );
}

function PermissionList({ perms, admin }) {
  return (
    <>
      {admin && (
        <div className="notice error app-admin" role="alert">
          <b>This app asks for Administrator.</b> That is every permission at once: it can read every channel, change roles, remove people and delete things. Only add an app like this if you know and trust whoever runs it.
        </div>
      )}
      {!admin && <ul className="app-perms">{perms.map((p) => <li key={p.key} title={p.description}><Icon name="check" size={14} /> {p.label}</li>)}</ul>}
    </>
  );
}

// ---------------------------------------------------------------- adding it
/** The window that adds an app to one of your servers. */
export function openAddToServer(appId, onInstalled) {
  return openModal(({ close }) => <AddToServerModal appId={appId} close={close} onInstalled={onInstalled} />);
}

function AddToServerModal({ appId, close, onInstalled }) {
  const [app, setApp] = useState(undefined);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);       // the server it was added to
  useEffect(() => {
    api.get(`/apps/${encodeURIComponent(appId)}`).then((a) => {
      setApp(a);
      setPick(a.servers.find((s) => !s.blocked)?.id || '');
    }).catch((e) => { toastError(e); close(); });
  }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!app) return <Modal title="Add to server" size="sm" onClose={close}><Spinner /></Modal>;

  const perms = permissionsIn(app.permissions);
  const admin = has(app.permissions, P.ADMINISTRATOR);
  const server = app.servers.find((s) => s.id === pick);
  const add = async () => {
    setBusy(true);
    try {
      await api.post(`/apps/${encodeURIComponent(app.id)}/install`, { guildId: pick });
      setDone(server);
      setApp((a) => ({ ...a, installCount: a.installCount + 1, servers: a.servers.map((s) => (s.id === pick ? { ...s, blocked: 'installed' } : s)) }));
      onInstalled?.();
    } catch (e) { toastError(e); }
    setBusy(false);
  };

  if (done) {
    return (
      <Modal title={`${nameOf(app)} is in ${done.name}`} size="sm" onClose={close}
        footer={<><Button variant="link" onClick={() => { setDone(null); setPick(app.servers.find((s) => !s.blocked)?.id || ''); }} disabled={!app.servers.some((s) => !s.blocked)}>Add to another</Button><Button onClick={() => { close(); closeSettings(); navigate(`/channels/${done.id}`); }}>Go to Server</Button></>}>
        <div className="app-added" data-testid="app-added">
          <Avatar userId={app.id} user={app.user} size={56} />
          <p>It has its own role in <b>{done.name}</b>. Give that role access to the channels it should use, under Server Settings → Roles. It only answers while its program is running.</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Add ${nameOf(app)} to a server`} subtitle={app.owner ? `Made by ${app.owner.displayName}` : undefined} onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} disabled={!pick} onClick={add}>{server ? `Add to ${server.name}` : 'Add'}</Button></>}>
      <div className="app-add" data-testid="add-to-server">
        {!app.servers.length ? (
          <EmptyState icon="bot" title="You don’t manage a server yet">Adding an app needs the Manage Server permission. Make a server of your own, or ask the owner of one to give you that permission.<br /><br /><Button onClick={() => { close(); openCreateServer(); }}>Create a Server</Button></EmptyState>
        ) : (
          <>
            <div className="field-label">Add it to</div>
            <div className="app-servers" role="radiogroup" aria-label="Server">
              {app.servers.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={pick === s.id} disabled={!!s.blocked} data-blocked={s.blocked || undefined} data-server={s.id}
                  className={cx('app-server', pick === s.id && 'selected')} onClick={() => setPick(s.id)}>
                  <GuildIcon guild={s} size={32} />
                  <span className="app-server-main"><b className="truncate">{s.name}</b>{s.blocked && <span className="tiny muted">{BLOCKED[s.blocked]}</span>}</span>
                  <span className="radio-circle" />
                </button>
              ))}
            </div>
            <div className="field-label app-add-h">What it will be allowed to do</div>
            <PermissionList perms={perms} admin={admin} />
          </>
        )}
      </div>
    </Modal>
  );
}
