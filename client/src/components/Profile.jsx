// User popouts, full profile modal and status menu.
import { BirthdayLine } from './Birthday.jsx';
import { ProfileSongLine } from './ProfileSong.jsx';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { store, useStore, displayName, guildPermissions, memberColor } from '../lib/state.js';
import { openDM, setStatus } from '../lib/actions.js';
import { toastError, toast } from '../lib/toast.js';
import { formatDate, intToHex, cx, STATUS_LABEL } from '../lib/utils.js';
import { navigate } from '../lib/router.jsx';
import { Markdown } from '../lib/markdown.jsx';
import { openUserSettings } from '../lib/ui.js';
import { P, has, highestRolePosition } from '../../../shared/permissions.js';
import { profileThemeProps, bannerFallback, nameStyleProps } from '../lib/perks.js';
import { Avatar, GuildIcon, Button, Modal, openModal, openPopout, closePopout, Spinner, Tabs, StatusDot, openContextMenu } from './ui.jsx';
import { EmojiGlyph } from './EmojiPicker.jsx';
import { openCustomStatus } from './modals.jsx';
import { userMenuItems } from './menus.jsx';
import { Icon } from './icons.jsx';
import { ActivityLine, LevelChip } from './Extras.jsx';
import { ServerTag } from './ServerTag.jsx';
import { ProfileEffect } from './ProfileEffect.jsx';
import { AccountSwitcher } from './AccountSwitcher.jsx';

export function openUserPopout(anchor, userId, guildId = null, placement = 'right') {
  if (!userId || userId === '0') return;
  openPopout(anchor, ({ close }) => <UserPopout userId={userId} guildId={guildId} close={close} />, { placement, key: `user:${userId}:${guildId}:${anchor?.dataset?.pk || ''}` });
}

function useProfile(userId) {
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get(`/users/${userId}/profile`).then((p) => alive && setProfile(p)).catch(() => {});
    return () => { alive = false; };
  }, [userId]);
  return [profile, setProfile];
}

function Banner({ user, height = 60 }) {
  const style = user?.banner ? { backgroundImage: `url(${user.banner})`, height: height * 2 } : { background: bannerFallback(user), height };
  return <div className="profile-banner" style={style} />;
}

export function CustomStatusLine({ status, className }) {
  if (!status || (!status.text && !status.emoji)) return null;
  return <div className={cx('custom-status', className)}>{status.emoji && <EmojiGlyph emoji={status.emoji} size={16} />}{status.text && <span>{status.text}</span>}</div>;
}

function NoteField({ userId, initial }) {
  const [note, setNote] = useState(initial || '');
  useEffect(() => setNote(initial || ''), [initial]);
  return (
    <textarea className="note-input" placeholder="Click to add a note" maxLength={256} value={note} rows={1}
      onChange={(e) => setNote(e.target.value)}
      onBlur={() => { if (note !== (initial || '')) api.patch(`/users/@me/notes/${userId}`, { note }).catch(toastError); }} />
  );
}

