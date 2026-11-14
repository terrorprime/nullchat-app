// Context menu builders for users, servers and channels.
import { useState } from 'react';
import { api, putImage } from '../lib/api.js';
import { store, displayName, guildPermissions, channelPermissions, isChannelMuted, sortedGuildChannels } from '../lib/state.js';
import { ackChannel, ackGuild, openDM } from '../lib/actions.js';
import { openCatchUp } from '../lib/catchup.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { copyText, inviteUrl } from '../lib/utils.js';
import { getSetting, getLocal } from '../lib/settings.js';
import { isCloseFriend, toggleCloseFriend } from '../lib/closeFriends.js';
import { openModFile, isModeratorHere } from './ModFile.jsx';
import { plainSoundMenuItem } from './VoiceSounds.jsx';
import { joinVoice, setUserVolume, setLocalMute, voiceStore, stageCommand } from '../lib/voice.js';
import { openGuildSettings, openChannelSettings, setUI } from '../lib/ui.js';
import { planCategoryMove, planChannelMove, planChannelStep, resolveCategoryDrop, canStep } from '../lib/reorder.js';
import { P, has, ChannelType, highestRolePosition, isVoiceLike } from '../../../shared/permissions.js';
import { confirmDialog, promptDialog, openContextMenu, Slider, pickFile } from './ui.jsx';
import { openPostEditor, forumOfPost } from './ForumTools.jsx';
import { openNewPost } from './Forum.jsx';
import { openInviteModal, openCreateChannel, openModeration, changeNickname, openGroupDMModal, canManageGuild } from './modals.jsx';
import { openProfileModal } from './Profile.jsx';
import { canFollowChannel, openFollowModal } from './Community.jsx';
import { serverFolderItems } from './Folders.jsx';
import { openLeaderboard, openBoost } from './Extras.jsx';

const sep = { type: 'separator' };
const devItem = (label, id) => (getSetting('developerMode') ? { label, icon: 'copy', onClick: () => { copyText(id); toast('Copied to clipboard', 'success', 1500); } } : null);

export function insertIntoComposer(text) {
  window.dispatchEvent(new CustomEvent('nullchat:insert', { detail: text }));
}

function VolumeSlider({ userId }) {
  const [v, setV] = useState(getLocal().userVolumes[userId] ?? 100);
  return (
    <div className="menu-slider">
      <div className="menu-slider-label">User Volume</div>
      <Slider value={v} min={0} max={200} onChange={(x) => { setV(x); setUserVolume(userId, x); }} format={(x) => `${x}%`} />
    </div>
  );
}

async function setRel(userId, type) {
  try {
    if (type === 0) await api.del(`/users/@me/relationships/${userId}`);
    else await api.put(`/users/@me/relationships/${userId}`, { type });
    if (type === 1) toast('Friend request sent.', 'success');
  } catch (e) { toastError(e); }
}

