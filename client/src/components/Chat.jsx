// Channel view: header, messages, composer, member list, threads, pins, search and inbox.
import { StreakBadge } from './Streak.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, store, displayName, channelPermissions, memberColor, isChannelUnread, isChannelMuted, unreadMentionTotal } from '../lib/state.js';
import { api } from '../lib/api.js';
import { on } from '../lib/gateway.js';
import { jumpToMessage, ackChannel, channelPath, openDM } from '../lib/actions.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatTimestamp, plural } from '../lib/utils.js';
import { useUI, setUI, toggleMemberList, openChannelSettings } from '../lib/ui.js';
import { useT } from '../lib/i18n.js';
import { registerAction } from '../lib/keybinds.js';
import { joinVoice, startCamera, useVoice } from '../lib/voice.js';
import { Markdown } from '../lib/markdown.jsx';
import { P, has, ChannelType, computeChannelPermissions, isTextLike } from '../../../shared/permissions.js';
import { canFollowChannel, openFollowModal } from './Community.jsx';
import { nameStyleProps } from '../lib/perks.js';
import { Avatar, IconButton, openPopout, Spinner, Tabs, Button, openContextMenu, confirmDialog, useMediaQuery } from './ui.jsx';
import { MessageList, Message } from './Messages.jsx';
import { Composer } from './Composer.jsx';
import { InboxContent } from './Inbox.jsx';
import { openUserPopout, CustomStatusLine } from './Profile.jsx';
import { openUserMenu, channelMenuItems } from './menus.jsx';
import { openGroupDMModal, openCreateThread } from './modals.jsx';
import { GroupIcon } from './Sidebar.jsx';
import { CallView } from './Voice.jsx';
import { Icon } from './icons.jsx';
import { ActivityLine } from './Extras.jsx';
import { ServerTag } from './ServerTag.jsx';
import { ForumView } from './Forum.jsx';
import { PostTags, forumOfPost } from './ForumTools.jsx';

// ================================================================ channel view
/** Is this Escape press free to take you to the newest messages? (Not while a window, menu or popout is open, or while you are typing in a box other than the message composer.) */
function escapeIsFree(e) {
  if (e?.key !== 'Escape') return false;   // Mark Channel Read can be moved to another key; then it only marks
  if (document.querySelector('.modal-layer,.context-menu,.popout')) return false;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable || (t.tagName === 'TEXTAREA' && !t.closest?.('.composer')))) return false;
  return true;
}

