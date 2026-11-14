// Server tags: a short tag (2 to 4 letters or numbers) with a badge, which a server sets and members may choose to wear next to their name.
// Shared by the server (to check what is saved) and the web client (to draw it), so both sides always agree.

export const TAG_MIN = 2, TAG_MAX = 4;

/** What a tag may be made of: capital letters A-Z and numbers 0-9 only (no look-alike letters from other alphabets). */
export const TAG_PATTERN = /^[A-Z0-9]{2,4}$/;
export const normalizeTagText = (s) => String(s ?? '').trim().toUpperCase();
export const validTagText = (s) => TAG_PATTERN.test(s);

/** Tags that would pass for the people who run the place; nobody can take them. */
export const TAG_RESERVED = ['ADM', 'ADMN', 'MOD', 'MODS', 'STAF', 'NULL', 'SYS', 'BOT', 'ROOT', 'HELP', 'TEAM', 'OWN', 'CEO', 'NC'];
export const isReservedTag = (s) => TAG_RESERVED.includes(normalizeTagText(s));

/** The colours a tag can have. The pill takes its text from this colour blended with the theme's text colour, so each one reads on dark and light themes. */
export const TAG_COLORS = ['#c2ff3d', '#6cc4ff', '#ff8a5c', '#d58bff', '#ffd23d', '#5cf0b0', '#ff6b8b', '#b4b9c2'];
export const DEFAULT_TAG_COLOR = TAG_COLORS[0];

/** The built-in badges, drawn on a 24 by 24 grid as outlines (SVG path data). A server can also upload its own picture instead. */
export const TAG_ICONS = {
  bolt: ['M13 2 4 14h6l-1 8 9-12h-6z'],
  leaf: ['M5 19c0-9 5-14 15-14 0 10-5 15-14 15', 'M5 19c3-5 6-8 10-10'],
  flame: ['M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 2 1 2 0-3 0-5 2-8z'],
  skull: ['M5 12a7 7 0 0 1 14 0v4l-3 1v3H8v-3l-3-1z', 'M9.5 11.5v1.5', 'M14.5 11.5v1.5'],
  fish: ['M3 12c3-5 8-6 12-3l5-3v12l-5-3c-4 3-9 2-12-3z'],
  crown: ['m3 8 5 5 4-8 4 8 5-5-2 11H5z'],
  star: ['m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z'],
  moon: ['M20 14a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z'],
  heart: ['M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z'],
  shield: ['M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z'],
  gem: ['M6 4h12l3 5-9 11L3 9z', 'M3 9h18', 'M9 4l-1 5 4 11 4-11-1-5'],
  ghost: ['M5 21V11a7 7 0 0 1 14 0v10l-3-2-2 2-2-2-2 2-2-2z', 'M9.5 11v1.5', 'M14.5 11v1.5'],
};
export const TAG_ICON_NAMES = Object.keys(TAG_ICONS);
export const DEFAULT_TAG_ICON = 'bolt';

/** An uploaded badge lives here (a file name made of 32 hex letters and a picture extension). */
export const TAG_BADGE_URL = /^\/uploads\/tagbadges\/[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/;
/** The biggest uploaded badge, in bytes. (The web client shrinks it to a 128 pixel square first, usually a few KB.) */
export const TAG_BADGE_MAX_BYTES = 256 * 1024;
