// Profile song: the line on a profile that plays it (popout and full profile), and choosing yours (Settings → Profile).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/state.js';
import { useStoreOf } from '../lib/store.js';
import { toast, toastError } from '../lib/toast.js';
import { getLocal, setLocal, onLocalChange } from '../lib/settings.js';
import { cx } from '../lib/utils.js';
import { MAX_SECONDS, readSong, prepareProfileSong, saveProfileSong, renameProfileSong, removeProfileSong, songStore, playProfileSong, stopProfileSong, shouldAutoplay } from '../lib/profileSong.js';
import { Button, ToggleSetting } from './ui.jsx';
import { Icon } from './icons.jsx';

function useAutoSongs() {
  const [on, setOn] = useState(() => getLocal().profileSongs !== false);
  useEffect(() => onLocalChange((l) => setOn(l.profileSongs !== false)), []);
  return on;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** On a profile: the person's song, which starts by itself when the profile opens (unless that is switched off) and stops when it closes. */
export function ProfileSongLine({ user }) {
  const song = user?.profileSong || null;
  const url = song?.url || null;
  const playing = useStoreOf(songStore, (s) => !!url && s.url === url);
  const auto = useAutoSongs();
  useEffect(() => {
    if (!url) return undefined;
    if (shouldAutoplay(user.id)) playProfileSong(url);
    return () => stopProfileSong(url);
  }, [url, user?.id]);
  if (!song) return null;
  const toggleAuto = () => {
    setLocal({ profileSongs: !auto });
    if (auto) stopProfileSong(url);
    toast(auto ? 'Profile songs will not start by themselves' : 'Profile songs start when you open a profile', 'success', 2200);
  };
  return (
    <div className="profile-section" data-profile-song data-playing={playing ? 'yes' : 'no'}>
      <h4>Profile Song</h4>
      <div className="profile-song">
        <button className="profile-song-play" onClick={() => (playing ? stopProfileSong(url) : playProfileSong(url))} aria-label={playing ? 'Stop the song' : 'Play the song'} data-song-play>
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <span className={cx('profile-song-bars', playing && 'on')} aria-hidden="true"><i /><i /><i /></span>
        <span className="profile-song-title truncate">{song.title || 'Untitled'}</span>
        <button className={cx('icon-btn profile-song-auto', !auto && 'off')} onClick={toggleAuto} aria-pressed={auto} aria-label="Play profile songs by themselves" data-tooltip={auto ? 'Songs start by themselves. Click to stop that.' : 'Songs wait for you to press play. Click to let them start.'} data-song-auto>
          <Icon name={auto ? 'volume' : 'volumeOff'} size={15} />
        </button>
      </div>
    </div>
  );
}

/** In Settings → Profile. Saves by itself (it is not part of the Save Changes bar). */
export function ProfileSongSettings() {
  const song = useStore((s) => s.me.profileSong || null);
  const isBot = useStore((s) => !!s.me.bot);
  const playing = useStoreOf(songStore, (s) => !!song && s.url === song.url);
  const auto = useAutoSongs();
  const [pick, setPick] = useState(null);   // { decoded, start, title } while choosing the part of a new file
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(song?.title || '');
  const [preview, setPreview] = useState(null);   // the blob address being listened to
  const input = useRef(null);
  useEffect(() => { setName(song?.title || ''); }, [song?.title, song?.url]);
  const endPreview = () => { if (preview) { stopProfileSong(preview); URL.revokeObjectURL(preview); setPreview(null); } };
  useEffect(() => () => { stopProfileSong(); }, []);
  const previewing = useStoreOf(songStore, (s) => !!preview && s.url === preview);
  useEffect(() => { if (preview && !previewing) { const t = setTimeout(() => { if (songStore.get().url !== preview) { URL.revokeObjectURL(preview); setPreview(null); } }, 400); return () => clearTimeout(t); } return undefined; }, [preview, previewing]);
  if (isBot) return null;

  const open = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const decoded = await readSong(file);
      if (decoded.duration < 1) throw new Error('A profile song has to be at least a second long.');
      setPick({ decoded, start: 0, title: file.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60) });
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const listen = async () => {
    if (preview) { endPreview(); return; }
    setBusy(true);
    try {
      const { blob } = await prepareProfileSong(pick.decoded, pick.start);
      const u = URL.createObjectURL(blob);
      setPreview(u);
      await playProfileSong(u);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const save = async () => {
    endPreview();
    setBusy(true);
    try {
      const { blob } = await prepareProfileSong(pick.decoded, pick.start);
      await saveProfileSong(blob, pick.title.trim());
      setPick(null);
      toast('Profile song saved', 'success', 1800);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const cancel = () => { endPreview(); setPick(null); };
  const remove = async () => {
    setBusy(true);
    try { stopProfileSong(); await removeProfileSong(); toast('Profile song removed', 'success', 1800); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const rename = async () => {
    setBusy(true);
    try { await renameProfileSong(name.trim()); toast('Saved', 'success', 1500); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const longest = pick ? Math.max(0, pick.decoded.duration - MAX_SECONDS) : 0;
  return (
    <div className="profile-song-settings" data-profile-song-settings data-has-song={song ? 'yes' : 'no'}>
      <p className="tiny muted">Up to {MAX_SECONDS} seconds of any audio file. It plays quietly for people who open your profile; anyone can turn profile songs off for themselves.</p>
      <input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; open(f); }} data-song-file />
      {pick ? (
        <div className="profile-song-editor" data-song-editor>
          <label className="field-label" htmlFor="song-title">Name</label>
          <input id="song-title" className="input" maxLength={60} placeholder="What is it called?" value={pick.title} onChange={(e) => setPick({ ...pick, title: e.target.value })} data-song-title />
          {longest > 0 ? (
            <>
              <label className="field-label" htmlFor="song-start">Start at {clock(pick.start)} <span className="muted">(plays to {clock(Math.min(pick.decoded.duration, pick.start + MAX_SECONDS))})</span></label>
              <input id="song-start" type="range" min={0} max={Math.floor(longest * 2) / 2} step={0.5} value={pick.start} onChange={(e) => { endPreview(); setPick({ ...pick, start: Number(e.target.value) }); }} data-song-start />
            </>
          ) : <p className="tiny muted">The whole file is used ({clock(pick.decoded.duration)}).</p>}
          <div className="profile-song-buttons">
            <Button size="sm" variant="secondary" disabled={busy} onClick={listen} data-song-listen><Icon name={preview ? 'pause' : 'play'} size={14} /> {preview ? 'Stop' : 'Listen'}</Button>
            <Button size="sm" loading={busy} onClick={save} data-song-save>Save Song</Button>
            <Button size="sm" variant="link" disabled={busy} onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : song ? (
        <div className="profile-song-editor">
          <label className="field-label" htmlFor="song-name">Name</label>
          <div className="profile-song-name">
            <input id="song-name" className="input" maxLength={60} placeholder="Untitled" value={name} onChange={(e) => setName(e.target.value)} data-song-name />
            {name.trim() !== (song.title || '') && <Button size="sm" loading={busy} onClick={rename} data-song-rename>Save Name</Button>}
          </div>
          <div className="profile-song-buttons">
            <Button size="sm" variant="secondary" onClick={() => (playing ? stopProfileSong() : playProfileSong(song.url))} data-song-listen><Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Stop' : 'Listen'}</Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>Change</Button>
            <Button size="sm" variant="link" disabled={busy} onClick={remove} data-song-remove>Remove</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()} data-song-choose><Icon name="music" size={14} /> Choose a Song</Button>
      )}
      <ToggleSetting title="Play other people’s profile songs" description="Off: a profile shows a play button instead. Songs never start by themselves while you are in a call, or for someone you blocked."
        checked={auto} onChange={(v) => { setLocal({ profileSongs: v }); if (!v) stopProfileSong(); }} />
    </div>
  );
}