export function ChannelView({ channelId, threadId }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const narrow = useMediaQuery('(max-width: 860px)');
  const memberListOpen = useUI((u) => (narrow ? u.mobileMembers : u.memberList));
  const search = useUI((u) => u.search);
  const hasCall = useStore((s) => !!s.calls[channelId] || Object.values(s.voiceStates).some((v) => v.channelId === channelId));
  const inThisCall = useVoice((v) => v.channelId === channelId);
  const wide = useMediaQuery('(min-width: 1100px)');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const placeholder = useStore((s) => {
    const ch = s.channels[channelId];
    if (!ch) return '';
    if (ch.type === ChannelType.DM) return t('messagePlaceholder', { name: `@${displayName(s, ch.recipients[0])}` });
    if (ch.type === ChannelType.GROUP_DM) return t('messagePlaceholder', { name: ch.name || ch.recipients.map((r) => displayName(s, r)).join(', ') });
    return t('messagePlaceholder', { name: `#${ch.name}` });
  });
  useEffect(() => registerAction('toggleMembers', () => { toggleMemberList(); }), []);
  // Escape marks the channel read and, if you have scrolled up into older messages, takes you back to the newest ones (the "Jump to Present" button).
  // It only does that when nothing else wanted the key: a window or menu is open, you are typing in some other box (search, an edit), or the composer
  // used it itself (closing the mention list, cancelling a reply). Those call preventDefault, which is why the jump waits until the key press is over.
  useEffect(() => registerAction('markChannelRead', (e) => {
    ackChannel(channelId, true);
    if (escapeIsFree(e)) setTimeout(() => { if (!e.defaultPrevented) window.dispatchEvent(new CustomEvent('nullchat:jump-present', { detail: { channelId } })); }, 0);
    return false;
  }), [channelId]);
  useEffect(() => { setUI({ search: null, mobileMembers: false }); }, [channelId]);

  if (!channel) return <div className="chat empty"><Spinner /></div>;
  const isGuild = !!channel.guildId;
  const isForum = channel.type === ChannelType.FORUM;
  const showMembers = memberListOpen && (isGuild || channel.type === ChannelType.GROUP_DM) && !search && (isForum ? !threadId : (wide || !threadId));
  const dropHandlers = {
    onDragEnter: (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth.current++; setDragging(true); } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDragOver: (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); },
    onDrop: (e) => {
      e.preventDefault(); dragDepth.current = 0; setDragging(false);
      if (e.dataTransfer.files?.length) window.dispatchEvent(new CustomEvent(`nullchat:files:${channelId}`, { detail: e.dataTransfer.files }));
    },
  };
  return (
    <div className={cx('chat-layout', threadId && 'with-thread')}>
      <section className="chat">
        <ChannelHeader channel={channel} />
        <div className="chat-body">
          {isForum ? (
            <div className="chat-main"><ForumView channel={channel} threadId={threadId} /></div>
          ) : (
          <div className="chat-main" {...dropHandlers}>
            {!isGuild && (hasCall || inThisCall) && <CallView channelId={channelId} />}
            <MessageList channelId={channelId} header={<ChannelWelcome channel={channel} />} />
            <Composer channelId={channelId} placeholder={placeholder} />
            {dragging && <div className="drop-overlay"><div><Icon name="upload" size={48} /><h3>Upload to {isGuild ? `#${channel.name}` : 'this conversation'}</h3><p>You can add comments before uploading.</p></div></div>}
          </div>
          )}
          {search && <SearchPanel />}
          {showMembers && narrow && <div className="member-scrim" onClick={() => setUI({ mobileMembers: false })} />}
          {showMembers && (isGuild ? <MemberList channel={channel} /> : <GroupMembers channel={channel} />)}
        </div>
      </section>
      {threadId && <ThreadPanel threadId={threadId} parentId={channelId} />}
    </div>
  );
}

