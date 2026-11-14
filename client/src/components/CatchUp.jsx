// The catch-up card: "while you were gone" for the server you just came back to. It floats over the corner of the chat and never
// blocks it; everything on it is a way to jump to the place it talks about. (When it shows: lib/catchup.js.)
import { useEffect } from 'react';
import { useStore, store, displayName } from '../lib/state.js';
import { useStoreOf } from '../lib/store.js';
import { catchUpStore, closeCatchUp } from '../lib/catchup.js';
import { jumpToMessage, ackGuild, channelPath } from '../lib/actions.js';
import { navigate } from '../lib/router.jsx';
import { setUI } from '../lib/ui.js';
import { formatTimestamp } from '../lib/utils.js';
import { Avatar } from './ui.jsx';
import { Icon } from './icons.jsx';

function go(channelId, messageId) {
  const ch = store.get().channels[channelId];
  if (!ch) return;
  navigate(channelPath(ch));
  setUI({ mobileNav: false });
  if (messageId) setTimeout(() => jumpToMessage(channelId, messageId), 60);   // (after the channel has opened)
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function PeopleLine({ c, guildId }) {
  const names = useStore((s) => c.people.map((u) => displayName(s, u.id, guildId) || u.displayName || u.username).join('\u0000')).split('\u0000');
  const rest = c.peopleCount - c.people.length;
  return <>{names.join(', ')}{rest > 0 ? ` and ${plural(rest, 'other')}` : ''}</>;
}

function Item({ item, guildId, icon, label }) {
  const name = useStore((s) => displayName(s, item.author.id, guildId) || item.author.displayName || item.author.username);
  const by = useStore((s) => (item.by ? displayName(s, item.by.id, guildId) || item.by.displayName || item.by.username : null));
  const channel = useStore((s) => s.channels[item.channelId]?.name);
  return (
    <button type="button" className="catchup-item" onClick={() => go(item.channelId, item.id)} data-catchup-item={item.id}>
      <Avatar user={item.author} guildId={guildId} size={24} />
      <span className="catchup-item-body">
        <span className="catchup-item-head">{icon && <Icon name={icon} size={12} />}<b>{name}</b> <span className="muted">{label ? `${label} in` : 'in'} #{channel}{by ? ` · pinned by ${by}` : ''}</span></span>
        <span className="catchup-snippet">{item.content || 'Sent something without text'}</span>
      </span>
    </button>
  );
}

export function CatchUpCard() {
  const card = useStoreOf(catchUpStore, (s) => s.card);
  const guildName = useStore((s) => (card ? s.guilds[card.guildId]?.name : null));
  const names = useStore((s) => (card ? card.data.channels.map((c) => s.channels[c.id]?.name || '').join('\u0000') : ''));
  useEffect(() => {
    if (!card) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop, .popout, .context-menu')) closeCatchUp(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card]);
  if (!card || !guildName) return null;
  const d = card.data;
  const chanNames = names.split('\u0000');
  const waiting = [...d.quiet.map((q) => ({ ...q, kind: 'quiet' })), ...d.mentions.map((m) => ({ ...m, kind: 'mention' }))];
  const nothing = !d.total && !waiting.length && !d.pins.length;
  return (
    <aside className="catchup-card" role="complementary" aria-label="While you were gone" data-catchup>
      <header className="catchup-head">
        <div>
          <div className="catchup-title">While you were gone</div>
          <div className="catchup-sub">{guildName}{d.since ? ` · since ${formatTimestamp(d.since)}` : ''}</div>
        </div>
        <button className="icon-btn small" aria-label="Close" onClick={closeCatchUp}><Icon name="x" size={16} /></button>
      </header>
      <div className="catchup-body scroller">
        {nothing ? (
          <p className="catchup-empty">You’re all caught up. Nothing new here.</p>
        ) : (
          <p className="catchup-summary" data-catchup-summary>
            {d.total > 0 ? <><b>{plural(d.total, 'new message')}</b> in {plural(d.channelCount, 'channel')}</> : 'No new conversations'}
            {d.mentionCount > 0 && <> · <b>{plural(d.mentionCount, 'mention')}</b></>}
            {d.quietCount > 0 && <> · <b>{plural(d.quietCount, 'quiet reply', 'quiet replies')}</b></>}
          </p>
        )}
        {waiting.length > 0 && (
          <section data-catchup-section="waiting">
            <h4>Waiting for you</h4>
            {waiting.map((w) => <Item key={w.kind + w.id} item={w} guildId={card.guildId} icon={w.kind === 'quiet' ? 'eyeOff' : null} label={w.kind === 'quiet' ? 'replied quietly' : w.everyone ? 'pinged everyone' : 'mentioned you'} />)}
          </section>
        )}
        {d.channels.length > 0 && (
          <section data-catchup-section="busiest">
            <h4>Busiest conversations</h4>
            {d.channels.map((c, i) => (
              <div className="catchup-channel" key={c.id} data-catchup-channel={c.id}>
                <button type="button" className="catchup-channel-row" onClick={() => go(c.id, c.firstUnreadId)} title="Go to the first new message">
                  <span className="catchup-channel-name"><Icon name="hash" size={14} />{chanNames[i]}</span>
                  <span className="catchup-count">{c.count}{c.capped ? '+' : ''}</span>
                </button>
                <div className="catchup-people"><PeopleLine c={c} guildId={card.guildId} /></div>
                {c.highlight && (
                  <button type="button" className="catchup-highlight" onClick={() => go(c.id, c.highlight.id)} title="Go to this message">
                    <Icon name="star" size={12} />
                    <span className="catchup-snippet"><b>{displayName(store.get(), c.highlight.author.id, card.guildId) || c.highlight.author.displayName}</b>: {c.highlight.content}</span>
                    <span className="catchup-why">{[c.highlight.reactions ? plural(c.highlight.reactions, 'reaction') : null, c.highlight.replies ? plural(c.highlight.replies, 'reply', 'replies') : null].filter(Boolean).join(' · ')}</span>
                  </button>
                )}
              </div>
            ))}
            {d.channelCount > d.channels.length && <div className="catchup-more">and {plural(d.channelCount - d.channels.length, 'more channel')} with new messages</div>}
          </section>
        )}
        {d.pins.length > 0 && (
          <section data-catchup-section="pins">
            <h4>Pinned</h4>
            {d.pins.map((p) => <Item key={p.id} item={p} guildId={card.guildId} icon="pin" />)}
          </section>
        )}
      </div>
      <footer className="catchup-foot">
        {!nothing && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { ackGuild(card.guildId); closeCatchUp(); }}>Mark all as read</button>}
        <button type="button" className="btn btn-primary btn-sm" onClick={closeCatchUp}>{nothing ? 'Close' : 'Got it'}</button>
      </footer>
    </aside>
  );
}
