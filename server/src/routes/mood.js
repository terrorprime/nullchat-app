// Mood rooms: a voice channel can have a shared background sound (rain, a fireplace, waves…). The server only keeps WHICH sound
// the room has; each person's app makes the sound itself, quietly, under the conversation, and each person can turn it down or
// off for themselves. Nothing is mixed into anyone's microphone.
//
// Who can change it: anyone who is in the room (it is the room's sound), unless the channel is set so that only people who can
// manage the channel may. Those people can always change it, from anywhere.
import { z } from 'zod';
import { run } from '../db.js';
import { bad, forbidden, enforceRateLimit } from '../lib/http.js';
import { channelAccess, getChannelRow, serializeChannel } from '../models.js';
import { sendToChannel, voiceStates } from '../gateway.js';
import { MOOD_IDS } from '../../../shared/moods.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';

export default function register(r) {
  r.put('/api/channels/:id/mood', async (ctx) => {
    const { channel, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM || channel.type !== ChannelType.VOICE) throw bad('Only voice channels have a room sound.');
    const body = z.object({ mood: z.string().max(30).nullable().optional(), locked: z.boolean().optional() }).parse(ctx.body || {});
    const manager = has(perms, P.MANAGE_CHANNELS);
    if (body.locked !== undefined && !manager) throw forbidden('Only people who can manage this channel can change who sets the room sound.');
    if (body.mood !== undefined) {
      if (body.mood !== null && !MOOD_IDS.includes(body.mood)) throw bad('Unknown room sound.');
      if (!manager) {
        if (channel.mood_locked) throw forbidden('Only people who can manage this channel can change its room sound.');
        if (voiceStates.get(ctx.user.id)?.channelId !== channel.id) throw forbidden('Join the voice channel to change its room sound.');
      }
      enforceRateLimit(`mood:${ctx.user.id}`, 10, 60_000, 'You are changing the room sound too quickly.');
      run('UPDATE channels SET mood = ? WHERE id = ?', body.mood, channel.id);
    }
    if (body.locked !== undefined) run('UPDATE channels SET mood_locked = ? WHERE id = ?', body.locked ? 1 : 0, channel.id);
    const row = getChannelRow(channel.id);
    const out = serializeChannel(row);
    sendToChannel(row, 'CHANNEL_UPDATE', out);
    // The people in the room are told who changed it (a small note in their app).
    if (body.mood !== undefined && body.mood !== (channel.mood || null)) sendToChannel(row, 'VOICE_MOOD', { channelId: channel.id, guildId: channel.guild_id, mood: body.mood, userId: ctx.user.id });
    return out;
  });
}