export function userMenuItems(userId, { guildId = null, channelId = null, inProfile = false } = {}) {
  const s = store.get();
  const me = s.me.id;
  const self = userId === me;
  const rel = s.relationships[userId]?.type || 0;
  const isBot = !!s.users[userId]?.bot; // bots: no friends, no DMs, no calls
  const items = [];
  if (!inProfile) items.push({ label: 'Profile', onClick: () => openProfileModal(userId, guildId) });
  items.push({ label: 'Mention', onClick: () => insertIntoComposer(`<@${userId}> `) });
  if (!self && !isBot) {
    items.push({ label: 'Message', onClick: () => openDM(userId) });
    if (rel !== 2) items.push({ label: 'Call', onClick: async () => { const dm = await openDM(userId); if (dm) joinVoice(dm.id); } });
  }
  // Voice controls
  const myVoice = voiceStore.get().channelId;
  const theirVoice = s.voiceStates[userId];
  if (!self && myVoice && theirVoice?.channelId === myVoice) {
    items.push(sep, { render: () => <VolumeSlider userId={userId} /> });
    items.push({ label: 'Mute', checked: !!getLocal().localMutes[userId], onClick: () => setLocalMute(userId, !getLocal().localMutes[userId]) });
    if (s.users[userId]?.voiceSounds?.join || s.users[userId]?.voiceSounds?.leave || getLocal().plainSoundFor?.[userId]) items.push(plainSoundMenuItem(userId));
  }
  // Group DM owner tools
  const ch = channelId ? s.channels[channelId] : null;
  if (ch?.type === ChannelType.GROUP_DM && ch.ownerId === me && !self) {
    items.push(sep, { label: 'Remove From Group', danger: true, onClick: () => api.del(`/channels/${ch.id}/recipients/${userId}`).catch(toastError) });
  }
  // Server tools
  if (guildId && s.members[guildId]?.[userId]) {
    const g = s.guilds[guildId];
    const perms = guildPermissions(s, guildId);
    const actor = s.members[guildId][me];
    const target = s.members[guildId][userId];
    const above = g.ownerId === me || highestRolePosition(g, actor) > highestRolePosition(g, target);
    items.push(sep);
    if ((self && has(perms, P.CHANGE_NICKNAME)) || (!self && has(perms, P.MANAGE_NICKNAMES) && above)) items.push({ label: 'Change Nickname', onClick: () => changeNickname(guildId, userId) });
    if (has(perms, P.MANAGE_ROLES)) {
      const myTop = highestRolePosition(g, actor);
      const roles = g.roles.filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position);
      if (roles.length) {
        items.push({
          label: 'Roles',
          items: roles.map((r) => ({
            label: <span><span className="role-dot" style={{ background: r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--text-muted)' }} /> {r.name}</span>,
            checked: target.roles.includes(r.id),
            disabled: r.position >= myTop && g.ownerId !== me,
            onClick: () => {
              const cur = store.get().members[guildId][userId].roles;
              api.patch(`/guilds/${guildId}/members/${userId}`, { roles: cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id] }).catch(toastError);
            },
          })),
        });
      }
    }
    if (theirVoice?.guildId === guildId) {
      // On a stage: people who run it (and are on it themselves) choose who speaks.
      const myVoice = s.voiceStates[s.me.id];
      if (myVoice && myVoice.channelId === theirVoice.channelId && s.channels[theirVoice.channelId]?.type === ChannelType.STAGE && has(perms, P.MUTE_MEMBERS) && !self) {
        items.push(theirVoice.suppress
          ? { label: 'Invite to Speak', icon: 'mic', onClick: () => stageCommand('speak', { userId }) }
          : { label: 'Move to Audience', icon: 'userMinus', onClick: () => stageCommand('audience', { userId }) });
      }
      if (has(perms, P.MUTE_MEMBERS)) items.push({ label: 'Server Mute', checked: !!theirVoice.mute, onClick: () => api.patch(`/guilds/${guildId}/members/${userId}`, { mute: !theirVoice.mute }).catch(toastError) });
      if (has(perms, P.DEAFEN_MEMBERS)) items.push({ label: 'Server Deafen', checked: !!theirVoice.deaf, onClick: () => api.patch(`/guilds/${guildId}/members/${userId}`, { deaf: !theirVoice.deaf }).catch(toastError) });
      if (has(perms, P.MOVE_MEMBERS)) {
        const voiceChans = (s.guildChannels[guildId] || []).map((id) => s.channels[id]).filter((c) => c && isVoiceLike(c.type) && c.id !== theirVoice.channelId);
        if (voiceChans.length) items.push({ label: 'Move To', items: voiceChans.map((c) => ({ label: c.name, onClick: () => api.patch(`/guilds/${guildId}/members/${userId}`, { channelId: c.id }).catch(toastError) })) });
        items.push({ label: 'Disconnect', danger: true, onClick: () => api.patch(`/guilds/${guildId}/members/${userId}`, { disconnect: true }).catch(toastError) });
      }
    }
    if (!self && !isBot && isModeratorHere(perms)) {
      if (has(perms, P.MODERATE_MEMBERS) && above && g.ownerId !== userId) items.push({ label: `Warn ${displayName(s, userId, guildId)}`, danger: true, onClick: () => openModFile(guildId, userId, { warn: true }) });
      items.push({ label: 'Warnings and Notes', icon: 'shield', onClick: () => openModFile(guildId, userId) });
    }
    if (!self && above && g.ownerId !== userId) {
      if (has(perms, P.MODERATE_MEMBERS) && !isBot) {
        items.push(target.timeoutUntil
          ? { label: 'Remove Timeout', onClick: () => api.patch(`/guilds/${guildId}/members/${userId}`, { timeoutUntil: null }).catch(toastError) }
          : { label: `Timeout ${displayName(s, userId, guildId)}`, danger: true, onClick: () => openModeration('timeout', guildId, userId) });
      }
      if (has(perms, P.KICK_MEMBERS)) items.push({ label: `${isBot ? 'Remove' : 'Kick'} ${displayName(s, userId, guildId)}`, danger: true, onClick: () => openModeration('kick', guildId, userId) });
      if (has(perms, P.BAN_MEMBERS) && !isBot) items.push({ label: `Ban ${displayName(s, userId, guildId)}`, danger: true, onClick: () => openModeration('ban', guildId, userId) });
    }
  }
  if (!self && !isBot) {
    items.push(sep);
    if (rel === 0) items.push({ label: 'Add Friend', onClick: () => setRel(userId, 1) });
    if (rel === 3) items.push({ label: 'Accept Friend Request', onClick: () => setRel(userId, 1) });
    if (rel === 4) items.push({ label: 'Cancel Friend Request', onClick: () => setRel(userId, 0) });
    if (rel === 1) items.push({ label: 'Close Friend', icon: 'star', checked: isCloseFriend(s, userId), onClick: () => toggleCloseFriend(userId) });
    if (rel === 1) items.push({ label: 'Remove Friend', danger: true, onClick: async () => { if (await confirmDialog({ title: `Remove '${displayName(s, userId)}'`, body: 'Are you sure you want to remove them from your friends?', confirmText: 'Remove Friend', danger: true })) setRel(userId, 0); } });
    items.push(rel === 2
      ? { label: 'Unblock', onClick: () => setRel(userId, 0) }
      : { label: 'Block', danger: true, onClick: async () => { if (await confirmDialog({ title: `Block ${displayName(s, userId)}?`, body: 'They won’t be able to message you, and their messages will be hidden. They will be removed from your friends.', confirmText: 'Block', danger: true })) setRel(userId, 2); } });
  }
  items.push(sep, devItem('Copy User ID', userId));
  return items.filter(Boolean);
}

