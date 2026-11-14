// The animated overlay of a profile effect. Put it as the first child of a profile card (".user-popout" / ".profile-modal"):
// it fills the card, sits above it and lets every click through. What it looks like is in styles.css (".pfx").
//   keep     show it even when "Profile effects" is off in Accessibility (the picker and the editor's own preview, like name styles)
//   paused   a still snapshot that plays while hovered or focused (the thumbnails in the picker)
import { particlesFor } from '../lib/profileEffects.js';
import { cx } from '../lib/utils.js';

export function ProfileEffect({ effect, keep = false, paused = false }) {
  const parts = effect ? particlesFor(effect) : null;
  if (!parts) return null;
  return (
    <div className={cx('pfx', `pfx-${effect}`, keep && 'pfx-keep', paused && 'paused')} aria-hidden="true" data-testid="profile-effect" data-effect={effect}>
      {parts.map((p) => <i key={p.key} style={p.style}>{p.text}</i>)}
    </div>
  );
}
