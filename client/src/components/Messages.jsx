// Message list and message rendering.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, store, displayName, authorName, sameSender, memberColor, channelPermissions } from '../lib/state.js';
import { loadMessages, loadNewer, ackChannel, jumpToMessage, toggleReaction, markUnread, removeFailedMessage, sendMessage } from '../lib/actions.js';
import { dismissEphemeral } from '../lib/bots.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { saveFile, downloadUrl } from '../lib/saveFile.js';
import { cx, formatTimestamp, formatMessageTime, formatTime, formatFull, formatDate, formatShortDate, sameDay, formatBytes, copyText, idTime } from '../lib/utils.js';
import { Markdown, toPlainText } from '../lib/markdown.jsx';
import { getSetting, useSettingValue } from '../lib/settings.js';
import { setUI, useUI, setReply, isPhone } from '../lib/ui.js';
import { QuietNote, startQuietReply, quietAllowed } from './Quiet.jsx';
import { useT } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';
import { replaceShortcodes, DEFAULT_RECENT, getRecent, parseCustomKey } from '../lib/emoji.js';
import { mentionContext, encodeMentions, decodeMentions, typedMentionSpans } from '../lib/mentionText.js';
import { MentionTextarea } from './MentionField.jsx';
import { P, has, ChannelType, isTextLike } from '../../../shared/permissions.js';
import { ServerTag } from './ServerTag.jsx';
import { Avatar, GuildIcon, Spinner, openContextMenu, openPopout, confirmDialog, openImageViewer, IconButton, useLongPress } from './ui.jsx';
import { publishAnnouncement } from './Community.jsx';
import { EmojiPicker, EmojiGlyph } from './EmojiPicker.jsx';
import { nameStyleProps } from '../lib/perks.js';
import { openUserPopout } from './Profile.jsx';
import { openUserMenu } from './menus.jsx';
import { openCreateThread } from './modals.jsx';
import { PollCard } from './Poll.jsx';
import { MessageComponents } from './BotComponents.jsx';
import { InviteCards } from './InviteCard.jsx';
import { inviteLinksIn } from '../lib/invites.js';
import { reminderMenuItems } from './Reminder.jsx';
import { toggleSaved } from '../lib/saved.js';
import { gifLinkOf, findFavoriteByLink, toggleChatGif } from '../lib/gifFavorites.js';
import { ChatGif } from './ChatGif.jsx';
import { Icon } from './icons.jsx';
import { pageZoom } from '../lib/zoom.js';

const GROUP_WINDOW = 7 * 60 * 1000;

