// Friends home page and server discovery.
import { useEffect, useMemo, useState } from 'react';
import { useStore, store, displayName } from '../lib/state.js';
import { api } from '../lib/api.js';
import { openDM } from '../lib/actions.js';
import { joinVoice, useVoice } from '../lib/voice.js';
import { navigate, useSearch } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, debounce, STATUS_LABEL } from '../lib/utils.js';
import { useT } from '../lib/i18n.js';
import { isCloseFriend, toggleCloseFriend } from '../lib/closeFriends.js';
import { Avatar, Button, IconButton, Tabs, GuildIcon, Spinner, EmptyState, openContextMenu, confirmDialog, useMediaQuery } from './ui.jsx';
import { openUserMenu } from './menus.jsx';
import { openUserPopout, CustomStatusLine, openProfileModal } from './Profile.jsx';
import { ActivityLine, SuggestionsPanel } from './Extras.jsx';
import { openGroupDMModal, openCreateServer } from './modals.jsx';
import { MobileNavButton } from './Chat.jsx';
import { DiscoverTabs } from './Apps.jsx';
import { Icon } from './icons.jsx';

export function FriendsPage() {
  const t = useT();
  const search = useSearch();
  const [tab, setTab] = useState(search.get('tab') === 'add' ? 'add' : 'online');
  const pending = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 3).length);
  // On a phone the five tabs don't fit beside the title (Blocked and Add Friend were cut off),
  // so they get their own row under the header instead.
  const phone = useMediaQuery('(max-width: 768px)');
  const tabs = (
    <Tabs value={tab} onChange={setTab} className={phone ? 'friends-tabs-row' : 'friends-tabs'} tabs={[
      { value: 'online', label: t('online') },
      { value: 'all', label: t('all') },
      { value: 'pending', label: t('pending'), badge: pending || null },
      { value: 'blocked', label: t('blocked') },
      { value: 'add', label: t('addFriend'), className: 'add-friend-tab' },
    ]} />
  );
  return (
    <section className="friends-page">
      <header className="chat-header">
        <MobileNavButton />
        <Icon name="friends" size={22} className="header-icon" />
        <h1 className="header-title">{t('friends')}</h1>
        <span className="header-divider hide-sm" />
        {!phone && tabs}
        <div className="header-actions"><IconButton icon="plusCircle" label="New Group DM" onClick={() => openGroupDMModal()} /></div>
      </header>
      {phone && <div className="friends-subbar">{tabs}</div>}
      <div className="friends-body">
        <div className="friends-main">{tab === 'add' ? <AddFriend /> : <FriendList tab={tab} />}</div>
        <ActiveNow />
      </div>
    </section>
  );
}

function FriendList({ tab }) {
  const [q, setQ] = useState('');
  const rels = useStore((s) => s.relationships);
  const presences = useStore((s) => s.presences);
  const users = useStore((s) => s.users);
  const close = useStore((s) => s.settings?.closeFriends);
  const list = useMemo(() => {
    const s = store.get();
    let rows = Object.values(rels);
    if (tab === 'online') rows = rows.filter((r) => r.type === 1 && (presences[r.id]?.status || 'offline') !== 'offline');
    if (tab === 'all') rows = rows.filter((r) => r.type === 1);
    if (tab === 'pending') rows = rows.filter((r) => r.type === 3 || r.type === 4);
    if (tab === 'blocked') rows = rows.filter((r) => r.type === 2);
    if (q) rows = rows.filter((r) => displayName(s, r.id).toLowerCase().includes(q.toLowerCase()) || users[r.id]?.username.includes(q.toLowerCase()));
    // close friends first, then by name
    const starred = (r) => (isCloseFriend(s, r.id) ? 0 : 1);
    return rows.sort((a, b) => (a.type - b.type) || (starred(a) - starred(b)) || displayName(s, a.id).localeCompare(displayName(s, b.id)));
  }, [rels, presences, users, tab, q, close]);
  const label = { online: 'Online', all: 'All Friends', pending: 'Pending', blocked: 'Blocked' }[tab];
  return (
    <>
      <div className="friends-search"><input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /><Icon name="search" size={18} /></div>
      <h3 className="section-label">{label} — {list.length}</h3>
      {list.length === 0 ? (
        <EmptyState icon={tab === 'blocked' ? 'ban' : tab === 'pending' ? 'clock' : 'friends'}>
          {tab === 'online' ? 'No one’s around to play with right now.' : tab === 'pending' ? 'There are no pending friend requests. Here’s a nice empty page for you.' : tab === 'blocked' ? 'You can’t unblock the void.' : 'You have no friends yet. Add some by username!'}
        </EmptyState>
      ) : (
        <div className="friend-rows">{list.map((r) => <FriendRow key={r.id} rel={r} />)}</div>
      )}
    </>
  );
}