// ================================================================ header
/** Phones: the back arrow at the left of every header. It goes to the servers and channels list. */
export function MobileNavButton() {
  const unread = useStore((s) => unreadMentionTotal(s));
  return (
    <button className="icon-btn mobile-only nav-toggle" aria-label="Back to servers and channels" onClick={() => setUI({ mobileNav: true, navGuild: null })}>
      <Icon name="chevronLeft" size={26} />{unread > 0 && <span className="mention-badge nav-toggle-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

function ChannelHeader({ channel }) {
  const t = useT();
  const narrow = useMediaQuery('(max-width: 860px)');
  const memberListOpen = useUI((u) => (narrow ? u.mobileMembers : u.memberList));
  const muted = useStore((s) => isChannelMuted(s, channel));
  const isGuild = !!channel.guildId;
  const guildName = useStore((s) => (channel.guildId ? s.guilds[channel.guildId]?.name : null));
  const dmUser = useStore((s) => (channel.type === ChannelType.DM ? s.users[channel.recipients[0]] : null));
  const dmName = useStore((s) => (channel.type === ChannelType.DM ? displayName(s, channel.recipients[0]) : channel.type === ChannelType.GROUP_DM ? channel.name || channel.recipients.map((r) => displayName(s, r)).join(', ') : null));
  const dmPresence = useStore((s) => (channel.type === ChannelType.DM ? s.presences[channel.recipients[0]] : null));
  const canFollow = useStore((s) => canFollowChannel(s, channel));
  const pinsRef = useRef(null); const threadsRef = useRef(null); const inboxRef = useRef(null);
  const [topicOpen, setTopicOpen] = useState(false);
  const toggleMute = () => api.patch(`/users/@me/guilds/${channel.guildId || '@me'}/settings`, { channelOverrides: { [channel.id]: { muted: !muted } } }).catch(toastError);
  return (
    <header className="chat-header">
      <MobileNavButton />
      {isGuild ? (
        <>
          {guildName && <><span className="crumb" title={guildName}>{guildName}</span><span className="crumb-sep">/</span></>}
          <Icon name={channel.type === ChannelType.VOICE ? 'speaker' : channel.type === ChannelType.ANNOUNCEMENT ? 'megaphone' : channel.type === ChannelType.FORUM ? 'forum' : 'hash'} size={22} className="header-icon" />
          <h1 className="header-title truncate" onContextMenu={(e) => openContextMenu(e, channelMenuItems(channel.id))}>{channel.name}</h1>
          {channel.topic && channel.type !== ChannelType.FORUM && <><span className="header-divider" /><button className="header-topic truncate" onClick={() => setTopicOpen(true)}>{channel.topic}</button></>}
        </>
      ) : (
        <>
          {channel.type === ChannelType.DM ? <Avatar userId={channel.recipients[0]} size={24} status /> : <GroupIcon channel={channel} size={24} />}
          <h1 className="header-title truncate" onClick={(e) => dmUser && openUserPopout(e.currentTarget, dmUser.id, null, 'bottom')}>{dmName}</h1>
          {channel.type === ChannelType.DM && <StreakBadge kind="dm" id={channel.id} className="in-header" />}
          {dmPresence?.customStatus && <><span className="header-divider" /><CustomStatusLine status={dmPresence.customStatus} className="header-topic truncate" /></>}
        </>
      )}
      <div className="header-actions">
        {!isGuild && <IconButton icon="phone" label={t('startCall')} onClick={() => joinVoice(channel.id)} />}
        {!isGuild && <IconButton icon="video" label={t('startVideoCall')} onClick={async () => { if (await joinVoice(channel.id)) startCamera(); }} />}
        {canFollow && <IconButton icon="megaphone" label="Follow this channel in another server" onClick={() => openFollowModal(channel.id)} />}
        {isGuild && isTextLike(channel.type) && <IconButton icon="thread" label={t('threads')} ref={threadsRef} onClick={(e) => openPopout(e.currentTarget, ({ close }) => <ThreadsPopout channel={channel} close={close} />, { placement: 'bottom', align: 'end', key: 'threads' })} />}
        <IconButton icon={muted ? 'bellOff' : 'bell'} label={muted ? t('unmuteChannel') : t('muteChannel')} onClick={toggleMute} active={muted} className="hide-sm" />
        {channel.type !== ChannelType.FORUM && <IconButton icon="pin" label={t('pinnedMessages')} ref={pinsRef} onClick={(e) => openPopout(e.currentTarget, ({ close }) => <PinsPopout channelId={channel.id} close={close} />, { placement: 'bottom', align: 'end', key: 'pins' })} />}
        {channel.type === ChannelType.GROUP_DM && <IconButton icon="userPlus" label="Add Friends to DM" onClick={() => openGroupDMModal(channel.id)} />}
        {channel.type === ChannelType.DM && <IconButton icon="userPlus" label="Create Group DM" onClick={() => openGroupDMModal(channel.id)} className="hide-sm" />}
        {(isGuild || channel.type === ChannelType.GROUP_DM) && <IconButton icon="friends" label={memberListOpen ? 'Hide Member List' : 'Show Member List'} active={memberListOpen} onClick={toggleMemberList} />}
        <SearchBox channel={channel} />
        <IconButton icon="inbox" label={t('inbox')} ref={inboxRef} onClick={(e) => openPopout(e.currentTarget, ({ close }) => <InboxPopout close={close} />, { placement: 'bottom', align: 'end', key: 'inbox' })} className="hide-sm" />
      </div>
      {topicOpen && (
        <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && setTopicOpen(false)}>
          <div className="modal modal-sm"><div className="modal-header"><h2>#{channel.name}</h2></div><div className="modal-body"><Markdown text={channel.topic} ctx={{ guildId: channel.guildId }} /></div>
            <div className="modal-footer"><Button onClick={() => setTopicOpen(false)}>Close</Button></div></div>
        </div>
      )}
    </header>
  );
}

// ================================================================ welcome headers
function ChannelWelcome({ channel }) {
  const t = useT();
  const canManage = useStore((s) => has(channelPermissions(s, channel.id), P.MANAGE_CHANNELS));
  const user = useStore((s) => (channel.type === ChannelType.DM ? s.users[channel.recipients[0]] : null));
  const name = useStore((s) => (channel.type === ChannelType.DM ? displayName(s, channel.recipients[0]) : channel.type === ChannelType.GROUP_DM ? channel.name || channel.recipients.map((r) => displayName(s, r)).join(', ') : channel.name));
  const rel = useStore((s) => (user ? s.relationships[user.id]?.type || 0 : 0));
  const mutual = useStore((s) => (user ? Object.keys(s.members).filter((g) => s.members[g][user.id]).length : 0));
  if (channel.type === ChannelType.THREAD) return null;
  if (channel.guildId) {
    return (
      <div className="channel-welcome">
        <div className="welcome-icon"><Icon name={channel.type === ChannelType.ANNOUNCEMENT ? 'megaphone' : 'hash'} size={44} /></div>
        <h2>{t('beginningOfChannel', { name: channel.name })}</h2>
        <p className="muted">{t('beginningOfChannelSub', { name: channel.name })}</p>
        {channel.type === ChannelType.ANNOUNCEMENT && <p className="muted small">An announcement channel. Write a post, then press Publish to copy it into every server that follows this channel.</p>}
        {canManage && <button className="link-btn row-center" onClick={() => openChannelSettings(channel.id)}><Icon name="edit" size={16} /> Edit Channel</button>}
      </div>
    );
  }
  if (user) {
    const relAct = async (type) => { try { if (type === 0) await api.del(`/users/@me/relationships/${user.id}`); else await api.put(`/users/@me/relationships/${user.id}`, { type }); } catch (e) { toastError(e); } };
    return (
      <div className="channel-welcome dm">
        <Avatar user={user} size={80} />
        <h2>{name}</h2>
        <div className="welcome-username">{user.username}</div>
        <p className="muted">{t('beginningOfDM', { name })}</p>
        <div className="welcome-actions">
          {mutual > 0 && <span className="muted small">{plural(mutual, 'Mutual Server')}</span>}
          {rel === 0 && <Button size="sm" onClick={() => relAct(1)}>Add Friend</Button>}
          {rel === 1 && <Button size="sm" variant="secondary" onClick={async () => { if (await confirmDialog({ title: 'Remove Friend', body: `Remove ${name} from your friends?`, confirmText: 'Remove Friend', danger: true })) relAct(0); }}>Remove Friend</Button>}
          {rel === 3 && <Button size="sm" onClick={() => relAct(1)}>Accept Friend Request</Button>}
          {rel === 4 && <Button size="sm" variant="secondary" disabled>Friend Request Sent</Button>}
          {rel === 2 ? <Button size="sm" variant="secondary" onClick={() => relAct(0)}>Unblock</Button> : <Button size="sm" variant="secondary" onClick={() => relAct(2)}>Block</Button>}
        </div>
      </div>
    );
  }
  return (
    <div className="channel-welcome dm">
      <GroupIcon channel={channel} size={80} />
      <h2>{name}</h2>
      <p className="muted">Welcome to the beginning of the <b>{name}</b> group.</p>
      <Button size="sm" variant="secondary" onClick={() => openGroupDMModal(channel.id)}>Invite Friends</Button>
    </div>
  );
}

// ================================================================ member list
function MemberList({ channel }) {
  const guildId = channel.guildId;
  const guild = useStore((s) => s.guilds[guildId]);
  const members = useStore((s) => s.members[guildId]);
  const presences = useStore((s) => s.presences);
  const groups = useMemo(() => {
    if (!guild || !members) return [];
    const permChannel = channel.type === ChannelType.THREAD ? store.get().channels[channel.parentId] || channel : channel;
    const visible = Object.values(members).filter((m) => has(computeChannelPermissions(guild, m, permChannel), P.VIEW_CHANNEL));
    const hoisted = guild.roles.filter((r) => r.hoist && r.id !== guild.id).sort((a, b) => b.position - a.position);
    const out = hoisted.map((r) => ({ id: r.id, name: r.name, members: [] }));
    const online = { id: 'online', name: 'Online', members: [] };
    const offline = { id: 'offline', name: 'Offline', members: [] };
    for (const m of visible) {
      const st = presences[m.userId]?.status || 'offline';
      if (st === 'offline') { offline.members.push(m); continue; }
      const top = hoisted.find((r) => m.roles.includes(r.id));
      (top ? out.find((g) => g.id === top.id) : online).members.push(m);
    }
    const s = store.get();
    const sortFn = (a, b) => displayName(s, a.userId, guildId).localeCompare(displayName(s, b.userId, guildId));
    return [...out, online, offline].filter((g) => g.members.length).map((g) => ({ ...g, members: g.members.sort(sortFn) }));
  }, [guild, members, presences, channel, guildId]);
  return (
    <aside className="member-list" aria-label="Members">
      {groups.map((g) => (
        <div key={g.id}>
          <h3 className="member-group">{g.name} — {g.members.length}</h3>
          {g.members.slice(0, 500).map((m) => <MemberRow key={m.userId} userId={m.userId} guildId={guildId} offline={g.id === 'offline'} owner={guild.ownerId === m.userId} />)}
        </div>
      ))}
    </aside>
  );
}

function MemberRow({ userId, guildId, offline, owner, channelId }) {
  const name = useStore((s) => displayName(s, userId, guildId));
  const color = useStore((s) => (guildId ? memberColor(s, guildId, userId) : null));
  const nameStyle = useStore((s) => s.users[userId]?.nameStyle);
  const presence = useStore((s) => s.presences[userId]);
  const timedOut = useStore((s) => !!(guildId && s.members[guildId]?.[userId]?.timeoutUntil));
  const isBot = useStore((s) => !!s.users[userId]?.bot);
  const serverTag = useStore((s) => s.users[userId]?.serverTag);
  const ns = nameStyleProps({ nameStyle }, color);
  return (
    <div className={cx('member-row', offline && 'offline')} data-pk={`ml${userId}`} onClick={(e) => openUserPopout(e.currentTarget, userId, guildId, 'left')} onContextMenu={(e) => openUserMenu(e, userId, { guildId, channelId })}>
      <Avatar userId={userId} guildId={guildId} size={32} status />
      <div className="member-text">
        <div className="member-name truncate" style={color ? { color } : undefined}><span className={cx('member-name-text', ns.className)} style={ns.style}>{name}</span><ServerTag tag={serverTag} />{isBot && <span className="bot-tag">BOT</span>}{owner && <Icon name="crown" size={14} className="owner-crown" title="Server Owner" />}{timedOut && <Icon name="clock" size={14} className="danger-icon" title="Timed out" />}</div>
        {presence?.activity && !offline ? <ActivityLine activity={presence.activity} className="tiny" /> : presence?.customStatus && !offline && <CustomStatusLine status={presence.customStatus} className="tiny truncate" />}
      </div>
    </div>
  );
}

function GroupMembers({ channel }) {
  const me = useStore((s) => s.me.id);
  const ids = [me, ...channel.recipients];
  return (
    <aside className="member-list">
      <h3 className="member-group">Members — {ids.length}</h3>
      {ids.map((id) => <div key={id} className="member-with-crown"><MemberRow userId={id} owner={channel.ownerId === id} channelId={channel.id} /></div>)}
    </aside>
  );
}

// ================================================================ pins
function PinsPopout({ channelId, close }) {
  const [pins, setPins] = useState(null);
  const channel = useStore((s) => s.channels[channelId]);
  const canManage = useStore((s) => !s.channels[channelId]?.guildId || has(channelPermissions(s, channelId), P.MANAGE_MESSAGES));
  useEffect(() => {
    const load = () => api.get(`/channels/${channelId}/pins`).then(setPins).catch(() => setPins([]));
    load();
    return on('CHANNEL_PINS_UPDATE', (d) => { if (d.channelId === channelId) load(); });
  }, [channelId]);
  return (
    <div className="popout-panel">
      <div className="popout-panel-head"><Icon name="pin" size={20} /><b>Pinned Messages</b></div>
      <div className="popout-panel-body">
        {!pins ? <Spinner /> : !pins.length ? (
          <div className="empty-state small"><Icon name="pin" size={40} /><p className="muted">This channel doesn’t have any pinned messages… yet.</p></div>
        ) : pins.map((m) => (
          <div key={m.id} className="result-card">
            <Message message={m} channel={channel} preview />
            <div className="result-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => { close(); jumpToMessage(channelId, m.id); }}>Jump</button>
              {canManage && <button className="icon-btn small" aria-label="Unpin" onClick={() => api.del(`/channels/${channelId}/pins/${m.id}`).catch(toastError)}><Icon name="x" size={16} /></button>}
            </div>
          </div>
        ))}
      </div>
      <div className="popout-panel-foot muted tiny">PROTIP: Right-click a message (or use its ⋯ menu) to pin it.</div>
    </div>
  );
}

// ================================================================ threads list
function ThreadsPopout({ channel, close }) {
  const [threads, setThreads] = useState(null);
  const canCreate = useStore((s) => has(channelPermissions(s, channel.id), P.CREATE_THREADS));
  useEffect(() => { api.get(`/channels/${channel.id}/threads`).then(setThreads).catch(() => setThreads([])); }, [channel.id]);
  const active = (threads || []).filter((t) => !t.archived);
  const archived = (threads || []).filter((t) => t.archived);
  const row = (t) => (
    <button key={t.id} className="thread-row" onClick={() => { close(); navigate(channelPath(t)); }}>
      <Icon name="thread" size={18} />
      <div className="grow left"><b className="truncate">{t.name}</b><div className="tiny muted">{t.messageCount} messages {t.locked && '· 🔒 locked'}</div></div>
    </button>
  );
  return (
    <div className="popout-panel">
      <div className="popout-panel-head"><Icon name="thread" size={20} /><b>Threads</b><span className="grow" />{canCreate && <Button size="sm" onClick={() => { close(); openCreateThread(channel.id, null); }}>Create</Button>}</div>
      <div className="popout-panel-body">
        {!threads ? <Spinner /> : !threads.length ? (
          <div className="empty-state small"><Icon name="thread" size={40} /><h3>There are no threads.</h3><p className="muted">Stay focused on a conversation with a thread — a temporary text channel.</p></div>
        ) : (
          <>
            {active.length > 0 && <><h4 className="section-label">{active.length} Active</h4>{active.map(row)}</>}
            {archived.length > 0 && <><h4 className="section-label">{archived.length} Archived</h4>{archived.map(row)}</>}
          </>
        )}
      </div>
    </div>
  );
}

// ================================================================ thread side panel
function ThreadPanel({ threadId, parentId }) {
  const thread = useStore((s) => s.channels[threadId]);
  const parent = useStore((s) => s.channels[parentId]);
  const perms = useStore((s) => channelPermissions(s, threadId));
  const myId = useStore((s) => s.me.id);
  const forum = useStore((s) => forumOfPost(s, s.channels[threadId]));   // (set when this is a post in a forum channel)
  const ownerName = useStore((s) => { const t = s.channels[threadId]; return t?.ownerId ? displayName(s, t.ownerId, t.guildId) : ''; });
  const [starter, setStarter] = useState(null);
  useEffect(() => {
    if (thread?.messageId) api.get(`/channels/${parentId}/messages/${thread.messageId}`).then(setStarter).catch(() => setStarter(null));
    else setStarter(null);
  }, [thread?.messageId, parentId]);
  useEffect(() => {
    if (!thread) {
      api.get(`/channels/${threadId}`).then((t) => store.set({ channels: { ...store.get().channels, [t.id]: t } })).catch(() => navigate(`/channels/${parent?.guildId}/${parentId}`, { replace: true }));
    }
  }, [thread, threadId, parentId, parent?.guildId]);
  const closePanel = () => navigate(`/channels/${parent?.guildId}/${parentId}`);
  if (!thread) return <aside className="thread-panel"><Spinner /></aside>;
  const canManage = has(perms, P.MANAGE_THREADS) || thread.ownerId === myId;
  return (
    <aside className="thread-panel">
      <header className="chat-header">
        <Icon name={forum ? 'forum' : 'thread'} size={20} className="header-icon" />
        <h1 className="header-title truncate" onContextMenu={(e) => openContextMenu(e, channelMenuItems(threadId))}>{thread.name}</h1>
        {thread.archived && <span className="pill">{forum ? 'Closed' : 'Archived'}</span>}
        {thread.pinned && <Icon name="pin" size={16} title="Pinned to the top of the forum" />}
        {thread.locked && <Icon name="lock" size={16} />}
        <div className="header-actions">
          {canManage && <IconButton icon="more" label={forum ? 'Post Settings' : 'Thread Settings'} onClick={(e) => openContextMenu(e, channelMenuItems(threadId))} />}
          <IconButton icon="x" label="Close" onClick={closePanel} />
        </div>
      </header>
      <div className="chat-main">
        <MessageList channelId={threadId} header={
          forum ? (
            <div className="thread-start post-start">
              <h2>{thread.name}</h2>
              <PostTags forum={forum} ids={thread.appliedTags} />
              <p className="muted small">Started by {ownerName} · {formatTimestamp(thread.createdAt)}{thread.locked ? ' · Locked' : ''}</p>
            </div>
          ) : <div className="thread-start">
            <div className="welcome-icon"><Icon name="thread" size={36} /></div>
            <h2>{thread.name}</h2>
            {starter ? <div className="thread-starter"><Message message={starter} channel={parent} preview /></div> : <p className="muted small">Started in #{parent?.name}</p>}
          </div>
        } />
        <Composer channelId={threadId} placeholder={forum ? 'Reply to this post' : `Message ${thread.name}`} compact />
      </div>
    </aside>
  );
}

// ================================================================ search
function parseSearch(q) {
  const filters = {};
  const rest = q.replace(/\b(from|mentions|has|in|before|after|pinned):("[^"]+"|\S+)/g, (m, k, v) => {
    v = v.replace(/^"|"$/g, '');
    if (k === 'has') filters.has = [...(filters.has || []), v];
    else filters[k] = v;
    return '';
  }).trim();
  return { content: rest, ...filters };
}

function SearchBox({ channel }) {
  const search = useUI((u) => u.search);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => registerAction('search', () => { ref.current?.focus(); }), []);
  useEffect(() => { if (!search) setQ(''); }, [search]);
  const submit = () => {
    if (!q.trim()) { setUI({ search: null }); return; }
    setUI({ search: { channelId: channel.id, guildId: channel.guildId, query: q.trim(), offset: 0, at: Date.now() } });
  };
  return (
    <div className={cx('search-box', (q || search) && 'active')}>
      <input ref={ref} placeholder={channel.guildId ? 'Search' : 'Search'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search messages"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setQ(''); setUI({ search: null }); e.currentTarget.blur(); } }} />
      {q || search ? <button aria-label="Clear search" onClick={() => { setQ(''); setUI({ search: null }); }}><Icon name="x" size={14} /></button> : <Icon name="search" size={14} />}
      {!search && document.activeElement === ref.current && <div className="search-hint" />}
    </div>
  );
}

function SearchPanel() {
  const search = useUI((u) => u.search);
  const [res, setRes] = useState(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('desc');
  useEffect(() => { setOffset(0); }, [search?.at]);
  useEffect(() => {
    if (!search) return;
    const s = store.get();
    const f = parseSearch(search.query);
    const params = new URLSearchParams();
    if (f.content) params.set('content', f.content);
    const findUser = (name) => {
      const n = name.replace(/^@/, '').toLowerCase();
      return Object.values(s.users).find((u) => u.username === n || (u.displayName || '').toLowerCase() === n)?.id;
    };
    if (f.from) { const id = findUser(f.from); if (id) params.set('authorId', id); else { setRes({ total: 0, messages: [], error: `No user named “${f.from}”.` }); return; } }
    if (f.mentions) { const id = findUser(f.mentions); if (id) params.set('mentions', id); }
    if (f.has) params.set('has', f.has.join(','));
    if (f.before) { const d = Date.parse(f.before); if (d) params.set('before', String(d)); }
    if (f.after) { const d = Date.parse(f.after); if (d) params.set('after', String(d)); }
    if (f.pinned) params.set('pinned', f.pinned);
    params.set('offset', String(offset));
    params.set('sort', sort);
    let path;
    if (search.guildId) {
      if (f.in) { const ch = (s.guildChannels[search.guildId] || []).map((id) => s.channels[id]).find((c) => c?.name === f.in.replace(/^#/, '')); if (ch) params.set('channelId', ch.id); }
      path = `/guilds/${search.guildId}/messages/search?${params}`;
    } else path = `/channels/${search.channelId}/messages-search?${params}`;
    setRes(null);
    api.get(path).then(setRes).catch((e) => setRes({ total: 0, messages: [], error: e.message }));
  }, [search, offset, sort]);
  if (!search) return null;
  return (
    <aside className="search-panel">
      <div className="search-panel-head">
        <b>{res ? `${res.total} Result${res.total === 1 ? '' : 's'}` : 'Searching…'}</b>
        <Tabs value={sort} onChange={(v) => { setSort(v); setOffset(0); }} tabs={[{ value: 'desc', label: 'Newest' }, { value: 'asc', label: 'Oldest' }]} />
        <IconButton icon="x" label="Close search" onClick={() => setUI({ search: null })} />
      </div>
      <div className="search-panel-body">
        {!res && <Spinner />}
        {res?.error && <p className="muted pad">{res.error}</p>}
        {res && !res.error && !res.messages.length && <div className="empty-state small"><Icon name="search" size={40} /><p className="muted">No results found. Try <code>from:username</code>, <code>has:image</code>, <code>in:channel</code>, <code>before:2025-01-01</code>.</p></div>}
        {res?.messages.map((m) => <SearchResult key={m.id} m={m} />)}
        {res && res.total > 25 && (
          <div className="pager">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Back</Button>
            <span className="muted small">Page {offset / 25 + 1} of {Math.ceil(res.total / 25)}</span>
            <Button size="sm" variant="secondary" disabled={offset + 25 >= res.total} onClick={() => setOffset(offset + 25)}>Next</Button>
          </div>
        )}
      </div>
    </aside>
  );
}

function SearchResult({ m }) {
  const ch = useStore((s) => s.channels[m.channelId]);
  const go = () => {
    if (ch) navigate(channelPath(ch));
    setTimeout(() => jumpToMessage(m.channelId, m.id), 50);
  };
  return (
    <div className="result-card" onClick={go} role="button" tabIndex={0}>
      {ch?.guildId && <div className="result-channel"><Icon name={ch.type === 11 ? 'thread' : 'hash'} size={14} />{ch.name}</div>}
      <Message message={m} channel={ch} preview />
      <div className="result-actions"><button className="btn btn-secondary btn-sm">Jump</button></div>
    </div>
  );
}

// ================================================================ inbox
function InboxPopout({ close }) {
  return (
    <div className="popout-panel inbox">
      <div className="popout-panel-head"><Icon name="inbox" size={20} /><b>Inbox</b></div>
      <InboxContent close={close} />
    </div>
  );
}

export { formatTimestamp, toast, openDM };
