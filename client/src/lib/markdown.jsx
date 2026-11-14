// Safe markdown renderer producing React elements (never uses innerHTML).
import { useState, Fragment } from 'react';
import { useStore, displayName } from './state.js';
import { formatFull, relativeTime, formatTime, formatDate, formatShortDate, copyText } from './utils.js';
import { navigate } from './router.jsx';

const INLINE_RULES = [
  ['code', /``([^`]+?)``|`([^`\n]+?)`/],
  ['mention', /<@!?(\d{19})>/],
  ['role', /<@&(\d{19})>/],
  ['channel', /<#(\d{19})>/],
  ['customEmoji', /<(a?):([a-zA-Z0-9_]{2,32}):(\d{19})>/],
  ['timestamp', /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/],
  ['masked', /\[([^\]\n]{1,200})\]\(<?(https?:\/\/[^\s)>]+)>?\)/],
  ['url', /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_~|])/],
  ['everyone', /@(everyone|here)\b/],
  ['spoiler', /\|\|([\s\S]+?)\|\|/],
  ['bold', /\*\*([\s\S]+?)\*\*/],
  ['underline', /__([\s\S]+?)__/],
  // (the last character before the closing mark cannot be a backslash: "\_" or "\*" is a plain mark, it does not end the italics)
  ['italic', /\*(?!\s)([\s\S]*?[^\s*\\])\*(?!\*)|(?<![\w])_(?!\s)([\s\S]*?[^\s_\\])_(?![\w])/],
  ['strike', /~~([\s\S]+?)~~/],
  ['escape', /\\([*_~`|\\<>#@[\]()-])/],
];

function parseInline(text, depth = 0) {
  const out = [];
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 2000) {
    let best = null;
    for (const [name, re] of INLINE_RULES) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { name, m };
      if (best && best.m.index === 0) break;
    }
    if (!best) { out.push({ t: 'text', v: rest }); break; }
    const { name, m } = best;
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) });
    const nested = (s) => (depth > 6 ? [{ t: 'text', v: s }] : parseInline(s, depth + 1));
    switch (name) {
      case 'code': out.push({ t: 'code', v: m[1] ?? m[2] }); break;
      case 'mention': out.push({ t: 'mention', id: m[1] }); break;
      case 'role': out.push({ t: 'role', id: m[1] }); break;
      case 'channel': out.push({ t: 'channel', id: m[1] }); break;
      case 'customEmoji': out.push({ t: 'customEmoji', animated: !!m[1], name: m[2], id: m[3] }); break;
      case 'timestamp': out.push({ t: 'timestamp', ts: Number(m[1]) * 1000, style: m[2] || 'f' }); break;
      case 'masked': out.push({ t: 'link', href: m[2], children: nested(m[1]) }); break;
      case 'url': out.push({ t: 'link', href: m[1] || m[2], children: [{ t: 'text', v: m[1] || m[2] }] }); break;
      case 'everyone': out.push({ t: 'everyone', v: m[1] }); break;
      case 'spoiler': out.push({ t: 'spoiler', children: nested(m[1]) }); break;
      case 'bold': out.push({ t: 'strong', children: nested(m[1]) }); break;
      case 'underline': out.push({ t: 'u', children: nested(m[1]) }); break;
      case 'italic': out.push({ t: 'em', children: nested(m[1] ?? m[2]) }); break;
      case 'strike': out.push({ t: 's', children: nested(m[1]) }); break;
      case 'escape': out.push({ t: 'text', v: m[1] }); break;
      default: break;
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Split text into blocks: code fences, quotes, headings, lists and paragraphs. */
function parseBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', v: para.join('\n') }); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([\w+-]*)\s*(.*)$/.exec(line);
    if (fence) {
      // Find closing fence (may be on the same line).
      const sameLine = /^```([\w+-]*)?(.*?)```\s*$/.exec(line);
      if (sameLine && line.length > 6) { flush(); blocks.push({ t: 'codeblock', lang: '', v: (sameLine[1] || '') + (sameLine[2] || '') }); i++; continue; }
      let j = i + 1; const body = fence[2] ? [fence[2]] : [];
      while (j < lines.length && !/```\s*$/.test(lines[j])) { body.push(lines[j]); j++; }
      if (j < lines.length) {
        const last = lines[j].replace(/```\s*$/, '');
        if (last) body.push(last);
        flush(); blocks.push({ t: 'codeblock', lang: fence[1], v: body.join('\n') }); i = j + 1; continue;
      }
    }
    if (/^>>> ?/.test(line)) { flush(); blocks.push({ t: 'quote', v: [line.replace(/^>>> ?/, ''), ...lines.slice(i + 1)].join('\n') }); break; }
    if (/^> ?/.test(line) && !/^>\S*>/.test(line)) {
      flush(); const q = [];
      while (i < lines.length && /^> ?/.test(lines[i])) { q.push(lines[i].replace(/^> ?/, '')); i++; }
      blocks.push({ t: 'quote', v: q.join('\n') }); continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, v: h[2] }); i++; continue; }
    const sub = /^-# (.+)$/.exec(line);
    if (sub) { flush(); blocks.push({ t: 'sub', v: sub[1] }); i++; continue; }
    if (/^\s*([-*]|\d+\.) \S/.test(line)) {
      flush(); const items = []; const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.) \S/.test(lines[i])) { items.push({ indent: /^\s+/.test(lines[i]), v: lines[i].replace(/^\s*([-*]|\d+\.) /, '') }); i++; }
      blocks.push({ t: ordered ? 'ol' : 'ul', items }); continue;
    }
    para.push(line); i++;
  }
  flush();
  return blocks;
}

// ---------------- rendering ----------------
function UserMention({ id, ctx }) {
  const name = useStore((s) => (s.users[id] ? displayName(s, id, ctx.guildId) : null));
  return (
    <span className="mention interactive" onClick={(e) => ctx.onUserClick?.(id, e)}>@{name || 'unknown-user'}</span>
  );
}
function RoleMention({ id, ctx }) {
  const role = useStore((s) => (ctx.guildId ? s.guilds[ctx.guildId]?.roles.find((r) => r.id === id) : null));
  if (!role) return <span className="mention">@deleted-role</span>;
  const color = role.color ? '#' + role.color.toString(16).padStart(6, '0') : null;
  return <span className="mention" style={color ? { color, background: color + '26' } : undefined}>@{role.name}</span>;
}
function ChannelMention({ id }) {
  const ch = useStore((s) => s.channels[id]);
  if (!ch) return <span className="mention">#unknown</span>;
  const go = () => navigate(ch.guildId ? `/channels/${ch.guildId}/${ch.type === 11 ? ch.parentId : ch.id}${ch.type === 11 ? `?thread=${ch.id}` : ''}` : `/channels/@me/${ch.id}`);
  return <span className="mention interactive" onClick={go}>{ch.type === 2 || ch.type === 13 ? '🔊' : '#'}{ch.name}</span>;
}
function Spoiler({ children }) {
  const [shown, setShown] = useState(false);
  return <span className={'spoiler' + (shown ? ' shown' : '')} onClick={() => setShown(true)}>{children}</span>;
}
function Timestamp({ ts, style }) {
  const map = {
    t: () => formatTime(ts), T: () => new Date(ts).toLocaleTimeString(), d: () => formatShortDate(ts), D: () => formatDate(ts),
    f: () => `${formatDate(ts)} ${formatTime(ts)}`, F: () => formatFull(ts), R: () => relativeTime(ts),
  };
  return <span className="md-timestamp" title={formatFull(ts)}>{(map[style] || map.f)()}</span>;
}
function CodeBlock({ lang, v }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="md-codeblock">
      <button className="md-copy" onClick={() => { copyText(v); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied!' : 'Copy'}</button>
      {lang && <span className="md-lang">{lang}</span>}
      <code>{v}</code>
    </pre>
  );
}

function safeHref(href) {
  try { const u = new URL(href); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; }
}

function renderInline(nodes, ctx, keyPrefix = '') {
  return nodes.map((n, i) => {
    const key = keyPrefix + i;
    switch (n.t) {
      case 'text': return <Fragment key={key}>{ctx.emojiText ? ctx.emojiText(n.v, key) : n.v}</Fragment>;
      case 'code': return <code key={key} className="md-code">{n.v}</code>;
      case 'mention': return <UserMention key={key} id={n.id} ctx={ctx} />;
      case 'role': return <RoleMention key={key} id={n.id} ctx={ctx} />;
      case 'channel': return <ChannelMention key={key} id={n.id} />;
      case 'everyone': return <span key={key} className="mention">@{n.v}</span>;
      case 'customEmoji': return <img key={key} className={'emoji custom' + (ctx.jumbo ? ' jumbo' : '')} src={`/emojis/${n.id}`} alt={`:${n.name}:`} title={`:${n.name}:`} draggable={false} onError={(e) => { e.currentTarget.replaceWith(document.createTextNode(`:${n.name}:`)); }} />;
      case 'timestamp': return <Timestamp key={key} ts={n.ts} style={n.style} />;
      case 'link': {
        const href = safeHref(n.href);
        if (!href) return <Fragment key={key}>{renderInline(n.children, ctx, key + '-')}</Fragment>;
        return <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" title={href} onClick={(e) => ctx.onLinkClick?.(href, e)}>{renderInline(n.children, ctx, key + '-')}</a>;
      }
      case 'spoiler': return <Spoiler key={key}>{renderInline(n.children, ctx, key + '-')}</Spoiler>;
      case 'strong': return <strong key={key}>{renderInline(n.children, ctx, key + '-')}</strong>;
      case 'em': return <em key={key}>{renderInline(n.children, ctx, key + '-')}</em>;
      case 'u': return <u key={key}>{renderInline(n.children, ctx, key + '-')}</u>;
      case 's': return <s key={key}>{renderInline(n.children, ctx, key + '-')}</s>;
      default: return null;
    }
  });
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}\u{FE0F}?)*|\p{Regional_Indicator}{2}|<a?:\w{2,32}:\d{19}>|\s)+$/u;

export function isEmojiOnly(text) {
  if (!text || text.length > 200 || !EMOJI_ONLY.test(text)) return false;
  const count = (text.match(/\p{Extended_Pictographic}|<a?:\w+:\d+>/gu) || []).length;
  return count > 0 && count <= 27;
}

export function Markdown({ text, ctx = {}, inlineOnly = false }) {
  if (!text) return null;
  const jumbo = !inlineOnly && isEmojiOnly(text.trim());
  const c = { ...ctx, jumbo };
  if (inlineOnly) return <>{renderInline(parseInline(text), c)}</>;
  const blocks = parseBlocks(text);
  return (
    <div className={'markdown' + (jumbo ? ' jumbo' : '')}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'codeblock': return <CodeBlock key={i} lang={b.lang} v={b.v} />;
          case 'quote': return <blockquote key={i}><Markdown text={b.v} ctx={ctx} /></blockquote>;
          case 'h': { const H = `h${b.level}`; return <H key={i} className="md-h">{renderInline(parseInline(b.v), c, `${i}-`)}</H>; }
          case 'sub': return <small key={i} className="md-sub">{renderInline(parseInline(b.v), c, `${i}-`)}</small>;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j} className={it.indent ? 'indent' : ''}>{renderInline(parseInline(it.v), c, `${i}-${j}-`)}</li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(parseInline(it.v), c, `${i}-${j}-`)}</li>)}</ol>;
          default: return <div key={i} className="md-p">{renderInline(parseInline(b.v), c, `${i}-`)}</div>;
        }
      })}
    </div>
  );
}

/** Plain-text version of a message (used for notifications and reply previews). */
export function toPlainText(text, s, guildId) {
  return String(text || '')
    .replace(/<@!?(\d{19})>/g, (_, id) => '@' + (s.users[id] ? displayName(s, id, guildId) : 'unknown'))
    .replace(/<@&(\d{19})>/g, (_, id) => '@' + (s.guilds[guildId]?.roles.find((r) => r.id === id)?.name || 'role'))
    .replace(/<#(\d{19})>/g, (_, id) => '#' + (s.channels[id]?.name || 'channel'))
    .replace(/<a?:(\w+):\d{19}>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toLocaleString())
    .replace(/\|\|[\s\S]+?\|\|/g, '▒▒▒▒')
    .replace(/[*_~`]{1,3}/g, '');
}