function FriendRow({ rel }) {
  const user = useStore((s) => s.users[rel.id]);
  const name = useStore((s) => displayName(s, rel.id));
  const presence = useStore((s) => s.presences[rel.id]);
  const close = useStore((s) => isCloseFriend(s, rel.id));
  if (!user) return null;
  const act = async (fn) => { try { await fn(); } catch (e) { toastError(e); } };
  const status = presence?.status || 'offline';
  return (
    <div className="friend-row" onClick={() => rel.type === 1 && openDM(rel.id)} onContextMenu={(e) => openUserMenu(e, rel.id)}>
      <Avatar userId={rel.id} size={36} status />
      <div className="friend-text">
        <div><b className="friend-name">{name}</b>{close && <Icon name="star" size={13} className="close-star" aria-label="Close friend" />} <span className="friend-username muted">{user.username}</span></div>
        <div className="tiny muted">
          {rel.type === 3 ? 'Incoming Friend Request' : rel.type === 4 ? 'Outgoing Friend Request' : rel.type === 2 ? 'Blocked'
            : presence?.activity ? <ActivityLine activity={presence.activity} /> : presence?.customStatus ? <CustomStatusLine status={presence.customStatus} /> : STATUS_LABEL[status]}
        </div>
      </div>
      <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
        {rel.type === 1 && <>
          <IconButton icon="star" label={close ? 'Remove from Close Friends' : 'Add to Close Friends'} className={cx('close-friend-btn', close && 'on')} aria-pressed={close} data-close-friend={close ? 'on' : 'off'} onClick={() => toggleCloseFriend(rel.id)} />
          <IconButton icon="chat" label="Message" onClick={() => openDM(rel.id)} />
          <IconButton icon="more" label="More" onClick={(e) => openContextMenu(e, [
            { label: 'Start Voice Call', onClick: async () => { const dm = await openDM(rel.id); if (dm) joinVoice(dm.id); } },
            { label: 'View Profile', onClick: () => openProfileModal(rel.id) },
            { type: 'separator' },
            { label: 'Remove Friend', danger: true, onClick: async () => { if (await confirmDialog({ title: `Remove '${name}'`, body: <>Are you sure you want to permanently remove <b>{name}</b> from your friends?</>, confirmText: 'Remove Friend', danger: true })) act(() => api.del(`/users/@me/relationships/${rel.id}`)); } },
          ])} />
        </>}
        {rel.type === 3 && <>
          <IconButton icon="check" label="Accept" className="accept" onClick={() => act(() => api.put(`/users/@me/relationships/${rel.id}`, { type: 1 }))} />
          <IconButton icon="x" label="Ignore" className="decline" onClick={() => act(() => api.del(`/users/@me/relationships/${rel.id}`))} />
        </>}
        {rel.type === 4 && <IconButton icon="x" label="Cancel" className="decline" onClick={() => act(() => api.del(`/users/@me/relationships/${rel.id}`))} />}
        {rel.type === 2 && <IconButton icon="userPlus" label="Unblock" onClick={() => act(() => api.del(`/users/@me/relationships/${rel.id}`))} />}
      </div>
    </div>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const doSearch = useMemo(() => debounce((q) => {
    if (q.length < 2) { setResults([]); return; }
    api.get(`/users/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => setResults([]));
  }, 300), []);
  useEffect(() => { doSearch(username.trim()); }, [username, doSearch]);
  const submit = async (e, name = username) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setLoading(true); setState(null);
    try {
      await api.post('/users/@me/relationships', { username: name.trim() });
      setState({ ok: true, msg: <>Success! Your friend request to <b>{name.trim()}</b> was sent.</> });
      setUsername('');
    } catch (err) { setState({ ok: false, msg: err.message }); }
    finally { setLoading(false); }
  };
  return (
    <div className="add-friend">
      <h2>Add Friend</h2>
      <p className="muted">You can add friends with their NullChat username.</p>
      <form className={cx('add-friend-form', state && (state.ok ? 'ok' : 'bad'))} onSubmit={submit}>
        <input autoFocus placeholder="You can add friends with their NullChat username." value={username} onChange={(e) => { setUsername(e.target.value); setState(null); }} maxLength={40} />
        <Button type="submit" loading={loading} disabled={!username.trim()}>Send Friend Request</Button>
      </form>
      {state && <p className={cx('small', state.ok ? 'success-text' : 'error-text')}>{state.msg}</p>}
      {results.length > 0 && (
        <div className="user-results">
          <h3 className="section-label">People</h3>
          {results.map((u) => (
            <div key={u.id} className="friend-row" onClick={(e) => openUserPopout(e.currentTarget, u.id)}>
              <Avatar user={u} size={36} status />
              <div className="friend-text"><b>{u.displayName || u.username}</b> <span className="muted small">{u.username}</span></div>
              <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
                {u.relationship === 0 && <Button size="sm" variant="success" onClick={() => submit(null, u.username)}>Add</Button>}
                {u.relationship === 1 && <span className="muted small">Friends</span>}
                {u.relationship === 4 && <span className="muted small">Request sent</span>}
                {u.relationship === 3 && <Button size="sm" onClick={() => submit(null, u.username)}>Accept</Button>}
                {u.relationship === 2 && <span className="muted small">Blocked</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <SuggestionsPanel />
      <div className="add-friend-more">
        <h3 className="section-label">Other places to make friends</h3>
        <button className="discover-cta" onClick={() => navigate('/discovery')}><Icon name="compass" size={28} /><div><b>Explore Discoverable Servers</b></div><Icon name="chevronRight" /></button>
      </div>
    </div>
  );
}

function ActiveNow() {
  const friends = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 1).map((r) => r.id));
  const voice = useStore((s) => s.voiceStates);
  const presences = useStore((s) => s.presences);
  const channels = useStore((s) => s.channels);
  const guilds = useStore((s) => s.guilds);
  const active = friends.filter((id) => voice[id] || presences[id]?.activity || presences[id]?.customStatus);
  return (
    <aside className="active-now hide-md">
      <h2>Active Now</h2>
      {active.length === 0 ? (
        <div className="active-empty"><b>It’s quiet for now…</b><p className="muted small">When a friend starts an activity — like hanging out in voice — we’ll show it here!</p></div>
      ) : active.map((id) => {
        const v = voice[id];
        const ch = v ? channels[v.channelId] : null;
        return (
          <div key={id} className="active-card" onClick={(e) => openUserPopout(e.currentTarget, id, null, 'left')}>
            <div className="row-center"><Avatar userId={id} size={32} status /><b className="truncate"><Name id={id} /></b></div>
            <ActivityLine activity={presences[id]?.activity} className="small" />
            {presences[id]?.customStatus && <CustomStatusLine status={presences[id].customStatus} className="small" />}
            {v && ch && (
              <div className="active-voice">
                <Icon name="speaker" size={16} />
                <span className="truncate small">{ch.guildId ? `${ch.name} — ${guilds[ch.guildId]?.name}` : 'In a call'}</span>
                {ch.guildId && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); joinVoice(ch.id); navigate(`/channels/${ch.guildId}/${ch.id}`); }}>Join</Button>}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
function Name({ id }) { return useStore((s) => displayName(s, id)); }

// ================================================================ discovery
export function DiscoveryPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const load = useMemo(() => debounce((query) => api.get(`/discovery?q=${encodeURIComponent(query)}`).then(setList).catch(() => setList([])), 250), []);
  useEffect(() => { load(q); }, [q, load]);
  const join = async (g) => {
    if (g.joined) { navigate(`/channels/${g.id}`); return; }
    try {
      const r = await api.post(`/discovery/${g.id}/join`);
      toast(`Welcome to ${g.name}!`, 'success');
      navigate(`/channels/${r.guildId}${r.channelId ? `/${r.channelId}` : ''}`);
    } catch (e) { toastError(e); }
  };
  return (
    <section className="discovery">
      <header className="chat-header"><MobileNavButton /><Icon name="compass" size={22} className="header-icon" /><h1 className="header-title">{t('discover')}</h1><DiscoverTabs active="servers" /></header>
      <div className="discovery-scroll">
        <div className="discovery-hero">
          <h1>{t('findCommunity')}</h1>
          <p>From gaming, to music, to learning, there’s a place for you.</p>
          <div className="discovery-search"><input placeholder="Explore communities" value={q} onChange={(e) => setQ(e.target.value)} /><Icon name="search" size={20} /></div>
        </div>
        <h2 className="section-title">{q ? `Results for “${q}”` : 'Featured communities'}</h2>
        {!list ? <Spinner /> : list.length === 0 ? (
          <EmptyState icon="compass" title="No public servers yet">
            Server owners can list their server here in Server Settings → Overview → “Show in Server Discovery”.
            <br /><br /><Button onClick={openCreateServer}>Create a Server</Button>
          </EmptyState>
        ) : (
          <div className="discovery-grid">
            {list.map((g) => (
              <div key={g.id} className="discovery-card" onClick={() => join(g)} role="button" tabIndex={0}>
                <div className="discovery-banner" style={g.banner ? { backgroundImage: `url(${g.banner})` } : undefined} />
                <GuildIcon guild={g} size={48} className="discovery-icon" />
                <div className="discovery-info">
                  <h3 className="truncate">{g.name}</h3>
                  <p className="muted small clamp-3">{g.description || 'No description.'}</p>
                  <div className="discovery-counts">
                    <span><i className="dot online" /> {g.onlineCount} Online</span>
                    <span><i className="dot" /> {g.memberCount} Members</span>
                    {g.joined && <span className="pill">{t('joined')}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export { useVoice };
