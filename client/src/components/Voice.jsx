// Voice channel stage, DM call view, video tiles, call controls and incoming-call prompt.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, store, displayName, channelPermissions } from '../lib/state.js';
import { useVoice, voiceStore, joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreen, setScreenQuality, stageCommand } from '../lib/voice.js';
import { send } from '../lib/gateway.js';
import { navigate } from '../lib/router.jsx';
import { registerAction } from '../lib/keybinds.js';
import { cx, formatDuration } from '../lib/utils.js';
import { useT } from '../lib/i18n.js';
import { P, has, ChannelType, STAGE_MAX_SPEAKERS, STAGE_DEFAULT_LIMIT } from '../../../shared/permissions.js';
import { Avatar, Button, IconButton, confirmDialog, openPopout, openContextMenu } from './ui.jsx';
import { SHARE_QUALITIES } from './ScreenSharePicker.jsx';
import { openUserMenu } from './menus.jsx';
import { openInviteModal } from './modals.jsx';
import { MobileNavButton } from './Chat.jsx';
import { GroupIcon } from './Sidebar.jsx';
import { Icon } from './icons.jsx';
import { VoiceChatPanel } from './Extras.jsx';
import { MoodButton, MoodChip } from './Mood.jsx';
import { MusicButton } from './Music.jsx';
import { PopoutButton, usePopoutWindow, closeCallPopout, layoutTiles, InviteTile, useTileColor } from './CallPopout.jsx';
import { getLocal, setLocal } from '../lib/settings.js';

function VideoEl({ stream, mirror, contain }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) { el.srcObject = stream || null; el.play?.().catch(() => {}); }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={cx('tile-video', mirror && 'mirror', contain && 'contain')} />;
}

/** Build the list of tiles (camera / screen / avatar) for everyone in a voice channel (on a stage: only the speakers). */
function useTiles(channelId, speakersOnly = false) {
  const states = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId && (!speakersOnly || !v.suppress)).sort((a, b) => a.joinedAt - b.joinedAt));
  const myId = useStore((s) => s.me.id);
  const v = useVoice((x) => ({ peers: x.peers, localCamera: x.localCamera, localScreen: x.localScreen, connected: x.channelId === channelId }));
  return useMemo(() => {
    const tiles = [];
    for (const st of states) {
      const self = st.userId === myId;
      const peer = v.peers[st.userId];
      const cam = self ? v.localCamera : (st.cameraStreamId && peer?.streams?.[st.cameraStreamId]) || null;
      const scr = self ? v.localScreen : (st.screenStreamId && peer?.streams?.[st.screenStreamId]) || null;
      if (st.selfStream) tiles.push({ key: `${st.userId}:screen`, userId: st.userId, kind: 'screen', stream: scr, state: st, self, peerState: peer?.state });
      tiles.push({ key: `${st.userId}:cam`, userId: st.userId, kind: st.selfVideo ? 'camera' : 'avatar', stream: st.selfVideo ? cam : null, state: st, self, peerState: peer?.state });
    }
    return tiles;
  }, [states, myId, v.peers, v.localCamera, v.localScreen]);
}

