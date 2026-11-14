// A message from the site admin, shown above everything else until the person closes it.
import { useStore } from '../lib/state.js';
import { dismissAnnouncement } from '../lib/announcement.js';
import { cx } from '../lib/utils.js';
import { Icon } from './icons.jsx';

/** floating = a fixed bar along the bottom for screens without the app layout (login, register). */
export function AnnouncementBar({ floating = false }) {
  const a = useStore((s) => s.announcement);
  const dismissed = useStore((s) => s.announcementDismissed);
  if (!a || dismissed === a.id) return null;
  return (
    <div className={cx('notice-banner announcement-bar', `level-${a.level}`, floating && 'floating')} role={a.level === 'critical' ? 'alert' : 'status'} data-announcement={a.id}>
      <Icon name="bell" size={18} />
      <span className="announcement-text">{a.text}</span>
      <button className="banner-close" aria-label="Close announcement" data-tooltip="Close" onClick={() => dismissAnnouncement(a.id)}><Icon name="x" size={16} /></button>
    </div>
  );
}
