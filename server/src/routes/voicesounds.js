// Your own join and leave sounds. A person can upload one short sound that the people in a voice channel hear when they come in,
// and another for when they go. The app turns whatever file was picked into a small WAV before sending it (at most five seconds,
// evened out in loudness), and the server only keeps a file that really is one: nobody can blast a minute of noise into a room.
// A server can turn custom sounds off for its voice channels, and every listener can turn them off for themselves.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, run } from '../db.js';
import { UPLOAD_DIR } from '../config.js';
import { bad, enforceRateLimit } from '../lib/http.js';
import { receiveUpload, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import { guildAccess, requirePerm, getUserRow, privateUser, guildPayloadFor, voiceSoundsOf } from '../models.js';
import { broadcastUserUpdate, syncGuild } from '../gateway.js';
import { audit } from '../services.js';
import { P } from '../../../shared/permissions.js';

export const VOICE_SOUND_KINDS = ['join', 'leave'];
export const VOICE_SOUND_MAX_SECONDS = 5;
const MAX_BYTES = 600 * 1024;   // five seconds of 16-bit mono at 48 kHz is 480 KB
const DIR = 'voicesounds';

if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'voice_sounds'").get()) db.exec('ALTER TABLE users ADD COLUMN voice_sounds TEXT');   // JSON: { join: url, leave: url }
if (!db.prepare("SELECT 1 FROM pragma_table_info('guilds') WHERE name = 'voice_sounds_off'").get()) db.exec('ALTER TABLE guilds ADD COLUMN voice_sounds_off INTEGER NOT NULL DEFAULT 0');
fs.mkdirSync(path.join(UPLOAD_DIR, DIR), { recursive: true });

/**
 * Look at a WAV file: plain 16-bit PCM, one or two channels, a sane sample rate. Returns { seconds } or null when it is anything else.
 * (Walks the chunks rather than trusting fixed offsets: a WAV may carry a LIST chunk before its data.)
 */
export function inspectWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12; let fmt = null; let dataBytes = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      if (size < 16 || at + 8 + 16 > buf.length) return null;
      fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - (at + 8));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes === null) return null;
  if (fmt.format !== 1 || fmt.bits !== 16 || (fmt.channels !== 1 && fmt.channels !== 2) || fmt.rate < 8000 || fmt.rate > 48000) return null;
  return { seconds: dataBytes / (fmt.rate * fmt.channels * 2) };
}

const kindOf = (ctx) => { if (!VOICE_SOUND_KINDS.includes(ctx.params.kind)) throw bad('A sound is for joining or for leaving.'); return ctx.params.kind; };
const save = (uid, v) => run('UPDATE users SET voice_sounds = ? WHERE id = ?', v.join || v.leave ? JSON.stringify(v) : null, uid);

export default function register(r) {
  // The sound itself, as the bytes of a WAV file.
  r.put('/api/users/@me/voice-sounds/:kind', { raw: true }, async (ctx) => {
    const kind = kindOf(ctx);
    if (ctx.user.bot) throw bad('Bots do not have join sounds.');
    enforceRateLimit(`voicesound:${ctx.user.id}`, 20, 10 * 60 * 1000);
    const up = await receiveUpload(ctx.req, DIR, MAX_BYTES);
    let info = null;
    try { info = inspectWav(fs.readFileSync(up.filePath)); } catch { /* unreadable: treated as not a sound */ }
    if (!info || info.seconds < 0.1 || info.seconds > VOICE_SOUND_MAX_SECONDS + 0.2) {
      fs.rmSync(up.filePath, { force: true });
      throw bad(!info ? 'That is not a sound NullChat can use. Pick an audio file in the app and it is converted for you.' : info.seconds < 0.1 ? 'That sound is too short to hear.' : `A join or leave sound can be at most ${VOICE_SOUND_MAX_SECONDS} seconds long.`);
    }
    const name = `${up.storedName}.wav`;
    fs.renameSync(up.filePath, path.join(UPLOAD_DIR, DIR, name));
    const v = voiceSoundsOf(getUserRow(ctx.user.id));
    removeUpload(DIR, storedNameFromUrl(v[kind]));
    v[kind] = `/uploads/${DIR}/${name}`;
    save(ctx.user.id, v);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });

  // Back to the standard sound.
  r.delete('/api/users/@me/voice-sounds/:kind', async (ctx) => {
    const kind = kindOf(ctx);
    const v = voiceSoundsOf(getUserRow(ctx.user.id));
    removeUpload(DIR, storedNameFromUrl(v[kind]));
    v[kind] = null;
    save(ctx.user.id, v);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });

  // Whether this server's voice channels play people's own sounds ({ enabled }).
  r.put('/api/guilds/:id/voice-sounds', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(ctx.body);
    run('UPDATE guilds SET voice_sounds_off = ? WHERE id = ?', enabled ? 0 : 1, guild.id);
    audit(guild.id, ctx.user.id, 'GUILD_UPDATE', { targetId: guild.id, targetType: 'guild', changes: { customVoiceSounds: enabled } });
    syncGuild(guild.id);
    return guildPayloadFor(guild.id, ctx.user.id);
  });
}