function Tile({ tile, guildId, focused, onFocus, small, box }) {
  const name = useStore((s) => displayName(s, tile.userId, guildId));
  const colour = useTileColor(tile.userId, guildId);
  const speaking = useVoice((x) => !!x.speaking[tile.userId]);
  const connected = useVoice((x) => !!x.channelId);
  const ref = useRef(null);
  const st = tile.state;
  const fullscreen = (e) => { e.stopPropagation(); ref.current?.requestFullscreen?.(); };
  const waiting = !tile.self && connected && tile.peerState && !['connected'].includes(tile.peerState);
  return (
    <div ref={ref} className={cx('tile', tile.kind, speaking && tile.kind !== 'screen' && 'speaking', focused && 'focused', small && 'small')}
      style={{ '--tile': colour, ...(box ? { width: box.w, height: box.h } : null) }} onClick={onFocus} onContextMenu={(e) => openUserMenu(e, tile.userId, { guildId })}>
      {tile.kind === 'avatar' && (
        <div className="tile-avatar" style={{ '--tile-bg': 'var(--bg-tertiary)' }}>
          <Avatar userId={tile.userId} guildId={guildId} size={small ? 34 : box ? Math.round(Math.max(48, Math.min(120, box.h * 0.3, box.w * 0.2))) : 80} />
        </div>
      )}
      {tile.kind !== 'avatar' && (tile.stream ? <VideoEl stream={tile.stream} mirror={tile.self && tile.kind === 'camera'} contain={tile.kind === 'screen'} />
        : <div className="tile-avatar"><Avatar userId={tile.userId} guildId={guildId} size={small ? 34 : 80} /><span className="muted small">{tile.self ? 'Starting…' : connected ? 'Loading stream…' : 'Join to watch'}</span></div>)}
      <div className="tile-label">
        {tile.kind === 'screen' && <span className="live-badge">LIVE</span>}
        {(st.selfMute || st.mute || st.suppress) && tile.kind !== 'screen' && <Icon name="micOff" size={14} className={st.mute ? 'danger-icon' : ''} />}
        {(st.selfDeaf || st.deaf) && tile.kind !== 'screen' && <Icon name="headphonesOff" size={14} />}
        <span className="truncate">{name}{tile.kind === 'screen' ? '’s screen' : ''}</span>
      </div>
      {waiting && <span className="tile-conn" data-tooltip={`Connection: ${tile.peerState}`}><Icon name="wifi" size={14} /></span>}
      {tile.kind !== 'avatar' && tile.stream && <button className="tile-fs" aria-label="Full screen" onClick={fullscreen}><Icon name="fullscreen" size={16} /></button>}
    </div>
  );
}

/** The size of an element, kept up to date (for laying the tiles out to fit it). */
function useBox(ref) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', read); return () => window.removeEventListener('resize', read); }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

// `fit` (a server's voice channel): equal 16:9 tiles sized to fill the space and centred in it, with a tile for inviting someone
// while you are alone, the way the call's own window lays them out.
function Stage({ channelId, guildId, compact, speakersOnly, fit }) {
  const tiles = useTiles(channelId, speakersOnly);
  const [focus, setFocus] = useState(null);
  const gridRef = useRef(null);
  const size = useBox(gridRef);
  const connected = useVoice((x) => x.channelId === channelId);
  const canInvite = useStore((s) => !!guildId && has(channelPermissions(s, channelId), P.CREATE_INVITE));
  useEffect(() => { if (focus && !tiles.some((t) => t.key === focus)) setFocus(null); }, [tiles, focus]);
  // Auto-focus a new screen share.
  const screenKey = tiles.find((t) => t.kind === 'screen' && !t.self)?.key;
  useEffect(() => { if (screenKey) setFocus(screenKey); }, [screenKey]);
  const focused = tiles.find((t) => t.key === focus);
  if (focused) {
    return (
      <div className={cx('stage focus-mode', compact && 'compact')}>
        <div className="stage-focus"><Tile tile={focused} guildId={guildId} focused onFocus={() => setFocus(null)} /></div>
        <div className="stage-strip">{tiles.filter((t) => t.key !== focus).map((t) => <Tile key={t.key} tile={t} guildId={guildId} small onFocus={() => setFocus(t.key)} />)}</div>
      </div>
    );
  }
  const n = tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  if (fit) {
    const invite = connected && canInvite && n === 1 && size.w >= 520;
    const lay = layoutTiles(n + (invite ? 1 : 0), size.w, size.h);
    const box = size.w ? { w: lay.w, h: lay.h } : null;
    return (
      <div ref={gridRef} className="stage grid fit" style={{ '--cols': lay.cols }} data-stage-cols={lay.cols}>
        {box && tiles.map((t) => <Tile key={t.key} tile={t} guildId={guildId} box={box} onFocus={() => setFocus(t.key)} />)}
        {box && invite && <InviteTile win={window} channelId={channelId} w={box.w} h={box.h} />}
      </div>
    );
  }
  return (
    <div className={cx('stage grid', compact && 'compact')} style={{ '--cols': cols }}>
      {tiles.map((t) => <Tile key={t.key} tile={t} guildId={guildId} onFocus={() => setFocus(t.key)} />)}
    </div>
  );
}

