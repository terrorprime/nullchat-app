// The small "What's new" window: opens once after an update, and can be reopened from Settings → Updates.
// What it says lives in lib/changelog.js (add an entry there to announce an update).
import { openModal, Button } from './ui.jsx';
import { Icon } from './icons.jsx';
import { store } from '../lib/state.js';
import { navigate } from '../lib/router.jsx';
import { closeSettings, openUserSettings } from '../lib/ui.js';
import { updateSettings } from '../lib/settings.js';
import { pendingReleases, recentReleases } from '../lib/changelog.js';

const LOCAL_KEY = 'nullchat.whatsnew';

function localSeen() {
  try { return localStorage.getItem(LOCAL_KEY) || null; } catch { return null; }
}
/** The newest release id this person has seen: the synced setting or this device's copy, whichever is later. */
export function seenRelease(settings) {
  const a = settings?.whatsNew?.seen;
  const b = localSeen();
  const ids = [typeof a === 'string' ? a : null, b].filter(Boolean);
  return ids.length ? ids.sort().pop() : null;
}
/** Remember (on this device and on the account) that releases up to `id` have been seen. */
export function markReleaseSeen(id) {
  if (!id) return;
  const cur = seenRelease(store.get().settings);
  if (cur && cur >= id) return;
  try { localStorage.setItem(LOCAL_KEY, id); } catch { /* storage can be blocked */ }
  updateSettings({ whatsNew: { seen: id } });
}

/** '2026-11-09' -> 'November 9, 2026' (a plain calendar date; no time zone shift). */
export function releaseDate(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(id);
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function WhatsNew({ releases, close }) {
  const tryIt = (it) => {
    close();
    if (it.settings) { openUserSettings(it.settings); return; }
    closeSettings(); navigate(it.to);
  };
  return (
    <div className="modal modal-sm wn" role="dialog" aria-modal="true" aria-labelledby="wn-title" data-testid="whats-new">
      <button className="modal-close icon-btn" onClick={close} aria-label="Close"><Icon name="x" size={22} /></button>
      <div className="modal-header">
        <div className="wn-badge" aria-hidden="true"><Icon name="rocket" size={22} /></div>
        <h2 id="wn-title">What’s new</h2>
      </div>
      <div className="modal-body">
        {releases.map((r) => (
          <section key={r.id} className="wn-release" data-release={r.id}>
            <h3 className="wn-rel"><span>{r.title}</span><time className="wn-date" dateTime={r.id.slice(0, 10)}>{releaseDate(r.id)}</time></h3>
            <ul className="wn-list">
              {r.items.map((it) => (
                <li key={it.title} className="wn-item">
                  <span className="wn-ico" aria-hidden="true"><Icon name={it.icon} size={18} /></span>
                  <div>
                    <div className="wn-item-title">{it.title}</div>
                    <div className="wn-item-text">{it.text}</div>
                    {(it.to || it.settings) && <Button variant="secondary" size="sm" className="wn-try" onClick={() => tryIt(it)}>Try it</Button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="modal-footer">
        <Button autoFocus onClick={close}>Got it</Button>
      </div>
    </div>
  );
}

function open(releases) {
  if (!releases.length) return;
  openModal(({ close }) => <WhatsNew releases={releases} close={close} />, { onClose: () => markReleaseSeen(releases[0].id) });
}

/** Open the window by hand (Settings → Updates): the newest few updates. */
export function openWhatsNew() { open(recentReleases()); }

let announcedTo = null;
/** After sign-in: open the window if there is an update this person hasn't seen. At most once per account per page load. */
export function maybeShowWhatsNew() {
  const s = store.get();
  if (s.status !== 'ready' || !s.me || announcedTo === s.me.id) return;
  const { show, mark } = pendingReleases({ me: s.me, seen: seenRelease(s.settings) });
  if (mark) { announcedTo = s.me.id; markReleaseSeen(mark); return; }
  if (!show.length) return;
  announcedTo = s.me.id;
  open(show);
}
