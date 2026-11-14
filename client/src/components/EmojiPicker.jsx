// Emoji picker (unicode + server custom emoji) with a GIF tab and a Stickers tab.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/state.js';
import { CATEGORIES, emojisIn, searchEmoji, getRecent, pushRecent, DEFAULT_RECENT, parseCustomKey, emojiName } from '../lib/emoji.js';
import { api } from '../lib/api.js';
import { cx, debounce } from '../lib/utils.js';
import { GuildIcon, Spinner } from './ui.jsx';
import { Icon } from './icons.jsx';
import { GifPicker } from './GifPicker.jsx';
import { StickerPicker } from './StickerPicker.jsx';

/** Renders an emoji key (unicode or "name:id") as text or an image. */
export function EmojiGlyph({ emoji, size }) {
  const custom = parseCustomKey(emoji);
  if (custom) return <img className="emoji custom" src={`/emojis/${custom.id}`} alt={`:${custom.name}:`} title={`:${custom.name}:`} style={size ? { width: size, height: size } : undefined} draggable={false} />;
  return <span className="emoji-char" style={size ? { fontSize: size * 0.85 } : undefined}>{emoji}</span>;
}

/**
 * onSelect receives { key, text }: `key` for reactions ("😀" or "name:id"), `text` for message content.
 */
export function EmojiPicker({ onSelect, onClose, keepOpen = false, initialTab = 'emoji', showGifs = false, onGif, channelId, onSticker }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div className="picker">
      <div className="picker-tabs">
        {showGifs && <button className={cx('picker-tab', tab === 'gif' && 'active')} onClick={() => setTab('gif')}>GIFs</button>}
        {onSticker && <button className={cx('picker-tab', tab === 'sticker' && 'active')} onClick={() => setTab('sticker')}>Stickers</button>}
        <button className={cx('picker-tab', tab === 'emoji' && 'active')} onClick={() => setTab('emoji')}>Emoji</button>
      </div>
      {tab === 'emoji'
        ? <EmojiGrid onSelect={(sel, shift) => { onSelect(sel); if (!keepOpen && !shift) onClose?.(); }} />
        : tab === 'sticker'
          ? <StickerPicker channelId={channelId} onPick={(st) => { onSticker?.(st); onClose?.(); }} />
          : <GifPicker onPick={(g) => { onGif?.(g); onClose?.(); }} />}
    </div>
  );
}

function EmojiGrid({ onSelect }) {
  const guilds = useStore((s) => s.guilds);
  const customByGuild = useMemo(() => Object.values(guilds).filter((g) => g.emojis?.length), [guilds]);
  const allCustom = useMemo(() => customByGuild.flatMap((g) => g.emojis), [customByGuild]);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState(null);
  const scrollRef = useRef(null);
  const recent = getRecent();
  const recentList = (recent.length ? recent : DEFAULT_RECENT).slice(0, 16);

  const pick = (e, item) => {
    let key; let text;
    if (item.custom) { key = `${item.custom.name}:${item.custom.id}`; text = `<${item.custom.animated ? 'a' : ''}:${item.custom.name}:${item.custom.id}>`; }
    else if (parseCustomKey(item.char)) { const c = parseCustomKey(item.char); const ce = allCustom.find((x) => x.id === c.id); key = item.char; text = `<${ce?.animated ? 'a' : ''}:${c.name}:${c.id}>`; }
    else { key = item.char; text = item.char; }
    pushRecent(key);
    onSelect({ key, text }, e.shiftKey);
  };
  const results = query ? searchEmoji(query, allCustom, 120) : null;
  const jump = (id) => { const el = scrollRef.current?.querySelector(`[data-cat="${id}"]`); if (el) scrollRef.current.scrollTop = el.offsetTop - 4; };

  const cell = (item, i) => {
    const custom = item.custom;
    const label = custom ? custom.name : item.name;
    return (
      <button key={(custom?.id || item.char) + i} className="emoji-cell" onClick={(e) => pick(e, item)}
        onMouseEnter={() => setHover({ item, label })} aria-label={label}>
        {custom ? <img src={custom.url} alt={custom.name} loading="lazy" draggable={false} /> : <EmojiGlyph emoji={item.char} />}
      </button>
    );
  };

  return (
    <div className="emoji-picker">
      <div className="picker-search">
        <input className="input" autoFocus placeholder="Find the perfect emoji" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="emoji-body">
        {!query && (
          <div className="emoji-rail">
            <button onClick={() => jump('recent')} title="Frequently Used"><Icon name="clock" size={18} /></button>
            {customByGuild.map((g) => <button key={g.id} onClick={() => jump(`g${g.id}`)} title={g.name}><GuildIcon guild={g} size={24} /></button>)}
            {CATEGORIES.map((c) => <button key={c.id} onClick={() => jump(c.id)} title={c.label}>{c.icon}</button>)}
          </div>
        )}
        <div className="emoji-scroll" ref={scrollRef}>
          {results ? (
            results.length ? <div className="emoji-grid">{results.map((r, i) => cell(r.custom ? { custom: r.custom } : { char: r.char, name: r.name }, i))}</div>
              : <div className="picker-empty muted">No emoji match “{query}”.</div>
          ) : (
            <>
              <div className="emoji-cat" data-cat="recent">Frequently Used</div>
              <div className="emoji-grid">{recentList.map((k, i) => {
                const c = parseCustomKey(k);
                if (c) { const ce = allCustom.find((x) => x.id === c.id); return ce ? cell({ custom: ce }, i) : null; }
                return cell({ char: k, name: k }, i);
              })}</div>
              {customByGuild.map((g) => (
                <div key={g.id}>
                  <div className="emoji-cat" data-cat={`g${g.id}`}>{g.name}</div>
                  <div className="emoji-grid">{g.emojis.map((ce, i) => cell({ custom: ce }, i))}</div>
                </div>
              ))}
              {CATEGORIES.map((c) => (
                <div key={c.id}>
                  <div className="emoji-cat" data-cat={c.id}>{c.label}</div>
                  <div className="emoji-grid">{emojisIn(c.id).map((e, i) => cell(e, i))}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="emoji-footer">
        {hover ? (
          <>
            {hover.item.custom ? <img src={hover.item.custom.url} alt="" /> : <span className="emoji-big">{hover.item.char}</span>}
            <span>:{hover.item.custom ? hover.label : emojiName(hover.item.char)}:</span>
          </>
        ) : <span className="muted small">Hold Shift to pick several</span>}
      </div>
    </div>
  );
}