/**
 * Full screen for the call you are looking at (the button at the right end of the call's buttons). The whole app goes full
 * screen and the call is laid over it, so menus, tooltips and pop-ups still work on top. Esc (or the button) leaves it, and so
 * does leaving the call or opening another channel.
 */
function useCallFullscreen() {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && document.body.classList.contains('call-fullscreen'));
  useEffect(() => {
    const sync = () => {
      // (the browser's own full screen ended, e.g. with Esc: put the call back in its place)
      if (!document.fullscreenElement && document.body.dataset.callFs === 'real') { document.body.classList.remove('call-fullscreen'); delete document.body.dataset.callFs; }
      setOn(document.body.classList.contains('call-fullscreen'));
    };
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (document.body.classList.contains('call-fullscreen')) {   // (the call's buttons went away: left the call, or another channel)
        document.body.classList.remove('call-fullscreen'); delete document.body.dataset.callFs;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      }
    };
  }, []);
  const toggle = async () => {
    if (document.body.classList.contains('call-fullscreen')) {
      document.body.classList.remove('call-fullscreen'); delete document.body.dataset.callFs;
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setOn(false);
      return;
    }
    document.body.classList.add('call-fullscreen');
    setOn(true);
    // Where the browser refuses real full screen, the call still fills the whole NullChat window.
    try { await document.documentElement.requestFullscreen(); document.body.dataset.callFs = 'real'; } catch { document.body.dataset.callFs = 'window'; }
  };
  return [on, toggle];
}
function FullscreenButton() {
  const [on, toggle] = useCallFullscreen();
  // while the call fills the screen, its top line and buttons fade away when the mouse is still
  useEffect(() => {
    if (!on) return undefined;
    let timer = 0;
    const wake = () => { document.body.classList.remove('call-idle'); clearTimeout(timer); timer = setTimeout(() => document.body.classList.add('call-idle'), 3500); };
    wake();
    const names = ['mousemove', 'pointerdown', 'keydown'];
    names.forEach((n) => document.addEventListener(n, wake));
    return () => { clearTimeout(timer); names.forEach((n) => document.removeEventListener(n, wake)); document.body.classList.remove('call-idle'); };
  }, [on]);
  return (
    <button className="cc-btn cc-fullscreen" onClick={toggle} aria-label={on ? 'Leave full screen' : 'Full screen'} aria-pressed={on} data-tooltip={on ? 'Leave Full Screen' : 'Full Screen'} data-tooltip-side="left" data-call-fullscreen>
      <Icon name="fullscreen" size={20} />
    </button>
  );
}

export function CallControls({ channelId, compact }) {
  const t = useT();
  const v = useVoice((x) => ({ selfMute: x.selfMute, selfDeaf: x.selfDeaf, video: x.video, screen: x.screen, noMic: x.noMic, connected: x.channelId === channelId }));
  const canStream = useStore((s) => has(channelPermissions(s, channelId), P.STREAM));
  const serverMute = useStore((s) => !!s.voiceStates[s.me.id]?.mute);
  if (!v.connected) return null;
  return (
    <div className={cx('call-controls', compact && 'compact')}>
      <div className="cc-group">
        <button className={cx('cc-btn', (v.selfMute || v.noMic || serverMute) && 'off')} onClick={toggleMute} data-tooltip={v.selfMute ? t('unmute') : t('mute')} data-tooltip-side="top">
          <Icon name={v.selfMute || v.noMic || serverMute ? 'micOff' : 'mic'} size={22} />
        </button>
        <button className={cx('cc-btn', v.selfDeaf && 'off')} onClick={toggleDeafen} data-tooltip={v.selfDeaf ? t('undeafen') : t('deafen')} data-tooltip-side="top">
          <Icon name={v.selfDeaf ? 'headphonesOff' : 'headphones'} size={22} />
        </button>
        <button className={cx('cc-btn', v.video && 'on')} disabled={!canStream} onClick={toggleCamera} data-tooltip={v.video ? 'Turn Off Camera' : 'Turn On Camera'} data-tooltip-side="top">
          <Icon name={v.video ? 'video' : 'videoOff'} size={22} />
        </button>
      </div>
      <div className="cc-group">
        <button className={cx('cc-btn', v.screen && 'on')} disabled={!canStream} onClick={toggleScreen} data-tooltip={v.screen ? t('stopSharing') : t('shareScreen')} data-tooltip-side="top">
          <Icon name={v.screen ? 'screenOff' : 'screen'} size={22} />
        </button>
        {v.screen && (
          <button className="cc-btn" aria-label="Stream quality" data-tooltip="Stream Quality" data-tooltip-side="top"
            onClick={(e) => {
              let cur = 'standard';
              try { cur = JSON.parse(localStorage.getItem('nullchat.screenshare') || '{}').quality || cur; } catch { /* ignore */ }
              openContextMenu(e, SHARE_QUALITIES.map((q) => ({ label: q.label, checked: q.value === cur, onClick: () => setScreenQuality(q.value) })));
            }}>
            <Icon name="settings" size={22} />
          </button>
        )}
        <MoodButton channelId={channelId} />
        <MusicButton channelId={channelId} />
        <PopoutButton />
      </div>
      <button className="cc-btn hangup" onClick={() => leaveVoice()} data-tooltip={t('disconnect')} data-tooltip-side="top"><Icon name="phoneOff" size={22} /></button>
      <FullscreenButton />
    </div>
  );
}