function RoleList({ guildId, userId }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const member = useStore((s) => s.members[guildId]?.[userId]);
  const canManage = useStore((s) => {
    const p = guildPermissions(s, guildId);
    return has(p, P.MANAGE_ROLES);
  });
  const myTop = useStore((s) => highestRolePosition(s.guilds[guildId], s.members[guildId]?.[s.me.id]));
  if (!guild || !member) return null;
  const roles = guild.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
  const setRoles = (ids) => api.patch(`/guilds/${guildId}/members/${userId}`, { roles: ids }).catch(toastError);
  const addable = guild.roles.filter((r) => r.id !== guild.id && !member.roles.includes(r.id) && r.position < myTop);
  return (
    <div className="profile-section">
      <h4>{roles.length ? 'Roles' : 'No Roles'}</h4>
      <div className="role-chips">
        {roles.map((r) => (
          <span key={r.id} className="role-chip">
            <button className="role-chip-dot" style={{ background: r.color ? intToHex(r.color) : 'var(--text-muted)' }}
              disabled={!canManage || r.position >= myTop} onClick={() => setRoles(member.roles.filter((x) => x !== r.id))} title={canManage ? 'Remove role' : ''}>
              {canManage && r.position < myTop && <Icon name="x" size={10} strokeWidth={3} />}
            </button>
            {r.name}
          </span>
        ))}
        {canManage && addable.length > 0 && (
          <button className="role-chip add" onClick={(e) => openContextMenu(e, addable.map((r) => ({ label: r.name, onClick: () => setRoles([...member.roles, r.id]) })))} aria-label="Add role">
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function UserPopout({ userId, guildId, close }) {
  const user = useStore((s) => s.users[userId]);
  const me = useStore((s) => s.me);
  const presence = useStore((s) => s.presences[userId]);
  const member = useStore((s) => (guildId ? s.members[guildId]?.[userId] : null));
  const guild = useStore((s) => (guildId ? s.guilds[guildId] : null));
  const name = useStore((s) => displayName(s, userId, guildId));
  const color = useStore((s) => (guildId ? memberColor(s, guildId, userId) : null));
  const [profile] = useProfile(userId);
  const [msg, setMsg] = useState('');
  const u = user || profile?.user;
  if (!u) return <div className="user-popout loading"><Spinner /></div>;
  const self = userId === me.id;
  const tp = profileThemeProps(u);
  const ns = nameStyleProps(u, color);
  const cs = self ? me.customStatus : presence?.customStatus;
  const status = self ? (me.status === 'invisible' ? 'invisible' : presence?.status || me.status) : presence?.status || 'offline';

  const sendMsg = async (e) => {
    e.preventDefault();
    if (!msg.trim()) return;
    const dm = await openDM(userId);
    if (dm) { await api.post(`/channels/${dm.id}/messages`, { content: msg.trim() }).catch(toastError); }
    close();
  };
  return (
    <div className={cx('user-popout', tp.className)} style={tp.style} onContextMenu={(e) => openContextMenu(e, userMenuItems(userId, { guildId }))}>
      <ProfileEffect effect={u.profileEffect} />
      <Banner user={u} />
      <div className="popout-avatar-wrap">
        <button className="popout-avatar" onClick={() => { close(); openProfileModal(userId, guildId); }} aria-label="View profile">
          <Avatar user={u} guildId={guildId} size={80} />
          <StatusDot status={status} mobile={presence?.mobile} size={18} />
        </button>
        {!self && profile?.relationship === 1 && <span className="friend-badge" title="Friend"><Icon name="friends" size={14} /></span>}
      </div>
      <div className="popout-body">
        <div className="popout-names">
          <div className={cx('popout-name', ns.className)} style={ns.style}>{name}</div>
          <div className="popout-username">{u.username}{u.pronouns && <span className="muted"> • {u.pronouns}</span>} <LevelChip level={u.level} /><ServerTag tag={u.serverTag} />{u.bot && <span className="bot-tag">BOT</span>}{u.isDevJr && <span className="pill mod-pill" title="This person is a Dev Jr for the whole NullChat">Dev Jr</span>}{u.isMod && <span className="pill mod-pill" title="This person is a moderator for the whole NullChat">Mod</span>}</div>
          <CustomStatusLine status={cs} />
          <ActivityLine activity={presence?.activity} />
        </div>
        {self && (
          <div className="popout-actions">
            <Button size="sm" variant="secondary" onClick={() => { close(); openUserSettings('profile'); }}><Icon name="edit" size={14} /> Edit Profile</Button>
          </div>
        )}
        <div className="popout-card">
          <ProfileSongLine user={u} />
          {u.bio && <div className="profile-section"><h4>About Me</h4><div className="bio"><Markdown text={u.bio} /></div></div>}
          <div className="profile-section">
            <h4>Member Since</h4>
            <div className="since-row">
              <span><span className="nc-dot" /> {formatDate(u.createdAt)}</span>
              {member && guild && <span className="row-center"><GuildIcon guild={guild} size={16} /> {formatDate(member.joinedAt)}</span>}
            </div>
          </div>
          <BirthdayLine user={u} />
          {guildId && <RoleList guildId={guildId} userId={userId} />}
          {member?.timeoutUntil && <div className="notice warn small">Timed out until {new Date(member.timeoutUntil).toLocaleString()}</div>}
          {!self && <div className="profile-section"><h4>Note</h4><NoteField userId={userId} initial={profile?.note} /></div>}
        </div>
        {!self && !u.bot && (
          <form onSubmit={sendMsg}><input className="input popout-msg" placeholder={`Message @${u.username}`} value={msg} onChange={(e) => setMsg(e.target.value)} /></form>
        )}
      </div>
    </div>
  );
}

export function openProfileModal(userId, guildId = null) {
  if (!userId || userId === '0') return;
  closePopout();
  openModal(({ close }) => <ProfileModal userId={userId} guildId={guildId} close={close} />);
}

function ProfileModal({ userId, guildId, close }) {
  const user = useStore((s) => s.users[userId]);
  const me = useStore((s) => s.me);
  const presence = useStore((s) => s.presences[userId]);
  const rel = useStore((s) => s.relationships[userId]?.type || 0);
  const guilds = useStore((s) => s.guilds);
  const [profile] = useProfile(userId);
  const [tab, setTab] = useState('about');
  const u = user || profile?.user;
  if (!u) return <Modal onClose={close}><Spinner /></Modal>;
  const self = userId === me.id;
  const tp = profileThemeProps(u);
  const ns = nameStyleProps(u, null);
  const cs = self ? me.customStatus : presence?.customStatus;
  const friendAction = async (kind) => {
    try {
      if (kind === 'add') { await api.put(`/users/@me/relationships/${userId}`, { type: 1 }); toast('Friend request sent!', 'success'); }
      if (kind === 'remove') await api.del(`/users/@me/relationships/${userId}`);
    } catch (e) { toastError(e); }
  };
  return (
    <div className={cx('profile-modal', tp.className)} style={tp.style}>
      <ProfileEffect effect={u.profileEffect} />
      <Banner user={u} height={110} />
      <div className="profile-modal-head">
        <div className="popout-avatar big"><Avatar user={u} guildId={guildId} size={120} /><StatusDot status={self ? (presence?.status || me.status) : presence?.status || 'offline'} size={24} /></div>
        <div className="profile-modal-actions">
          {self ? <Button onClick={() => { close(); openUserSettings('profile'); }}>Edit Profile</Button> : (
            <>
              {!u.bot && rel === 1 && <Button onClick={() => { close(); openDM(userId); }}><Icon name="chat" size={16} /> Send Message</Button>}
              {!u.bot && rel === 0 && <Button variant="success" onClick={() => friendAction('add')}><Icon name="userPlus" size={16} /> Add Friend</Button>}
              {!u.bot && rel === 4 && <Button variant="secondary" disabled>Friend Request Sent</Button>}
              {!u.bot && rel === 3 && <Button variant="success" onClick={() => friendAction('add')}>Accept Friend Request</Button>}
              {rel === 2 && <Button variant="secondary" onClick={() => friendAction('remove')}>Unblock</Button>}
              {!u.bot && rel !== 1 && rel !== 2 && <Button variant="secondary" onClick={() => { close(); openDM(userId); }}>Message</Button>}
              <button className="icon-btn" aria-label="More" onClick={(e) => openContextMenu(e, userMenuItems(userId, { guildId, inProfile: true }))}><Icon name="more" /></button>
            </>
          )}
        </div>
      </div>
      <div className="profile-modal-body">
        <div className={cx('popout-name big', ns.className)} style={ns.style}>{u.displayName || u.username}</div>
        <div className="popout-username">{u.username}{u.pronouns && <span className="muted"> • {u.pronouns}</span>} <LevelChip level={u.level} /><ServerTag tag={u.serverTag} />{u.bot && <span className="bot-tag">BOT</span>}{u.isDevJr && <span className="pill mod-pill" title="This person is a Dev Jr for the whole NullChat">Dev Jr</span>}{u.isMod && <span className="pill mod-pill" title="This person is a moderator for the whole NullChat">Mod</span>}</div>
        <CustomStatusLine status={cs} />
        <ActivityLine activity={presence?.activity} />
        {!self && <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'about', label: 'About Me' },
          { value: 'servers', label: `${profile?.mutualGuilds.length ?? '…'} Mutual Servers` },
          { value: 'friends', label: `${profile?.mutualFriends.length ?? '…'} Mutual Friends` },
        ]} />}
        <div className="profile-modal-tab">
          {/* (kept mounted on the other tabs, so the song is not cut off by looking at mutual servers) */}
          <div hidden={!(tab === 'about' || self)}><ProfileSongLine user={u} /></div>
          {(tab === 'about' || self) && (
            <>
              {u.bio ? <div className="profile-section"><h4>About Me</h4><div className="bio"><Markdown text={u.bio} /></div></div> : null}
              <div className="profile-section"><h4>Member Since</h4><div>{formatDate(u.createdAt)}</div></div>
              <BirthdayLine user={u} />
              {guildId && <RoleList guildId={guildId} userId={userId} />}
              {!self && <div className="profile-section"><h4>Note</h4><NoteField userId={userId} initial={profile?.note} /></div>}
            </>
          )}
          {tab === 'servers' && !self && (profile ? (profile.mutualGuilds.length ? profile.mutualGuilds.map((mg) => guilds[mg.id] && (
            <button key={mg.id} className="list-row" onClick={() => { close(); navigate(`/channels/${mg.id}`); }}>
              <GuildIcon guild={guilds[mg.id]} size={40} /><div><b>{guilds[mg.id].name}</b>{mg.nick && <div className="muted small">{mg.nick}</div>}</div>
            </button>
          )) : <p className="muted center pad">No servers in common</p>) : <Spinner />)}
          {tab === 'friends' && !self && (profile ? (profile.mutualFriends.length ? profile.mutualFriends.map((f) => (
            <button key={f.id} className="list-row" onClick={() => { close(); openProfileModal(f.id); }}>
              <Avatar user={f} size={40} status /><div><b>{f.displayName || f.username}</b><div className="muted small">{f.username}</div></div>
            </button>
          )) : <p className="muted center pad">No friends in common</p>) : <Spinner />)}
        </div>
      </div>
    </div>
  );
}

export function StatusMenu({ close }) {
  const me = useStore((s) => s.me);
  const items = [
    ['online', 'Online', null],
    ['idle', 'Idle', null],
    ['dnd', 'Do Not Disturb', 'You will not receive any desktop notifications.'],
    ['invisible', 'Invisible', 'You will not appear online, but will have full access to NullChat.'],
  ];
  return (
    <div className="status-menu">
      <div className="status-menu-head">
        <Avatar userId={me.id} size={56} status />
        <div><div className="popout-name">{me.displayName || me.username}</div><div className="popout-username">{me.username}</div></div>
      </div>
      <CustomStatusLine status={me.customStatus} className="pad-x" />
      <div className="menu-sep" />
      {items.map(([v, label, desc]) => (
        <button key={v} className={cx('status-option', me.status === v && 'active')} onClick={() => { setStatus(v); close(); }}>
          <StatusDot status={v} size={12} />
          <div><div>{label}</div>{desc && <div className="muted tiny">{desc}</div>}</div>
        </button>
      ))}
      <div className="menu-sep" />
      <button className="status-option" onClick={() => { close(); openCustomStatus(); }}><Icon name="smile" size={16} /><div>{me.customStatus ? 'Edit Custom Status' : 'Set Custom Status'}</div></button>
      {me.customStatus && <button className="status-option" onClick={() => { api.patch('/users/@me/presence', { customStatus: null }).catch(toastError); close(); }}><Icon name="x" size={16} /><div>Clear Custom Status</div></button>}
      <button className="status-option" onClick={() => { close(); openUserSettings('profile'); }}><Icon name="edit" size={16} /><div>Edit Profile</div></button>
      <button className="status-option" onClick={() => { close(); openProfileModal(me.id); }}><Icon name="user" size={16} /><div>View Profile</div></button>
      <AccountSwitcher close={close} />
    </div>
  );
}

export { STATUS_LABEL, store };