// ================================================================ list
export function MessageList({ channelId, header }) {
  const t = useT();
  const entry = useStore((s) => s.messages[channelId]);
  const channel = useStore((s) => s.channels[channelId]);
  const myId = useStore((s) => s.me.id);
  const blocked = useStore((s) => s.relationships);
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevHeightRef = useRef(0);
  const prevFirstIdRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadMarker, setUnreadMarker] = useState(null);
  const [markedByHand, setMarkedByHand] = useState(false);   // "Mark Unread" was used here: the line is drawn even before one's own message, and the channel stays unread while it is on screen
  const [highlight, setHighlight] = useState(null);

  // Snapshot the read marker when the channel opens.
  useEffect(() => {
    const s = store.get();
    const rs = s.readStates[channelId];
    const ch = s.channels[channelId];
    setUnreadMarker(ch?.lastMessageId && rs?.lastReadId && ch.lastMessageId > rs.lastReadId ? rs.lastReadId : null);
    setMarkedByHand(false);
    atBottomRef.current = true;
    setAtBottom(true);
    loadMessages(channelId);
  }, [channelId]);
  // Everything is loaded again after the connection is rebuilt (a deploy, a laptop waking up, a long network drop), which empties this list:
  // fetch it again, whenever it is not there, not only when the channel is first opened (it showed the loading placeholder forever).
  useEffect(() => {
    if (!entry?.loaded && !entry?.loading) loadMessages(channelId);
  }, [channelId, entry?.loaded, entry?.loading]);

  const list = entry?.list || [];

  // Swiping a message on a phone replies to it.
  useEffect(() => {
    const onSwipeReply = (e) => {
      const m = (store.get().messages[channelId]?.list || []).find((x) => x.id === e.detail?.id);
      if (m) startReply(m);
    };
    window.addEventListener('nullchat:swipe-reply', onSwipeReply);
    return () => window.removeEventListener('nullchat:swipe-reply', onSwipeReply);
  }, [channelId]);

  // Keep scroll position: stick to bottom, or preserve position when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = list[0]?.id;
    // Older messages were added at the top: keep what was on screen where it was. (A list that was replaced by another one, such as the newest
    // messages after jumping to an old one, does not contain the old first message: that is not "older ones added", so it falls through.)
    const prevFirstStillThere = prevFirstIdRef.current && firstId !== prevFirstIdRef.current && prevHeightRef.current && !entry?.focusId
      ? list.findIndex((m) => m.id === prevFirstIdRef.current) : -1;
    if (prevFirstStillThere > 0) el.scrollTop += el.scrollHeight - prevHeightRef.current;
    else if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    prevFirstIdRef.current = firstId;
    prevHeightRef.current = el.scrollHeight;
  });

  // Jump to a focused message (reply click, search result, pin).
  useEffect(() => {
    if (!entry?.focusId) return;
    const el = scrollRef.current?.querySelector(`[data-mid="${entry.focusId}"]`);
    if (el) {
      atBottomRef.current = false;
      el.scrollIntoView({ block: 'center' });
      setHighlight(entry.focusId);
      const tm = setTimeout(() => setHighlight(null), 2200);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [entry?.focusId, entry?.focusAt]);

  // Re-stick to the bottom when images load etc.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => { if (atBottomRef.current) el.scrollTop = el.scrollHeight; });
    for (const child of el.children) ro.observe(child);
    ro.observe(el);
    return () => ro.disconnect();
  }, [channelId, list.length, list[0]?.id]);   // (a replaced list of the same length has new elements to watch too)

  // "Mark Unread" (message menu): draw the new-messages line at that message and leave the channel unread while it stays open here.
  // Leaving the channel, Esc or "Mark as read" ends it.
  useEffect(() => {
    const onMarked = (e) => {
      if (e.detail?.channelId !== channelId) return;
      setUnreadMarker(e.detail.lastReadId);
      setMarkedByHand(true);
    };
    window.addEventListener('nullchat:marked-unread', onMarked);
    return () => window.removeEventListener('nullchat:marked-unread', onMarked);
  }, [channelId]);

  // Acknowledge when viewing the bottom.
  const lastId = channel?.lastMessageId;
  const readUpTo = useStore((st) => st.readStates[channelId]?.lastReadId);
  useEffect(() => { if (markedByHand && lastId && readUpTo && readUpTo >= lastId) setMarkedByHand(false); }, [markedByHand, lastId, readUpTo]);   // read again (Esc, Mark as read, another device): back to normal
  const covered = useUI((u) => u.mobileNav) && isPhone(); // a phone's servers/channels list is on top of this chat
  useEffect(() => {
    if (!atBottom || entry?.hasNewer || covered || markedByHand) return undefined;
    const ack = () => { if (document.hasFocus()) ackChannel(channelId); };
    ack();
    window.addEventListener('focus', ack);
    return () => window.removeEventListener('focus', ack);
  }, [atBottom, lastId, channelId, entry?.hasNewer, covered, markedByHand]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    const e = store.get().messages[channelId];
    if (el.scrollTop < 300 && e?.hasMore && !e.loading && e.list.length) {
      prevHeightRef.current = el.scrollHeight;
      loadMessages(channelId, { before: e.list.find((m) => !m.pending)?.id });
    }
    if (bottom && e?.hasNewer && !e.loading) loadNewer(channelId);
  }, [channelId, atBottom]);

  const jumpToPresent = () => {
    const e = store.get().messages[channelId];
    atBottomRef.current = true;
    if (e?.hasNewer) loadMessages(channelId, { force: true });
    else if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  // Escape (see Chat.jsx) asks for the same thing the "Jump to Present" button does, when that button is showing.
  useEffect(() => {
    const onJump = (e) => {
      if (e.detail?.channelId !== channelId) return;
      if (store.get().messages[channelId]?.hasNewer || !atBottomRef.current) jumpToPresent();
    };
    window.addEventListener('nullchat:jump-present', onJump);
    return () => window.removeEventListener('nullchat:jump-present', onJump);
  }, [channelId]);

  const items = [];
  let prev = null;
  let blockedRun = [];
  const flushBlocked = () => { if (blockedRun.length) { items.push(<BlockedGroup key={`b${blockedRun[0].id}`} messages={blockedRun} channel={channel} />); blockedRun = []; } };
  for (const m of list) {
    if (prev && !sameDay(prev.createdAt, m.createdAt)) { flushBlocked(); items.push(<div key={`d${m.id}`} className="day-divider"><span>{formatDate(m.createdAt)}</span></div>); }
    if (unreadMarker && prev && prev.id <= unreadMarker && m.id > unreadMarker && (markedByHand || m.author.id !== myId)) {
      flushBlocked(); items.push(<div key="new" className="new-divider"><span>{t('newMessages')}</span></div>);
    }
    if (blocked[m.author.id]?.type === 2) { blockedRun.push(m); prev = m; continue; }
    flushBlocked();
    const grouped = !!prev && sameSender(prev.author, m.author) && isGroupable(prev) && isGroupable(m) && !m.replyTo && !m.interaction && !m.ephemeral && !prev.ephemeral && !m.quiet && !prev.quiet && !m.crosspost && !prev.crosspost
      && m.createdAt - prev.createdAt < GROUP_WINDOW && sameDay(prev.createdAt, m.createdAt) && !(unreadMarker && prev.id <= unreadMarker && m.id > unreadMarker);
    items.push(<Message key={m.nonce && m.pending ? m.nonce : m.id} message={m} grouped={grouped} channel={channel} highlighted={highlight === m.id} />);
    prev = m;
  }
  flushBlocked();

  return (
    <div className="message-list-wrap">
      {unreadMarker && !atBottom && (
        <button className="unread-bar" onClick={() => { jumpToMessage(channelId, list.find((m) => m.id > unreadMarker)?.id || unreadMarker); }}>
          <span>New messages since {formatTime(idTime(unreadMarker))}</span><span>Jump <Icon name="chevronDown" size={14} /></span>
        </button>
      )}
      <div className="message-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite">
        <div className="message-list">
          {entry && !entry.hasMore && entry.loaded && header}
          {entry?.hasMore && entry.loaded && <div className="load-more">{entry.loading ? <Spinner size={24} /> : null}</div>}
          {!entry?.loaded && <div className="messages-loading">{[...Array(6)].map((_, i) => <div key={i} className="skeleton-msg"><span className="sk-avatar" /><div><span className="sk-line short" /><span className="sk-line" style={{ width: `${40 + ((i * 37) % 50)}%` }} /></div></div>)}</div>}
          {entry?.error && !list.length && <div className="muted center pad">Couldn’t load messages: {entry.error} <button className="link-btn" onClick={() => loadMessages(channelId, { force: true })}>Retry</button></div>}
          {items}
          <div className="list-spacer" />
        </div>
      </div>
      {(entry?.hasNewer || !atBottom) && list.length > 0 && (
        <button className="jump-present" onClick={jumpToPresent}>{entry?.hasNewer ? 'You’re viewing older messages' : ''} <b>{t('jumpToPresent')}</b> <Icon name="chevronDown" size={14} /></button>
      )}
    </div>
  );
}