/** Where the call's tiles would be, while the call is in a window of its own. */
function PoppedOut({ compact }) {
  return (
    <div className={cx('voice-popped', compact && 'compact')} data-call-popped>
      <Icon name="pip" size={compact ? 22 : 40} />
      <div className="voice-popped-text">This call is in its own window.</div>
      <Button size={compact ? 'sm' : undefined} variant="secondary" onClick={() => closeCallPopout()}>Bring It Back</Button>
    </div>
  );
}

// ================================================================ guild voice channel
export function VoiceChannelView({ channelId }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const count = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).length);
  const connected = useVoice((v) => v.channelId === channelId);
  const status = useVoice((v) => (v.channelId === channelId ? v.status : null));
  const canConnect = useStore((s) => has(channelPermissions(s, channelId), P.CONNECT));
  const canInvite = useStore((s) => has(channelPermissions(s, channelId), P.CREATE_INVITE));
  const canRead = useStore((s) => has(channelPermissions(s, channelId), P.READ_MESSAGE_HISTORY));
  // (the chat beside the call stays the way you last left it; closed until you open it)
  const [chatOpen, setChat] = useState(() => !!getLocal().voiceChatOpen);
  const setChatOpen = (v) => { setChat(v); setLocal({ voiceChatOpen: v }); };
  const popped = usePopoutWindow() && connected;
  if (!channel) return null;
  const full = channel.userLimit > 0 && count >= channel.userLimit;
  return (
    <section className="voice-view">
      <header className="chat-header dark">
        <MobileNavButton />
        <Icon name="speaker" size={22} className="header-icon" />
        <h1 className="header-title truncate">{channel.name}</h1>
        {channel.userLimit > 0 && <span className="pill">{count}/{channel.userLimit}</span>}
        <MoodChip channelId={channelId} />
        <div className="header-actions">
          {canRead && <IconButton icon="chat" label={chatOpen ? 'Hide Chat' : 'Show Chat'} onClick={() => setChatOpen(!chatOpen)} />}
          {canInvite && <IconButton icon="userPlus" label={t('invitePeople')} onClick={() => openInviteModal(channel.guildId, channel.id)} />}
        </div>
      </header>
      <div className="voice-split">
      <div className="voice-body">
        {popped ? <PoppedOut /> : connected || count > 0 ? <Stage channelId={channelId} guildId={channel.guildId} fit /> : null}
        {!connected && (
          <div className={cx('voice-join', count > 0 && 'overlay')}>
            <Icon name="speaker" size={count ? 32 : 56} />
            <h2>{channel.name}</h2>
            <p className="muted">{count ? `${count} ${count === 1 ? 'person is' : 'people are'} hanging out.` : 'No one is currently in voice.'}</p>
            <Button size="lg" variant="success" disabled={!canConnect || full} onClick={() => joinVoice(channelId)}>
              {!canConnect ? 'No permission to join' : full ? 'Channel is full' : t('joinVoice')}
            </Button>
          </div>
        )}
        {connected && status !== 'connected' && <div className="voice-connecting"><span className="spinner" /> {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div>}
      </div>
      {canRead && chatOpen && <VoiceChatPanel channelId={channelId} onClose={() => setChatOpen(false)} />}
      </div>
      <CallControls channelId={channelId} />
    </section>
  );
}