export function openUserMenu(e, userId, opts) { openContextMenu(e, userMenuItems(userId, opts)); }

function notifSubmenu(guildId, channelId) {
  const s = store.get();
  const gs = s.guildSettings[guildId] || { notifications: 0, muted: false, suppressEveryone: false, channelOverrides: {} };
  const patch = (body) => api.patch(`/users/@me/guilds/${guildId}/settings`, body).catch(toastError);
  if (channelId) {
    const cur = gs.channelOverrides?.[channelId]?.notifications ?? -1;
    return [
      { label: 'Use Server Default', checked: cur === -1, onClick: () => patch({ channelOverrides: { [channelId]: { notifications: -1 } } }) },
      { label: 'All Messages', checked: cur === 0, onClick: () => patch({ channelOverrides: { [channelId]: { notifications: 0 } } }) },
      { label: 'Only @mentions', checked: cur === 1, onClick: () => patch({ channelOverrides: { [channelId]: { notifications: 1 } } }) },
      { label: 'Nothing', checked: cur === 2, onClick: () => patch({ channelOverrides: { [channelId]: { notifications: 2 } } }) },
    ];
  }
  return [
    { label: 'All Messages', checked: gs.notifications === 0, onClick: () => patch({ notifications: 0 }) },
    { label: 'Only @mentions', checked: gs.notifications === 1, onClick: () => patch({ notifications: 1 }) },
    { label: 'Nothing', checked: gs.notifications === 2, onClick: () => patch({ notifications: 2 }) },
    sep,
    { label: 'Suppress @everyone and @here', checked: !!gs.suppressEveryone, onClick: () => patch({ suppressEveryone: !gs.suppressEveryone }) },
  ];
}

