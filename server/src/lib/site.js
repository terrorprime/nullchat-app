// Settings the site admin can change while the server is running (no redeploy): the announcement banner shown to
// everyone, and whether new accounts can be created. They live in the database's _meta table, so backups carry them.
import { get, run } from '../db.js';
import { config } from '../config.js';
import { newId } from './security.js';

export const getMeta = (k) => get('SELECT value FROM _meta WHERE key = ?', k)?.value ?? null;
export const setMeta = (k, v) => {
  if (v === null) run('DELETE FROM _meta WHERE key = ?', k);
  else run('INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
};

export const LEVELS = ['info', 'warning', 'critical'];
export const MAX_ANNOUNCEMENT = 500;

/** Can new accounts be created? The admin's choice wins; without one, the REGISTRATION_OPEN setting decides. */
export function registrationOpen() {
  const v = getMeta('site.registration_open');
  if (v === '1') return true;
  if (v === '0') return false;
  return config.registrationOpen;
}
export const registrationSource = () => (getMeta('site.registration_open') === null ? 'config' : 'admin');
export const setRegistrationOverride = (open) => setMeta('site.registration_open', open === null ? null : open ? '1' : '0');

export function getAnnouncement() {
  const raw = getMeta('site.announcement');
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return a && typeof a.text === 'string' && a.text ? a : null;
  } catch { return null; }
}
/** A new announcement gets a new id, so people who closed the previous one see this one. */
export function setAnnouncement({ text, level }, adminName) {
  const a = { id: newId(), text, level, createdAt: Date.now(), by: adminName };
  setMeta('site.announcement', JSON.stringify(a));
  return a;
}
export const clearAnnouncement = () => setMeta('site.announcement', null);
