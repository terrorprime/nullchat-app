// Account levels, server boost tiers and the "Playing X" game list. Shared by server and client
// so both sides agree on the maths.

// Level n starts at 100 * n^2 xp (level 1 = 100 xp, level 5 = 2,500 xp, level 10 = 10,000 xp).
export const xpForLevel = (level) => 100 * level * level;
export const levelFor = (xp) => Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 100));

export function levelProgress(xp) {
  const level = levelFor(xp);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xp, floor, next, pct: Math.max(0, Math.min(1, (xp - floor) / (next - floor))) };
}

// Badge shown next to a level on profiles and the leaderboard.
export const LEVEL_BADGES = [
  { min: 50, id: 'legend', label: 'Legend', color: '#ffb020' },
  { min: 30, id: 'veteran', label: 'Veteran', color: '#ff6b6b' },
  { min: 20, id: 'regular', label: 'Regular', color: '#b48cff' },
  { min: 10, id: 'active', label: 'Active', color: '#4cc9f0' },
  { min: 5, id: 'chatter', label: 'Chatter', color: '#7bd88f' },
  { min: 1, id: 'newcomer', label: 'Newcomer', color: '#9aa0a6' },
];
export const badgeForLevel = (level) => LEVEL_BADGES.find((b) => level >= b.min) || null;

// XP rules: one award per user per server every 30 seconds, 15 to 25 xp each.
export const XP_COOLDOWN_MS = 30_000;
export const XP_MIN = 15;
export const XP_MAX = 25;

// ---- server boosts ("Supercharge") ----------------------------------------------------------
// Boosts are free. Every account gets BOOSTS_PER_USER of them to spread across servers.
export const BOOSTS_PER_USER = 3;
export const BOOST_TIERS = [
  { level: 3, boosts: 14, perks: ['Animated server icon', 'Server banner', 'Custom invite link'] },
  { level: 2, boosts: 7, perks: ['Server banner', 'Custom invite link'] },
  { level: 1, boosts: 2, perks: ['Custom invite link'] },
];
export const boostLevelFor = (count) => (BOOST_TIERS.find((t) => count >= t.boosts)?.level) || 0;

// ---- game activity ---------------------------------------------------------------------------
// The desktop app matches running processes against this list. Only the display name leaves the
// computer. Keys are lowercase process names without ".exe".
export const KNOWN_GAMES = {
  fortniteclient: 'Fortnite', 'fortniteclient-win64-shipping': 'Fortnite', valorant: 'VALORANT', 'valorant-win64-shipping': 'VALORANT',
  leagueclient: 'League of Legends', 'league of legends': 'League of Legends', cs2: 'Counter-Strike 2', csgo: 'Counter-Strike',
  dota2: 'Dota 2', minecraft: 'Minecraft', robloxplayerbeta: 'Roblox', robloxstudiobeta: 'Roblox Studio',
  gta5: 'Grand Theft Auto V', rocketleague: 'Rocket League', overwatch: 'Overwatch 2', 'r5apex': 'Apex Legends', 'r5apex_dx12': 'Apex Legends',
  destiny2: 'Destiny 2', eldenring: 'Elden Ring', cyberpunk2077: 'Cyberpunk 2077', 'rainbowsix': 'Rainbow Six Siege', 'rainbowsix_vulkan': 'Rainbow Six Siege',
  'wow': 'World of Warcraft', 'wowclassic': 'World of Warcraft Classic', hearthstone: 'Hearthstone', 'stardew valley': 'Stardew Valley',
  terraria: 'Terraria', factorio: 'Factorio', rust: 'Rust', 'rustclient': 'Rust', 'palworld-win64-shipping': 'Palworld',
  'among us': 'Among Us', 'fallguys_client': 'Fall Guys', 'fallguys_client_game': 'Fall Guys', 'helldivers2': 'Helldivers 2',
  'baldursgate3': 'Baldur\'s Gate 3', bg3: 'Baldur\'s Gate 3', 'bg3_dx11': 'Baldur\'s Gate 3', 'fifa23': 'FIFA 23', 'eafc24': 'EA SPORTS FC 24',
  'teamfortress2': 'Team Fortress 2', tf_win64: 'Team Fortress 2', 'left4dead2': 'Left 4 Dead 2', 'hollow knight': 'Hollow Knight', hollowknight: 'Hollow Knight',
  'minecraft.windows': 'Minecraft', tslgame: 'PUBG: BATTLEGROUNDS', rdr2: 'Red Dead Redemption 2', genshinimpact: 'Genshin Impact', starrail: 'Honkai: Star Rail',
  zenlesszonezero: 'Zenless Zone Zero', 'warframe.x64': 'Warframe', phasmophobia: 'Phasmophobia', 'lethal company': 'Lethal Company',
  'deadbydaylight-win64-shipping': 'Dead by Daylight', sotgame: 'Sea of Thieves', pathofexile: 'Path of Exile', pathofexile_x64: 'Path of Exile',
  'osu!': 'osu!', cod: 'Call of Duty', bf2042: 'Battlefield 2042', haloinfinite: 'Halo Infinite', hogwartslegacy: 'Hogwarts Legacy',
  witcher3: 'The Witcher 3', sekiro: 'Sekiro', ffxiv_dx11: 'Final Fantasy XIV', brawlhalla: 'Brawlhalla', projectzomboid64: 'Project Zomboid',
  'marvel-win64-shipping': 'Marvel Rivals', 'valheim': 'Valheim', 'deeprockgalactic-win64-shipping': 'Deep Rock Galactic',
};
export const gameNameFor = (proc) => KNOWN_GAMES[String(proc || '').toLowerCase().replace(/\.exe$/, '')] || null;

export function sanitizeActivity(v) {
  if (!v || typeof v !== 'object') return null;
  const name = String(v.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
  if (!name) return null;
  return { name, since: Number.isFinite(v.since) ? v.since : Date.now() };
}
