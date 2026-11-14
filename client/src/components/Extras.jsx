// Yapin'-style extras: "Playing X" line, level badges, server leaderboard, server boosts,
// people suggestions and the text chat that sits next to a voice channel.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useStore, displayName } from '../lib/state.js';
import { toastError, toast } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { openDM } from '../lib/actions.js';
import { badgeForLevel, levelProgress, BOOST_TIERS } from '../../../shared/levels.js';
import { Avatar, Button, Modal, openModal, Spinner } from './ui.jsx';
import { Icon } from './icons.jsx';
import { MessageList } from './Messages.jsx';
import { Composer } from './Composer.jsx';

// ================================================================ small pieces
export function ActivityLine({ activity, className }) {
  if (!activity?.name) return null;
  return <div className={cx('activity-line', className)}><Icon name="gamepad" size={14} /><span className="truncate">Playing <b>{activity.name}</b></span></div>;
}

export function LevelChip({ level, className }) {
  if (level == null) return null;
  const badge = badgeForLevel(level);
  return (
    <span className={cx('level-chip', className)} style={badge ? { '--chip': badge.color } : undefined} data-tooltip={badge ? `${badge.label} · Level ${level}` : `Level ${level}`}>
      LVL {level}
    </span>
  );
}

function Bar({ pct }) {
  return <div className="xp-bar"><span style={{ width: `${Math.round(pct * 100)}%` }} /></div>;
}

function Name({ id, guildId }) {
  const name = useStore((s) => displayName(s, id, guildId));
  return <>{name}</>;
}

// ================================================================ leaderboard
export function openLeaderboard(guildId) {
  openModal(({ close }) => <LeaderboardModal guildId={guildId} close={close} />);
}

function LeaderboardModal({ guildId, close }) {
  const guildName = useStore((s) => s.guilds[guildId]?.name);
  const myId = useStore((s) => s.me.id);
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/guilds/${guildId}/leaderboard`).then(setData).catch((e) => { toastError(e); close(); }); }, [guildId]);
  return (
    <Modal title="Leaderboard" subtitle={`Most active members of ${guildName || 'this server'}. Chat to earn xp.`} onClose={close} size="md" bodyClass="leaderboard-body">
      {!data ? <div className="center pad"><Spinner /></div> : (
        <>
          {data.me && (
            <div className="lb-me">
              <div className="row-center"><b>Your level</b><LevelChip level={data.me.level} /><span className="grow" />
                <span className="muted small">{data.me.rank ? `Rank #${data.me.rank}` : ''} · {data.me.messages} messages</span></div>
              <Bar pct={data.me.pct} />
              <div className="tiny muted">{data.me.xp - data.me.floor} / {data.me.next - data.me.floor} xp to level {data.me.level + 1}</div>
            </div>
          )}
          {data.board.length === 0 ? <p className="muted center pad">No one has earned xp yet. Send a message to get on the board!</p> : (
            <ol className="lb-list">
              {data.board.map((x) => (
                <li key={x.userId} className={cx('lb-row', x.userId === myId && 'me', x.rank <= 3 && `top${x.rank}`)}>
                  <span className="lb-rank">{x.rank <= 3 ? <Icon name="trophy" size={18} /> : x.rank}</span>
                  <Avatar userId={x.userId} size={32} />
                  <span className="grow truncate"><Name id={x.userId} guildId={guildId} /></span>
                  <LevelChip level={x.level} />
                  <span className="lb-xp tiny muted">{x.xp.toLocaleString()} xp</span>
                </li>
              ))}
            </ol>
          )}
          {data.hiddenCount > 0 && <p className="tiny muted">{data.hiddenCount} {data.hiddenCount === 1 ? 'member has' : 'members have'} hidden from the leaderboard.</p>}
        </>
      )}
    </Modal>
  );
}

// ================================================================ boosts
export function openBoost(guildId) {
  openModal(({ close }) => <BoostModal guildId={guildId} close={close} />);
}

