// Your own join and leave sounds: picking them (Settings → Voice & Video), and the server's switch (Server Settings → Overview).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/state.js';
import { toast, toastError } from '../lib/toast.js';
import { getLocal, setLocal, onLocalChange } from '../lib/settings.js';
import { play, playClip } from '../lib/sounds.js';
import { MAX_SECONDS, prepareVoiceSound, saveVoiceSound, removeVoiceSound, setGuildVoiceSounds } from '../lib/voiceSounds.js';
import { Button, ToggleSetting, SettingRow } from './ui.jsx';
import { Icon } from './icons.jsx';

const KINDS = [['join', 'When you join', 'Plays for everyone in the voice channel as you come in.'], ['leave', 'When you leave', 'Plays for the people still there as you go.']];

function SoundRow({ kind, title, description }) {
  const url = useStore((s) => s.me.voiceSounds?.[kind] || null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { blob, trimmed } = await prepareVoiceSound(file);
      await saveVoiceSound(kind, blob);
      toast(trimmed ? `Saved. Only the first ${MAX_SECONDS} seconds are used.` : 'Sound saved', 'success', trimmed ? 4000 : 1800);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await removeVoiceSound(kind); toast('Back to the standard sound', 'success', 1800); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <SettingRow title={title} description={`${description} ${url ? 'You have your own sound.' : 'You have the standard sound.'}`}>
      <div className="voice-sound-actions" data-voice-sound={kind} data-has-sound={url ? 'yes' : 'no'}>
        <button className="icon-btn" aria-label={`Listen to your ${kind} sound`} onClick={() => { if (url) playClip(url, kind, { force: true }); else play(kind); }}><Icon name="volume" size={16} /></button>
        <input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; pick(f); }} />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>{url ? 'Change' : 'Choose a Sound'}</Button>
        {url && <Button size="sm" variant="link" disabled={busy} onClick={remove}>Remove</Button>}
      </div>
    </SettingRow>
  );
}

function useLocal() {
  const [l, setL] = useState(getLocal());
  useEffect(() => onLocalChange(() => setL(getLocal())), []);
  return l;
}

/** In Settings → Voice & Video. */
export function VoiceSoundSettings() {
  const l = useLocal();
  const isBot = useStore((s) => !!s.me.bot);
  const quiet = Object.keys(l.plainSoundFor || {}).filter((id) => l.plainSoundFor[id]);
  const names = useStore((s) => quiet.map((id) => s.users[id]?.displayName || s.users[id]?.username || 'Someone').join(', '));
  if (isBot) return null;
  return (
    <div className="settings-section" data-voice-sounds>
      <h3>Join and Leave Sounds</h3>
      <p className="muted small">Pick your own sound for coming into a voice channel and for leaving it: any audio file, up to {MAX_SECONDS} seconds. NullChat evens out the loudness, so nobody’s sound is louder than anyone else’s.</p>
      {KINDS.map(([kind, title, description]) => <SoundRow key={kind} kind={kind} title={title} description={description} />)}
      <ToggleSetting title="Play other people’s own sounds" description="Off: everyone makes the standard join and leave sound on this device. A server can also turn them off for its voice channels."
        checked={l.voiceSounds !== false} onChange={(v) => setLocal({ voiceSounds: v })} />
      {quiet.length > 0 && (
        <SettingRow title="Standard sound for" description={names} divider={false}>
          <Button size="sm" variant="link" onClick={() => setLocal({ plainSoundFor: {} })}>Clear</Button>
        </SettingRow>
      )}
    </div>
  );
}

/** In Server Settings → Overview. Saves as soon as it is flipped. */
export function GuildVoiceSoundsSetting({ guild }) {
  const [busy, setBusy] = useState(false);
  const change = async (v) => {
    setBusy(true);
    try { await setGuildVoiceSounds(guild.id, v); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <div data-guild-voice-sounds>
      <ToggleSetting title="Members’ own join and leave sounds" description="Off: everyone makes the standard sound in this server’s voice channels." checked={!guild.voiceSoundsOff} disabled={busy} onChange={change} />
    </div>
  );
}

/** For the right-click menu of someone in your voice channel. */
export function plainSoundMenuItem(userId) {
  const l = getLocal();
  const on = !!l.plainSoundFor?.[userId];
  return { label: 'Standard Join Sound', checked: on, onClick: () => { const next = { ...(getLocal().plainSoundFor || {}) }; if (on) delete next[userId]; else next[userId] = true; setLocal({ plainSoundFor: next }); } };
}
