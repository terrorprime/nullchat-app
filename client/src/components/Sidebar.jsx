// Server bar, channel list, DM list, voice connection panel and user panel.
import { PopoutButton } from './CallPopout.jsx';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useStore, sortedGuildChannels, guildHasUnread, guildMentionCount, isChannelUnread, isChannelMuted, displayName, guildPermissions, unreadMentionTotal,
  channelPermissions, memberColor,
} from '../lib/state.js';
import { navigate, Link } from '../lib/router.jsx';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { cx, formatDuration } from '../lib/utils.js';
import { updateSettings, getLocal, setLocal } from '../lib/settings.js';
import { useVoice, joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreen } from '../lib/voice.js';
import { openUserSettings, setUI, uiStore, useUI, isPhone, openChannelSettings } from '../lib/ui.js';
import { useReorder } from '../lib/useReorder.js';
import { planCategoryMove, planChannelMove } from '../lib/reorder.js';
import { channelPath } from '../lib/actions.js';
import { useT } from '../lib/i18n.js';
import { P, has, ChannelType, isTextLike, isVoiceLike } from '../../../shared/permissions.js';
import { Avatar, GuildIcon, IconButton, openContextMenu, openPopout, StatusDot, useLongPress } from './ui.jsx';
import { guildMenuItems, channelMenuItems, openUserMenu, applyChannelPlan } from './menus.jsx';
import { openCreateServer, openInviteModal, openCreateChannel, openQuickSwitcher, openGroupDMModal, openDownloadApps } from './modals.jsx';
import { desktop, isStandalone } from '../lib/install.js';
import { openSavedModal } from './Saved.jsx';
import { openInboxModal } from './Inbox.jsx';
import { StatusMenu, CustomStatusLine, openUserPopout } from './Profile.jsx';
import { ActivityLine } from './Extras.jsx';
import { EmojiGlyph } from './EmojiPicker.jsx';
import { Icon, Logo } from './icons.jsx';
import { useEffect } from 'react';
import { cleanFolders } from '../../../shared/community.js';
import { buildItems, sortGuildIds, changeLayout, moveItem } from '../lib/folders.js';
import { FolderIcon, useFolderCounts, folderMenuItems } from './Folders.jsx';
import { pageZoom } from '../lib/zoom.js';
import { moodById } from '../../../shared/moods.js';
import { MusicPlayer } from './Music.jsx';
import { StreakBadge } from './Streak.jsx';

// Which folders are open is remembered on this device.
const OPEN_KEY = 'nullchat.openFolders';
const readOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); } };
const writeOpen = (set) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* not remembered */ } };

// ================================================================ guild bar
/** Picks a server (or Home) in the bar. On a phone that only changes which channels the list shows; on desktop it opens it. */
function pickGuild(id) {
  if (isPhone() && uiStore.get().mobileNav) { setUI({ navGuild: id }); return; }
  navigate(id === '@me' ? '/channels/@me' : `/channels/${id}`);
}

