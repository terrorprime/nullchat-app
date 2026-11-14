// Calendar days in a time zone. Used by streaks (which day does a message count for?) and birthdays (is it their birthday
// yet, where they live?). Runs on the server and in the app, so both always agree on what "today" is.
const formatters = new Map();

/** Is this a time zone name the runtime knows (like "America/Chicago")? */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

/** The date and hour it is at `ms` in `tz` (UTC when the zone is missing or unknown): { year, month, day, hour, dayNumber }. */
export function localDate(ms, tz) {
  const zone = validTimeZone(tz) ? tz : 'UTC';
  const p = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, dayNumber: Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000) };
}

/** A whole number that goes up by one each calendar day in `tz`. */
export const dayNumber = (ms, tz) => localDate(ms, tz).dayNumber;

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Is { month, day } a real date of the year (February 29 included)? */
export const validBirthday = (b) => !!b && Number.isInteger(b.month) && Number.isInteger(b.day) && b.month >= 1 && b.month <= 12 && b.day >= 1 && b.day <= DAYS_IN_MONTH[b.month - 1];

/** Is the birthday on this date? Someone born on February 29 has it on February 28 in the years without one. */
export function isBirthdayOn(b, { year, month, day }) {
  if (!validBirthday(b)) return false;
  if (b.month === 2 && b.day === 29 && !isLeapYear(year)) return month === 2 && day === 28;
  return b.month === month && b.day === day;
}

/** "March 4" */
export const birthdayText = (b) => (validBirthday(b) ? `${MONTH_NAMES[b.month - 1]} ${b.day}` : '');

/** What a streak shows right now: its count while it is alive (counted today or yesterday), else 0; and whether today is still to do. */
export function streakNow(s, nowMs = Date.now()) {
  if (!s || !s.count) return { count: 0, pending: false };
  const today = dayNumber(nowMs, s.tz);
  if (s.lastDay >= today) return { count: s.count, pending: false };
  if (s.lastDay === today - 1) return { count: s.count, pending: true };
  return { count: 0, pending: false };
}