// ================================================================ stage channel
// A few people speak, everyone else listens. Listeners raise a hand; people who can mute members (the ones who run the stage) invite them
// to speak and send speakers back to the audience. Audio goes straight from each speaker to each listener (see lib/voice.js).
function StageControls({ channelId }) {
  const t = useT();
  const v = useVoice((x) => ({ selfMute: x.selfMute, video: x.video, screen: x.screen, noMic: x.noMic, connected: x.channelId === channelId }));
  const mine = useStore((s) => s.voiceStates[s.me.id]);
  const perms = useStore((s) => channelPermissions(s, channelId));
  const canStream = has(perms, P.STREAM), mod = has(perms, P.MUTE_MEMBERS), canSpeak = has(perms, P.SPEAK);
  const speakers = useStore((s) => Object.values(s.voiceStates).filter((x) => x.channelId === channelId && !x.suppress).length);
  const [busy, setBusy] = useState(false);
  if (!v.connected || !mine) return null;
  const run = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const speaker = !mine.suppress;
  const end = async () => {
    if (!(await confirmDialog({ title: 'End the stage?', body: 'Everyone is disconnected, speakers and listeners alike. Anyone can start it again by joining.', confirmText: 'End stage', danger: true }))) return;
    stageCommand('end');
  };
  return (
    <div className="call-controls stage-controls">
      {speaker ? (
        <>
          <button className={cx('cc-btn', v.video && 'on')} disabled={!canStream} onClick={toggleCamera} data-tooltip={v.video ? 'Turn Off Camera' : 'Turn On Camera'} data-tooltip-side="top"><Icon name={v.video ? 'video' : 'videoOff'} size={22} /></button>
          <button className={cx('cc-btn', v.screen && 'on')} disabled={!canStream} onClick={toggleScreen} data-tooltip={v.screen ? t('stopSharing') : t('shareScreen')} data-tooltip-side="top"><Icon name={v.screen ? 'screenOff' : 'screen'} size={22} /></button>
          <button className={cx('cc-btn', (v.selfMute || v.noMic) && 'off')} onClick={toggleMute} data-tooltip={v.selfMute ? t('unmute') : t('mute')} data-tooltip-side="top"><Icon name={v.selfMute || v.noMic ? 'micOff' : 'mic'} size={22} /></button>
          <button className="stage-btn" disabled={busy} onClick={() => run(() => stageCommand('audience'))}><Icon name="userMinus" size={18} /> Step down</button>
        </>
      ) : mod && canSpeak ? (
        <button className="stage-btn" disabled={busy || speakers >= STAGE_MAX_SPEAKERS} data-tooltip={speakers >= STAGE_MAX_SPEAKERS ? `A stage can have ${STAGE_MAX_SPEAKERS} speakers` : undefined}
          onClick={() => run(() => stageCommand('speak'))}><Icon name="mic" size={18} /> Speak</button>
      ) : (
        <button className={cx('stage-btn', mine.handAt && 'on')} disabled={busy || !canSpeak} data-tooltip={!canSpeak ? 'You are not allowed to speak here' : undefined}
          onClick={() => run(() => stageCommand('hand', { raised: !mine.handAt }))}>
          <Icon name="hand" size={18} /> {mine.handAt ? 'Lower hand' : 'Raise hand'}
        </button>
      )}
      <PopoutButton />
      {mod && <button className="stage-btn danger" onClick={end}>End stage</button>}
      <button className="cc-btn hangup" onClick={() => leaveVoice()} data-tooltip={t('disconnect')} data-tooltip-side="top"><Icon name="phoneOff" size={22} /></button>
      <FullscreenButton />
    </div>
  );
}

