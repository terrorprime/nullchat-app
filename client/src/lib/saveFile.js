// "Download" for a file, a picture or a GIF, in a way that works on phones too.
//
// A plain <a download> link is enough on a computer. On phones it is not:
//   - iPhone / iPad: for a picture the link is opened instead of saved, and in NullChat added to the Home Screen that replaces the
//     whole app with the picture and no way back. So there the file is fetched and handed to the system's share sheet, which has
//     "Save Image" (to Photos) and "Save to Files".
//   - Android: the browser only keeps a picture when the server says it is a file to keep, so the link asks for that (?download=1).
//   - A GIF from GIPHY lives on another site, where the link's "download" hint is ignored everywhere: it is fetched and saved from here.
import { toast } from './toast.js';
import { inNativeApp } from './native.js';
import { confirmDialog } from '../components/ui.jsx';

const SHARE_MAX = 60 * 1024 * 1024;   // bigger than this is not read into memory to share; the link is opened instead

const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const sameOrigin = (url) => { try { return new URL(url, location.href).origin === location.origin; } catch { return false; } };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };

/** A name to save under: the one given, else the last part of the link, with an ending that matches what the file is. */
export function saveName(url, filename, type) {
  let name = filename;
  if (!name) { try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch { name = ''; } }
  name = (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  if (!/\.[a-z0-9]{1,5}$/i.test(name) && EXT[type]) name += `.${EXT[type]}`;
  return name;
}

/** The link that makes our own server send a file as "keep this" under the given name. */
export function downloadUrl(url, filename) {
  if (!sameOrigin(url)) return url;
  const u = new URL(url, location.href);
  u.searchParams.set('name', filename || 'file');
  u.searchParams.set('download', '1');
  return u.pathname + u.search;
}

function clickLink(href, name) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}

async function share(file) {
  try { await navigator.share({ files: [file] }); return 'shared'; }
  catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
    if (e?.name !== 'NotAllowedError') throw e;
  }
  // The phone only opens its share sheet straight after a tap, and fetching the file took too long for the first one to count. Ask for one more.
  if (!(await confirmDialog({ title: 'Ready to save', body: `“${file.name}” is ready. Tap Save, then choose “Save Image” or “Save to Files”.`, confirmText: 'Save' }))) return 'cancelled';
  try { await navigator.share({ files: [file] }); return 'shared'; }
  catch (e) { if (e?.name === 'AbortError') return 'cancelled'; throw e; }
}

const busy = new Set();
/**
 * Save a file to the person's device. `url` is one of our uploads or a picture on another site; `filename`, `type` and `size` are what is known about it.
 * Resolves to 'download' (the browser is saving it), 'shared' (handed to the phone's share sheet), 'cancelled', 'opened' (could only be opened) or 'busy'.
 */
export async function saveFile(url, filename, { type, size } = {}) {
  if (busy.has(url)) return 'busy';
  const same = sameOrigin(url);
  const name = saveName(url, filename, type);
  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  const viaShare = canShare && (isIOS() || inNativeApp()) && !(size > SHARE_MAX);
  // Our own file on a computer or an Android phone: the browser downloads it itself (nothing is read into memory, so 150 MB files are fine).
  if (same && !viaShare) { clickLink(downloadUrl(url, name), name); return 'download'; }
  busy.add(url);
  const slow = setTimeout(() => toast('Getting the file…', 'info', 2500), 1200);
  try {
    const res = await fetch(url, same ? { credentials: 'same-origin' } : { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    clearTimeout(slow);
    const kind = blob.type || type || 'application/octet-stream';
    const file = new File([blob], saveName(url, filename, kind), { type: kind });
    if (viaShare && navigator.canShare({ files: [file] })) return await share(file);
    const href = URL.createObjectURL(blob);
    clickLink(href, file.name);
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return 'download';
  } catch (e) {
    clearTimeout(slow);
    if (same) { clickLink(downloadUrl(url, name), name); return 'download'; }
    // Another site that won't let us fetch its picture: open it, where the phone or browser can save it.
    window.open(url, '_blank', 'noopener,noreferrer');
    toast('Opened it in a new tab. Press and hold the picture (or right-click it) to save it.', 'info', 6000);
    return 'opened';
  } finally { busy.delete(url); }
}
