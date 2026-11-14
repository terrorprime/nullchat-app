// The shared music queue of a voice channel: the button among the call controls, the window with the queue, and the player
// itself, which sits above the voice panel in the sidebar so that it keeps playing wherever you go in the app.
// (server: routes/music.js, helpers: lib/music.js)
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, store, channelPermissions, displayName } from '../lib/state.js';
import { useVoice } from '../lib/voice.js';
import { toast, toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { getLocal, onLocalChange } from '../lib/settings.js';
import { expectedPositionMs, clock, loadMusic, addTrack, removeTrack, controlMusic, reportMusic, lockMusic, setMusicVolume, setMusicOff } from '../lib/music.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';
import { openPopout, Slider, Switch } from './ui.jsx';
import { Icon } from './icons.jsx';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

function useLocal() {
  const [l, setL] = useState(getLocal());
  useEffect(() => onLocalChange(setL), []);
  return l;
}
/** Re-renders every `ms` while `on` (for the progress bar). */
function useTick(on, ms = 500) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return undefined; const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [on, ms]);
}
const useRoom = (channelId) => useStore((s) => (channelId ? s.music[channelId] || null : null));
/** May this person pause, skip, seek and remove other people's tracks? (They add tracks and take their own back either way.) */
function useMayControl(channelId) {
  const manager = useStore((s) => has(channelPermissions(s, channelId), P.MANAGE_CHANNELS));
  const locked = useStore((s) => !!s.channels[channelId]?.musicLocked);
  const inRoom = useVoice((v) => v.channelId === channelId);
  return { manager, locked, inRoom, mayControl: manager || (inRoom && !locked) };
}
const openMusic = (anchor, channelId, placement = 'top') => openPopout(anchor, ({ close }) => <MusicPanel channelId={channelId} onClose={close} />, { placement, key: 'music' });

/** The music button among the call controls of a server voice channel. */
export function MusicButton({ channelId }) {
  const channel = useStore((s) => s.channels[channelId]);
  const room = useRoom(channelId);
  if (!channel || channel.type !== ChannelType.VOICE) return null;
  const n = room?.tracks.length || 0;
  return (
    <button className={cx('cc-btn music-btn', n > 0 && 'on')} aria-label="Music" data-music-count={n}
      data-tooltip={n ? `Music: ${room.tracks[0].title}` : 'Music'} data-tooltip-side="top" onClick={(e) => openMusic(e.currentTarget, channelId)}>
      <Icon name="music" size={22} />
    </button>
  );
}

