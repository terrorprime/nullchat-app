// The little flame with a number: days in a row (lib/streaks.js). Shown from two days on; one day is not a streak yet.
import { useEffect, useState } from 'react';
import { useStore } from '../lib/state.js';
import { useSettingValue } from '../lib/settings.js';
import { cx } from '../lib/utils.js';
import { streakNow } from '../../../shared/daytime.js';

/** `kind` is 'dm' (id = the channel) or 'guild' (id = the server). */
export function StreakBadge({ kind, id, className }) {
  const streak = useStore((s) => (kind === 'dm' ? s.streaks.dms[id] : s.streaks.guilds[id]) || null);
  const show = useSettingValue(useStore, 'chat.streaks') !== false;
  // A streak can end, or today can become "still to do", just because midnight passed: look again every minute.
  const [, tick] = useState(0);
  useEffect(() => { if (!streak) return undefined; const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, [!!streak]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show || !streak) return null;
  const now = streakNow(streak);
  if (now.count < 2) return null;
  const what = kind === 'dm'
    ? (now.pending ? 'Write to each other today to keep it going.' : 'You both wrote today.')
    : (now.pending ? 'It continues when two people write here today.' : 'Two or more people wrote here today.');
  const tip = `${now.count} days in a row. ${what}${streak.best > now.count ? ` Best: ${streak.best}.` : ''}`;
  return (
    <span className={cx('streak-badge', now.pending && 'pending', className)} data-streak={now.count} data-streak-pending={now.pending ? '1' : '0'} data-tooltip={tip} aria-label={tip} role="img">
      <span aria-hidden="true">🔥</span>{now.count}
    </span>
  );
}