export function GuildBar({ activeGuildId }) {
  const guilds = useStore((s) => s.guilds);
  const order = useStore((s) => s.settings?.guildOrder || []);
  const dmUnread = useStore((s) => s.privateChannelIds.filter((id) => (s.readStates[id]?.mentionCount || 0) > 0 && !isChannelMuted(s, s.channels[id])));
  const pendingCount = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 3).length);
  const rawFolders = useStore((s) => s.settings?.guildFolders);
  const [drag, setDrag] = useState(null);       // what is being dragged: { kind: 'guild' | 'folder', id }
  const [over, setOver] = useState(null);       // where it would land: { key, zone: 'before' | 'after' | 'merge' | 'end' }
  const [openIds, setOpenIds] = useState(readOpen);
  const items = useMemo(() => buildItems(sortGuildIds(guilds, order), cleanFolders(rawFolders, Object.keys(guilds))), [guilds, order, rawFolders]);
  const toggleFolder = (id) => setOpenIds((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); writeOpen(n); return n; });
  const finishDrag = () => { setDrag(null); setOver(null); };
  // Drag and drop (with a mouse): drop in the middle of a server to put the two in a folder, near its top or bottom edge to place it before or after.
  const dnd = (ref, { canMerge = false } = {}) => {
    const key = `${ref.kind}:${ref.id}`;
    return {
      draggable: true,
      onDragStart: (e) => { e.stopPropagation(); setDrag({ kind: ref.kind, id: ref.id }); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ref.id); } catch { /* ignore */ } },
      onDragEnd: finishDrag,
      onDragOver: (e) => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / Math.max(1, r.height);
        const zone = canMerge && drag.kind === 'guild' && y > 0.28 && y < 0.72 ? 'merge' : y < 0.5 ? 'before' : 'after';
        if (!over || over.key !== key || over.zone !== zone) setOver({ key, zone });
      },
      onDrop: (e) => {
        e.preventDefault(); e.stopPropagation();
        const zone = over?.key === key ? over.zone : 'before';
        const d = drag; finishDrag();
        if (d && !(d.kind === ref.kind && d.id === ref.id)) changeLayout((cur) => moveItem(cur, d, ref, zone));
      },
      dropClass: drag && over?.key === key && !(drag.kind === ref.kind && drag.id === ref.id) ? `drop-${over.zone}` : null,
    };
  };
  return (
    <nav className="guild-bar" aria-label="Servers">
      <GuildBarItem active={activeGuildId === '@me'} tooltip="Direct Messages" badge={dmUnread.length ? null : pendingCount} onClick={() => pickGuild('@me')}>
        <div className="guild-icon home"><Logo size={30} /></div>
      </GuildBarItem>
      {dmUnread.map((id) => <DMUnreadItem key={id} channelId={id} />)}
      <div className="guild-sep" />
      <div className={cx('guild-list', over?.key === 'end' && 'drop-end')}
        onDragOver={(e) => { if (drag) { e.preventDefault(); if (over?.key !== 'end') setOver({ key: 'end', zone: 'end' }); } }}
        onDrop={(e) => { e.preventDefault(); const d = drag; finishDrag(); if (d) changeLayout((cur) => moveItem(cur, d, null, 'end')); }}>
        {items.map((it) => {
          if (it.kind === 'guild') {
            const g = guilds[it.id];
            if (!g) return null;
            const t = dnd({ kind: 'guild', id: it.id }, { canMerge: true });
            return (
              <div key={it.id} className={cx('guild-drag', t.dropClass)} draggable onDragStart={t.onDragStart} onDragEnd={t.onDragEnd} onDragOver={t.onDragOver} onDrop={t.onDrop}>
                <GuildButton guild={g} active={activeGuildId === g.id} />
              </div>
            );
          }
          const members = it.guildIds.map((id) => guilds[id]).filter(Boolean);
          const isOpen = openIds.has(it.id);
          const t = dnd({ kind: 'folder', id: it.id }, { canMerge: true });
          return (
            <div key={it.id} className={cx('guild-folder', isOpen && 'open')} style={{ '--fc': it.color }}>
              <div className={cx('guild-drag', t.dropClass)} draggable onDragStart={t.onDragStart} onDragEnd={t.onDragEnd} onDragOver={t.onDragOver} onDrop={t.onDrop}>
                <FolderButton folder={it} guilds={members} open={isOpen} active={!isOpen && members.some((g) => g.id === activeGuildId)} onToggle={() => toggleFolder(it.id)} />
              </div>
              {isOpen && (
                <div className="folder-guilds">
                  {members.map((g) => {
                    const gt = dnd({ kind: 'guild', id: g.id, inFolder: it.id });
                    return (
                      <div key={g.id} className={cx('guild-drag', gt.dropClass)} draggable onDragStart={gt.onDragStart} onDragEnd={gt.onDragEnd} onDragOver={gt.onDragOver} onDrop={gt.onDrop}>
                        <GuildButton guild={g} active={activeGuildId === g.id} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <GuildBarItem tooltip="Add a Server" onClick={openCreateServer} className="green"><div className="guild-icon action"><Icon name="plus" size={24} /></div></GuildBarItem>
      <GuildBarItem tooltip="Discover" active={activeGuildId === 'discovery'} onClick={() => { navigate('/discovery'); setUI({ mobileNav: false }); }} className="green"><div className="guild-icon action"><Icon name="compass" size={24} /></div></GuildBarItem>
      {!desktop && !isStandalone() && (
        <>
          <div className="guild-sep" />
          <GuildBarItem tooltip="Download Apps" onClick={openDownloadApps} className="green"><div className="guild-icon action"><Icon name="download" size={22} /></div></GuildBarItem>
        </>
      )}
    </nav>
  );
}

function GuildBarItem({ active, unread, tooltip, badge, onClick, onContextMenu, children, className, expanded }) {
  return (
    <div className={cx('guild-item', active && 'active', unread && 'unread', className)}>
      <span className="guild-pill" />
      <button className="guild-btn" onClick={onClick} onContextMenu={onContextMenu} data-tooltip={tooltip} data-tooltip-side="right" aria-label={tooltip} aria-expanded={expanded}>
        {children}
      </button>
      {badge ? <span className="mention-badge guild-badge">{badge > 99 ? '99+' : badge}</span> : null}
    </div>
  );
}

/** A folder in the bar: closed, it shows a few of its servers' icons; a click opens it to show them one by one. */
function FolderButton({ folder, guilds, open, active, onToggle }) {
  const { unread, mentions } = useFolderCounts(folder.guildIds);
  const tooltip = folder.name || guilds.map((g) => g.name).join(', ');
  return (
    <GuildBarItem active={active} unread={unread && !open} tooltip={tooltip} badge={open ? 0 : mentions} expanded={open} onClick={onToggle} onContextMenu={(e) => openContextMenu(e, folderMenuItems(folder.id))} className="folder-item">
      <FolderIcon folder={folder} guilds={guilds} open={open} />
    </GuildBarItem>
  );
}

function GuildButton({ guild, active }) {
  const unread = useStore((s) => guildHasUnread(s, guild.id));
  const mentions = useStore((s) => (s.guildSettings[guild.id]?.muted ? 0 : guildMentionCount(s, guild.id)));
  const inVoice = useVoice((v) => v.guildId === guild.id);
  const muted = useStore((s) => !!s.guildSettings[guild.id]?.muted);
  return (
    <GuildBarItem active={active} unread={unread} tooltip={guild.name} badge={mentions}
      onClick={() => pickGuild(guild.id)} onContextMenu={(e) => openContextMenu(e, guildMenuItems(guild.id))}>
      <GuildIcon guild={guild} className={cx(muted && 'muted')} />
      {inVoice && <span className="guild-voice-indicator"><Icon name="speaker" size={10} /></span>}
    </GuildBarItem>
  );
}

function DMUnreadItem({ channelId }) {
  const ch = useStore((s) => s.channels[channelId]);
  const count = useStore((s) => s.readStates[channelId]?.mentionCount || 0);
  const name = useStore((s) => (ch?.type === ChannelType.DM ? displayName(s, ch.recipients[0]) : ch?.name || 'Group'));
  if (!ch) return null;
  return (
    <GuildBarItem tooltip={name} badge={count} unread onClick={() => { navigate(`/channels/@me/${channelId}`); setUI({ mobileNav: false }); }} onContextMenu={(e) => openContextMenu(e, channelMenuItems(channelId))}>
      {ch.type === ChannelType.DM ? <Avatar userId={ch.recipients[0]} size={48} /> : <GroupIcon channel={ch} size={48} />}
    </GuildBarItem>
  );
}

export function GroupIcon({ channel, size = 32 }) {
  if (channel.icon) return <Avatar src={channel.icon} name={channel.name || 'Group'} size={size} />;
  return <div className="avatar" style={{ width: size, height: size }}><div className="avatar-fallback group" style={{ fontSize: size * 0.45 }}><Icon name="friends" size={size * 0.55} /></div></div>;
}

// ================================================================ guild channel sidebar
/** The grip you drag a row by in Reorder mode. */
function ReorderHandle({ label, ...props }) {
  return <span className="reorder-handle" role="button" aria-label={`Drag to move ${label}`} {...props}><Icon name="menu" size={18} /></span>;
}

export function GuildSidebar({ guildId, channelId, threadId }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const layout = useStore((s) => sortedGuildChannels(s, guildId));
  const threads = useStore((s) => Object.values(s.channels).filter((c) => c.type === ChannelType.THREAD && c.guildId === guildId && !c.archived));
  const canManage = useStore((s) => has(guildPermissions(s, guildId), P.MANAGE_CHANNELS));
  const canInvite = useStore((s) => has(guildPermissions(s, guildId), P.CREATE_INVITE));
  const reorderOn = useUI((s) => s.reorderGuild === guildId) && canManage;
  const [collapsed, setCollapsed] = useState(() => getLocal().collapsedCategories || {});
  const headerRef = useRef(null);
  const scrollRef = useRef(null);
  const { view, ghostRef, rowProps, handleProps } = useReorder({
    scrollRef, layout, enabled: canManage,
    onDrop: (kind, id, drop) => applyChannelPlan(guildId, kind === 'category' ? planCategoryMove(layout, id, drop) : planChannelMove(layout, id, drop)),
  });
  // Reorder mode ends with Done, with Escape, when you leave the server, or if you lose the right to move channels.
  useEffect(() => {
    if (!reorderOn) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setUI({ reorderGuild: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reorderOn]);
  useEffect(() => () => { if (uiStore.get().reorderGuild === guildId) setUI({ reorderGuild: null }); }, [guildId]);
  useEffect(() => { if (!canManage && uiStore.get().reorderGuild === guildId) setUI({ reorderGuild: null }); }, [canManage, guildId]);
  if (!guild) return null;
  const toggleCat = (id) => { const next = { ...collapsed, [id]: !collapsed[id] }; setCollapsed(next); setLocal({ collapsedCategories: next }); };
  const openMenu = () => {
    const r = headerRef.current.getBoundingClientRect();
    openContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left + 8, clientY: r.bottom + 4, currentTarget: headerRef.current }, guildMenuItems(guildId));
  };
  const draggingCategory = view?.kind === 'category';
  const draggingChannel = view?.kind === 'channel';

  const renderChannel = (c) => (
    <div key={c.id} data-reorder-row="channel" data-id={c.id} className={cx('reorder-row', view?.id === c.id && 'dragging')} {...rowProps('channel', c)}>
      <ChannelItem channel={c} active={c.id === channelId && !threadId} reorder={reorderOn}
        handle={reorderOn && <ReorderHandle label={c.name} {...handleProps('channel', c)} />} />
      {isVoiceLike(c.type) && <VoiceUsers channelId={c.id} guildId={guildId} />}
      {isTextLike(c.type) && threads.filter((t) => t.parentId === c.id).map((t) => (
        <ThreadItem key={t.id} thread={t} active={t.id === threadId} />
      ))}
    </div>
  );

  return (
    <div className={cx('channel-sidebar', reorderOn && 'reorder-on')}>
      <header ref={headerRef} className={cx('sidebar-header guild-header', guild.banner && 'has-banner')} onClick={openMenu} role="button" tabIndex={0}
        style={guild.banner ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.45), transparent 60%), url(${guild.banner})` } : undefined}>
        <span className="truncate">{guild.name}</span>
        <StreakBadge kind="guild" id={guildId} />
        <Icon name="chevronDown" size={18} />
      </header>
      {reorderOn && (
        <div className="reorder-bar" role="status">
          <span className="reorder-bar-text">Drag the handles to move channels and categories</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setUI({ reorderGuild: null })}>Done</button>
        </div>
      )}
      <div ref={scrollRef} className="channel-scroll" onContextMenu={(e) => { if (e.target === e.currentTarget) openContextMenu(e, guildMenuItems(guildId)); }}>
        {canInvite && !reorderOn && (
          <button className="invite-cta" onClick={() => openInviteModal(guildId, channelId)}><Icon name="userPlus" size={16} /> Invite People</button>
        )}
        {draggingChannel && !layout.uncategorized.length && layout.categories.length > 0 && (
          <div data-reorder-row="zone" className={cx('reorder-zone', view.marker?.zone && 'on')}>Drop here for no category</div>
        )}
        {layout.uncategorized.map(renderChannel)}
        {layout.categories.map(({ category, channels }) => {
          const isCollapsed = collapsed[category.id];
          const visible = draggingCategory ? [] : isCollapsed ? channels.filter((c) => c.id === channelId || isVoiceLike(c.type)) : channels;
          return (
            <div key={category.id} className={cx('category', view?.id === category.id && 'dragging')}>
              <CategoryHeader category={category} guildId={guildId} collapsed={draggingCategory || !!isCollapsed} canManage={canManage} reorder={reorderOn}
                dropTarget={view?.marker?.into === category.id} dndProps={rowProps('category', category)}
                handle={reorderOn && <ReorderHandle label={category.name} {...handleProps('category', category)} />} onToggle={() => toggleCat(category.id)} />
              {visible.map(renderChannel)}
            </div>
          );
        })}
        {!layout.uncategorized.length && !layout.categories.length && <div className="muted small pad center">No channels you can see yet.</div>}
        {view?.marker?.top != null && <div className="reorder-line" style={{ top: view.marker.top }} />}
      </div>
      {view && createPortal(
        <div ref={ghostRef} className="reorder-ghost" style={{ left: view.x / pageZoom() + 12, top: view.y / pageZoom() + 8 }}>
          <Icon name={view.kind === 'category' ? 'chevronDown' : view.type === ChannelType.VOICE ? 'speaker' : view.type === ChannelType.STAGE ? 'stage' : view.type === ChannelType.ANNOUNCEMENT ? 'megaphone' : view.type === ChannelType.FORUM ? 'forum' : 'hash'} size={view.kind === 'category' ? 12 : 18} strokeWidth={view.kind === 'category' ? 3 : 2} />
          <span className="truncate">{view.label}</span>
        </div>, document.body)}
    </div>
  );
}

function CategoryHeader({ category, guildId, collapsed, canManage, reorder, dropTarget, dndProps, handle, onToggle }) {
  const longPress = useLongPress((e) => openContextMenu(e, channelMenuItems(category.id)));
  return (
    <div className={cx('category-header', dropTarget && 'drop-target')} data-reorder-row="category" data-id={category.id} {...dndProps} {...longPress}
      onClick={onToggle} onContextMenu={(e) => openContextMenu(e, channelMenuItems(category.id))}>
      <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} strokeWidth={3} />
      <span className="truncate">{category.name}</span>
      {canManage && !reorder && (
        <span className="category-actions">
          <button className="category-edit" aria-label="Edit Category" data-tooltip="Edit Category" onClick={(e) => { e.stopPropagation(); openChannelSettings(category.id); }}><Icon name="settings" size={15} /></button>
          <button className="category-add" aria-label="Create Channel" data-tooltip="Create Channel" onClick={(e) => { e.stopPropagation(); openCreateChannel(guildId, category.id); }}><Icon name="plus" size={16} /></button>
        </span>
      )}
      {handle}
    </div>
  );
}

function ChannelItem({ channel, active, reorder, handle }) {
  const unread = useStore((s) => !isVoiceLike(channel.type) && isChannelUnread(s, channel.id));
  const mentions = useStore((s) => s.readStates[channel.id]?.mentionCount || 0);
  const muted = useStore((s) => isChannelMuted(s, channel));
  const canEdit = useStore((s) => has(channelPermissions(s, channel.id), P.MANAGE_CHANNELS));
  const canInvite = useStore((s) => has(channelPermissions(s, channel.id), P.CREATE_INVITE));
  const priv = channel.overwrites?.some((o) => o.id === channel.guildId && (o.deny & P.VIEW_CHANNEL));
  const hasMusic = useStore((s) => !!s.music[channel.id]);
  const occupants = useStore((s) => (isVoiceLike(channel.type) ? Object.values(s.voiceStates).filter((v) => v.channelId === channel.id).length : 0));
  const isVoice = channel.type === ChannelType.VOICE;   // a voice channel is joined by opening it; a stage is opened first and joined from its page
  const isStage = channel.type === ChannelType.STAGE;
  const longPress = useLongPress((e) => openContextMenu(e, channelMenuItems(channel.id)));
  const onClick = (e) => {
    e.preventDefault();
    if (reorder) return; // in Reorder mode a tap does not open the channel
    if (isVoice) { joinVoice(channel.id); }
    navigate(`/channels/${channel.guildId}/${channel.id}`);
    setUI({ mobileNav: false });
  };
  return (
    <a href={`/channels/${channel.guildId}/${channel.id}`} draggable={false} className={cx('channel-item', active && 'active', unread && !muted && 'unread', muted && 'muted')}
      onClick={onClick} onContextMenu={(e) => openContextMenu(e, channelMenuItems(channel.id))} {...longPress}>
      {unread && !muted && !active && <span className="unread-pill" />}
      <span className="channel-icon">
        <Icon name={isVoice ? 'speaker' : isStage ? 'stage' : channel.type === ChannelType.ANNOUNCEMENT ? 'megaphone' : channel.type === ChannelType.FORUM ? 'forum' : 'hash'} size={20} />
        {priv && <Icon name="lock" size={10} className="channel-lock" strokeWidth={3} />}
      </span>
      <span className="channel-name truncate">{channel.name}</span>
      {isVoice && hasMusic && <span className="channel-mood" title="Music is playing">♪</span>}
      {isVoice && moodById(channel.mood) && <span className="channel-mood" title={`Room sound: ${moodById(channel.mood).name}`}>{moodById(channel.mood).emoji}</span>}
      {(isVoice || isStage) && channel.userLimit > 0 && <span className="user-limit">{String(occupants).padStart(2, '0')}/{String(channel.userLimit).padStart(2, '0')}</span>}
      {!reorder && (
        <span className="channel-actions">
          {canInvite && <button aria-label="Invite" data-tooltip="Create Invite" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openInviteModal(channel.guildId, channel.id); }}><Icon name="userPlus" size={16} /></button>}
          {canEdit && <button aria-label="Edit Channel" data-tooltip="Edit Channel" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openChannelSettings(channel.id); }}><Icon name="settings" size={16} /></button>}
        </span>
      )}
      {mentions > 0 && <span className="mention-badge">{mentions}</span>}
      {handle}
    </a>
  );
}

function ThreadItem({ thread, active }) {
  const unread = useStore((s) => isChannelUnread(s, thread.id));
  const mentions = useStore((s) => s.readStates[thread.id]?.mentionCount || 0);
  return (
    <a href={channelPath(thread)} className={cx('channel-item thread-item', active && 'active', unread && 'unread')}
      onClick={(e) => { e.preventDefault(); navigate(channelPath(thread)); setUI({ mobileNav: false }); }} onContextMenu={(e) => openContextMenu(e, channelMenuItems(thread.id))}>
      <span className="thread-spine" />
      <span className="channel-name truncate">{thread.name}</span>
      {mentions > 0 && <span className="mention-badge">{mentions}</span>}
    </a>
  );
}

function VoiceUsers({ channelId, guildId }) {
  const all = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).sort((a, b) => a.joinedAt - b.joinedAt));
  const isStage = useStore((s) => s.channels[channelId]?.type === ChannelType.STAGE);
  const speaking = useVoice((v) => (v.channelId === channelId ? v.speaking : {}));
  if (!all.length) return null;
  // A stage lists only the people on stage; the audience is a count (it can be dozens of people).
  const states = isStage ? all.filter((v) => !v.suppress) : all;
  const listening = all.length - states.length;
  return (
    <div className="voice-users">
      {states.map((v) => <VoiceUserRow key={v.userId} state={v} guildId={guildId} speaking={!!speaking[v.userId]} />)}
      {isStage && listening > 0 && <div className="stage-listening tiny muted">{states.length ? `+ ${listening} listening` : `${listening} listening`}</div>}
    </div>
  );
}

function VoiceUserRow({ state, guildId, speaking }) {
  const name = useStore((s) => displayName(s, state.userId, guildId));
  return (
    <div className="voice-user" data-pk={`vu${state.userId}`} onClick={(e) => openUserPopout(e.currentTarget, state.userId, guildId)} onContextMenu={(e) => openUserMenu(e, state.userId, { guildId })}>
      <Avatar userId={state.userId} guildId={guildId} size={24} speaking={speaking} />
      <span className="truncate grow">{name}</span>
      {state.selfStream && <span className="live-badge">LIVE</span>}
      {state.selfVideo && <Icon name="video" size={14} />}
      {(state.mute || state.suppress) ? <Icon name="micOff" size={14} className="danger-icon" /> : state.selfMute && <Icon name="micOff" size={14} />}
      {state.deaf ? <Icon name="headphonesOff" size={14} className="danger-icon" /> : state.selfDeaf && <Icon name="headphonesOff" size={14} />}
    </div>
  );
}

// ================================================================ DM sidebar
export function DMSidebar({ channelId }) {
  const t = useT();
  const ids = useStore((s) => s.privateChannelIds);
  const pending = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 3).length);
  const inboxCount = useStore((s) => unreadMentionTotal(s));
  const atFriends = !channelId;
  return (
    <div className="channel-sidebar dm-sidebar">
      <header className="sidebar-header">
        <button className="search-fake" onClick={openQuickSwitcher}>{t('findConversation')}</button>
      </header>
      <div className="channel-scroll">
        <Link to="/channels/@me" className={cx('dm-nav', atFriends && 'active')} onClick={() => setUI({ mobileNav: false })}>
          <Icon name="friends" size={22} /><span className="grow">{t('friends')}</span>{pending > 0 && <span className="mention-badge">{pending}</span>}
        </Link>
        <Link to="/discovery" className="dm-nav" onClick={() => setUI({ mobileNav: false })}><Icon name="compass" size={22} /><span className="grow">{t('discover')}</span></Link>
        <button type="button" className="dm-nav" onClick={() => { setUI({ mobileNav: false }); openInboxModal(); }}><Icon name="inbox" size={22} /><span className="grow">Inbox</span>{inboxCount > 0 && <span className="mention-badge">{inboxCount > 99 ? '99+' : inboxCount}</span>}</button>
        <button type="button" className="dm-nav" onClick={() => { setUI({ mobileNav: false }); openSavedModal(); }}><Icon name="bookmark" size={22} /><span className="grow">Saved</span></button>
        <div className="dm-heading">
          <span>{t('directMessages')}</span>
          <button className="icon-btn small" aria-label="Create DM" data-tooltip="Create DM" onClick={() => openGroupDMModal()}><Icon name="plus" size={16} /></button>
        </div>
        {ids.length === 0 && <div className="dm-empty muted small">No conversations yet. Start one from your friends list!</div>}
        {ids.map((id) => <DMItem key={id} channelId={id} active={id === channelId} />)}
      </div>
    </div>
  );
}

function DMItem({ channelId, active }) {
  const ch = useStore((s) => s.channels[channelId]);
  const name = useStore((s) => {
    if (!ch) return '';
    if (ch.type === ChannelType.DM) return displayName(s, ch.recipients[0]);
    return ch.name || ch.recipients.map((r) => displayName(s, r)).join(', ') || 'Empty Group';
  });
  const presence = useStore((s) => (ch?.type === ChannelType.DM ? s.presences[ch.recipients[0]] : null));
  const unread = useStore((s) => (s.readStates[channelId]?.mentionCount || 0));
  const inCall = useStore((s) => !!s.calls[channelId]);
  if (!ch) return null;
  const close = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ch.type === ChannelType.GROUP_DM) { openContextMenu(e, channelMenuItems(channelId)); return; }
    api.del(`/channels/${channelId}`).catch(toastError);
    if (active) navigate('/channels/@me');
  };
  return (
    <a href={`/channels/@me/${channelId}`} className={cx('dm-item', active && 'active', unread > 0 && 'unread')}
      onClick={(e) => { e.preventDefault(); navigate(`/channels/@me/${channelId}`); setUI({ mobileNav: false }); }}
      onContextMenu={(e) => openContextMenu(e, channelMenuItems(channelId))}>
      {ch.type === ChannelType.DM ? <Avatar userId={ch.recipients[0]} size={32} status /> : <GroupIcon channel={ch} size={32} />}
      <div className="dm-text">
        <div className="truncate dm-name">{name}</div>
        {ch.type === ChannelType.GROUP_DM && <div className="truncate tiny muted">{ch.recipients.length + 1} Members</div>}
        {presence?.activity && ch.type === ChannelType.DM ? <ActivityLine activity={presence.activity} className="tiny" /> : presence?.customStatus && ch.type === ChannelType.DM && <CustomStatusLine status={presence.customStatus} className="tiny truncate" />}
      </div>
      {ch.type === ChannelType.DM && <StreakBadge kind="dm" id={channelId} />}
      {inCall && <Icon name="phone" size={14} className="green-icon" />}
      {unread > 0 && <span className="mention-badge">{unread}</span>}
      <button className="dm-close" aria-label="Close DM" onClick={close}><Icon name="x" size={16} /></button>
    </a>
  );
}

// ================================================================ voice connection panel
/** What the connection is doing right now, for the tooltip on the voice status: ping, what is being sent, and any loss. */
function linkText(v) {
  if (v.ping == null) return 'Waiting for peers';
  const k = v.link || {};
  const parts = [`Ping ${v.ping} ms`];
  if (k.voiceKbps) parts.push(`voice ${k.voiceKbps} kbps`);
  if (k.video) parts.push(`video ${k.video.w}×${k.video.h}${k.video.fps ? ` at ${k.video.fps} fps` : ''}, ${k.video.kbps >= 1000 ? `${(k.video.kbps / 1000).toFixed(1)} Mbps` : `${k.video.kbps} kbps`}${k.video.limited ? ` (limited by ${k.video.limited})` : ''}`);
  if (k.loss) parts.push(`${k.loss}% lost`);
  return parts.join(' · ');
}

export function VoicePanel() {
  const v = useVoice((x) => ({ channelId: x.channelId, status: x.status, ping: x.ping, link: x.link, video: x.video, screen: x.screen, joinedAt: x.joinedAt }));
  const ch = useStore((s) => (v.channelId ? s.channels[v.channelId] : null));
  const guild = useStore((s) => (ch?.guildId ? s.guilds[ch.guildId] : null));
  const dmName = useStore((s) => (ch && !ch.guildId ? (ch.type === ChannelType.DM ? displayName(s, ch.recipients[0]) : ch.name || 'Group Call') : null));
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  if (!v.channelId) return null;
  const quality = v.ping == null ? '' : v.ping < 80 ? 'good' : v.ping < 200 ? 'ok' : 'bad';
  const label = v.status === 'connected' ? 'Voice Connected' : v.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <div className="voice-panel">
      <MusicPlayer />
      <div className="voice-panel-row">
        <div className={cx('voice-status', v.status, quality)} data-tooltip={linkText(v)} data-tooltip-side="top">
          <Icon name="signal" size={18} />
          <div>
            <div className="voice-status-label">{label}</div>
            <button className="voice-channel-link truncate" onClick={() => navigate(ch?.guildId ? `/channels/${ch.guildId}/${ch.id}` : `/channels/@me/${v.channelId}`)}>
              {ch ? (ch.guildId ? `${ch.name} / ${guild?.name}` : dmName) : '…'}
            </button>
          </div>
        </div>
        {v.joinedAt && <span className="voice-timer tiny muted">{formatDuration(Date.now() - v.joinedAt)}</span>}
        <IconButton icon="phoneOff" label="Disconnect" onClick={() => leaveVoice()} tooltipSide="top" />
      </div>
      <div className="voice-panel-buttons">
        <button className={cx('vp-btn', v.video && 'active')} onClick={toggleCamera}><Icon name={v.video ? 'video' : 'videoOff'} size={18} /> <span>{v.video ? 'Stop Video' : 'Video'}</span></button>
        <button className={cx('vp-btn', v.screen && 'active')} onClick={toggleScreen}><Icon name="screen" size={18} /> <span>{v.screen ? 'Stop' : 'Screen'}</span></button>
        <PopoutButton className="vp-btn vp-icon" size={18} />
      </div>
    </div>
  );
}

// ================================================================ user panel
export function UserPanel() {
  const t = useT();
  const me = useStore((s) => s.me);
  const status = useStore((s) => (s.me.status === 'invisible' ? 'invisible' : s.presences[s.me.id]?.status || s.me.status));
  const { selfMute, selfDeaf, noMic } = useVoice((v) => ({ selfMute: v.selfMute, selfDeaf: v.selfDeaf, noMic: v.noMic }));
  const serverMute = useStore((s) => !!s.voiceStates[s.me.id]?.mute);
  const ref = useRef(null);
  return (
    <div className="user-panel">
      <button ref={ref} className="user-panel-me" onClick={() => openPopout(ref.current, ({ close }) => <StatusMenu close={close} />, { placement: 'top', key: 'status' })}>
        <Avatar userId={me.id} size={32} />
        <StatusDot status={status} size={12} className="user-panel-status" />
        <div className="user-panel-names">
          <div className="truncate user-panel-name">{me.displayName || me.username}</div>
          <div className="truncate tiny muted user-panel-sub">
            {me.customStatus ? <>{me.customStatus.emoji && <EmojiGlyph emoji={me.customStatus.emoji} size={12} />} {me.customStatus.text}</> : t(`status_${status}`)}
          </div>
        </div>
      </button>
      <IconButton icon={selfMute || noMic || serverMute ? 'micOff' : 'mic'} label={selfMute ? t('unmute') : t('mute')} danger={selfMute || noMic || serverMute} onClick={toggleMute} tooltipSide="top" />
      <IconButton icon={selfDeaf ? 'headphonesOff' : 'headphones'} label={selfDeaf ? t('undeafen') : t('deafen')} danger={selfDeaf} onClick={toggleDeafen} tooltipSide="top" />
      <IconButton icon="settings" label={t('userSettings')} onClick={() => openUserSettings()} tooltipSide="top" />
    </div>
  );
}

export { memberColor };