function isGroupable(m) { return m.type === 0 || m.type === 19; }

function BlockedGroup({ messages, channel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="blocked-group">
      <div className="blocked-bar"><Icon name="ban" size={16} /> {messages.length} blocked message{messages.length > 1 ? 's' : ''} — <button className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button></div>
      {open && messages.map((m, i) => <Message key={m.id} message={m} grouped={i > 0} channel={channel} />)}
    </div>
  );
}

// ================================================================ single message
const SYSTEM_TEXT = {
  1: (a, s, m) => <><b>{a}</b> added <b>{m.mentions?.[0] ? displayName(s, m.mentions[0]) : 'someone'}</b> to the group.</>,
  2: (a, s, m) => (m.mentions?.[0] && m.mentions[0] !== m.author.id ? <><b>{a}</b> removed <b>{displayName(s, m.mentions[0])}</b> from the group.</> : <><b>{a}</b> left the group.</>),
  3: (a) => <><b>{a}</b> started a call.</>,
  4: (a, s, m) => <><b>{a}</b> changed the channel name: <b>{m.content || '(none)'}</b></>,
  6: (a) => <><b>{a}</b> pinned a message to this channel. See all <b>pinned messages</b>.</>,
  7: (a) => {
    const lines = [<>Everyone welcome <b>{a}</b>!</>, <><b>{a}</b> just joined. Say hi!</>, <><b>{a}</b> hopped into the server.</>, <>Glad you’re here, <b>{a}</b>.</>, <><b>{a}</b> just showed up!</>];
    return lines[Math.abs(a.length * 7) % lines.length];
  },
  21: (a) => <>It’s <b>{a}</b>’s birthday today! 🎂 Wish them a happy birthday.</>,
  18: (a, s, m) => <><b>{a}</b> started a thread: <b>{m.content}</b>. See all <b>threads</b>.</>,
};
const SYSTEM_ICON = { 1: 'userPlus', 2: 'arrowLeft', 3: 'phone', 4: 'edit', 6: 'pin', 7: 'arrowLeft', 18: 'thread', 21: 'cake' };