// ================================================================ the window
function MusicPanel({ channelId, onClose }) {
  const channel = useStore((s) => s.channels[channelId]);
  const room = useRoom(channelId);
  const myId = useStore((s) => s.me.id);
  const { manager, locked, inRoom, mayControl } = useMayControl(channelId);
  const l = useLocal();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { loadMusic(channelId); }, [channelId]);
  const cur = room?.tracks[0] || null;
  useTick(!!room?.playing);
  if (!channel) return null;
  const pos = expectedPositionMs(room) / 1000;
  const add = async (e) => {
    e.preventDefault();
    const link = url.trim();
    if (!link || busy) return;
    setBusy(true); setError('');
    try { await addTrack(channelId, link); setUrl(''); } catch (err) { setError(err?.message || 'That link could not be added.'); }
    setBusy(false);
  };
  return (
    <div className="music-panel" role="dialog" aria-label="Music">
      <div className="mood-head">
        <b>Music</b>
        <button className="icon-btn small" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <p className="tiny muted mood-lead">Everyone in this voice channel hears the same track at the same moment. It never goes into anyone’s microphone.</p>
      <form className="music-add" onSubmit={add}>
        <input className="input" value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} placeholder="Paste a YouTube or audio link" aria-label="Link to add" disabled={!inRoom || busy} maxLength={2000} />
        <button className="btn btn-primary btn-sm" type="submit" disabled={!inRoom || busy || !url.trim()}>{busy ? 'Adding…' : 'Add'}</button>
      </form>
      {error && <p className="tiny music-error" role="alert">{error}</p>}
      {!inRoom && <p className="tiny muted" data-music-why>Join the voice channel to add music to it.</p>}

      {cur ? (
        <div className="music-current" data-music-current={cur.id}>
          {cur.thumb ? <img className="music-thumb" src={cur.thumb} alt="" /> : <span className="music-thumb music-thumb-blank"><Icon name="music" size={20} /></span>}
          <div className="music-current-text">
            <div className="music-title truncate" title={cur.title}>{cur.title}</div>
            <div className="tiny muted truncate">{cur.by ? `${cur.by} · ` : ''}added by {displayName(store.get(), cur.addedBy, channel.guildId) || 'someone'}</div>
            <div className="music-progress">
              <span className="tiny muted music-time">{clock(pos)}</span>
              <input type="range" className="music-seek" aria-label="Position" min={0} max={Math.max(1, Math.floor(cur.duration || 0))} step={1} value={Math.min(Math.floor(pos), Math.floor(cur.duration || 0))}
                disabled={!mayControl || !cur.duration} style={{ '--pct': `${cur.duration ? Math.min(100, (pos / cur.duration) * 100) : 0}%` }}
                onChange={(e) => controlMusic(channelId, 'seek', { trackId: cur.id, positionMs: Number(e.target.value) * 1000 })} />
              <span className="tiny muted music-time">{cur.duration ? clock(cur.duration) : '–:––'}</span>
            </div>
          </div>
          <div className="music-buttons">
            <button className="icon-btn" aria-label={room.playing ? 'Pause' : 'Play'} disabled={!mayControl} onClick={() => controlMusic(channelId, room.playing ? 'pause' : 'play', { trackId: cur.id })}><Icon name={room.playing ? 'pause' : 'play'} size={18} /></button>
            <button className="icon-btn" aria-label="Skip" disabled={!mayControl} onClick={() => controlMusic(channelId, 'skip', { trackId: cur.id })}><Icon name="skip" size={18} /></button>
          </div>
        </div>
      ) : (
        <p className="music-empty muted">Nothing is playing. Add a link and everyone in the room hears it.</p>
      )}

      {room && room.tracks.length > 1 && (
        <>
          <div className="music-next-head">
            <span>Up next · {room.tracks.length - 1}</span>
            {mayControl && <button className="link-btn tiny" onClick={() => controlMusic(channelId, 'clear')}>Clear all</button>}
          </div>
          <ol className="music-queue">
            {room.tracks.slice(1).map((t) => {
              const mayRemove = mayControl || (inRoom && t.addedBy === myId);
              return (
                <li key={t.id} className="music-item" data-music-item={t.id}>
                  <button className="music-item-main" disabled={!mayControl} title={mayControl ? 'Play this now' : undefined} onClick={() => controlMusic(channelId, 'jump', { trackId: t.id })}>
                    <span className="truncate music-item-title">{t.title}</span>
                    <span className="tiny muted truncate">added by {displayName(store.get(), t.addedBy, channel.guildId) || 'someone'}</span>
                  </button>
                  {mayRemove && <button className="icon-btn small" aria-label={`Remove ${t.title}`} onClick={() => removeTrack(channelId, t.id)}><Icon name="x" size={14} /></button>}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {locked && !manager && <p className="tiny muted mood-why" data-music-locked>Only people who can manage this channel can pause, skip or remove other people’s tracks.</p>}

      <div className="mood-mine">
        <div className="mood-mine-row"><span>Hear the music</span><Switch checked={!l.musicOff} onChange={(v) => setMusicOff(!v)} label="Hear the music" /></div>
        <div className={cx('mood-mine-row', l.musicOff && 'dim')}><span>Your volume</span><Slider value={l.musicVolume ?? 50} min={0} max={100} onChange={setMusicVolume} format={(v) => `${v}%`} /></div>
        <p className="tiny muted">These two are only for you, on this device.</p>
      </div>
      {manager && (
        <div className="mood-mine-row mood-lock"><span>Only managers can control it</span><Switch checked={locked} onChange={(v) => lockMusic(channelId, v)} label="Only managers can control it" /></div>
      )}
    </div>
  );
}

// ================================================================ the player (in the sidebar, above the voice panel)
/** Plays the music of the voice channel you are in. Rendered once, by the voice panel, so it never restarts as you move around. */
export function MusicPlayer() {
  const channelId = useVoice((v) => v.channelId);
  const deaf = useVoice((v) => !!v.selfDeaf);
  const isVoiceChannel = useStore((s) => s.channels[channelId]?.type === ChannelType.VOICE);
  const online = useStore((s) => s.status === 'ready');
  const room = useRoom(isVoiceChannel ? channelId : null);
  const l = useLocal();
  const { mayControl } = useMayControl(channelId);
  // Joining a room (or coming back after the connection dropped): ask what is playing. After that the events keep it current.
  useEffect(() => { if (channelId && isVoiceChannel && online) loadMusic(channelId); }, [channelId, isVoiceChannel, online]);
  if (!room || !room.tracks.length) return null;
  const track = room.tracks[0];
  const volume = deaf ? 0 : Math.max(0, Math.min(100, l.musicVolume ?? 50));
  return (
    <div className="music-now" data-music-now={track.id} data-music-kind={track.kind}>
      {l.musicOff ? null
        : track.kind === 'youtube' ? <YouTubeDeck key={track.id} channelId={channelId} room={room} track={track} volume={volume} />
          : <AudioDeck key={track.id} channelId={channelId} room={room} track={track} volume={volume} />}
      <div className="music-now-row">
        <button className="music-now-title truncate" title={track.title} onClick={(e) => openMusic(e.currentTarget, channelId, 'top')}>
          <Icon name="music" size={14} /> <span className="truncate">{track.title}</span>
        </button>
        {l.musicOff
          ? <button className="link-btn tiny" onClick={() => setMusicOff(false)} data-music-turn-on>Off for you · turn on</button>
          : (
            <>
              <button className="icon-btn small" aria-label={room.playing ? 'Pause music' : 'Play music'} disabled={!mayControl} onClick={() => controlMusic(channelId, room.playing ? 'pause' : 'play', { trackId: track.id })}><Icon name={room.playing ? 'pause' : 'play'} size={14} /></button>
              <button className="icon-btn small" aria-label="Skip track" disabled={!mayControl} onClick={() => controlMusic(channelId, 'skip', { trackId: track.id })}><Icon name="skip" size={14} /></button>
            </>
          )}
      </div>
    </div>
  );
}

/** What both players share: the latest room state in a ref, and the reports to the server, each sent once per track. */
function useDeck(channelId, room, track) {
  const roomRef = useRef(room); roomRef.current = room;
  const sent = useRef({ duration: false, ended: false, failed: false });
  const report = useMemo(() => ({
    duration(seconds) {
      if (sent.current.duration || !(seconds > 0.5) || !Number.isFinite(seconds)) return;
      sent.current.duration = true;
      if (!roomRef.current.tracks[0]?.duration) reportMusic(channelId, 'duration', { trackId: track.id, duration: Math.min(seconds, 12 * 3600) });
    },
    ended() {
      if (sent.current.ended) return;
      sent.current.ended = true;
      reportMusic(channelId, 'ended', { trackId: track.id });
    },
    failed() {
      if (sent.current.failed) return;
      sent.current.failed = true;
      reportMusic(channelId, 'failed', { trackId: track.id });
    },
  }), [channelId, track.id]);
  return { roomRef, report };
}

function YouTubeDeck({ channelId, room, track, volume }) {
  const frame = useRef(null);
  const info = useRef({});            // what the player last told us (playerState, currentTime, duration …)
  const ready = useRef(false);
  const volRef = useRef(volume); volRef.current = volume;
  const { roomRef, report } = useDeck(channelId, room, track);
  const [stuck, setStuck] = useState(false);
  const [failed, setFailed] = useState(false);
  // The address is worked out once per track: changing it would reload the player.
  const src = useMemo(() => {
    const start = Math.floor(expectedPositionMs(room) / 1000);
    return `${YT_ORIGIN}/embed/${encodeURIComponent(track.videoId)}?enablejsapi=1&autoplay=${room.playing ? 1 : 0}&controls=0&disablekb=1&playsinline=1&rel=0&start=${start}&origin=${encodeURIComponent(location.origin)}`;
  }, [track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (o) => { try { frame.current?.contentWindow?.postMessage(JSON.stringify(o), YT_ORIGIN); } catch { /* not loaded yet */ } };
  const cmd = (func, ...args) => post({ event: 'command', func, args });

  /** Bring the player to where the room is. */
  const sync = () => {
    if (!ready.current) return;
    const r = roomRef.current;
    const i = info.current;
    const st = i.playerState;
    const want = expectedPositionMs(r) / 1000;
    const dur = i.duration || r.tracks[0]?.duration || 0;
    cmd('setVolume', volRef.current); cmd(volRef.current > 0 ? 'unMute' : 'mute');
    if (st === 0 && dur && want >= dur - 5) return;   // it played out; the room's clock is about to move on
    const moving = st === 1 || st === 3;
    const have = (i.currentTime || 0) + (st === 1 && i.at ? (Date.now() - i.at) / 1000 : 0);
    if (r.playing) {
      if (!moving) cmd('playVideo');
      if (Math.abs(have - want) > 2) cmd('seekTo', want, true);
    } else {
      if (moving) cmd('pauseVideo');
      if (Math.abs((i.currentTime || 0) - want) > 1) cmd('seekTo', want, true);
    }
  };
  const syncRef = useRef(sync); syncRef.current = sync;

  useEffect(() => {
    let startedAt = 0;
    const onMessage = (e) => {
      if (e.origin !== YT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      let d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      if (!d || typeof d !== 'object') return;
      if (d.event === 'onError') { setFailed(true); return; }
      if (d.info && typeof d.info === 'object') {
        Object.assign(info.current, d.info);
        if (typeof d.info.currentTime === 'number') info.current.at = Date.now();
        if (info.current.duration > 0) report.duration(info.current.duration);
        if (d.info.playerState === 0) report.ended();
        if (d.info.playerState === 1) setStuck(false);
      }
      if (!ready.current && (d.event === 'onReady' || d.event === 'initialDelivery' || d.event === 'infoDelivery')) {
        ready.current = true; startedAt = Date.now();
        cmd('addEventListener', 'onError');
        syncRef.current();
      }
    };
    window.addEventListener('message', onMessage);
    // The player only talks to a page that says it is listening; say so until it answers.
    const hello = setInterval(() => { if (!ready.current) post({ event: 'listening', id: 'nullchat-music', channel: 'widget' }); }, 400);
    const keep = setInterval(() => {
      syncRef.current();
      // The room is playing and the player still is not, a while after it loaded: the browser wants a click first.
      const st = info.current.playerState;
      if (ready.current && roomRef.current.playing && st !== 1 && st !== 3 && st !== 0 && Date.now() - startedAt > 4000) setStuck(true);
    }, 2000);
    return () => { window.removeEventListener('message', onMessage); clearInterval(hello); clearInterval(keep); };
  }, [track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { syncRef.current(); }, [room.playing, room.positionMs, room.receivedAt, volume]);
  // A video that cannot be played here (removed, or its owner does not allow it outside YouTube): say so, then let the room move on.
  useEffect(() => { if (!failed) return undefined; const t = setTimeout(() => report.failed(), 3000); return () => clearTimeout(t); }, [failed, report]);

  return (
    <div className="music-video">
      <iframe ref={frame} title="Music player" src={src} allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" data-music-frame />
      {failed && <div className="music-note" role="status">This video can’t be played here.</div>}
      {stuck && !failed && <div className="music-note click-through" role="status">Click the video to start the music</div>}
    </div>
  );
}

function AudioDeck({ channelId, room, track, volume }) {
  const el = useRef(null);
  const { roomRef, report } = useDeck(channelId, room, track);
  const [stuck, setStuck] = useState(false);
  const [failed, setFailed] = useState(false);

  const sync = () => {
    const a = el.current;
    if (!a || failed) return;
    const r = roomRef.current;
    const want = expectedPositionMs(r) / 1000;
    a.volume = Math.max(0, Math.min(1, volume / 100));
    if (a.readyState < 1) return;   // (nothing can be done before it knows what it is; "loadedmetadata" calls this again)
    if (a.ended && Number.isFinite(a.duration) && want >= a.duration - 5) return;
    if (r.playing) {
      if (Math.abs(a.currentTime - want) > 1.5) a.currentTime = want;
      if (a.paused) a.play().then(() => setStuck(false)).catch((e) => { if (e?.name === 'NotAllowedError') setStuck(true); });
    } else {
      if (!a.paused) a.pause();
      if (Math.abs(a.currentTime - want) > 0.7) a.currentTime = want;
    }
  };
  const syncRef = useRef(sync); syncRef.current = sync;
  useEffect(() => { syncRef.current(); }, [room.playing, room.positionMs, room.receivedAt, volume]);
  useEffect(() => { const t = setInterval(() => syncRef.current(), 2000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!failed) return undefined; const t = setTimeout(() => report.failed(), 3000); return () => clearTimeout(t); }, [failed, report]);

  return (
    <div className="music-audio">
      <audio ref={el} src={track.url} preload="auto" data-music-audio
        onLoadedMetadata={(e) => { report.duration(e.currentTarget.duration); syncRef.current(); }}
        onEnded={() => report.ended()} onError={() => setFailed(true)} />
      {failed && <div className="music-note inline" role="status">This file can’t be played.</div>}
      {stuck && !failed && <button className="music-note inline" onClick={() => { setStuck(false); syncRef.current(); }}>Click to start the music</button>}
    </div>
  );
}

/** Something happened to the music of the room you are in: a small note for the things worth one. (Called for the VOICE_MUSIC event.) */
export function announceMusic(d) {
  const s = store.get();
  if (!d.userId || d.userId === s.me?.id) return;
  const name = displayName(s, d.userId, d.guildId) || 'Someone';
  if (d.action === 'add') {
    const t = d.tracks.find((x) => x.id === d.trackId);
    if (t) toast(`${name} added “${t.title}” to the music`, 'info', 3500);
  } else if (d.action === 'skip') toast(`${name} skipped the track`, 'info', 2500);
  else if (d.action === 'clear') toast(`${name} cleared the music queue`, 'info', 2500);
}