export function guildMenuItems(guildId) {
  const s = store.get();
  const g = s.guilds[guildId];
  if (!g) return [];
  const perms = guildPermissions(s, guildId);
  const gs = s.guildSettings[guildId];
  const owner = g.ownerId === s.me.id;
  return [
    { label: 'Mark As Read', onClick: () => ackGuild(guildId) },
    { label: 'Catch Up', icon: 'inbox', onClick: () => openCatchUp(guildId) },
    sep,
    has(perms, P.CREATE_INVITE) && { label: 'Invite People', onClick: () => openInviteModal(guildId) },
    { label: 'Leaderboard', icon: 'trophy', onClick: () => openLeaderboard(guildId) },
    { label: g.boostLevel ? `Boost Server (Level ${g.boostLevel})` : 'Boost Server', icon: 'rocket', onClick: () => openBoost(guildId) },
    sep,
    { label: gs?.muted ? 'Unmute Server' : 'Mute Server', onClick: () => api.patch(`/users/@me/guilds/${guildId}/settings`, { muted: !gs?.muted }).catch(toastError) },
    { label: 'Notification Settings', items: notifSubmenu(guildId) },
    ...serverFolderItems(guildId),
    sep,
    canManageGuild(s, guildId) && { label: 'Server Settings', icon: 'settings', onClick: () => openGuildSettings(guildId) },
    has(perms, P.MANAGE_CHANNELS) && { label: 'Create Channel', onClick: () => openCreateChannel(guildId) },
    has(perms, P.MANAGE_CHANNELS) && { label: 'Create Category', onClick: () => openCreateChannel(guildId, null, ChannelType.CATEGORY) },
    has(perms, P.MANAGE_CHANNELS) && { label: 'Reorder Channels', icon: 'menu', onClick: () => startReorder(guildId) },
    has(perms, P.CHANGE_NICKNAME) && { label: 'Edit Server Profile', onClick: () => changeNickname(guildId, s.me.id) },
    sep,
    !owner && { label: 'Leave Server', danger: true, onClick: () => leaveGuild(guildId) },
    devItem('Copy Server ID', guildId),
  ].filter(Boolean);
}

export async function leaveGuild(guildId) {
  const g = store.get().guilds[guildId];
  const ok = await confirmDialog({ title: `Leave '${g.name}'`, body: <>Are you sure you want to leave <b>{g.name}</b>? You won’t be able to rejoin unless you are re-invited.</>, confirmText: 'Leave Server', danger: true });
  if (!ok) return;
  try { await api.del(`/users/@me/guilds/${guildId}`); navigate('/channels/@me'); }
  catch (e) { toastError(e); }
}

