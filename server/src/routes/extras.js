// Yapin'-style extras: server leaderboard, server boosts and "people you may know" suggestions.
import { get, all, run, parseJSON } from '../db.js';
import { bad, notFound, enforceRateLimit } from '../lib/http.js';
import { guildAccess, publicUser, getUserRow, getGuildCore } from '../models.js';
import { syncGuild } from '../gateway.js';
import { audit } from '../services.js';
import { levelFor, levelProgress, badgeForLevel, BOOSTS_PER_USER, BOOST_TIERS, boostLevelFor } from '../../../shared/levels.js';

const hidden = (userRow, key) => !!parseJSON(userRow?.settings, {}).privacy?.[key];

export default function register(r) {
  // ---- leaderboard ----
  r.get('/api/guilds/:id/leaderboard', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    const rows = all(`SELECT gx.user_id, gx.xp, gx.messages, u.settings FROM guild_xp gx JOIN users u ON u.id = gx.user_id
                      WHERE gx.guild_id = ? ORDER BY gx.xp DESC LIMIT 200`, guild.id);
    const visible = rows.filter((x) => !parseJSON(x.settings, {}).privacy?.hideLeaderboard);
    const board = visible.slice(0, 25).map((x, i) => {
      const level = levelFor(x.xp);
      return { rank: i + 1, userId: x.user_id, xp: x.xp, messages: x.messages, level, badge: badgeForLevel(level)?.id || null };
    });
    const mine = get('SELECT xp, messages FROM guild_xp WHERE guild_id = ? AND user_id = ?', guild.id, ctx.user.id);
    const myRank = mine ? 1 + get('SELECT COUNT(*) AS n FROM guild_xp WHERE guild_id = ? AND xp > ?', guild.id, mine.xp).n : null;
    return {
      board,
      me: mine ? { ...levelProgress(mine.xp), messages: mine.messages, rank: myRank } : null,
      hiddenCount: rows.length - visible.length,
    };
  });

  // ---- server boosts ("Supercharge", free) ----
  r.get('/api/guilds/:id/boosts', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    const boosters = all('SELECT user_id, created_at FROM guild_boosts WHERE guild_id = ? ORDER BY created_at', guild.id)
      .map((b) => ({ userId: b.user_id, since: b.created_at }));
    const used = get('SELECT COUNT(*) AS n FROM guild_boosts WHERE user_id = ?', ctx.user.id).n;
    return {
      count: boosters.length,
      level: boostLevelFor(boosters.length),
      boosters,
      tiers: BOOST_TIERS,
      mine: boosters.some((b) => b.userId === ctx.user.id),
      remaining: Math.max(0, BOOSTS_PER_USER - used),
      perUser: BOOSTS_PER_USER,
    };
  });

  r.put('/api/guilds/:id/boost', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    enforceRateLimit(`boost:${ctx.user.id}`, 10, 60_000);
    if (get('SELECT 1 FROM guild_boosts WHERE guild_id = ? AND user_id = ?', guild.id, ctx.user.id)) throw bad('You already boosted this server.');
    const used = get('SELECT COUNT(*) AS n FROM guild_boosts WHERE user_id = ?', ctx.user.id).n;
    if (used >= BOOSTS_PER_USER) throw bad(`You have used all ${BOOSTS_PER_USER} of your boosts. Remove one from another server first.`);
    const before = guild.boostLevel;
    run('INSERT INTO guild_boosts (guild_id, user_id, created_at) VALUES (?, ?, ?)', guild.id, ctx.user.id, Date.now());
    audit(guild.id, ctx.user.id, 'GUILD_BOOST_ADD', { targetId: guild.id, targetType: 'guild' });
    syncGuild(guild.id);
    const after = getGuildCore(guild.id).boostLevel;
    return { ok: true, level: after, leveledUp: after > before };
  });

  r.delete('/api/guilds/:id/boost', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    const res = run('DELETE FROM guild_boosts WHERE guild_id = ? AND user_id = ?', guild.id, ctx.user.id);
    if (!res.changes) throw notFound('You haven’t boosted this server.');
    audit(guild.id, ctx.user.id, 'GUILD_BOOST_REMOVE', { targetId: guild.id, targetType: 'guild' });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ---- "people you may know" ----
  // Ranked by shared servers and mutual friends. People who switched off
  // Settings > Privacy > "Suggest me to people with similar interests" never appear.
  r.get('/api/users/@me/suggestions', async (ctx) => {
    enforceRateLimit(`suggest:${ctx.user.id}`, 20, 60_000);
    const me = ctx.user.id;
    if (parseJSON(ctx.user.settings, {}).privacy?.suggestMe === false) return [];
    const rows = all(`
      SELECT u.*,
        (SELECT COUNT(*) FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = u.id) AS shared_servers,
        (SELECT COUNT(*) FROM relationships x JOIN relationships y ON x.other_id = y.other_id WHERE x.user_id = ? AND y.user_id = u.id AND x.type = 1 AND y.type = 1) AS mutual_friends
      FROM users u
      WHERE u.id != ? AND u.banned_at IS NULL AND u.bot = 0
        AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.user_id = ? AND r.other_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.user_id = u.id AND r.other_id = ? AND r.type = 2)
      ORDER BY (shared_servers * 2 + mutual_friends * 3) DESC, u.xp DESC
      LIMIT 60`, me, me, me, me, me);
    return rows
      .filter((u) => (u.shared_servers > 0 || u.mutual_friends > 0) && parseJSON(u.settings, {}).privacy?.suggestMe !== false)
      .slice(0, 20)
      .map((u) => ({ ...publicUser(u), sharedServers: u.shared_servers, mutualFriends: u.mutual_friends }));
  });

  // ---- own level card ----
  r.get('/api/users/@me/level', async (ctx) => {
    const u = getUserRow(ctx.user.id);
    const level = levelFor(u.xp);
    return { ...levelProgress(u.xp), badge: badgeForLevel(level), hideLevel: hidden(u, 'hideLevel') };
  });
}
