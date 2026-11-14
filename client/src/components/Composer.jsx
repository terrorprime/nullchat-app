// Message composer with autocomplete, slash commands, file uploads, replies and typing indicators.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, store, displayName, authorName, channelPermissions, memberColor } from '../lib/state.js';
import { sendMessage } from '../lib/actions.js';
import { send } from '../lib/gateway.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatBytes, formatTime } from '../lib/utils.js';
import { useUI, setUI, setReply, setDraft, uiStore } from '../lib/ui.js';
import { getSetting, getLocal } from '../lib/settings.js';
import { searchEmoji, replaceShortcodes, convertEmoticons } from '../lib/emoji.js';
import { useT } from '../lib/i18n.js';
import { readStoredDraft, storeDraft } from '../lib/drafts.js';
import { registerAction } from '../lib/keybinds.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';
import { Avatar, openPopout, pickFile, Switch, openContextMenu } from './ui.jsx';
import { openPollModal, pollCommand } from './Poll.jsx';
import { openSchedulePicker } from './Schedule.jsx';
import { scheduleMessage, schedulePresets, openScheduledTab } from '../lib/scheduled.js';
import { timeUntil } from '../lib/saved.js';
import { loadCommands, matchBotCommand, parseOptionText, resolveOptions, runBotCommand } from '../lib/bots.js';
import { EmojiPicker } from './EmojiPicker.jsx';
import { registerComposer } from '../lib/composerFocus.js';
import { mentionContext, encodeMentions, decodeMentions, typedMentionSpans } from '../lib/mentionText.js';
import { MentionTextarea } from './MentionField.jsx';
import { autosize } from './Messages.jsx';
import { Icon } from './icons.jsx';
import { QuietRow, QuietSwitch, quietAllowed } from './Quiet.jsx';

const NO_SPANS = [];
let maxUploadMb = 150;
api.get('/config').then((c) => { maxUploadMb = c.maxUploadMb || 150; }).catch(() => {});

const COMMANDS = [
  { name: 'shrug', desc: 'Appends ¯\\_(ツ)_/¯ to your message.', run: (a) => `${a} ¯\\\\\\_(ツ)\\_/¯`.trim() },   // (the markdown for ¯\_(ツ)_/¯: the arm's backslash and both underscores are escaped so they show as they are)
  { name: 'tableflip', desc: 'Appends (╯°□°)╯︵ ┻━┻ to your message.', run: (a) => `${a} (╯°□°)╯︵ ┻━┻`.trim() },
  { name: 'unflip', desc: 'Appends ┬─┬ノ( º _ ºノ) to your message.', run: (a) => `${a} ┬─┬ノ( º _ ºノ)`.trim() },
  { name: 'lenny', desc: 'Appends ( ͡° ͜ʖ ͡°) to your message.', run: (a) => `${a} ( ͡° ͜ʖ ͡°)`.trim() },
  { name: 'me', desc: 'Displays text with emphasis.', run: (a) => (a ? `_${a}_` : '') },
  { name: 'spoiler', desc: 'Marks your message as a spoiler.', run: (a) => (a ? `||${a}||` : '') },
  { name: 'silent', desc: 'Sends a message without notifying anyone.', run: (a) => a, silent: true },
  { name: 'schedule', desc: 'Sends your message later. Use /schedule Your message, then pick a time.', schedule: true },
  { name: 'poll', desc: 'Starts a poll. Use /poll Question | Option 1 | Option 2, or just /poll for the form.', action: (a, ch) => pollCommand(a, ch) },
  { name: 'nick', desc: 'Changes your nickname on this server.', guildOnly: true, action: async (a, ch) => { await api.patch(`/guilds/${ch.guildId}/members/@me`, { nick: a || null }); toast(a ? `Your nickname is now ${a}.` : 'Nickname reset.', 'success'); } },
  { name: 'thread', desc: 'Starts a new thread in this channel.', guildOnly: true, action: async (a, ch) => { const { navigate } = await import('../lib/router.jsx'); const t = await api.post(`/channels/${ch.id}/threads`, { name: a || 'New Thread' }); navigate(`/channels/${ch.guildId}/${ch.id}?thread=${t.id}`); } },
];