export function channelMenuItems(channelId) {
  const s = store.get();
  const ch = s.channels[channelId];
  if (!ch) return [];
  const me = s.me.id;
  if (!ch.guildId) {
    const isGroup = ch.type === ChannelType.GROUP_DM;
    const other = !isGroup ? ch.recipients[0] : null;
    const gs = s.guildSettings['@me'];
    const muted = !!gs?.channelOverrides?.[ch.id]?.muted;
    return [
      { label: 'Mark As Read', onClick: () => ackChannel(ch.id, true) },
      other && { label: 'Profile', onClick: () => openProfileModal(other) },
      { label: 'Call', onClick: () => { navigate(`/channels/@me/${ch.id}`); joinVoice(ch.id); } },
      isGroup && { label: 'Add Friends', onClick: () => openGroupDMModal(ch.id) },
      isGroup && { label: 'Change Name', onClick: async () => { const n = await promptDialog({ title: 'Change Group Name', label: 'Group Name', initial: ch.name || '' }); if (n !== null) api.patch(`/channels/${ch.id}`, { name: n }).catch(toastError); } },
      isGroup && { label: 'Change Icon', onClick: async () => { const f = await pickFile('image/png,image/jpeg,image/gif,image/webp'); if (f) putImage(`/channels/${ch.id}/icon`, f).catch(toastError); } },
      isGroup && ch.icon && { label: 'Remove Icon', onClick: () => api.patch(`/channels/${ch.id}`, { icon: null }).catch(toastError) },
      sep,
      { label: muted ? 'Unmute Conversation' : 'Mute Conversation', onClick: () => api.patch('/users/@me/guilds/@me/settings', { channelOverrides: { [ch.id]: { muted: !muted } } }).catch(toastError) },
      sep,
      isGroup
        ? { label: 'Leave Group', danger: true, onClick: async () => { if (await confirmDialog({ title: 'Leave Group', body: 'Are you sure you want to leave this group? You won’t be able to rejoin unless you are re-added.', confirmText: 'Leave Group', danger: true })) { await api.del(`/channels/${ch.id}`).catch(toastError); navigate('/channels/@me'); } } }
        : { label: 'Close DM', onClick: () => { api.del(`/channels/${ch.id}`).catch(toastError); if (location.pathname.includes(ch.id)) navigate('/channels/@me'); } },
      other && { label: s.relationships[other]?.type === 2 ? 'Unblock' : 'Block', danger: s.relationships[other]?.type !== 2, onClick: () => setRel(other, s.relationships[other]?.type === 2 ? 0 : 2) },
      devItem('Copy Channel ID', ch.id),
    ].filter(Boolean);
  }
  const perms = channelPermissions(s, ch.id);
  const gperms = guildPermissions(s, ch.guildId);
  const muted = isChannelMuted(s, ch);
  const isCat = ch.type === ChannelType.CATEGORY;
  const isThread = ch.type === ChannelType.THREAD;
  const forumOfThread = isThread ? forumOfPost(s, ch) : null;   // (a post in a forum channel)
  const isForum = ch.type === ChannelType.FORUM;
  const canManage = isThread ? (has(perms, P.MANAGE_THREADS) || ch.ownerId === me) : has(perms, P.MANAGE_CHANNELS);
  const canDelete = isThread ? (has(perms, P.MANAGE_THREADS) || (!!forumOfThread && ch.ownerId === me)) : has(perms, P.MANAGE_CHANNELS);
  const thing = isCat ? 'Category' : forumOfThread ? 'Post' : isThread ? 'Thread' : 'Channel';
  const layout = sortedGuildChannels(s, ch.guildId);
  const cats = layout.categories.map((c) => c.category);
  const catCount = cats.length;
  const catIndex = isCat ? cats.findIndex((c) => c.id === ch.id) : -1;
  return [
    !isCat && { label: 'Mark As Read', onClick: () => ackChannel(ch.id, true) },
    sep,
    !isCat && !isThread && has(perms, P.CREATE_INVITE) && { label: 'Invite People', onClick: () => openInviteModal(ch.guildId, ch.id) },
    !isCat && { label: 'Copy Link', onClick: () => { copyText(`${location.origin}/channels/${ch.guildId}/${isThread ? `${ch.parentId}?thread=${ch.id}` : ch.id}`); toast('Link copied', 'success', 1500); } },
    sep,
    { label: muted ? `Unmute ${isCat ? 'Category' : 'Channel'}` : `Mute ${isCat ? 'Category' : 'Channel'}`, onClick: () => api.patch(`/users/@me/guilds/${ch.guildId}/settings`, { channelOverrides: { [ch.id]: { muted: !muted } } }).catch(toastError) },
    !isCat && !isVoiceLike(ch.type) && { label: 'Notification Settings', items: notifSubmenu(ch.guildId, ch.id) },
    sep,
    forumOfThread && canManage && { label: 'Edit Post', icon: 'edit', onClick: () => openPostEditor(ch.id) },
    isForum && has(perms, P.CREATE_THREADS) && { label: 'New Post', icon: 'plus', onClick: () => { navigate(`/channels/${ch.guildId}/${ch.id}`); openNewPost(ch.id); } },
    forumOfThread && has(perms, P.MANAGE_THREADS) && !ch.archived && { label: ch.pinned ? 'Unpin Post' : 'Pin Post', icon: 'pin', onClick: () => api.patch(`/channels/${ch.id}`, { pinned: !ch.pinned }).then(() => toast(ch.pinned ? 'Post unpinned' : 'Post pinned to the top', 'success', 1800)).catch(toastError) },
    isThread && canManage && { label: forumOfThread ? (ch.archived ? 'Reopen Post' : 'Close Post') : (ch.archived ? 'Unarchive Thread' : 'Archive Thread'), onClick: () => api.patch(`/channels/${ch.id}`, { archived: !ch.archived }).catch(toastError) },
    isThread && has(perms, P.MANAGE_THREADS) && { label: ch.locked ? `Unlock ${forumOfThread ? 'Post' : 'Thread'}` : `Lock ${forumOfThread ? 'Post' : 'Thread'}`, onClick: () => api.patch(`/channels/${ch.id}`, { locked: !ch.locked }).catch(toastError) },
    !isThread && canManage && { label: `Edit ${isCat ? 'Category' : 'Channel'}`, icon: 'settings', onClick: () => openChannelSettings(ch.id) },
    isCat && canManage && { label: 'Rename Category', onClick: () => renameCategory(ch.id) },
    isCat && canManage && { label: 'Move Up', disabled: catIndex <= 0, onClick: () => moveCategory(ch.id, -1) },
    isCat && canManage && { label: 'Move Down', disabled: catIndex < 0 || catIndex >= catCount - 1, onClick: () => moveCategory(ch.id, 1) },
    !isCat && !isThread && canManage && { label: 'Move Up', disabled: !canStep(layout, ch.id, -1), onClick: () => moveChannelStep(ch.id, -1) },
    !isCat && !isThread && canManage && { label: 'Move Down', disabled: !canStep(layout, ch.id, 1), onClick: () => moveChannelStep(ch.id, 1) },
    !isThread && canManage && { label: 'Reorder Channels', icon: 'menu', onClick: () => startReorder(ch.guildId) },
    !isCat && !isThread && canManage && catCount > 0 && { label: 'Move to Category', items: [
      { label: 'No category', checked: !ch.parentId, onClick: () => moveChannelToCategory(ch.id, null) },
      ...cats.map((c) => ({ label: c.name, checked: ch.parentId === c.id, onClick: () => moveChannelToCategory(ch.id, c.id) })),
    ] },
    isCat && has(gperms, P.MANAGE_CHANNELS) && { label: 'Create Text Channel', onClick: () => openCreateChannel(ch.guildId, ch.id, 0) },
    isCat && has(gperms, P.MANAGE_CHANNELS) && { label: 'Create Voice Channel', onClick: () => openCreateChannel(ch.guildId, ch.id, 2) },
    isCat && has(gperms, P.MANAGE_CHANNELS) && { label: 'Create Forum Channel', onClick: () => openCreateChannel(ch.guildId, ch.id, 15) },
    isCat && has(gperms, P.MANAGE_CHANNELS) && { label: 'Create Announcement Channel', onClick: () => openCreateChannel(ch.guildId, ch.id, 5) },
    isCat && has(gperms, P.MANAGE_CHANNELS) && { label: 'Create Stage Channel', onClick: () => openCreateChannel(ch.guildId, ch.id, 13) },
    ch.type === ChannelType.VOICE && { label: 'Join Voice', onClick: () => { joinVoice(ch.id); navigate(`/channels/${ch.guildId}/${ch.id}`); } },
    ch.type === ChannelType.STAGE && { label: 'Open Stage', icon: 'stage', onClick: () => navigate(`/channels/${ch.guildId}/${ch.id}`) },
    ch.type === ChannelType.ANNOUNCEMENT && canFollowChannel(s, ch) && { label: 'Follow in Another Server', icon: 'megaphone', onClick: () => openFollowModal(ch.id) },
    canDelete && { label: `Delete ${thing}`, danger: true, onClick: () => deleteChannel(ch.id) },
    sep,
    devItem('Copy Channel ID', ch.id),
  ].filter(Boolean);
}