function AudienceRow({ state, guildId, mod, full }) {
  const name = useStore((s) => displayName(s, state.userId, guildId));
  const [busy, setBusy] = useState(false);
  const invite = async (e) => { e.stopPropagation(); setBusy(true); try { await stageCommand('speak', { userId: state.userId }); } finally { setBusy(false); } };
  return (
    <div className={cx('audience-row', state.handAt && 'hand')} onContextMenu={(e) => openUserMenu(e, state.userId, { guildId })}>
      <Avatar userId={state.userId} guildId={guildId} size={32} />
      <span className="audience-name truncate">{name}</span>
      {state.handAt ? <span className="hand-badge" data-tooltip="Hand raised"><Icon name="hand" size={14} /></span> : null}
      {mod && state.handAt ? <Button size="sm" loading={busy} disabled={full} onClick={invite} data-tooltip={full ? `A stage can have ${STAGE_MAX_SPEAKERS} speakers` : undefined}>Invite to speak</Button> : null}
    </div>
  );
}

export function StageChannelView({ channelId }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const states = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).sort((a, b) => a.joinedAt - b.joinedAt));
  const connected = useVoice((v) => v.channelId === channelId);
  const status = useVoice((v) => (v.channelId === channelId ? v.status : null));
  const perms = useStore((s) => channelPermissions(s, channelId));
  const [chatOpen, setChatOpen] = useState(true);
  if (!channel) return null;
  const canConnect = has(perms, P.CONNECT), canInvite = has(perms, P.CREATE_INVITE), canRead = has(perms, P.READ_MESSAGE_HISTORY), mod = has(perms, P.MUTE_MEMBERS);
  const limit = channel.userLimit || STAGE_DEFAULT_LIMIT;
  const speakers = states.filter((x) => !x.suppress);
  const audience = states.filter((x) => x.suppress).sort((a, b) => (a.handAt ? 0 : 1) - (b.handAt ? 0 : 1) || (a.handAt || a.joinedAt) - (b.handAt || b.joinedAt));
  const full = states.length >= limit && !has(perms, P.MOVE_MEMBERS);
  const speakersFull = speakers.length >= STAGE_MAX_SPEAKERS;
  return (
    <section className="voice-view stage-view">
      <header className="chat-header dark">
        <MobileNavButton />
        <Icon name="stage" size={22} className="header-icon" />
        <h1 className="header-title truncate">{channel.name}</h1>
        <span className="pill" data-tooltip="People on the stage, out of the most it holds">{states.length}/{limit}</span>
        <div className="header-actions">
          {canRead && <IconButton icon="chat" label={chatOpen ? 'Hide Chat' : 'Show Chat'} onClick={() => setChatOpen(!chatOpen)} />}
          {canInvite && <IconButton icon="userPlus" label={t('invitePeople')} onClick={() => openInviteModal(channel.guildId, channel.id)} />}
        </div>
      </header>
      <div className="voice-split">
        <div className="voice-body stage-body">
          <div className="stage-section">
            <h3 className="stage-heading">On stage <span className="muted">{speakers.length}</span></h3>
            {speakers.length ? <Stage channelId={channelId} guildId={channel.guildId} speakersOnly /> : (
              <div className="stage-empty muted">{states.length ? 'Nobody is speaking yet.' : 'The stage is empty.'}{mod && connected && audience.length ? ' Invite someone from the audience.' : ''}</div>
            )}
          </div>
          <div className="stage-section audience">
            <h3 className="stage-heading">Audience <span className="muted">{audience.length}</span></h3>
            {audience.length ? (
              <div className="audience-list">
                {audience.map((s) => <AudienceRow key={s.userId} state={s} guildId={channel.guildId} mod={mod && connected} full={speakersFull} />)}
              </div>
            ) : <div className="stage-empty muted small">No listeners yet.</div>}
          </div>
          {!connected && (
            <div className="stage-join">
              <Button size="lg" variant="success" disabled={!canConnect || full} onClick={() => joinVoice(channelId)}>
                {!canConnect ? 'No permission to join' : full ? 'The stage is full' : mod ? 'Join the stage' : 'Join as a listener'}
              </Button>
              <p className="tiny muted">{mod ? 'You join as a speaker.' : 'You can raise your hand to ask to speak.'} Your microphone is only used once you speak.</p>
            </div>
          )}
          {connected && status !== 'connected' && <div className="voice-connecting"><span className="spinner" /> {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div>}
        </div>
        {canRead && chatOpen && <VoiceChatPanel channelId={channelId} onClose={() => setChatOpen(false)} />}
      </div>
      <StageControls channelId={channelId} />
    </section>
  );
}

