// The Stickers tab of the picker: the stickers of the server you are in first, then the ones from your other servers
// (those only in a direct message, or in a server where you may use external emoji and stickers).
import { useMemo, useState } from 'react';
import { useStore, channelPermissions } from '../lib/state.js';
import { P, has } from '../../../shared/permissions.js';
import { GuildIcon } from './ui.jsx';

/** Does a sticker match what was typed? Every word has to appear in its name or its tag. */
function matches(st, q) {
  const terms = q.toLowerCase().split(/[\s,#]+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${st.name} ${st.tag || ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function StickerPicker({ channelId, onPick }) {
  const guilds = useStore((s) => s.guilds);
  const here = useStore((s) => s.channels[channelId]?.guildId || null);
  const perms = useStore((s) => channelPermissions(s, channelId));
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const canOthers = !here || has(perms, P.USE_EXTERNAL_EMOJIS);
    const list = Object.values(guilds).filter((g) => g.stickers?.length && (g.id === here || canOthers));
    list.sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
    return list.map((g) => ({ guild: g, stickers: g.stickers.filter((st) => matches(st, q)) })).filter((x) => x.stickers.length);
  }, [guilds, here, perms, q]);
  const hasAny = useMemo(() => Object.values(guilds).some((g) => g.stickers?.length), [guilds]);

  return (
    <div className="sticker-picker">
      <div className="picker-search">
        <input className="input" autoFocus placeholder="Find a sticker" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a sticker" />
      </div>
      <div className="sticker-scroll">
        {groups.length ? groups.map(({ guild, stickers }) => (
          <div key={guild.id}>
            <div className="emoji-cat"><GuildIcon guild={guild} size={18} /> {guild.name}</div>
            <div className="sticker-grid">
              {stickers.map((st) => (
                <button key={st.id} className="sticker-cell" onClick={() => onPick(st)} title={st.name} aria-label={`Send the sticker ${st.name}`}>
                  <img src={st.url} alt={st.name} loading="lazy" draggable={false} />
                  <span className="sticker-name">{st.name}</span>
                </button>
              ))}
            </div>
          </div>
        )) : (
          <div className="picker-empty muted">
            {q ? <>No sticker matches “{q}”.</>
              : hasAny ? <>Stickers from your other servers can be used here when you are allowed to use external emoji and stickers.</>
                : <>No stickers yet. Someone who manages emoji and stickers can add them in Server Settings.</>}
          </div>
        )}
      </div>
    </div>
  );
}
