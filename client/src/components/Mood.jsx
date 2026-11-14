// Mood rooms: the button and the little window for a voice channel's room sound (server: routes/mood.js, the sounds: lib/ambience.js).
import { useEffect, useState } from 'react';
import { useStore, store, channelPermissions, displayName } from '../lib/state.js';
import { useVoice } from '../lib/voice.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { getLocal, onLocalChange } from '../lib/settings.js';
import { setMoodVolume, setMoodOff } from '../lib/ambience.js';
import { MOODS, moodById } from '../../../shared/moods.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';
import { openPopout, Slider, Switch } from './ui.jsx';
import { Icon } from './icons.jsx';

function useLocal() {
  const [l, setL] = useState(getLocal());
  useEffect(() => onLocalChange(setL), []);
  return l;
}

/** The room-sound button among the call controls of a server voice channel. */
export function MoodButton({ channelId }) {
  const channel = useStore((s) => s.channels[channelId]);
  const l = useLocal();
  if (!channel || channel.type !== ChannelType.VOICE) return null;
  const mood = moodById(channel.mood);
  const heard = mood && !l.moodOff;
  return (
    <button className={cx('cc-btn mood-btn', heard && 'on')} aria-label="Room sound" data-mood={channel.mood || ''}
      data-tooltip={mood ? `Room sound: ${mood.name}${l.moodOff ? ' (off for you)' : ''}` : 'Room Sound'} data-tooltip-side="top"
      onClick={(e) => openPopout(e.currentTarget, ({ close }) => <MoodPicker channelId={channelId} onClose={close} />, { placement: 'top', key: 'mood' })}>
      {mood ? <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span> : <Icon name="volume" size={22} />}
    </button>
  );
}

/** In the voice channel's header: which sound the room has (for everyone who looks at the channel, in it or not). Opens the same window. */
export function MoodChip({ channelId }) {
  const channel = useStore((s) => s.channels[channelId]);
  const manager = useStore((s) => has(channelPermissions(s, channelId), P.MANAGE_CHANNELS));
  const mood = moodById(channel?.mood);
  if (!channel || channel.type !== ChannelType.VOICE || (!mood && !manager)) return null;
  return (
    <button type="button" className="pill mood-chip" data-mood-chip={channel.mood || ''} title="Room sound"
      onClick={(e) => openPopout(e.currentTarget, ({ close }) => <MoodPicker channelId={channelId} onClose={close} />, { placement: 'bottom', key: 'mood' })}>
      {mood ? <>{mood.emoji} {mood.name}</> : <><Icon name="volume" size={12} /> Room sound</>}
    </button>
  );
}

function MoodPicker({ channelId, onClose }) {
  const channel = useStore((s) => s.channels[channelId]);
  const manager = useStore((s) => has(channelPermissions(s, channelId), P.MANAGE_CHANNELS));
  const inRoom = useVoice((v) => v.channelId === channelId);
  const l = useLocal();
  const [busy, setBusy] = useState(false);
  if (!channel) return null;
  const canSet = manager || (inRoom && !channel.moodLocked);
  const why = canSet ? null : channel.moodLocked ? 'Only people who can manage this channel can change its room sound.' : 'Join the voice channel to change its room sound.';
  const put = async (body) => {
    setBusy(true);
    try { await api.put(`/channels/${channelId}/mood`, body); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <div className="mood-picker" role="dialog" aria-label="Room sound">
      <div className="mood-head">
        <b>Room sound</b>
        <button className="icon-btn small" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <p className="tiny muted mood-lead">Everyone in this voice channel hears the same quiet background. It never goes into anyone’s microphone.</p>
      <div className="mood-grid" role="radiogroup" aria-label="Room sound">
        <button type="button" role="radio" aria-checked={!channel.mood} className={cx('mood-option', !channel.mood && 'on')} disabled={!canSet || busy} onClick={() => put({ mood: null })} data-mood-option="off">
          <span className="mood-emoji" aria-hidden="true">🔇</span><span className="mood-name">Off</span>
        </button>
        {MOODS.map((m) => (
          <button type="button" role="radio" aria-checked={channel.mood === m.id} key={m.id} className={cx('mood-option', channel.mood === m.id && 'on')} disabled={!canSet || busy} title={m.hint} onClick={() => put({ mood: m.id })} data-mood-option={m.id}>
            <span className="mood-emoji" aria-hidden="true">{m.emoji}</span><span className="mood-name">{m.name}</span>
          </button>
        ))}
      </div>
      {why && <p className="tiny muted mood-why" data-mood-why>{why}</p>}
      <div className="mood-mine">
        <div className="mood-mine-row"><span>Hear the room sound</span><Switch checked={!l.moodOff} onChange={(v) => setMoodOff(!v)} /></div>
        <div className={cx('mood-mine-row', l.moodOff && 'dim')}><span>Your volume</span><Slider value={l.moodVolume ?? 35} min={0} max={100} onChange={setMoodVolume} format={(v) => `${v}%`} /></div>
        <p className="tiny muted">These two are only for you, on this device.</p>
      </div>
      {manager && (
        <div className="mood-mine-row mood-lock"><span>Only managers can change it</span><Switch checked={!!channel.moodLocked} onChange={(v) => put({ locked: v })} /></div>
      )}
    </div>
  );
}

/** Someone changed the sound of the room you are in: a small note. (Called for the VOICE_MOOD event.) */
export function announceMood(d) {
  const s = store.get();
  if (d.userId === s.me?.id) return;
  const name = displayName(s, d.userId, d.guildId) || 'Someone';
  const m = moodById(d.mood);
  toast(m ? `${name} changed the room sound to ${m.name} ${m.emoji}` : `${name} turned the room sound off`, 'info', 3500);
}