export async function renameCategory(categoryId) {
  const ch = store.get().channels[categoryId];
  if (!ch) return;
  const name = await promptDialog({ title: 'Rename Category', label: 'Category Name', initial: ch.name || '', confirmText: 'Save' });
  if (name === null || !name.trim() || name.trim() === ch.name) return;
  try { await api.patch(`/channels/${categoryId}`, { name: name.trim() }); } catch (e) { toastError(e); }
}

/**
 * Save a new channel/category order: shown on screen straight away, then sent to the server; if the server says no it goes back.
 * `updates` is the list [{ id, position, parentId? }] that PATCH /guilds/:id/channels takes.
 */
export async function applyChannelPlan(guildId, updates) {
  if (!updates?.length) return true;
  const before = {};
  store.set((s) => {
    const channels = { ...s.channels };
    for (const u of updates) {
      const c = channels[u.id];
      if (!c) continue;
      before[u.id] = c;
      channels[u.id] = { ...c, position: u.position, ...(u.parentId !== undefined && c.type !== ChannelType.CATEGORY ? { parentId: u.parentId } : {}) };
    }
    return { channels };
  });
  try { await api.patch(`/guilds/${guildId}/channels`, updates); return true; } catch (e) {
    store.set((s) => ({ channels: { ...s.channels, ...Object.fromEntries(Object.entries(before).filter(([id]) => s.channels[id])) } }));
    toastError(e);
    return false;
  }
}