export function Composer({ channelId, placeholder, compact = false }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const perms = useStore((s) => channelPermissions(s, channelId));
  const myMember = useStore((s) => (channel?.guildId ? s.members[channel.guildId]?.[s.me.id] : null));
  const dmBlocked = useStore((s) => channel?.type === ChannelType.DM && s.relationships[channel.recipients[0]]?.type === 2);
  const replyTo = useUI((u) => u.replyTo[channelId]);
  const scheduledHere = useStore((s) => Object.values(s.scheduled).filter((x) => x.channelId === channelId && !x.error).length);
  const myId = useStore((s) => s.me?.id);
  const initialDraft = uiStore.get().drafts[channelId] ?? readStoredDraft(myId, channelId);
  const [text, setText] = useState(initialDraft);
  const [files, setFiles] = useState([]);
  const [ac, setAc] = useState(null); // autocomplete state
  const [acIndex, setAcIndex] = useState(0);
  const [botPick, setBotPick] = useState(null); // id of the bot command chosen from the list (two bots can have a command with the same name)
  const [slowUntil, setSlowUntil] = useState(0);
  const [, force] = useState(0);
  const taRef = useRef(null);
  const emojiRef = useRef(null);
  const gifRef = useRef(null);
  const lastTyping = useRef(0);
  const isThread = channel?.type === ChannelType.THREAD;
  const canSend = has(perms, isThread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES) && !(isThread && channel.locked && !has(perms, P.MANAGE_THREADS));
  const canAttach = has(perms, P.ATTACH_FILES);
  const timedOut = myMember?.timeoutUntil && myMember.timeoutUntil > Date.now();
  const showSend = getSetting('chat.showSendButton');
  const rec = useVoiceRecorder((blob, name) => {
    if (!canAttach) return;
    const file = new File([blob], name, { type: blob.type.split(';')[0] });
    sendMessage(channelId, '', { files: [{ file, name, size: file.size, type: file.type, spoiler: false }] });
  });

  // The slash commands of the bots in this server (cached; refreshed when a bot changes them).
  const guildIdForCmds = channel?.guildId;
  const botCommands = useStore((s) => (guildIdForCmds ? s.commands[guildIdForCmds] : null));
  useEffect(() => { if (guildIdForCmds) loadCommands(guildIdForCmds); }, [guildIdForCmds]);

  // Reset per channel.
  useEffect(() => {
    setText(uiStore.get().drafts[channelId] ?? readStoredDraft(myId, channelId));
    setFiles([]);
    setAc(null);
    setBotPick(null);
    setTimeout(() => { if (taRef.current) { autosize(taRef.current); if (window.matchMedia('(pointer: fine)').matches) taRef.current.focus(); } }, 0);
  }, [channelId]);
  useEffect(() => { setDraft(channelId, text); }, [channelId, text]);
  // Keep a copy that survives a reload (keyed on the text alone, so switching channels never saves one channel's words under another).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { storeDraft(myId, channelId, text); }, [text]);

  // External inserts (mention from menus) and focus requests.
  useEffect(() => {
    const ins = (e) => insertText(decodeMentions(e.detail, mentionContext(channelId, perms)));   // ("Mention" from a menu: show @bob, not <@1234…>)
    const focus = () => taRef.current?.focus();
    window.addEventListener('nullchat:insert', ins);
    window.addEventListener('nullchat:focus-composer', focus);
    window.addEventListener(`nullchat:files:${channelId}`, onFilesEvent);
    return () => { window.removeEventListener('nullchat:insert', ins); window.removeEventListener('nullchat:focus-composer', focus); window.removeEventListener(`nullchat:files:${channelId}`, onFilesEvent); };
  });
  useEffect(() => registerAction('uploadFile', () => { if (canAttach) choose(); }));

  // Slowmode countdown re-render.
  useEffect(() => {
    if (slowUntil <= Date.now()) return undefined;
    const iv = setInterval(() => { force((x) => x + 1); if (slowUntil <= Date.now()) clearInterval(iv); }, 1000);
    return () => clearInterval(iv);
  }, [slowUntil]);

  // An uploaded GIF is sent by id; one from GIPHY is just its link.
  const sendPickedGif = (g) => (replyTo?.quietTo ? (toast('A quiet reply can only be text. Turn Quiet off first.', 'error'), undefined) : g.source === 'library' ? sendMessage(channelId, '', { gif: g }) : sendMessage(channelId, g.url));
  // A sticker is sent at once, as a message of its own (what is typed in the box stays there).
  const quietOnly = () => { if (!replyTo?.quietTo) return false; toast('A quiet reply can only be text. Turn Quiet off first.', 'error'); return true; };   // (nothing else may slip out as an ordinary message while a quiet reply is being written)
  const sendPickedSticker = (st) => { if (quietOnly()) return undefined; const reply = replyTo; if (reply) setReply(channelId, null); return sendMessage(channelId, '', { sticker: st, replyTo: reply ? { ...reply, mention: reply.mention !== false } : null }); };
  const insertText = (s) => {
    const el = taRef.current;
    if (!el) { setText((x) => x + s); return; }
    const start = el.selectionStart ?? text.length; const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    // (the cursor goes after what was inserted, unless more has been typed in the meantime: then it is already where it should be)
    requestAnimationFrame(() => { el.focus(); if (el.value === next) el.setSelectionRange(start + s.length, start + s.length); autosize(el); });
  };

  function addFiles(list) {
    if (!canAttach) { toast('You do not have permission to upload files here.', 'error'); return; }
    const arr = [...list];
    const tooBig = arr.filter((f) => f.size > maxUploadMb * 1024 * 1024);
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length > 1 ? 'are' : 'is'} too large. The limit is ${maxUploadMb} MB.`, 'error');
    const ok = arr.filter((f) => f.size <= maxUploadMb * 1024 * 1024).map((f) => ({ file: f, name: f.name || 'pasted-image.png', size: f.size, type: f.type, spoiler: false, preview: /^image\//.test(f.type) ? URL.createObjectURL(f) : null }));
    setFiles((cur) => {
      const next = [...cur, ...ok];
      if (next.length > 10) toast('You can upload at most 10 files at a time.', 'warning');
      return next.slice(0, 10);
    });
    taRef.current?.focus();
  }
  function onFilesEvent(e) { addFiles(e.detail); }
  // Tells lib/composerFocus.js this box exists, so it can keep the cursor here (and hand it text that was pasted elsewhere on the page).
  const live = useRef({});
  live.current = { insertText, addFiles };
  useEffect(() => registerComposer({ get el() { return taRef.current; }, insert: (t) => live.current.insertText(t), addFiles: (l) => live.current.addFiles(l) }), []);
  const choose = async () => { const list = await pickFile('', true); if (list?.length) addFiles(list); };

  // ---- autocomplete ----
  const ctxData = useCallback(() => mentionContext(channelId, perms), [channelId, perms]);

  const computeAc = (value, caret) => {
    const before = value.slice(0, caret);
    if (/^\/[\w-]*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      const items = COMMANDS.filter((c) => c.name.startsWith(q) && (!c.guildOnly || channel?.guildId)).map((c) => ({ kind: 'command', key: c.name, cmd: c }));
      const bots = (store.get().commands[channel?.guildId] || []).filter((c) => c.name.startsWith(q)).slice(0, 15).map((c) => ({ kind: 'botcommand', key: c.id, cmd: c }));
      items.push(...bots);
      return items.length ? { trigger: '/', start: 0, end: caret, items } : null;
    }
    // Inside a bot command: offer the choices of the option being typed.
    const bm = channel?.guildId && matchBotCommand(channel.guildId, before, botPick);
    if (bm && /^\/[\w-]+\s/.test(before)) {
      const active = activeOption(bm.cmd, bm.rest);
      const opt = active && bm.cmd.options.find((o) => o.name === active.opt);
      const choices = opt?.choices?.length ? opt.choices : opt?.type === 'boolean' ? [{ name: 'true', value: true }, { name: 'false', value: false }] : null;
      if (choices) {
        const partial = bm.rest.slice(active.valueStart).replace(/^\s+/, '');
        const items = choices.filter((c) => c.name.toLowerCase().includes(partial.toLowerCase()) && c.name.toLowerCase() !== partial.toLowerCase()).slice(0, 10).map((c) => ({ kind: 'choice', key: String(c.value), choice: c }));
        if (items.length) return { trigger: 'choice', start: caret - partial.length, end: caret, items };
      }
    }
    const m = /(^|\s)([@#:])([^\s@#:]*)$/.exec(before);
    if (!m) return null;
    const [, , trig, q] = m;
    const start = caret - q.length - 1;
    const { s, users, roles, channels, emojis } = ctxData();
    const lq = q.toLowerCase();
    let items = [];
    if (trig === '@') {
      const gid = channel?.guildId;
      items = users.map((id) => ({ id, u: s.users[id], name: displayName(s, id, gid) }))
        .filter((x) => x.u && (x.u.username.includes(lq) || x.name.toLowerCase().includes(lq)))
        .sort((a, b) => (a.name.toLowerCase().startsWith(lq) ? 0 : 1) - (b.name.toLowerCase().startsWith(lq) ? 0 : 1) || a.name.localeCompare(b.name))
        .slice(0, 8).map((x) => ({ kind: 'user', key: x.id, ...x }));
      items.push(...roles.filter((r) => r.name.toLowerCase().includes(lq)).slice(0, 5).map((r) => ({ kind: 'role', key: r.id, role: r })));
      if (gid && has(perms, P.MENTION_EVERYONE)) for (const e of ['everyone', 'here']) if (e.startsWith(lq)) items.push({ kind: 'everyone', key: e, name: e });
    } else if (trig === '#') {
      items = channels.filter((c) => c.name.toLowerCase().includes(lq)).slice(0, 10).map((c) => ({ kind: 'channel', key: c.id, ch: c }));
    } else if (trig === ':' && q.length >= 2) {
      items = searchEmoji(q, emojis, 10).map((e) => ({ kind: 'emoji', key: e.custom ? e.custom.id : e.char, e }));
    }
    return items.length ? { trigger: trig, start, end: caret, items } : null;
  };

  const applyAc = (item) => {
    if (!ac) return;
    let ins = '';
    if (item.kind === 'command') ins = `/${item.cmd.name} `;
    if (item.kind === 'botcommand') { ins = `/${item.cmd.name} `; setBotPick(item.cmd.id); }
    if (item.kind === 'choice') ins = `${item.choice.name} `;
    if (item.kind === 'user') ins = `@${item.u.username} `;
    if (item.kind === 'role') ins = `@${item.role.name} `;
    if (item.kind === 'everyone') ins = `@${item.name} `;
    if (item.kind === 'channel') ins = `#${item.ch.name} `;
    if (item.kind === 'emoji') ins = item.e.custom ? `:${item.e.custom.name}: ` : item.e.char;
    const next = text.slice(0, ac.start) + ins + text.slice(ac.end);
    setText(next);
    setAc(null);
    const pos = ac.start + ins.length;
    // (same here: if letters were typed right after the suggestion was picked, the cursor must not jump back behind them)
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); if (el.value === next) el.setSelectionRange(pos, pos); } });
  };

  // Convert human-friendly mentions to markup before sending.
  const encode = (raw) => {
    const ctx = ctxData();
    let out = encodeMentions(raw, ctx);
    out = replaceShortcodes(out, ctx.emojis);
    if (getSetting('chat.convertEmoticons')) out = convertEmoticons(out);
    return out;
  };

  // "Send later": same text handling as sending (commands, @silent, mentions), but nothing is sent now.
  const clearAfterScheduling = () => {
    setText(''); setReply(channelId, null); setAc(null);
    if (taRef.current) taRef.current.style.height = '';
  };
  const prepareScheduled = (raw = text) => {
    let content = raw.trim();
    let silent = false;
    const cm = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(content);
    if (cm) {
      const cmd = COMMANDS.find((c) => c.name === cm[1].toLowerCase());
      if (!cmd && channel?.guildId && matchBotCommand(channel.guildId, content, botPick)) { toast('Bot commands can’t be scheduled.', 'error'); return null; }
      if (cmd?.action) { toast('That command can’t be scheduled.', 'error'); return null; }
      if (cmd?.schedule) content = (cm[2] || '').trim();
      else if (cmd) { content = cmd.run((cm[2] || '').trim()); silent = !!cmd.silent; }
    }
    if (content.startsWith('@silent ')) { silent = true; content = content.slice(8).trim(); }
    if (!content) { toast('Type your message first, then schedule it.', 'info', 2500); return null; }
    if (content.length > 4000) { toast('Your message is too long (max 4000 characters).', 'error'); return null; }
    return { content: encode(content), silent };
  };
  const scheduleThis = async (at) => {
    if (!canSend || timedOut) return;
    const p = prepareScheduled();
    if (!p) return;
    if (replyTo?.quietTo) { toast('A quiet reply can’t be scheduled.', 'error'); return; }
    const reply = replyTo ? replyTo.id : null;
    if (!at) { openSchedulePicker({ channelId, content: p.content, silent: p.silent, replyTo: reply, onScheduled: clearAfterScheduling }); return; }
    if (await scheduleMessage(channelId, p.content, at, { replyTo: reply, silent: p.silent })) {
      clearAfterScheduling();
      toast(`Scheduled. It will be sent ${timeUntil(at)}.`, 'success', 3500);
    }
  };
  const scheduleMenu = (e) => openContextMenu(e, [
    ...schedulePresets().map((p) => ({ label: p.label, icon: 'clock', onClick: () => scheduleThis(p.at) })),
    { label: 'Pick a time…', icon: 'clock', onClick: () => scheduleThis(null) },
  ]);

  const submit = async () => {
    if (!canSend || timedOut) return;
    if (slowUntil > Date.now()) return;
    let content = text.trim();
    let silent = false;
    // Slash commands
    const cm = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(content);
    if (cm) {
      const cmd = COMMANDS.find((c) => c.name === cm[1].toLowerCase());
      // A bot's command (built-in ones win unless this one was picked from the list)
      const bm = channel?.guildId ? matchBotCommand(channel.guildId, content, botPick) : null;
      if (bm && (!cmd || botPick === bm.cmd.id)) {
        let options;
        try { options = resolveOptions(bm.cmd, channel.guildId, parseOptionText(bm.cmd, bm.rest).values); } catch (e) { toast(e.message, 'error', 6000); return; }
        if (await runBotCommand(channelId, bm.cmd, options)) {
          setText(''); setBotPick(null); setAc(null);
          if (taRef.current) taRef.current.style.height = '';
          lastTyping.current = 0;
        }
        return;
      }
      if (cmd?.schedule) {
        if (!(cm[2] || '').trim()) { toast('Type your message after /schedule, for example: /schedule Happy birthday!', 'info', 4000); return; }
        scheduleThis(null);
        return;
      }
      if (cmd) {
        if (cmd.action) {
          try { await cmd.action((cm[2] || '').trim(), channel); setText(''); } catch (e) { toastError(e); }
          return;
        }
        content = cmd.run((cm[2] || '').trim());
        silent = !!cmd.silent;
      }
    }
    if (content.startsWith('@silent ')) { silent = true; content = content.slice(8).trim(); }
    if (!content && !files.length) return;
    if (content.length > 4000) { toast('Your message is too long (max 4000 characters).', 'error'); return; }
    const reply = replyTo;
    if (reply?.quietTo) {   // a quiet reply: words only, and somebody has to be able to see it
      if (files.length) { toast('A quiet reply can only be text. Remove the files, or turn Quiet off.', 'error'); return; }
      if (!reply.quietTo.length) { toast('Pick at least one person who can see this reply.', 'error'); return; }
      if (content.length > 2000) { toast('A quiet reply can be at most 2000 characters.', 'error'); return; }
    }
    const toSend = files;
    setText(''); setFiles([]); setReply(channelId, null); setAc(null);
    if (taRef.current) { taRef.current.style.height = ''; }
    lastTyping.current = 0;
    if (channel?.rateLimit > 0 && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS)) setSlowUntil(Date.now() + channel.rateLimit * 1000);
    await sendMessage(channelId, encode(content), { replyTo: reply ? { ...reply, mention: reply.mention !== false } : null, files: toSend, silent, quietTo: reply?.quietTo || null });
  };

  const onKeyDown = (e) => {
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex((i) => (i + 1) % ac.items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex((i) => (i - 1 + ac.items.length) % ac.items.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applyAc(ac.items[acIndex] || ac.items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAc(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !(window.matchMedia('(pointer: coarse)').matches && !showSend)) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); e.stopPropagation(); setReply(channelId, null); return; }
    if (e.key === 'ArrowUp' && !text) {
      const list = store.get().messages[channelId]?.list || [];
      const mine = [...list].reverse().find((m) => m.author.id === store.get().me.id && !m.pending && !m.quiet && !m.ephemeral && (m.type === 0 || m.type === 19));   // (a quiet reply can't be edited)
      if (mine) { e.preventDefault(); setUI({ editing: mine.id }); }
    }
  };

  const onChange = (e) => {
    const v = e.target.value;
    setText(v);
    autosize(e.target);
    const next = computeAc(v, e.target.selectionStart);
    setAc(next); setAcIndex(0);
    if (v && !v.startsWith('/') && Date.now() - lastTyping.current > 8000) {
      lastTyping.current = Date.now();
      send('typing', { channelId });
    }
  };

  // A change made from the code, not by typing (the box's own mention handling uses it when the browser cannot do an undoable edit).
  const editTo = (next, caret) => {
    setText(next);
    setAc(computeAc(next, caret)); setAcIndex(0);
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); if (el.value === next) el.setSelectionRange(caret, caret); autosize(el); } });
  };

  const onPaste = (e) => {
    const fl = [...(e.clipboardData?.files || [])];
    if (fl.length) { e.preventDefault(); addFiles(fl); }
  };

  if (!channel) return null;
  let disabledReason = null;
  if (dmBlocked) disabledReason = 'You cannot send messages to a user you have blocked.';
  else if (timedOut) disabledReason = `You’re timed out until ${formatTime(myMember.timeoutUntil)}. You can still read messages.`;
  else if (isThread && channel.locked && !has(perms, P.MANAGE_THREADS)) disabledReason = 'This thread is locked.';
  else if (!canSend) disabledReason = t('noPermissionToSend');

  // While a bot's command is being typed, show what it does and which options it takes.
  let botHint = null;
  if (botCommands?.length && !disabledReason && /^\/[\w-]+(\s|$)/.test(text)) {
    const bm = matchBotCommand(channel.guildId, text, botPick);
    const builtin = COMMANDS.some((c) => c.name === bm?.cmd.name);
    if (bm && (!builtin || botPick === bm.cmd.id)) botHint = { cmd: bm.cmd, given: parseOptionText(bm.cmd, bm.rest).values };
  }
  const pickOption = (o) => {
    setText((cur) => `${cur.replace(/\s*$/, ' ')}${o.name}:`);
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };

  const slowLeft = Math.max(0, Math.ceil((slowUntil - Date.now()) / 1000));
  return (
    <div className={cx('composer-wrap', compact && 'compact')}>
      {ac && (
        <div className="autocomplete">
          <div className="ac-title">{ac.trigger === '/' ? 'Commands' : ac.trigger === 'choice' ? 'Choices' : ac.trigger === '@' ? 'Members' : ac.trigger === '#' ? 'Text Channels' : `Emoji matching :${text.slice(ac.start + 1, ac.end)}`}</div>
          {ac.items.map((it, i) => (
            <div key={`${it.kind}${it.key}`} className={cx('ac-item', i === acIndex && 'selected')} onMouseEnter={() => setAcIndex(i)} onMouseDown={(e) => { e.preventDefault(); applyAc(it); }}>
              <AcItem it={it} guildId={channel.guildId} />
            </div>
          ))}
        </div>
      )}
      {botHint && <BotHint hint={botHint} onPickOption={pickOption} />}
      {replyTo && <ReplyBar channelId={channelId} reply={replyTo} guildId={channel.guildId} />}
      {replyTo?.quietTo && <QuietRow channelId={channelId} reply={replyTo} guildId={channel.guildId} />}
      {files.length > 0 && (
        <div className="upload-tray">
          {files.map((f, i) => (
            <div key={i} className={cx('upload-item', f.spoiler && 'spoiler', f.editingAlt && 'editing-alt')}>
              <div className="upload-thumb">{f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={40} />}</div>
              <div className="upload-name truncate">{f.name}</div>
              <div className="tiny muted">{formatBytes(f.size)}</div>
              {f.editingAlt && (
                <textarea className="input upload-alt" autoFocus rows={3} maxLength={1000} value={f.description || ''} placeholder="Describe this for people who can’t see it"
                  aria-label={`Description of ${f.name}`} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                  onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); e.stopPropagation(); setFiles(files.map((x, j) => (j === i ? { ...x, editingAlt: false } : x))); } }} />
              )}
              <div className="upload-actions">
                {/^(image|video)\//.test(f.type || '') && (
                  <button data-tooltip={f.description ? 'Edit description' : 'Add description'} aria-label="Add a description for people who can’t see this" className={cx('alt-btn', (f.description || f.editingAlt) && 'active')}
                    onClick={() => setFiles(files.map((x, j) => (j === i ? { ...x, editingAlt: !x.editingAlt } : x)))}>ALT</button>
                )}
                <button data-tooltip="Spoiler" aria-label="Mark as spoiler" className={cx(f.spoiler && 'active')} onClick={() => setFiles(files.map((x, j) => (j === i ? { ...x, spoiler: !x.spoiler } : x)))}><Icon name={f.spoiler ? 'eyeOff' : 'eye'} size={16} /></button>
                <button data-tooltip="Remove" aria-label="Remove attachment" className="danger" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {rec.recording && (
        <div className="voice-recording" role="status">
          <span className="rec-dot" />
          <b>Recording</b>
          <span className="tiny muted">{Math.floor(rec.seconds / 60)}:{String(rec.seconds % 60).padStart(2, '0')} / 5:00</span>
          <span className="grow" />
          <button className="icon-btn small" aria-label="Cancel recording" data-tooltip="Cancel" onClick={rec.cancel}><Icon name="trash" size={18} /></button>
          <button className="icon-btn small rec-send" aria-label="Send voice message" data-tooltip="Send" onClick={rec.stop}><Icon name="send" size={18} /></button>
        </div>
      )}
      <div className={cx('composer', disabledReason && 'disabled', (replyTo || files.length || botHint) && 'attached-top')}>
        {(canAttach || canSend) && !disabledReason && (
          <button className="composer-btn upload-btn" aria-label="Add to message" data-tooltip="Upload a File or Create a Poll" data-tooltip-side="top" data-tooltip-align="start"
            onClick={(e) => openContextMenu(e, [
              canAttach && { label: 'Upload a File', icon: 'upload', onClick: choose },
              canSend && { label: 'Create Poll', icon: 'poll', onClick: () => openPollModal(channelId) },
            ])}><Icon name="plusCircle" size={22} /></button>
        )}
        <MentionTextarea inputRef={taRef} className="composer-input" rows={1} value={disabledReason ? '' : text} disabled={!!disabledReason}
          spans={disabledReason ? NO_SPANS : typedMentionSpans(text, channelId, perms)} onEdit={editTo}
          placeholder={disabledReason || placeholder} spellCheck={getSetting('chat.spellcheck')} maxLength={4100}
          onChange={onChange} onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => setTimeout(() => setAc(null), 150)}
          onClick={(e) => { const n = computeAc(text, e.target.selectionStart); setAc(n); }} aria-label={placeholder} />
        {!disabledReason && (
          <div className="composer-tools">
            {text.length > 3800 && <span className={cx('char-count', text.length > 4000 && 'over')}>{4000 - text.length}</span>}
            <button ref={gifRef} className="composer-btn" aria-label="Send a GIF" data-tooltip="GIFs"
              onClick={() => openPopout(gifRef.current, ({ close }) => <EmojiPicker initialTab="gif" showGifs onClose={close} onSelect={({ text: tx }) => insertText(tx)} onGif={sendPickedGif} channelId={channelId} onSticker={sendPickedSticker} />, { placement: 'top', align: 'end', key: 'gif' })}>
              <Icon name="gif" size={22} />
            </button>
            <button ref={emojiRef} className="composer-btn" aria-label="Select emoji" data-tooltip="Emoji"
              onClick={() => openPopout(emojiRef.current, ({ close }) => <EmojiPicker showGifs onClose={close} onSelect={({ text: tx }) => insertText(tx)} onGif={sendPickedGif} channelId={channelId} onSticker={sendPickedSticker} />, { placement: 'top', align: 'end', key: 'emoji' })}>
              <Icon name="smile" size={22} />
            </button>
            {canAttach && !text.trim() && !files.length && !rec.recording && (
              <button className="composer-btn" aria-label="Record a voice message" data-tooltip="Voice Message" onClick={rec.start}><Icon name="mic" size={22} /></button>
            )}
            {canSend && text.trim() && !files.length && !rec.recording && !botHint && !/^\/(poll|nick|thread)\b/i.test(text) && (
              <button className="composer-btn" aria-label="Schedule send" data-tooltip="Send later" onClick={scheduleMenu}><Icon name="clock" size={21} /></button>
            )}
            {(showSend || window.matchMedia('(pointer: coarse)').matches) && <button className="composer-btn send-btn" aria-label="Send" onClick={submit} disabled={!text.trim() && !files.length}
              onMouseDown={(e) => e.preventDefault() /* the box keeps the cursor (and on a phone the keyboard stays up) instead of the button taking it */}><Icon name="send" size={20} /></button>}
          </div>
        )}
      </div>
      <div className="composer-footer">
        <TypingIndicator channelId={channelId} />
        {scheduledHere > 0 && (
          <button type="button" className="link-btn scheduled-chip" onClick={openScheduledTab} data-tooltip="See what’s waiting to be sent"><Icon name="clock" size={13} /> {scheduledHere} scheduled</button>
        )}
        {channel.rateLimit > 0 && <span className="slowmode" data-tooltip={`Slowmode is enabled: ${channel.rateLimit}s`}><Icon name="clock" size={14} /> {slowLeft > 0 ? `${slowLeft}s` : 'Slowmode'}</span>}
      </div>
    </div>
  );
}