// ================================================================ DM call
export function CallView({ channelId }) {
  const call = useStore((s) => s.calls[channelId]);
  const ch = useStore((s) => s.channels[channelId]);
  const inCall = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).map((v) => v.userId));
  const connected = useVoice((v) => v.channelId === channelId);
  const startedAt = call?.startedAt;
  const [, tick] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const popped = usePopoutWindow() && connected;
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(iv); }, []);
  if (!ch) return null;
  const ringing = (call?.ringing || []).filter((id) => !inCall.includes(id));
  return (
    <div className={cx('call-view', expanded && 'expanded')}>
      <div className="call-top">
        <span className="muted small">{connected ? (inCall.length > 1 ? `In call · ${startedAt ? formatDuration(Date.now() - startedAt) : ''}` : 'Calling…') : 'Call in progress'}</span>
        <IconButton icon="fullscreen" label={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded(!expanded)} size={16} />
      </div>
      <div className="call-stage">
        {popped ? <PoppedOut compact /> : inCall.length > 0 && <Stage channelId={channelId} guildId={null} compact={!expanded} />}
        {ringing.length > 0 && (
          <div className="ringing-row">
            {ringing.map((id) => <div key={id} className="ringing-avatar"><Avatar userId={id} size={64} /></div>)}
          </div>
        )}
      </div>
      {connected ? <CallControls channelId={channelId} compact /> : (
        <div className="call-controls compact">
          <Button variant="success" onClick={() => joinVoice(channelId)}><Icon name="phone" size={16} /> Join Call</Button>
        </div>
      )}
      {connected && ringing.length === 0 && inCall.length === 1 && ch.type !== ChannelType.GROUP_DM && (
        <div className="call-hint"><Button size="sm" variant="secondary" onClick={() => send('call_ring', { channelId })}>Ring again</Button></div>
      )}
    </div>
  );
}

// ================================================================ incoming call prompt
export function IncomingCalls() {
  const t = useT();
  const myId = useStore((s) => s.me?.id);
  const myStatus = useStore((s) => s.presences[s.me?.id]?.status);
  const voiceChannel = useVoice((v) => v.channelId);
  const call = useStore((s) => Object.values(s.calls).find((c) => c.ringing.includes(myId) && c.channelId !== voiceChannel));
  const ch = useStore((s) => (call ? s.channels[call.channelId] : null));
  const caller = useStore((s) => (call ? Object.values(s.voiceStates).find((v) => v.channelId === call.channelId)?.userId : null));
  const name = useStore((s) => (ch ? (ch.type === ChannelType.DM ? displayName(s, ch.recipients[0]) : ch.name || ch.recipients.map((r) => displayName(s, r)).join(', ')) : ''));
  const accept = () => { if (!call) return false; navigate(`/channels/@me/${call.channelId}`); joinVoice(call.channelId); return true; };
  const decline = () => { if (!call) return false; send('call_decline', { channelId: call.channelId }); return true; };
  useEffect(() => registerAction('answerCall', () => accept() || false));
  useEffect(() => registerAction('declineCall', () => decline() || false));
  if (!call || !ch || myStatus === 'dnd') return null;
  return (
    <div className="incoming-call" role="alertdialog" aria-label="Incoming call">
      <div className="incoming-avatar">{ch.type === ChannelType.DM ? <Avatar userId={caller || ch.recipients[0]} size={80} /> : <GroupIcon channel={ch} size={80} />}</div>
      <b className="truncate">{name}</b>
      <span className="muted small">{t('incomingCall')}</span>
      <div className="incoming-actions">
        <button className="cc-btn hangup" onClick={decline} aria-label={t('decline')} data-tooltip={t('decline')}><Icon name="phoneOff" size={22} /></button>
        <button className="cc-btn accept" onClick={accept} aria-label={t('accept')} data-tooltip={t('accept')}><Icon name="phone" size={22} /></button>
      </div>
    </div>
  );
}

export { store, voiceStore, openPopout };