function BoostModal({ guildId, close }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/guilds/${guildId}/boosts`).then(setData).catch((e) => { toastError(e); close(); });
  useEffect(() => { load(); }, [guildId, guild?.boostCount]);
  const toggle = async () => {
    setBusy(true);
    try {
      if (data.mine) { await api.del(`/guilds/${guildId}/boost`); toast('Boost removed.', 'success'); }
      else {
        const res = await api.put(`/guilds/${guildId}/boost`);
        toast(res.leveledUp ? `${guild?.name} reached boost level ${res.level}!` : 'Thanks for boosting!', 'success');
      }
      await load();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const next = data ? [...BOOST_TIERS].reverse().find((t) => data.count < t.boosts) : null;
  return (
    <Modal title="Boost this server" subtitle="Boosts are free. Every account gets a few to spread across servers it likes." onClose={close} size="md"
      footer={data && <Button variant={data.mine ? 'secondary' : 'primary'} loading={busy} disabled={!data.mine && data.remaining === 0} onClick={toggle}>
        <Icon name="rocket" size={16} /> {data.mine ? 'Remove my boost' : data.remaining === 0 ? 'No boosts left' : 'Boost this server'}
      </Button>}>
      {!data ? <div className="center pad"><Spinner /></div> : (
        <div className="boost-body">
          <div className="boost-hero">
            <Icon name="rocket" size={40} />
            <div>
              <h3>Level {data.level}</h3>
              <p className="muted small">{data.count} {data.count === 1 ? 'boost' : 'boosts'}{next ? ` · ${next.boosts - data.count} more to reach level ${next.level}` : ' · max level'}</p>
            </div>
          </div>
          {next && <Bar pct={Math.min(1, data.count / next.boosts)} />}
          <div className="boost-tiers">
            {[...BOOST_TIERS].reverse().map((t) => (
              <div key={t.level} className={cx('boost-tier', data.level >= t.level && 'unlocked')}>
                <b>Level {t.level}</b><span className="tiny muted">{t.boosts} boosts</span>
                <ul>{t.perks.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            ))}
          </div>
          <p className="tiny muted">You have {data.remaining} of {data.perUser} boosts left. Banners and animated icons are already free on NullChat, so boosts are recognition for the community.</p>
          {data.boosters.length > 0 && (
            <>
              <h4 className="section-label">Boosters</h4>
              <div className="booster-row">{data.boosters.map((b) => <span key={b.userId} className="booster" data-tooltip={`Since ${new Date(b.since).toLocaleDateString()}`}><Avatar userId={b.userId} size={28} /></span>)}</div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ================================================================ people you may know
export function SuggestionsPanel() {
  const [list, setList] = useState(null);
  const rel = useStore((s) => s.relationships);
  useEffect(() => { api.get('/users/@me/suggestions').then(setList).catch(() => setList([])); }, []);
  const add = async (u) => {
    try { await api.put(`/users/@me/relationships/${u.id}`, { type: 1 }); toast(`Friend request sent to ${u.displayName || u.username}.`, 'success'); setList((l) => l.filter((x) => x.id !== u.id)); } catch (e) { toastError(e); }
  };
  const shown = (list || []).filter((u) => !rel[u.id]);
  if (list && !shown.length) return null;
  return (
    <div className="suggestions">
      <h3 className="section-label">People you may know</h3>
      {!list ? <div className="pad"><Spinner /></div> : shown.slice(0, 8).map((u) => (
        <div key={u.id} className="list-row static">
          <Avatar user={u} size={36} />
          <div className="grow">
            <b>{u.displayName || u.username}</b> <span className="muted small">{u.username}</span>
            <div className="tiny muted">{[u.sharedServers && `${u.sharedServers} shared ${u.sharedServers === 1 ? 'server' : 'servers'}`, u.mutualFriends && `${u.mutualFriends} mutual ${u.mutualFriends === 1 ? 'friend' : 'friends'}`].filter(Boolean).join(' · ')}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => openDM(u.id)}>Message</Button>
          <Button size="sm" variant="success" onClick={() => add(u)}>Add Friend</Button>
        </div>
      ))}
      <p className="tiny muted">Don’t want to show up here? Turn off “Suggest me to people” in Privacy &amp; Safety.</p>
    </div>
  );
}

// ================================================================ chat next to a voice channel
export function VoiceChatPanel({ channelId, onClose }) {
  const name = useStore((s) => s.channels[channelId]?.name);
  return (
    <aside className="voice-chat">
      <header className="voice-chat-head">
        <Icon name="chat" size={18} /><b className="truncate">{name} chat</b><span className="grow" />
        <button className="icon-btn small" aria-label="Hide chat" onClick={onClose}><Icon name="x" size={18} /></button>
      </header>
      <MessageList channelId={channelId} header={<p className="muted small pad">This is the text chat for <b>{name}</b>. Anyone who can see the channel can read it.</p>} />
      <Composer channelId={channelId} placeholder={`Message ${name || 'this voice channel'}`} compact />
    </aside>
  );
}