/** Records from the microphone and hands back the audio when you press send (max 5 minutes). */
function useVoiceRecorder(onDone) {
  const [state, setState] = useState({ recording: false, seconds: 0 });
  const mr = useRef(null);
  const chunks = useRef([]);
  const timer = useRef(null);
  const cancelled = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const cleanup = () => { clearInterval(timer.current); mr.current?.stream?.getTracks().forEach((t) => t.stop()); mr.current = null; setState({ recording: false, seconds: 0 }); };
  useEffect(() => () => { cancelled.current = true; if (mr.current && mr.current.state !== 'inactive') mr.current.stop(); clearInterval(timer.current); }, []);
  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Your browser can’t record audio.', 'error'); return; }
    try {
      const l = getLocal();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: l.inputDeviceId && l.inputDeviceId !== 'default' ? { exact: l.inputDeviceId } : undefined,
        echoCancellation: l.echoCancellation, noiseSuppression: l.noiseSuppression, autoGainControl: l.autoGainControl,
      } });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported?.(m));
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = []; cancelled.current = false;
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        const wasCancelled = cancelled.current;
        const blob = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' });
        cleanup();
        if (wasCancelled || blob.size < 1200) { if (!wasCancelled) toast('That was too short to send.', 'warning'); return; }
        const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
        doneRef.current(blob, `voice-message-${Date.now()}.${ext}`);
      };
      mr.current = r;
      r.start(250);
      const t0 = Date.now();
      setState({ recording: true, seconds: 0 });
      timer.current = setInterval(() => {
        const sec = Math.floor((Date.now() - t0) / 1000);
        setState({ recording: true, seconds: sec });
        if (sec >= 300 && mr.current?.state === 'recording') mr.current.stop();
      }, 250);
    } catch (e) {
      toast(e?.name === 'NotAllowedError' ? 'Allow microphone access to record a voice message.' : 'Couldn’t start recording.', 'error');
    }
  };
  const stop = () => { if (mr.current?.state === 'recording') mr.current.stop(); };
  const cancel = () => { cancelled.current = true; if (mr.current?.state === 'recording') mr.current.stop(); else cleanup(); };
  return { ...state, start, stop, cancel };
}

