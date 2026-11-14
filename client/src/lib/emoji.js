// Emoji index, short-code aliases, emoticon conversion and recently-used tracking.
import DATA from './emoji-data.json';

export const CATEGORIES = [
  { id: 'people', label: 'People', icon: '😀' },
  { id: 'nature', label: 'Nature', icon: '🌿' },
  { id: 'food', label: 'Food & Drink', icon: '🍔' },
  { id: 'activity', label: 'Activities', icon: '⚽' },
  { id: 'travel', label: 'Travel & Places', icon: '✈️' },
  { id: 'objects', label: 'Objects', icon: '💡' },
  { id: 'symbols', label: 'Symbols', icon: '❤️' },
  { id: 'flags', label: 'Flags', icon: '🏳️' },
];

// Friendly short codes people expect to type.
const ALIASES = {
  smile: '😄', smiley: '😃', grin: '😁', joy: '😂', rofl: '🤣', laughing: '😆', sweat_smile: '😅', wink: '😉', blush: '😊',
  innocent: '😇', heart_eyes: '😍', kissing_heart: '😘', yum: '😋', sunglasses: '😎', smirk: '😏', neutral_face: '😐',
  expressionless: '😑', unamused: '😒', roll_eyes: '🙄', thinking: '🤔', flushed: '😳', disappointed: '😞', worried: '😟',
  angry: '😠', rage: '😡', cry: '😢', sob: '😭', scream: '😱', sleeping: '😴', sleepy: '😪', mask: '😷', nerd: '🤓',
  upside_down: '🙃', relieved: '😌', pensive: '😔', confused: '😕', slight_smile: '🙂', slight_frown: '🙁', hugging: '🤗',
  shushing: '🤫', zipper_mouth: '🤐', star_struck: '🤩', partying_face: '🥳', pleading_face: '🥺', skull: '💀', ghost: '👻',
  alien: '👽', robot: '🤖', poop: '💩', clown: '🤡', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍', broken_heart: '💔', sparkling_heart: '💖',
  two_hearts: '💕', fire: '🔥', sparkles: '✨', star: '⭐', zap: '⚡', boom: '💥', '100': '💯', thumbsup: '👍', '+1': '👍',
  thumbsdown: '👎', '-1': '👎', ok_hand: '👌', clap: '👏', wave: '👋', pray: '🙏', muscle: '💪', point_up: '☝️',
  point_right: '👉', point_left: '👈', raised_hands: '🙌', handshake: '🤝', v: '✌️', crossed_fingers: '🤞', eyes: '👀',
  brain: '🧠', tada: '🎉', confetti_ball: '🎊', gift: '🎁', trophy: '🏆', medal: '🏅', crown: '👑', gem: '💎', moneybag: '💰',
  rocket: '🚀', airplane: '✈️', car: '🚗', house: '🏠', sun: '☀️', moon: '🌙', rainbow: '🌈', cloud: '☁️', snowflake: '❄️',
  coffee: '☕', tea: '🍵', beer: '🍺', pizza: '🍕', burger: '🍔', fries: '🍟', taco: '🌮', cake: '🍰', cookie: '🍪',
  popcorn: '🍿', apple: '🍎', avocado: '🥑', cat: '🐱', dog: '🐶', fox: '🦊', bear: '🐻', panda: '🐼', unicorn: '🦄',
  frog: '🐸', monkey: '🐵', see_no_evil: '🙈', penguin: '🐧', butterfly: '🦋', snake: '🐍', turtle: '🐢', dragon: '🐉',
  soccer: '⚽', basketball: '🏀', video_game: '🎮', joystick: '🕹️', game_die: '🎲', musical_note: '🎵', notes: '🎶',
  headphones: '🎧', microphone: '🎤', guitar: '🎸', art: '🎨', computer: '💻', keyboard: '⌨️', phone: '📱', bulb: '💡',
  book: '📖', books: '📚', pencil: '✏️', memo: '📝', lock: '🔒', key: '🔑', bell: '🔔', mag: '🔍', link: '🔗', hammer: '🔨',
  wrench: '🔧', gear: '⚙️', shield: '🛡️', warning: '⚠️', x: '❌', white_check_mark: '✅', check: '✔️', question: '❓',
  exclamation: '❗', no_entry: '⛔', hourglass: '⌛', alarm_clock: '⏰', calendar: '📅', pushpin: '📌', paperclip: '📎',
  wave_hand: '👋', salute: '🫡', melting_face: '🫠', nauseated: '🤢', vomiting: '🤮', cold_face: '🥶', hot_face: '🥵',
  money_mouth: '🤑', cowboy: '🤠', zany: '🤪', monocle: '🧐', yawning: '🥱', woozy: '🥴', facepalm: '🤦', shrug: '🤷',
};

