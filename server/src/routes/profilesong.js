// Profile song: a short clip of music a person can put on their profile. It plays (quietly) for someone who opens that profile,
// unless they turned profile songs off on their device. Like join sounds, the app turns whatever file was picked into a small WAV
// before sending it (at most fifteen seconds, evened out in loudness) and the server only keeps a file that really is one.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, run } from '../db.js';
import { UPLOAD_DIR } from '../config.js';
import { bad, enforceRateLimit } from '../lib/http.js';
import { receiveUpload, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import { getUserRow, privateUser, profileSongOf } from '../models.js';
import { broadcastUserUpdate } from '../gateway.js';
import { inspectWav } from './voicesounds.js';

export const PROFILE_SONG_MAX_SECONDS = 15;
const MAX_BYTES = 2200 * 1024;   // fifteen seconds of 16-bit stereo at 32 kHz is 1.9 MB
const DIR = 'profilesongs';

if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'profile_song'").get()) db.exec('ALTER TABLE users ADD COLUMN profile_song TEXT');   // JSON: { url, title }
fs.mkdirSync(path.join(UPLOAD_DIR, DIR), { recursive: true });

const cleanTitle = (t) => String(t || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const save = (uid, song) => run('UPDATE users SET profile_song = ? WHERE id = ?', song ? JSON.stringify(song) : null, uid);
const answer = (ctx) => { broadcastUserUpdate(ctx.user.id); return privateUser(getUserRow(ctx.user.id)); };

export default function register(r) {
  // The clip itself, as the bytes of a WAV file. `?title=` names it (it can be changed afterwards too).
  r.put('/api/users/@me/profile-song', { raw: true }, async (ctx) => {
    if (ctx.user.bot) throw bad('Bots do not have profile songs.');
    enforceRateLimit(`profilesong:${ctx.user.id}`, 15, 10 * 60 * 1000);
    const up = await receiveUpload(ctx.req, DIR, MAX_BYTES);
    let info = null;
    try { info = inspectWav(fs.readFileSync(up.filePath)); } catch { /* unreadable: treated as not a sound */ }
    if (!info || info.seconds < 1 || info.seconds > PROFILE_SONG_MAX_SECONDS + 0.2) {
      fs.rmSync(up.filePath, { force: true });
      throw bad(!info ? 'That is not a sound NullChat can use. Pick an audio file in the app and it is converted for you.' : info.seconds < 1 ? 'A profile song has to be at least a second long.' : `A profile song can be at most ${PROFILE_SONG_MAX_SECONDS} seconds.`);
    }
    const name = `${up.storedName}.wav`;
    fs.renameSync(up.filePath, path.join(UPLOAD_DIR, DIR, name));
    const old = profileSongOf(getUserRow(ctx.user.id));
    removeUpload(DIR, storedNameFromUrl(old?.url));
    const title = 'title' in (ctx.query || {}) ? cleanTitle(ctx.query.title) : (old?.title || '');
    save(ctx.user.id, { url: `/uploads/${DIR}/${name}`, title });
    return answer(ctx);
  });

  // What it is called ({ title }, up to 60 characters; empty for none).
  r.patch('/api/users/@me/profile-song', async (ctx) => {
    const { title } = z.object({ title: z.string().max(200) }).parse(ctx.body);
    const song = profileSongOf(getUserRow(ctx.user.id));
    if (!song) throw bad('You have no profile song yet.');
    save(ctx.user.id, { url: song.url, title: cleanTitle(title) });
    return answer(ctx);
  });

  r.delete('/api/users/@me/profile-song', async (ctx) => {
    const song = profileSongOf(getUserRow(ctx.user.id));
    removeUpload(DIR, storedNameFromUrl(song?.url));
    save(ctx.user.id, null);
    return answer(ctx);
  });
}