/** The option a bot command is asking for at the caret: the last "name:" typed, or the first option before any. */
function activeOption(cmd, rest) {
  const names = (cmd.options || []).map((o) => o.name);
  if (!names.length) return null;
  const re = new RegExp(`(^|\\s)(${names.map((n) => n.replace(/-/g, '\\-')).join('|')}):`, 'g');
  let found = null;
  for (let m = re.exec(rest); m; m = re.exec(rest)) found = { opt: m[2], valueStart: m.index + m[0].length };
  return found || { opt: names[0], valueStart: 0 };
}

function BotName({ id }) {
  const name = useStore((s) => s.users[id]?.displayName || s.users[id]?.username || 'Bot');
  return <span className="bot-tag small-tag">{name}</span>;
}

/** The strip above the message box while a bot command is typed: which bot, what it does, and its options (tap one to type it). */
function BotHint({ hint, onPickOption }) {
  const { cmd, given } = hint;
  const missing = (cmd.options || []).filter((o) => o.required && given[o.name] === undefined);
  return (
    <div className="bot-hint" role="status">
      <div className="bot-hint-head">
        <Avatar userId={cmd.botId} size={22} />
        <BotName id={cmd.botId} />
        <span className="ac-cmd">/{cmd.name}</span>
        <span className="muted small truncate">{cmd.description}</span>
      </div>
      {cmd.options?.length > 0 && (
        <div className="bot-hint-opts">
          {cmd.options.map((o) => (
            <button key={o.name} type="button" className={cx('opt-chip', given[o.name] !== undefined && 'filled', o.required && 'req')} title={o.description}
              onMouseDown={(e) => { e.preventDefault(); onPickOption(o); }}>
              {o.name}{o.required ? ' *' : ''}{o.choices?.length ? ' ▾' : ''}
              <span className="opt-desc">{o.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="tiny muted">{missing.length ? `Still needed: ${missing.map((o) => o.name).join(', ')}.` : 'Press Enter to run it.'}</div>
    </div>
  );
}

function AcItem({ it, guildId }) {
  const color = useStore((s) => (it.kind === 'user' && guildId ? memberColor(s, guildId, it.id) : null));
  if (it.kind === 'command') return <><span className="ac-cmd">/{it.cmd.name}</span><span className="muted small grow right">{it.cmd.desc}</span></>;
  if (it.kind === 'botcommand') return <><Avatar userId={it.cmd.botId} size={22} /><span className="ac-cmd">/{it.cmd.name}</span><span className="ac-opts">{(it.cmd.options || []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ')}</span><span className="muted small grow right truncate">{it.cmd.description}</span><BotName id={it.cmd.botId} /></>;
  if (it.kind === 'choice') return <span>{it.choice.name}</span>;
  if (it.kind === 'user') return <><Avatar userId={it.id} guildId={guildId} size={24} status /><span style={color ? { color } : undefined}>{it.name}</span><span className="muted small grow right">{it.u.username}</span></>;
  if (it.kind === 'role') return <><span className="role-dot" style={{ background: it.role.color ? '#' + it.role.color.toString(16).padStart(6, '0') : 'var(--text-muted)' }} /><span>@{it.role.name}</span><span className="muted small grow right">Role</span></>;
  if (it.kind === 'everyone') return <><Icon name="at" size={20} /><span>@{it.name}</span><span className="muted small grow right">{it.name === 'everyone' ? 'Notify everyone who can see this channel.' : 'Notify everyone online.'}</span></>;
  if (it.kind === 'channel') return <><Icon name={it.ch.type === 2 ? 'speaker' : it.ch.type === 13 ? 'stage' : it.ch.type === 5 ? 'megaphone' : it.ch.type === 11 ? 'thread' : 'hash'} size={18} /><span>{it.ch.name}</span></>;
  if (it.kind === 'emoji') return <>{it.e.custom ? <img className="emoji custom" src={it.e.custom.url} alt="" /> : <span className="emoji-char">{it.e.char}</span>}<span>:{it.e.custom ? it.e.custom.name : it.e.name}:</span></>;
  return null;
}

function ReplyBar({ channelId, reply, guildId }) {
  const name = useStore((s) => authorName(s, reply.author, guildId));
  const mention = reply.mention !== false;
  const self = useStore((s) => reply.author.id === s.me.id);
  const quietOk = useStore((s) => quietAllowed(s.channels[channelId]) && !reply.author.webhook);
  return (
    <div className="reply-bar">
      <span>{reply.quietTo ? 'Quiet reply to' : 'Replying to'} <b>{name}</b></span>
      <span className="grow" />
      {quietOk && <QuietSwitch channelId={channelId} reply={reply} />}
      {!self && !reply.quietTo && (
        <label className="reply-mention" data-tooltip={mention ? 'Click to disable pinging the original author' : 'Click to enable pinging the original author'}>
          <span className={cx(mention ? 'on' : 'off')}>@{mention ? 'ON' : 'OFF'}</span>
          <Switch checked={mention} onChange={(v) => setReply(channelId, { ...reply, mention: v })} />
        </label>
      )}
      <button className="icon-btn small" aria-label="Cancel reply" onClick={() => setReply(channelId, null)}><Icon name="x" size={16} /></button>
    </div>
  );
}

export function TypingIndicator({ channelId }) {
  const t = useT();
  const typing = useStore((s) => s.typing[channelId]);
  const [now, setNow] = useState(Date.now());
  const active = useMemo(() => Object.entries(typing || {}).filter(([, ts]) => now - ts < 9000).map(([id]) => id), [typing, now]);
  const names = useStore((s) => active.map((id) => displayName(s, id, s.channels[channelId]?.guildId)));
  useEffect(() => {
    if (!active.length) return undefined;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [active.length]);
  useEffect(() => { setNow(Date.now()); }, [typing]);
  if (!names.length) return <div className="typing" />;
  const label = names.length === 1 ? t('typing1', { a: names[0] }) : names.length === 2 ? t('typing2', { a: names[0], b: names[1] }) : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]} are typing…` : t('typingMany');
  return <div className="typing"><span className="typing-dots"><i /><i /><i /></span><span className="truncate">{label.split(/(\b(?:is|are) typing…)/).map((p, i) => (i % 2 ? p : <b key={i}>{p}</b>))}</span></div>;
}