const all = [];
const byName = new Map();
for (const cat of CATEGORIES) {
  for (const [char, name] of DATA[cat.id] || []) {
    const e = { char, name, category: cat.id, keywords: [name] };
    all.push(e);
    if (!byName.has(name)) byName.set(name, e);
  }
}
const byChar = new Map(all.map((e) => [e.char, e]));
for (const [alias, char] of Object.entries(ALIASES)) {
  const e = byChar.get(char);
  if (e) { e.keywords.unshift(alias); e.short = e.short || alias; }
  if (!byName.has(alias)) byName.set(alias, e || { char, name: alias, category: 'people', keywords: [alias], short: alias });
}

export const ALL_EMOJI = all;
export function emojiName(char) { const e = byChar.get(char); return e ? (e.short || e.name) : char; }
export function emojisIn(category) { return all.filter((e) => e.category === category); }
export function shortName(e) { return e.short || e.name; }

export function searchEmoji(query, customEmojis = [], limit = 60) {
  const q = query.toLowerCase().replace(/^:/, '').replace(/:$/, '');
  if (!q) return [];
  const out = [];
  for (const c of customEmojis) if (c.name.toLowerCase().includes(q)) out.push({ custom: c, name: c.name, score: c.name.toLowerCase().startsWith(q) ? 0 : 2 });
  const seen = new Set();
  for (const [name, e] of byName) {
    if (!e || seen.has(e.char)) continue;
    const idx = name.indexOf(q);
    if (idx < 0) continue;
    seen.add(e.char);
    out.push({ char: e.char, name, score: idx === 0 ? (ALIASES[name] ? 0 : 1) : 3 });
  }
  return out.sort((a, b) => a.score - b.score || a.name.length - b.name.length).slice(0, limit);
}

/** Replace :shortcodes: in text with emoji characters (or custom emoji markup). */
export function replaceShortcodes(text, customEmojis = []) {
  return text.replace(/(^|[^\w<]):([a-z0-9_+-]{2,40}):/gi, (m, pre, name) => {
    const custom = customEmojis.find((c) => c.name === name);
    if (custom) return `${pre}<${custom.animated ? 'a' : ''}:${custom.name}:${custom.id}>`;
    const e = byName.get(name.toLowerCase());
    return e ? pre + e.char : m;
  });
}

const EMOTICONS = { ':)': '🙂', ':-)': '🙂', ':(': '🙁', ':-(': '🙁', ':D': '😄', ':-D': '😄', ';)': '😉', ';-)': '😉', ':P': '😛', ':p': '😛', ':-P': '😛',
  ":'(": '😢', ':O': '😮', ':o': '😮', '<3': '❤️', '</3': '💔', 'xD': '😆', 'XD': '😆', ':|': '😐', ':/': '😕', 'B)': '😎', '>:(': '😠', ':*': '😘' };
export function convertEmoticons(text) {
  // Only convert emoticons that stand alone (surrounded by whitespace / line edges), never inside code or URLs.
  if (/`/.test(text)) return text;
  return text.replace(/(^|\s)(>:\(|<\/3|<3|:'\(|:-?[)(DPpOo|/*]|;-?\)|xD|XD|B\))(?=\s|$)/g, (m, pre, emo) => (EMOTICONS[emo] ? pre + EMOTICONS[emo] : m));
}

// ---- recently used ----
const RECENT_KEY = 'nullchat.recentEmoji';
export function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function pushRecent(key) {
  const list = [key, ...getRecent().filter((k) => k !== key)].slice(0, 32);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export const DEFAULT_RECENT = ['👍', '❤️', '😂', '🔥', '🎉', '👀', '😮', '😢'];

/** Is this reaction key a custom emoji ("name:id")? */
export function parseCustomKey(key) {
  const m = /^([a-zA-Z0-9_]{2,32}):(\d{19})$/.exec(key);
  return m ? { name: m[1], id: m[2] } : null;
}