export const Message = memo(function Message({ message: m, grouped, channel, highlighted, preview = false }) {
  const guildId = channel?.guildId || null;
  const myId = useStore((s) => s.me.id);
  const name = useStore((s) => authorName(s, m.author, guildId));
  const color = useStore((s) => (guildId ? memberColor(s, guildId, m.author.id) : null));
  const perms = useStore((s) => (channel ? channelPermissions(s, channel.id) : 0));
  const mentioned = useStore((s) => {
    if (m.author.id === s.me.id) return false;
    if (m.mentions?.includes(s.me.id)) return true;
    if (m.mentionEveryone && !s.guildSettings[guildId]?.suppressEveryone) return true;
    const mem = guildId ? s.members[guildId]?.[s.me.id] : null;
    return !!(mem && m.mentionRoles?.some((r) => mem.roles.includes(r)));
  });
  const isSaved = useStore((s) => !!s.saved[m.id]);
  const editing = useUI((u) => u.editing === m.id);
  const replying = useUI((u) => u.replyTo[m.channelId]?.id === m.id);
  const display = useSettingValue(useStore, 'messageDisplay');
  const compact = display === 'compact';
  const own = m.author.id === myId;
  const isSystem = m.type !== 0 && m.type !== 19;
  // A message remembers its author as they were when it loaded; prefer the live profile so changes to a
  // decoration, name style or avatar show up on messages already on screen.
  const liveAuthor = useStore((s) => s.users[m.author.id] || (s.me?.id === m.author.id ? s.me : null));
  const author = liveAuthor ? { ...m.author, ...liveAuthor } : m.author;
  const authorStyle = nameStyleProps(author, color);
  const avatarRef = useRef(null);

  const webhook = !!m.author.webhook;   // (no profile to open, and nobody to message or befriend)
  const openAuthor = (e) => { e.stopPropagation(); if (!webhook) openUserPopout(e.currentTarget, m.author.id, guildId); };
  const authorMenu = (e) => { if (webhook) { e.preventDefault(); return; } openUserMenu(e, m.author.id, { guildId, channelId: m.channelId }); };
  const ctx = { guildId, onUserClick: (id, e) => openUserPopout(e.currentTarget, id, guildId), emojiText: null };
  const menu = (e) => {
    if (preview || m.pending || m.ephemeral || m.quiet) return;
    if (e.target.closest('a,img.attachment-img,video')) return;
    openContextMenu(e, messageMenuItems(m, channel, perms, myId, e));
  };
  const longPress = useLongPress(menu);
  // A phone swipe on the message replies to it (the gesture lives in MobileNav.jsx and reads this flag).
  const canReply = !preview && !m.pending && !m.failed && !m.ephemeral && !m.quiet && has(perms, channel?.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES);
  // Announcement channels: a post is sent on to the servers that follow the channel when someone presses Publish. A copy that arrived
  // from another server (m.crosspost) shows which server it came from instead of who wrote it.
  const cp = m.crosspost || null;
  const inAnnouncements = channel?.type === ChannelType.ANNOUNCEMENT && !preview && !m.pending && !m.ephemeral && !cp && !m.poll;
  const canPublish = inAnnouncements && !m.published && (own ? has(perms, P.SEND_MESSAGES) : has(perms, P.MANAGE_MESSAGES));

  if (isSystem) {
    const sys = SYSTEM_TEXT[m.type];
    return (
      <div className={cx('message system', highlighted && 'highlighted')} data-mid={m.id} onContextMenu={menu}>
        <span className="system-icon"><Icon name={SYSTEM_ICON[m.type] || 'sparkle'} size={16} /></span>
        <div className="system-body">
          <span className="system-text" onClick={(e) => {
            if (m.type === 6 && m.replyTo?.id) jumpToMessage(m.channelId, m.replyTo.id);
            if (e.target.tagName === 'B' && e.target.textContent === name) openAuthor(e);
          }}>{sys ? sys(name, store.get(), m) : 'System message'}</span>
          <span className="msg-time" title={formatFull(m.createdAt)}>{formatMessageTime(m.createdAt)}</span>
        </div>
      </div>
    );
  }

  const jumboOk = !m.attachments?.length;
  const hideContent = isOnlyMediaLink(m);
  return (
    <div className={cx('message', grouped && 'grouped', compact && 'compact', mentioned && 'mentioned', highlighted && 'highlighted', m.pending && 'pending', m.failed && 'failed', m.ephemeral && 'ephemeral', m.quiet && 'ephemeral quiet', replying && 'replying', editing && 'editing')}
      data-mid={m.id} data-replyable={canReply ? '1' : undefined} onContextMenu={menu} role="article" {...(preview ? {} : longPress)}>
      {m.replyTo && <ReplyPreview reply={m.replyTo} channelId={m.channelId} guildId={guildId} />}
      {m.interaction && <InteractionLine it={m.interaction} guildId={guildId} />}
      <div className="message-inner">
        {compact ? (
          <span className="msg-time compact-time" title={formatFull(m.createdAt)}>{formatTime(m.createdAt)}</span>
        ) : grouped ? (
          <span className="msg-time hover-time" title={formatFull(m.createdAt)}>{formatTime(m.createdAt)}</span>
        ) : (
          cp ? <div className="msg-avatar crosspost-icon" title={`From ${cp.guildName}`}><GuildIcon guild={{ name: cp.guildName, icon: cp.guildIcon }} size={40} /></div>
            : <div className="msg-avatar" ref={avatarRef} onClick={openAuthor} onContextMenu={authorMenu}><Avatar user={author} guildId={guildId} size={40} /></div>
        )}
        <div className="msg-content">
          {(!grouped || compact) && (
            <div className="msg-header">
              {cp ? (
                <>
                  <span className="msg-author crosspost-from">{cp.guildName}</span>
                  <span className="announce-pill" title="Published by the server that runs this announcement channel"><Icon name="megaphone" size={11} /> Announcement</span>
                  <span className="tiny muted truncate">#{cp.channelName}</span>
                </>
              ) : (
                <>
                  <span className={cx('msg-author', authorStyle.className)} style={authorStyle.style} onClick={openAuthor} onContextMenu={authorMenu}>{name}</span>
                  {webhook ? <span className="bot-tag" title="Sent through a webhook">WEBHOOK</span> : author.bot && <span className="bot-tag" title="This account is a bot">BOT</span>}
                  <ServerTag tag={author.serverTag} />
                </>
              )}
              {!compact && <span className="msg-time" title={formatFull(m.createdAt)}>{formatMessageTime(m.createdAt)}</span>}
            </div>
          )}
          {editing ? <EditBox message={m} channel={channel} /> : (
            <>
              {m.content && !hideContent && (
                <div className="msg-text">
                  <Markdown text={m.content} ctx={{ ...ctx, jumboAllowed: jumboOk }} />
                  {m.editedAt && <span className="edited" title={formatFull(m.editedAt)}> (edited)</span>}
                </div>
              )}
              {m.interaction?.pending && <div className="bot-thinking"><span className="typing-dots"><i /><i /><i /></span><b>{name}</b> is thinking…</div>}
              {m.poll && <PollCard message={m} channel={channel} own={own} perms={perms} preview={preview} />}
              {m.forward && <ForwardCard message={m} ctx={ctx} />}
              {!m.forward && m.attachments?.length > 0 && <Attachments attachments={m.attachments} />}
              {m.stickers?.length > 0 && <MessageSticker sticker={m.stickers[0]} />}
              <MessageEmbeds m={m} perms={perms} own={own} ctx={ctx} />
              {m.components?.length > 0 && <MessageComponents message={m} preview={preview} />}
              {m.reactions?.length > 0 && <Reactions message={m} channel={channel} myId={myId} guildId={guildId} canReact={has(perms, P.ADD_REACTIONS)} />}
              {m.thread && <ThreadChip thread={m.thread} guildId={guildId} parentId={m.channelId} />}
              {canPublish && (
                <div className="publish-line"><button type="button" className="publish-btn" onClick={() => publishAnnouncement(m.channelId, m.id)}><Icon name="megaphone" size={13} /> Publish</button></div>
              )}
              {inAnnouncements && m.published && <div className="publish-line"><span className="published-note"><Icon name="check" size={13} /> Published to the servers that follow this channel</span></div>}
              {m.ephemeral && (
                <div className="ephemeral-note"><Icon name="eye" size={13} /> Only you can see this · <button className="link-btn" onClick={() => dismissEphemeral(m.channelId, m.id)}>Dismiss message</button></div>
              )}
              {m.quiet && !m.pending && <QuietNote message={m} guildId={guildId} canSend={!preview && has(perms, channel?.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES)} />}
              {m.failed && (
                <div className="msg-failed">
                  <Icon name="x" size={14} /> Message failed to send{m.error ? `: ${m.error}` : ''}.{' '}
                  <button className="link-btn" onClick={() => { removeFailedMessage(m.channelId, m.nonce); sendMessage(m.channelId, m.content, m.retry || {}); }}>Retry</button>{' · '}
                  <button className="link-btn" onClick={() => removeFailedMessage(m.channelId, m.nonce)}>Delete</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {isSaved && !preview && <span className="saved-flag" title="Saved for later"><Icon name="bookmark" size={13} /></span>}
      {!preview && !m.pending && !m.ephemeral && !m.quiet && !editing && <MessageToolbar message={m} channel={channel} perms={perms} own={own} />}
    </div>
  );
});

/** A sticker sent in a message: the picture, or a note when the server it came from has since taken it away. */
function MessageSticker({ sticker }) {
  const live = useStore((s) => {
    for (const g of Object.values(s.guilds)) { const f = g.stickers?.find((x) => x.id === sticker.id); if (f) return f; }
    return null;
  });
  // (one from a server you are in that is no longer in its list has been taken away; one from a server you are not in cannot be checked, so its picture stays)
  const inItsServer = useStore((s) => !!(sticker.guildId && s.guilds[sticker.guildId]));
  const st = live || (sticker.url && !inItsServer ? sticker : null);
  if (!st || sticker.removed) return <div className="msg-sticker removed muted" title={sticker.name}><Icon name="sticker" size={16} /> The sticker “{sticker.name}” was removed</div>;
  return <div className="msg-sticker"><img src={st.url} alt={`Sticker: ${st.name}`} title={st.name} draggable={false} loading="lazy" /></div>;
}

function isOnlyMediaLink(m) {
  if (!m.embeds?.length || !m.content) return false;
  const c = m.content.trim();
  return m.embeds.length === 1 && (m.embeds[0].type === 'image' || (m.embeds[0].type === 'video' && !m.embeds[0].youtubeId)) && m.embeds[0].url === c;
}

/** A message that was passed on from somewhere else: who wrote it, when, and what it said, with its files and previews. */
function ForwardCard({ message, ctx }) {
  const f = message.forward;
  const liveAuthor = useStore((s) => (f.author?.id ? s.users[f.author.id] : null));
  const author = liveAuthor ? { ...f.author, ...liveAuthor } : f.author;
  const name = liveAuthor?.displayName || f.author?.name || 'Unknown';
  const showPreviews = f.embeds?.length > 0 && getSetting('chat.linkPreviews');
  return (
    <div className="fwd-card">
      <div className="fwd-card-head"><Icon name="forward" size={13} /> Forwarded</div>
      {f.content && <div className="msg-text"><Markdown text={f.content} ctx={{ ...ctx, jumboAllowed: false }} /></div>}
      {message.attachments?.length > 0 && <Attachments attachments={message.attachments} />}
      {showPreviews && <Embeds embeds={f.embeds} message={message} perms={0} own={false} ctx={ctx} readOnly />}
      <div className="fwd-card-foot tiny muted">
        {author?.id ? <Avatar user={author} size={16} /> : null}
        <span className="fwd-card-author">{name}</span>
        <span title={formatFull(f.createdAt)}>· {formatShortDate(f.createdAt)}</span>
      </div>
    </div>
  );
}

function ReplyPreview({ reply, channelId, guildId }) {
  const name = useStore((s) => (reply.author ? authorName(s, reply.author, guildId) : null));
  const color = useStore((s) => (guildId && reply.author ? memberColor(s, guildId, reply.author.id) : null));
  const text = useStore((s) => (reply.content ? toPlainText(reply.content, s, guildId) : ''));
  if (reply.deleted) return <div className="reply-preview deleted"><span className="reply-spine" /><Icon name="reply" size={14} /><i className="muted">Original message was deleted</i></div>;
  return (
    <div className="reply-preview" onClick={() => jumpToMessage(channelId, reply.id)}>
      <span className="reply-spine" />
      <Avatar user={reply.author} guildId={guildId} size={16} />
      <span className="reply-author" style={color ? { color } : undefined}>@{name}</span>
      <span className="reply-text truncate">{text || <i>{reply.forwarded ? 'Forwarded message' : reply.sticker ? 'Sticker' : 'Click to see attachment'}</i>}</span>
    </div>
  );
}

function ThreadChip({ thread, guildId, parentId }) {
  const live = useStore((s) => s.channels[thread.id]);
  const t = live || thread;
  return (
    <button className="thread-chip" onClick={() => navigate(`/channels/${guildId}/${parentId}?thread=${thread.id}`)}>
      <Icon name="thread" size={16} /><b>{t.name}</b><span className="muted">{t.messageCount || 0} Messages ›</span>
    </button>
  );
}

// ---------------------------------------------------------------- attachments & embeds
function Attachments({ attachments }) {
  const inline = getSetting('chat.inlineMedia');
  return (
    <div className="attachments">
      {attachments.map((a) => <Attachment key={a.id} a={a} inline={inline} />)}
    </div>
  );
}

/** "ALT" on a picture that has a description: click it to read the description under the picture. */
function AltBadge({ text, shown, toggle }) {
  return <button type="button" className={cx('alt-badge', shown && 'on')} aria-pressed={shown} aria-label={shown ? 'Hide image description' : 'Show image description'} title={text.slice(0, 120)}
    onClick={(e) => { e.stopPropagation(); toggle(); }}>ALT</button>;
}

function Attachment({ a, inline }) {
  const [revealed, setRevealed] = useState(!a.spoiler);
  const [showAlt, setShowAlt] = useState(false);
  const isImage = /^image\//.test(a.contentType) && a.url;
  const isVideo = /^video\//.test(a.contentType) && a.url;
  const isAudio = /^audio\//.test(a.contentType) && a.url;
  if (!a.url) {
    return (
      <div className="file-card uploading">
        <Icon name="file" size={32} />
        <div className="grow"><div className="truncate">{a.filename}</div><div className="progress"><span style={{ width: `${Math.round((a.progress || 0) * 100)}%` }} /></div></div>
      </div>
    );
  }
  const download = downloadUrl(a.url, a.filename);
  const save = (e) => { e.preventDefault(); saveFile(a.url, a.filename, { type: a.contentType, size: a.size }).catch(() => toast('Could not save that file. Check your connection and try again.', 'error')); };
  if (isAudio && /^voice-message/.test(a.filename)) {
    return <div className="voice-msg"><Icon name="mic" size={18} /><audio controls src={a.url} preload="none" /></div>;
  }
  if (inline && isImage) {
    return (
      <div className="media-block">
        <div className={cx('media-wrap', !revealed && 'spoiler-media')} onClick={() => (revealed ? openImageViewer(a.url, a.filename, a.description) : setRevealed(true))}>
          <img className="attachment-img" src={a.url} alt={a.description || a.filename} loading="lazy" />
          {!revealed && <span className="spoiler-label">SPOILER</span>}
          {a.description && revealed && <AltBadge text={a.description} shown={showAlt} toggle={() => setShowAlt((v) => !v)} />}
        </div>
        {a.description && revealed && showAlt && <div className="alt-caption">{a.description}</div>}
      </div>
    );
  }
  if (inline && isVideo) {
    return (
      <div className="media-block">
        <div className={cx('media-wrap', !revealed && 'spoiler-media')} onClick={() => !revealed && setRevealed(true)}>
          <video className="attachment-video" src={a.url} controls={revealed} preload="metadata" aria-label={a.description || a.filename} />
          {revealed && <a className="media-save" href={download} download={a.filename} aria-label="Download video" data-tooltip="Download" data-save-file onClick={save}><Icon name="download" size={16} /></a>}
          {!revealed && <span className="spoiler-label">SPOILER</span>}
          {a.description && revealed && <AltBadge text={a.description} shown={showAlt} toggle={() => setShowAlt((v) => !v)} />}
        </div>
        {a.description && revealed && showAlt && <div className="alt-caption">{a.description}</div>}
      </div>
    );
  }
  return (
    <div className="file-card">
      <Icon name="file" size={32} />
      <div className="grow">
        <a className="truncate file-name" href={download} download={a.filename} onClick={save}>{a.filename}</a>
        <div className="tiny muted">{formatBytes(a.size)}</div>
        {isAudio && <audio controls src={a.url} preload="none" />}
      </div>
      <a className="icon-btn" href={download} download={a.filename} aria-label="Download" data-save-file onClick={save}><Icon name="download" size={20} /></a>
    </div>
  );
}

/** The previews under a message's text: invite links become a Join card, other links a preview (if previews are on), bots' cards as they are. */
function MessageEmbeds({ m, perms, own, ctx }) {
  const previews = getSetting('chat.linkPreviews');
  const invites = previews ? inviteLinksIn(m.content) : [];
  const urls = new Set(invites.map((i) => i.url));
  let embeds = previews ? m.embeds || [] : (m.embeds || []).filter((e) => e.type === 'rich');
  if (urls.size) embeds = embeds.filter((e) => e.type === 'rich' || !urls.has(e.url));   // (the card replaces the plain preview of the same link)
  return (
    <>
      {invites.length > 0 && <InviteCards links={invites} />}
      {embeds.length > 0 && <Embeds embeds={embeds} message={m} perms={perms} own={own} ctx={ctx} />}
    </>
  );
}

function Embeds({ embeds, message, perms, own, ctx, readOnly = false }) {
  const canSuppress = !readOnly && (own || has(perms, P.MANAGE_MESSAGES));
  return (
    <div className="embeds">
      {embeds.map((e, i) => {
        if (e.type === 'thread') return null;
        if (e.type === 'rich') return <RichEmbed key={i} e={e} ctx={ctx} />;
        if (e.type === 'image') return <ChatGif key={i} embed={e} canStar={!readOnly && !message?.pending} />;
        if (e.type === 'video' && !e.youtubeId) return <video key={i} className="attachment-video" src={e.video?.url || e.url} controls preload="metadata" />;
        return (
          <div key={i} className="embed" style={e.color ? { borderLeftColor: e.color } : undefined}>
            {canSuppress && <button className="embed-close" aria-label="Remove embed" onClick={() => api.patch(`/channels/${message.channelId}/messages/${message.id}`, { suppressEmbeds: true }).catch(toastError)}><Icon name="x" size={14} /></button>}
            {e.siteName && <div className="embed-site">{e.siteName}</div>}
            {e.title && <a className="embed-title" href={e.url} target="_blank" rel="noopener noreferrer nofollow">{e.title}</a>}
            {e.description && <div className="embed-desc">{e.description}</div>}
            {e.youtubeId ? <YouTube id={e.youtubeId} thumb={e.thumbnail?.url} />
              : e.thumbnail?.url && <img className="embed-thumb" src={e.thumbnail.url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          </div>
        );
      })}
    </div>
  );
}

/** A card a bot attached: colored side bar, author, title, text, fields, picture and footer. */
function RichEmbed({ e, ctx }) {
  const link = (url, children, cls) => (url ? <a className={cls} href={url} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <span className={cls}>{children}</span>);
  return (
    <div className="embed rich" style={e.color ? { borderLeftColor: e.color } : undefined}>
      <div className="rich-main">
        <div className="rich-body">
          {e.author && (
            <div className="embed-author">
              {e.author.iconUrl && <img src={e.author.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              {link(e.author.url, e.author.name)}
            </div>
          )}
          {e.title && (e.url ? link(e.url, e.title, 'embed-title') : <div className="embed-title plain">{e.title}</div>)}
          {e.description && <div className="embed-desc"><Markdown text={e.description} ctx={{ ...ctx, jumboAllowed: false }} /></div>}
          {e.fields?.length > 0 && (
            <div className="embed-fields">
              {e.fields.map((f, i) => (
                <div key={i} className={cx('embed-field', f.inline && 'inline')}>
                  <div className="embed-field-name">{f.name}</div>
                  <div className="embed-field-value"><Markdown text={f.value} ctx={{ ...ctx, jumboAllowed: false }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
        {e.thumbnail?.url && <img className="embed-thumb rich-thumb" src={e.thumbnail.url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      </div>
      {e.image?.url && <img className="embed-image" src={e.image.url} alt="" loading="lazy" referrerPolicy="no-referrer" onClick={() => openImageViewer(e.image.url)} />}
      {(e.footer || e.timestamp) && (
        <div className="embed-footer">
          {e.footer?.iconUrl && <img src={e.footer.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <span>{[e.footer?.text, e.timestamp ? formatTimestamp(e.timestamp) : null].filter(Boolean).join(' • ')}</span>
        </div>
      )}
    </div>
  );
}

/** "Sam used /echo" above the answer to a slash command (or "Sam used a button" when it answers a button, a menu or a form). */
function InteractionLine({ it, guildId }) {
  const name = useStore((s) => displayName(s, it.user.id, guildId));
  return (
    <div className="interaction-line">
      <span className="reply-spine" />
      <Avatar user={it.user} guildId={guildId} size={16} />
      <b>{name}</b> used {it.name ? <span className="slash-name">/{it.name}</span> : <span className="comp-used">{it.label || 'a command'}</span>}
    </div>
  );
}

function YouTube({ id, thumb }) {
  const [play, setPlay] = useState(false);
  if (play) return <iframe className="embed-video" src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`} title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />;
  return (
    <button className="embed-video yt-thumb" onClick={() => setPlay(true)} style={{ backgroundImage: `url(${thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`})` }} aria-label="Play video">
      <span className="play-btn"><Icon name="chevronRight" size={32} strokeWidth={3} /></span>
    </button>
  );
}

// ---------------------------------------------------------------- reactions
function Reactions({ message, channel, myId, guildId, canReact }) {
  const addRef = useRef(null);
  return (
    <div className="reactions">
      {message.reactions.map((r) => <ReactionChip key={r.emoji} r={r} message={message} channel={channel} myId={myId} guildId={guildId} />)}
      {canReact && (
        <button ref={addRef} className="reaction add" aria-label="Add Reaction"
          onClick={() => openPopout(addRef.current, ({ close }) => <EmojiPicker onSelect={({ key }) => toggleReaction(channel.id, store.get().messages[channel.id]?.list.find((x) => x.id === message.id) || message, key)} onClose={close} />, { placement: 'top' })}>
          <Icon name="smilePlus" size={16} />
        </button>
      )}
    </div>
  );
}
function ReactionChip({ r, message, channel, myId, guildId }) {
  const names = useStore((s) => r.users.slice(0, 6).map((id) => displayName(s, id, guildId)));
  const mine = r.users.includes(myId);
  const custom = parseCustomKey(r.emoji);
  const label = `${names.join(', ')}${r.count > 6 ? ` and ${r.count - 6} others` : ''} reacted with ${custom ? `:${custom.name}:` : r.emoji}`;
  return (
    <button className={cx('reaction', mine && 'mine')} onClick={() => toggleReaction(channel.id, message, r.emoji)} data-tooltip={label} data-tooltip-side="top">
      <EmojiGlyph emoji={r.emoji} size={18} /><span className="reaction-count">{r.count}</span>
    </button>
  );
}

// ---------------------------------------------------------------- toolbar, menu, editing
function MessageToolbar({ message, channel, perms, own }) {
  const reactRef = useRef(null);
  const quick = (getRecent().length ? getRecent() : DEFAULT_RECENT).slice(0, 3);
  const canThread = channel?.guildId && isTextLike(channel.type) && has(perms, P.CREATE_THREADS) && !message.thread;
  return (
    <div className="msg-toolbar" onClick={(e) => e.stopPropagation()}>
      {has(perms, P.ADD_REACTIONS) && quick.map((k) => (
        <button key={k} className="tb-btn quick" onClick={() => toggleReaction(channel.id, message, k)} aria-label={`React ${k}`}><EmojiGlyph emoji={k} size={18} /></button>
      ))}
      {has(perms, P.ADD_REACTIONS) && <button ref={reactRef} className="tb-btn" data-tooltip="Add Reaction" aria-label="Add Reaction"
        onClick={() => openPopout(reactRef.current, ({ close }) => <EmojiPicker onSelect={({ key }) => toggleReaction(channel.id, message, key)} onClose={close} />, { placement: 'left' })}><Icon name="smilePlus" size={18} /></button>}
      {own && !message.crosspost ? <button className="tb-btn" data-tooltip="Edit" aria-label="Edit" onClick={() => setUI({ editing: message.id })}><Icon name="edit" size={18} /></button>
        : has(perms, channel?.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES) && <button className="tb-btn" data-tooltip="Reply" aria-label="Reply" onClick={() => startReply(message)}><Icon name="reply" size={18} /></button>}
      {canThread && <button className="tb-btn" data-tooltip="Create Thread" aria-label="Create Thread" onClick={() => openCreateThread(channel.id, message)}><Icon name="thread" size={18} /></button>}
      <button className="tb-btn" data-tooltip="More" aria-label="More" onClick={(e) => openContextMenu(e, messageMenuItems(message, channel, perms, store.get().me.id, e))}><Icon name="more" size={18} /></button>
    </div>
  );
}

function startReply(message) {
  setReply(message.channelId, message);
  window.dispatchEvent(new CustomEvent('nullchat:focus-composer'));
}

export async function deleteMessage(m, skipConfirm = false) {
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: 'Delete Message',
      body: <><p className="muted">Are you sure you want to delete this message?</p><div className="message-preview-box"><Message message={m} channel={store.get().channels[m.channelId]} preview /></div><p className="tiny muted">Protip: hold Shift while clicking delete to skip this.</p></>,
      confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
  }
  try { await api.del(`/channels/${m.channelId}/messages/${m.id}`); } catch (e) { toastError(e); }
}

function messageMenuItems(m, channel, perms, myId, event) {
  const own = m.author.id === myId;
  const canManage = has(perms, P.MANAGE_MESSAGES);
  const isDM = !channel?.guildId;
  const sendFlag = channel?.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
  const isNormal = m.type === 0 || m.type === 19;
  const quick = (getRecent().length ? getRecent() : DEFAULT_RECENT).slice(0, 8);
  const gif = gifLinkOf(m);   // a GIF from this server or GIPHY that can be kept
  const gifFav = !!gif && !!findFavoriteByLink(store.get().gifFavorites, gif.link);
  const link = `${location.origin}/channels/${channel?.guildId || '@me'}/${channel?.type === ChannelType.THREAD ? `${channel.parentId}?thread=${channel.id}` : m.channelId}`;
  return [
    has(perms, P.ADD_REACTIONS) && { label: 'Add Reaction', items: quick.map((k) => ({ label: <EmojiGlyph emoji={k} size={18} />, onClick: () => toggleReaction(m.channelId, m, k) })) },
    { type: 'separator' },
    own && isNormal && !m.crosspost && { label: 'Edit Message', icon: 'edit', onClick: () => setUI({ editing: m.id }) },
    isNormal && !m.pending && !m.crosspost && !m.published && !m.poll && channel?.type === ChannelType.ANNOUNCEMENT && has(perms, own ? P.SEND_MESSAGES : P.MANAGE_MESSAGES) && { label: 'Publish', icon: 'megaphone', onClick: () => publishAnnouncement(m.channelId, m.id) },
    isNormal && has(perms, sendFlag) && { label: 'Reply', icon: 'reply', onClick: () => startReply(m) },
    isNormal && !m.pending && has(perms, sendFlag) && quietAllowed(channel) && !m.author.webhook && { label: 'Reply Quietly', icon: 'eyeOff', onClick: () => startQuietReply(m) },
    isNormal && channel?.guildId && isTextLike(channel.type) && has(perms, P.CREATE_THREADS) && !m.thread && { label: 'Create Thread', icon: 'thread', onClick: () => openCreateThread(channel.id, m) },
    own && !m.pending && m.attachments?.some((a) => /^(image|video)\//.test(a.contentType || '') && a.url) && { label: m.attachments.some((a) => a.description) ? 'Edit Image Description' : 'Add Image Description', icon: 'edit', onClick: () => import('./AltText.jsx').then((x) => x.openAltTextEditor(m)).catch(toastError) },
    m.content && { label: 'Copy Text', icon: 'copy', onClick: () => copyText(m.content) },
    isNormal && (isDM || canManage) && { label: m.pinned ? 'Unpin Message' : 'Pin Message', icon: 'pin', onClick: () => (m.pinned ? api.del(`/channels/${m.channelId}/pins/${m.id}`) : api.put(`/channels/${m.channelId}/pins/${m.id}`)).catch(toastError) },
    isNormal && !m.pending && { label: store.get().saved[m.id] ? 'Remove from Saved' : 'Save for Later', icon: 'bookmark', onClick: () => toggleSaved(m) },
    isNormal && !m.pending && { label: 'Remind Me', icon: 'clock', items: reminderMenuItems(m) },
    isNormal && !m.pending && gif && { label: gifFav ? 'Remove GIF from Favorites' : 'Add GIF to Favorites', icon: 'star', onClick: () => toggleChatGif(gif) },
    isNormal && !m.pending && !m.poll && { label: 'Forward', icon: 'forward', onClick: () => import('./MessageActions.jsx').then((x) => x.openForward(m)).catch(toastError) },
    { label: 'Mark Unread', icon: 'inbox', onClick: () => markUnread(m.channelId, m.id) },
    { label: 'Copy Message Link', icon: 'link', onClick: () => { copyText(link); toast('Link copied', 'success', 1500); } },
    { type: 'separator' },
    m.embeds?.length > 0 && (own || canManage) && { label: 'Remove Embeds', onClick: () => api.patch(`/channels/${m.channelId}/messages/${m.id}`, { suppressEmbeds: true }).catch(toastError) },
    (own || (canManage && !isDM)) && { label: 'Delete Message', icon: 'trash', danger: true, onClick: (e) => deleteMessage(m, e?.shiftKey || event?.shiftKey) },
    !own && isNormal && !m.pending && !m.failed && { label: 'Report Message', icon: 'flag', danger: true, onClick: () => import('./MessageActions.jsx').then((x) => x.openReport(m, channel)).catch(toastError) },
    { type: 'separator' },
    getSetting('developerMode') && { label: 'Copy Message ID', icon: 'copy', onClick: () => copyText(m.id) },
  ].filter(Boolean);
}

function EditBox({ message, channel }) {
  const [text, setText] = useState(() => decodeMentions(message.content, mentionContext(message.channelId)));   // (@bob, not <@1234…>)
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); autosize(el); }
  }, []);
  const cancel = () => setUI({ editing: null });
  const save = async () => {
    const s = store.get();
    const custom = Object.values(s.guilds).flatMap((g) => g.emojis || []);
    const content = replaceShortcodes(encodeMentions(text.trim(), mentionContext(message.channelId)), custom);
    if (content === message.content) { cancel(); return; }
    if (!content && !message.attachments?.length && !message.forward && !message.stickers?.length) { cancel(); deleteMessage(message); return; }
    try { await api.patch(`/channels/${message.channelId}/messages/${message.id}`, { content }); cancel(); }
    catch (e) { toastError(e); }
  };
  void channel;
  return (
    <div className="edit-box">
      <MentionTextarea inputRef={ref} className="edit-input" value={text} maxLength={4000} spans={typedMentionSpans(text, message.channelId)}
        onEdit={(next, caret) => { setText(next); requestAnimationFrame(() => { const el = ref.current; if (el) { el.setSelectionRange(caret, caret); autosize(el); } }); }}
        onChange={(e) => { setText(e.target.value); autosize(e.target); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
        }} />
      <div className="tiny muted">escape to <button className="link-btn" onClick={cancel}>cancel</button> • enter to <button className="link-btn" onClick={save}>save</button></div>
    </div>
  );
}

export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.5 / pageZoom())}px`;
}

export { IconButton };
