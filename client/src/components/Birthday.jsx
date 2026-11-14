// Birthdays: the part of Settings where you save yours, the line on a profile, and the server's choice of channel
// (server: routes/birthdays.js). Only the day and the month are ever asked for or kept.
import { useEffect, useState } from 'react';
import { useStore, store } from '../lib/state.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { Button, Select, ToggleSetting } from './ui.jsx';
import { DAYS_IN_MONTH, MONTH_NAMES, birthdayText, validBirthday } from '../../../shared/daytime.js';
import { ChannelType } from '../../../shared/permissions.js';

/** In Settings → My Account. */
export function BirthdaySettings() {
  const saved = useStore((s) => s.me.birthday || null);
  const [d, setD] = useState({ month: saved?.month || 0, day: saved?.day || 0, announce: saved ? saved.announce : true, profile: saved ? saved.profile : false });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD({ month: saved?.month || 0, day: saved?.day || 0, announce: saved ? saved.announce : true, profile: saved ? saved.profile : false }); }, [saved?.month, saved?.day, saved?.announce, saved?.profile]);
  const days = d.month ? DAYS_IN_MONTH[d.month - 1] : 31;
  const complete = validBirthday({ month: d.month, day: d.day });
  const dirty = complete && (!saved || saved.month !== d.month || saved.day !== d.day);
  const put = async (birthday, quiet) => {
    setBusy(true);
    try { const me = await api.put('/users/@me/birthday', { birthday }); if (!quiet) toast(birthday ? 'Birthday saved' : 'Birthday removed', 'success', 1800); setMe(me); } catch (e) { toastError(e); }
    setBusy(false);
  };
  // (like every other switch in settings, these two save as soon as they are flipped - once there is a birthday to save them with)
  const flip = (key, v) => {
    setD({ ...d, [key]: v });
    if (saved) put({ month: saved.month, day: saved.day, announce: saved.announce, profile: saved.profile, [key]: v }, true);
  };
  return (
    <div className="settings-section birthday-settings" data-birthday-settings>
      <h3>Birthday</h3>
      <p className="muted small">Only the day and the month, never the year. On the day, servers that have a birthday channel can post a message for you at 9 in the morning your time.</p>
      <div className="birthday-row">
        <Select value={String(d.month)} onChange={(v) => { const month = Number(v); setD({ ...d, month, day: month && d.day > DAYS_IN_MONTH[month - 1] ? 0 : d.day }); }}
          options={[{ value: '0', label: 'Month' }, ...MONTH_NAMES.map((n, i) => ({ value: String(i + 1), label: n }))]} />
        <Select value={String(d.day)} onChange={(v) => setD({ ...d, day: Number(v) })}
          options={[{ value: '0', label: 'Day' }, ...Array.from({ length: days }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]} />
      </div>
      <ToggleSetting title="Let my servers announce it" description="Only servers that chose a birthday channel, and only in a channel you can see yourself." checked={d.announce} disabled={busy} onChange={(v) => flip('announce', v)} />
      <ToggleSetting title="Show it on my profile" description="People who can see your profile see the day and month." checked={d.profile} disabled={busy} onChange={(v) => flip('profile', v)} />
      <div className="birthday-actions">
        <Button disabled={!dirty || busy} onClick={() => put({ month: d.month, day: d.day, announce: d.announce, profile: d.profile })}>{saved ? 'Save Changes' : 'Save Birthday'}</Button>
        {saved && <Button variant="link" disabled={busy} onClick={() => put(null)}>Remove my birthday</Button>}
      </div>
    </div>
  );
}

// (the server's answer is the account as it now is; the USER_UPDATE event says the same a moment later)
function setMe(me) {
  const s = store.get();
  if (s.me?.id === me.id) store.set({ me: { ...s.me, ...me }, users: { ...s.users, [me.id]: { ...(s.users[me.id] || {}), ...me } } });
}

/** On a profile: the day and month, when the person shows it. */
export function BirthdayLine({ user }) {
  if (!validBirthday(user?.birthday)) return null;
  return <div className="profile-section" data-profile-birthday><h4>Birthday</h4><div>🎂 {birthdayText(user.birthday)}</div></div>;
}

/** In Server Settings → Overview: where this server announces birthdays. Saves as soon as it is changed. */
export function BirthdayChannelSetting({ guild }) {
  const channels = useStore((s) => (s.guildChannels[guild.id] || []).map((id) => s.channels[id]).filter((c) => c && c.type === ChannelType.TEXT));
  const [busy, setBusy] = useState(false);
  const change = async (v) => {
    setBusy(true);
    try { await api.put(`/guilds/${guild.id}/birthdays`, { channelId: v || null }); toast('Saved', 'success', 1500); } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <div className="settings-section" data-birthday-channel>
      <h3>Birthday Channel</h3>
      <p className="muted small">When it is a member’s birthday, a message is posted here at 9 in the morning their time. Only for members who saved a birthday and allow servers to announce it (Settings → My Account).</p>
      <Select value={guild.birthdayChannelId || ''} disabled={busy} onChange={change} options={[{ value: '', label: 'No Birthday Messages' }, ...channels.map((c) => ({ value: c.id, label: `#${c.name}` }))]} />
    </div>
  );
}