/** Phones have no mouse to drag with: this turns on the list's "Reorder" mode, where every row gets a handle to drag by. */
export function startReorder(guildId) { setUI({ reorderGuild: guildId }); }

/** Swap a category with its neighbour (dir = -1 up, +1 down). */
export async function moveCategory(categoryId, dir) {
  const s = store.get();
  const cat = s.channels[categoryId];
  if (!cat) return;
  const layout = sortedGuildChannels(s, cat.guildId);
  const cats = layout.categories.map((c) => c.category);
  const i = cats.findIndex((c) => c.id === categoryId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cats.length) return;
  const drop = resolveCategoryDrop(layout, categoryId, cats[j].id, dir > 0);
  await applyChannelPlan(cat.guildId, planCategoryMove(layout, categoryId, drop));
}

/** One step up or down among the channels of its own kind, inside its category. */
export async function moveChannelStep(channelId, dir) {
  const s = store.get();
  const ch = s.channels[channelId];
  if (!ch?.guildId) return;
  await applyChannelPlan(ch.guildId, planChannelStep(sortedGuildChannels(s, ch.guildId), channelId, dir));
}

/** Put a channel at the bottom of a category (or of the uncategorized list when parentId is null). */
export async function moveChannelToCategory(channelId, parentId) {
  const s = store.get();
  const ch = s.channels[channelId];
  if (!ch || (ch.parentId || null) === parentId) return;
  const layout = sortedGuildChannels(s, ch.guildId);
  const drop = { parentId, index: Infinity, noop: false };
  await applyChannelPlan(ch.guildId, planChannelMove(layout, channelId, drop));
}

export async function deleteChannel(channelId) {
  const ch = store.get().channels[channelId];
  const kind = ch.type === ChannelType.CATEGORY ? 'Category' : ch.type === ChannelType.THREAD ? (store.get().channels[ch.parentId]?.type === ChannelType.FORUM ? 'Post' : 'Thread') : 'Channel';
  const ok = await confirmDialog({ title: `Delete ${kind}`, body: <>Are you sure you want to delete <b>{ch.type === 0 || ch.type === 5 || ch.type === 15 ? '#' : ''}{ch.name}</b>? This cannot be undone.</>, confirmText: `Delete ${kind}`, danger: true });
  if (!ok) return;
  try {
    await api.del(`/channels/${channelId}`);
    if (location.pathname.includes(channelId)) navigate(`/channels/${ch.guildId}`);
  } catch (e) { toastError(e); }
}

export { inviteUrl };
