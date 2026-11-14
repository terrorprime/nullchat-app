// Community tools: removing many members at once, a server's own invite link, the name and picture you wear in one server, and
// following another server's announcement channel. The rules live in shared/community.js (and are enforced on the server).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, putImage } from '../lib/api.js';
import { useStore, store, displayName, guildPermissions, channelPermissions } from '../lib/state.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, copyText, formatDate, relativeTime, plural, inviteUrl } from '../lib/utils.js';
import { P, has, ChannelType, highestRolePosition } from '../../../shared/permissions.js';
import { BULK_MAX, VANITY_MIN, VANITY_MAX, normalizeVanity, validVanity, isReservedVanity, JOIN_SOURCE_GROUPS, SOURCE_MAX, normalizeSource, sourceLabel } from '../../../shared/community.js';
import { Avatar, Button, Field, GuildIcon, Modal, Select, Spinner, confirmDialog, openModal, pickFile } from './ui.jsx';
import { Icon } from './icons.jsx';

const DAY = 86_400_000;

// ================================================================ remove many members at once
export function openBulkRemove(guildId) {
  openModal(({ close }) => <BulkRemoveModal guildId={guildId} close={close} />);
}

const JOINED = [['', 'At any time'], ['1', 'In the last 24 hours'], ['7', 'In the last 7 days'], ['30', 'In the last 30 days']];
const QUIET = [['', 'Anyone'], ['30', 'No messages for 30 days'], ['90', 'No messages for 90 days'], ['never', 'Never sent a message']];
const SHOW_MAX = 300;   // rows drawn at once; the filters do the narrowing

/** Why a member can't be picked, or null when they can. Mirrors the server's rules (it checks again). */
function whyNot(guild, me, myPos, m, user) {
  if (m.userId === me.id) return 'You';
  if (guild.ownerId === m.userId) return 'Owner';
  if (user?.bot) return 'Bot';
  if (highestRolePosition(guild, m) >= myPos) return 'Higher role';
  return null;
}

function BulkRemoveModal({ guildId, close }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const members = useStore((s) => s.members[guildId]);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const perms = useStore((s) => guildPermissions(s, guildId));
  const canKick = has(perms, P.KICK_MEMBERS), canBan = has(perms, P.BAN_MEMBERS);

  const [joined, setJoined] = useState('');
  const [quiet, setQuiet] = useState('');
  const [noRoles, setNoRoles] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [activity, setActivity] = useState(null);       // { lastPostAt: { userId: ms }, now } once asked for
  const [actState, setActState] = useState('idle');     // idle | loading | error
  const [action, setAction] = useState(canKick ? 'kick' : 'ban');
  const [deleteSecs, setDeleteSecs] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // "When did they last write?" is only fetched when a filter or the column needs it.
  useEffect(() => {
    if (!quiet || activity || actState !== 'idle') return;
    setActState('loading');
    api.get(`/guilds/${guildId}/members/activity`).then((a) => { setActivity(a); setActState('idle'); }).catch((e) => { setActState('error'); toastError(e); });
  }, [quiet]); // eslint-disable-line react-hooks/exhaustive-deps

  const myPos = guild && members ? highestRolePosition(guild, members[me.id]) : -1;
  const rows = useMemo(() => {
    if (!guild || !members) return [];
    const now = activity?.now || Date.now();
    const last = activity?.lastPostAt || {};
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const m of Object.values(members)) {
      const u = users[m.userId];
      if (joined && m.joinedAt < now - Number(joined) * DAY) continue;
      if (noRoles && m.roles.some((r) => r !== guild.id)) continue;
      if (quiet && activity) {
        const at = last[m.userId] || 0;
        if (quiet === 'never' ? at : (m.joinedAt > now - Number(quiet) * DAY || at > now - Number(quiet) * DAY)) continue;   // newer members have not had the time yet
      } else if (quiet) continue;   // still loading
      if (needle) {
        const name = displayName(store.get(), m.userId, guildId).toLowerCase();
        if (!name.includes(needle) && !(u?.username || '').toLowerCase().includes(needle)) continue;
      }
      out.push({ m, u, why: whyNot(guild, me, myPos, m, u), last: last[m.userId] || 0 });
    }
    return out.sort((a, b) => b.m.joinedAt - a.m.joinedAt);
  }, [guild, members, users, joined, quiet, noRoles, q, activity, myPos, me.id, guildId]);

  const eligible = rows.filter((r) => !r.why);
  const toggle = (id) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else if (n.size >= BULK_MAX) { toast(`You can remove up to ${BULK_MAX} people at a time.`, 'error', 2500); return p; }
    else n.add(id);
    return n;
  });
  const selectAll = () => setPicked((p) => {
    const n = new Set(p);
    for (const r of eligible) { if (n.size >= BULK_MAX) break; n.add(r.m.userId); }
    return n;
  });

  if (!guild || !members) return null;
  const verb = action === 'ban' ? 'Ban' : 'Kick';
  const go = async () => {
    const ids = [...picked].filter((id) => members[id]);
    if (!ids.length) return;
    const body = action === 'ban'
      ? 'They are removed and can’t come back until you unban them. This can’t be undone from here.'
      : 'They are removed from the server. They can join again with a new invite.';
    if (!(await confirmDialog({ title: `${verb} ${plural(ids.length, 'member')}?`, body, confirmText: `${verb} ${ids.length}`, danger: true }))) return;
    setBusy(true);
    try {
      const payload = { action, userIds: ids };
      if (reason.trim()) payload.reason = reason.trim();
      if (action === 'ban' && Number(deleteSecs)) payload.deleteMessageSeconds = Number(deleteSecs);
      setResult(await api.post(`/guilds/${guildId}/members/bulk`, payload));
      setPicked(new Set());
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  // ---- the answer
  if (result) {
    const s = store.get();
    const nameOf = (id) => displayName(s, id, guildId) || id;
    return (
      <Modal title={result.action === 'ban' ? 'Members banned' : 'Members kicked'} onClose={close} size="sm" footer={<Button onClick={close}>Done</Button>}>
        <p className="bulk-result-line"><b>{plural(result.done.length, 'member')}</b> {result.action === 'ban' ? 'banned' : 'removed'}.</p>
        {result.skipped.length > 0 && (
          <>
            <p className="small muted mb">{plural(result.skipped.length, 'person', 'people')} could not be {result.action === 'ban' ? 'banned' : 'removed'}:</p>
            <ul className="bulk-skipped">
              {result.skipped.map((x) => <li key={x.userId}><b className="truncate">{nameOf(x.userId)}</b><span className="muted small">{x.reason}</span></li>)}
            </ul>
          </>
        )}
      </Modal>
    );
  }

  const loadingActivity = !!quiet && !activity && actState !== 'error';
  const showLast = !!activity;
  return (
    <Modal title="Remove members" subtitle="Filter the list, tick the people to remove, then kick or ban them in one go." onClose={close} size="lg" className="bulk-modal"
      footer={(
        <>
          <span className="bulk-count grow">{picked.size ? `${plural(picked.size, 'member')} selected` : 'Nobody selected'}</span>
          <Button variant="link" onClick={close}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!picked.size} onClick={go}>{picked.size ? `${verb} ${picked.size}` : verb}</Button>
        </>
      )}>
      <div className="bulk-filters">
        <input className="input grow" placeholder="Search members" aria-label="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={joined} onChange={setJoined} options={JOINED.map(([value, label]) => ({ value, label: value ? `Joined ${label.toLowerCase()}` : 'Joined at any time' }))} />
        <Select value={quiet} onChange={setQuiet} options={QUIET.map(([value, label]) => ({ value, label }))} />
        <label className="bulk-check"><input type="checkbox" checked={noRoles} onChange={(e) => setNoRoles(e.target.checked)} /> No roles</label>
      </div>
      {quiet && quiet !== 'never' && <p className="tiny muted bulk-note">People who joined more recently than that are left out, since they have not had the time yet. Only messages in channels count, not voice.</p>}
      <div className="bulk-bar">
        <span className="small muted">{loadingActivity ? 'Looking up who has been quiet…' : `${plural(rows.length, 'member')} match${rows.length === 1 ? 'es' : ''}`}</span>
        <span className="grow" />
        <button type="button" className="link-btn small" disabled={!eligible.length} onClick={selectAll}>
          {eligible.length > BULK_MAX ? `Select the first ${BULK_MAX}` : `Select all ${eligible.length}`}
        </button>
        <button type="button" className="link-btn small" disabled={!picked.size} onClick={() => setPicked(new Set())}>Clear</button>
      </div>
      <div className="bulk-list" role="list">
        {loadingActivity && <div className="bulk-empty"><Spinner /></div>}
        {!loadingActivity && !rows.length && <div className="bulk-empty muted small">{quiet && actState === 'error' ? 'Could not look up who has been quiet. Choose “Anyone” or try again in a moment.' : 'Nobody matches these filters.'}</div>}
        {rows.slice(0, SHOW_MAX).map(({ m, u, why, last }) => {
          const on = picked.has(m.userId);
          return (
            <label key={m.userId} role="listitem" className={cx('bulk-row', on && 'on', why && 'off')}>
              <input type="checkbox" checked={on} disabled={!!why} onChange={() => toggle(m.userId)} aria-label={`Select ${displayName(store.get(), m.userId, guildId)}`} />
              <Avatar userId={m.userId} size={30} />
              <span className="bulk-name"><b className="truncate">{displayName(store.get(), m.userId, guildId)}</b><span className="tiny muted truncate">{u?.username}</span></span>
              <span className="bulk-when small muted">{why ? <span className="pill">{why}</span> : <>Joined {formatDate(m.joinedAt)}</>}</span>
              {showLast && <span className="bulk-when hide-sm small muted">{last ? `Wrote ${relativeTime(last)}` : 'Never wrote'}</span>}
            </label>
          );
        })}
        {rows.length > SHOW_MAX && <div className="bulk-empty muted small">Showing {SHOW_MAX} of {rows.length}. Use the filters to narrow the list.</div>}
      </div>
      <div className="bulk-action">
        {canKick && canBan && (
          <Field label="What to do">
            <Select value={action} onChange={setAction} options={[{ value: 'kick', label: 'Kick (they can join again)' }, { value: 'ban', label: 'Ban (they can’t come back)' }]} />
          </Field>
        )}
        {action === 'ban' && (
          <Field label="Delete their messages">
            <Select value={deleteSecs} onChange={setDeleteSecs} options={[['0', 'Don’t delete any'], ['3600', 'Previous hour'], ['86400', 'Previous 24 hours'], ['259200', 'Previous 3 days'], ['604800', 'Previous 7 days']].map(([value, label]) => ({ value, label }))} />
          </Field>
        )}
        <Field label="Reason (optional, goes in the audit log)" className="grow"><input className="input" maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ================================================================ a server's own invite link (Server Settings → Invites)
export function VanityEditor({ guild, uses }) {
  const saved = guild.vanityCode || '';
  const [v, setV] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setV(saved); setError(null); }, [saved]);
  const code = normalizeVanity(v);
  const problem = !code || code === saved ? null
    : code.length < VANITY_MIN || code.length > VANITY_MAX ? `Use ${VANITY_MIN} to ${VANITY_MAX} characters.`
      : !validVanity(code) ? 'Use only letters, numbers and single hyphens, starting and ending with a letter or number.'
        : isReservedVanity(code) ? 'That name is kept for NullChat itself. Pick another.' : null;
  const dirty = code !== saved;
  const ready = !!code && dirty && !problem;
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.put(`/guilds/${guild.id}/vanity`, { code }); toast('Invite link saved', 'success', 2000); }
    catch (e) { setError(e.errors?.code || e.message); if (!e.errors?.code) toastError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove the invite link?', body: `${inviteUrl(saved)} stops working right away. People who already joined stay. You can pick a new name any time, and someone else could take this one.`, confirmText: 'Remove link', danger: true }))) return;
    setBusy(true);
    try { await api.del(`/guilds/${guild.id}/vanity`); setV(''); toast('Invite link removed', 'success', 2000); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="settings-section vanity-editor">
      <h3>Your own invite link</h3>
      <p className="muted small">A short link that never expires and is easy to say out loud, like <span className="mono">{location.host}/invite/pixelclub</span>. Only one server can have each name.</p>
      <Field label="Link name" error={error || problem} hint={`${VANITY_MIN} to ${VANITY_MAX} letters, numbers or hyphens.`}>
        <div className="vanity-row">
          <span className="vanity-prefix mono" aria-hidden="true">{location.host}/invite/</span>
          <input className="input vanity-input" value={v} maxLength={VANITY_MAX} placeholder="pixelclub" aria-label="Link name" spellCheck={false} autoCapitalize="none" autoCorrect="off"
            onChange={(e) => { setError(null); setV(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')); }}
            onKeyDown={(e) => e.key === 'Enter' && ready && save()} />
        </div>
      </Field>
      <div className="row gap">
        <Button loading={busy} disabled={!ready} onClick={save}>{saved ? 'Save link' : 'Create link'}</Button>
        {saved && <Button variant="secondary" disabled={busy} onClick={() => { copyText(inviteUrl(saved)); toast('Invite link copied', 'success', 1500); }}>Copy link</Button>}
        {saved && <Button variant="link" disabled={busy} onClick={remove}>Remove link</Button>}
      </div>
      {saved && <p className="tiny muted vanity-uses">{uses === undefined ? '' : `${plural(uses, 'person', 'people')} joined with this link.`}</p>}
    </div>
  );
}

// ================================================================ your name and picture in one server
export function openServerProfile(guildId) {
  openModal(({ close }) => <ServerProfileModal guildId={guildId} close={close} />);
}

const PIC_TYPES = 'image/png,image/jpeg,image/gif,image/webp';
const PIC_MAX = 8 * 1024 * 1024;

function ServerProfileModal({ guildId, close }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.users[s.me.id] || s.me);
  const member = useStore((s) => s.members[guildId]?.[s.me.id]);
  const mayChange = useStore((s) => has(guildPermissions(s, guildId), P.CHANGE_NICKNAME));
  const [nick, setNick] = useState(member?.nick || '');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [removePic, setRemovePic] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  if (!guild || !member) return null;

  const pick = async () => {
    const f = await pickFile(PIC_TYPES);
    if (!f) return;
    if (f.size > PIC_MAX) { toast('That picture is over 8 MB. Pick a smaller one.', 'error', 3000); return; }
    setFile(f); setPreview(URL.createObjectURL(f)); setRemovePic(false);
  };
  const nickNow = nick.trim();
  const nickChanged = nickNow !== (member.nick || '');
  const picChanged = !!file || (removePic && !!member.avatar);
  const dirty = nickChanged || picChanged;
  const shown = file ? preview : removePic ? me.avatar : (member.avatar || me.avatar);
  const shownName = nickNow || me.displayName || me.username;
  const save = async () => {
    setBusy(true);
    try {
      if (nickChanged) await api.patch(`/guilds/${guildId}/members/@me`, { nick: nickNow || null });
      if (file) await putImage(`/guilds/${guildId}/members/@me/avatar`, file);
      else if (removePic && member.avatar) await api.del(`/guilds/${guildId}/members/@me/avatar`);
      toast('Server profile saved', 'success', 2000);
      close();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Server profile" subtitle={`How you look in ${guild.name}. Your main profile stays the same everywhere else.`} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} disabled={!dirty || !mayChange} onClick={save}>Save</Button></>}>
      {!mayChange && <div className="notice warn">You don’t have permission to change your name or picture in this server.</div>}
      <div className="sp-preview">
        <Avatar src={shown} name={shownName} userId={me.id} size={72} />
        <div className="sp-preview-text">
          <b className="truncate">{shownName}</b>
          <span className="tiny muted truncate">{me.username}</span>
        </div>
      </div>
      <Field label="Nickname"><input className="input" autoFocus maxLength={32} disabled={!mayChange} placeholder={me.displayName || me.username} value={nick} onChange={(e) => setNick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dirty && mayChange && save()} /></Field>
      <div className="field">
        <span className="field-label">Server picture</span>
        <div className="row gap">
          <Button variant="secondary" size="sm" disabled={!mayChange} onClick={pick}>{member.avatar || file ? 'Change picture' : 'Upload a picture'}</Button>
          {(file || (member.avatar && !removePic)) && <Button variant="link" size="sm" disabled={!mayChange} onClick={() => { setFile(null); setPreview(null); setRemovePic(!!member.avatar); }}>Remove</Button>}
        </div>
        <span className="field-hint">Shown instead of your main picture, only in this server. PNG, JPEG, GIF or WebP up to 8 MB.</span>
      </div>
    </Modal>
  );
}

// ================================================================ announcement channels: following one

/** Text channels in other servers that this person can send announcements to (they need Manage Channels there). */
function followTargets(s, sourceChannel) {
  const out = [];
  for (const g of Object.values(s.guilds)) {
    if (g.id === sourceChannel.guildId) continue;
    const chans = (s.guildChannels[g.id] || []).map((id) => s.channels[id])
      .filter((c) => c?.type === ChannelType.TEXT && has(channelPermissions(s, c.id), P.MANAGE_CHANNELS))
      .sort((a, b) => a.position - b.position);
    if (chans.length) out.push({ guild: g, channels: chans });
  }
  return out.sort((a, b) => a.guild.name.localeCompare(b.guild.name));
}

/** Can this person follow the channel into one of their other servers? Used to decide whether to show the Follow button. */
export function canFollowChannel(s, channel) {
  return channel?.type === ChannelType.ANNOUNCEMENT && followTargets(s, channel).length > 0;
}

export function openFollowModal(channelId) {
  openModal(({ close }) => <FollowModal channelId={channelId} close={close} />);
}

function FollowModal({ channelId, close }) {
  const channel = useStore((s) => s.channels[channelId]);
  const source = useStore((s) => s.guilds[s.channels[channelId]?.guildId]);
  const groups = useStore((s) => (s.channels[channelId] ? followTargets(s, s.channels[channelId]) : []));
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!channel || !source) return null;
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/channels/${channelId}/follows`, { targetChannelId: target.id });
      toast(`Following #${channel.name}. New announcements will appear in #${target.name}.`, 'success', 3500);
      close();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Follow #${channel.name}`} subtitle={`Announcements ${source.name} publishes will be copied into a channel of yours.`} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} disabled={!target} onClick={go}>Follow</Button></>}>
      {!groups.length ? <p className="muted">You need Manage Channels in another server with a text channel to follow into.</p> : (
        <div className="follow-groups" role="radiogroup" aria-label="Where announcements should go">
          {groups.map(({ guild, channels }) => (
            <div key={guild.id} className="follow-group">
              <div className="follow-group-head"><GuildIcon guild={guild} size={22} /><b className="truncate">{guild.name}</b></div>
              {channels.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={target?.id === c.id} className={cx('follow-opt', target?.id === c.id && 'on')} onClick={() => setTarget(c)}>
                  <Icon name="hash" size={16} /><span className="truncate">{c.name}</span><span className="follow-radio" aria-hidden="true" />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className="tiny muted mt">Only posts that someone publishes are copied. Edits and deletes stay in the original. A server can have up to 10 announcement channels flowing into one channel.</p>
    </Modal>
  );
}

/** Who follows this announcement channel, and which announcement channels flow into this one. Shown in channel settings. */
export function FollowsPanel({ channel }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => api.get(`/channels/${channel.id}/follows`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [channel.id, channel.type]); // eslint-disable-line react-hooks/exhaustive-deps
  const stop = async (f, ask) => {
    if (!(await confirmDialog({ title: ask.title, body: ask.body, confirmText: ask.confirm, danger: true }))) return;
    setBusy(f.id);
    try { await api.del(`/follows/${f.id}`); await load(); } catch (e) { toastError(e); } finally { setBusy(null); }
  };
  const isAnn = channel.type === ChannelType.ANNOUNCEMENT;
  const followers = data?.followers || [], following = data?.following || [];
  const row = (f, side, onStop) => (
    <div key={f.id} className="follow-row">
      <GuildIcon guild={{ name: side.guildName, icon: side.guildIcon }} size={30} />
      <span className="follow-row-text"><b className="truncate">{side.guildName}</b><span className="tiny muted truncate">#{side.channelName}</span></span>
      <Button size="sm" variant="secondary" loading={busy === f.id} onClick={onStop}>Stop</Button>
    </div>
  );
  return (
    <>
      {isAnn && (
        <div className="settings-section">
          <h3>Followers</h3>
          <p className="muted small">Servers that get a copy of every post you publish here. Anyone who can see this channel and manage channels in another server can follow it.</p>
          {error && <p className="small muted">{error}</p>}
          {!data && !error && <Spinner />}
          {data && !followers.length && <p className="small muted">No server follows this channel yet.</p>}
          {followers.map((f) => row(f, f.target, () => stop(f, { title: `Stop sending to ${f.target.guildName}?`, body: `Posts you publish here will no longer appear in #${f.target.channelName}. Posts already copied stay.`, confirm: 'Stop sending' })))}
        </div>
      )}
      {data && following.length > 0 && (
        <div className="settings-section">
          <h3>Receiving announcements from</h3>
          <p className="muted small">Posts these channels publish are copied into this one.</p>
          {following.map((f) => row(f, f.source, () => stop(f, { title: `Stop following ${f.source.guildName}?`, body: `New announcements from #${f.source.channelName} will no longer appear here. Posts already copied stay.`, confirm: 'Stop following' })))}
        </div>
      )}
    </>
  );
}

/** Publish one post of an announcement channel to every server that follows it. */
export async function publishAnnouncement(channelId, messageId) {
  if (!(await confirmDialog({ title: 'Publish this post?', body: 'A copy goes to every server that follows this channel, and shows up there right away. Later edits and deletes here don’t change the copies, and you can’t take them back.', confirmText: 'Publish' }))) return;
  try {
    const r = await api.post(`/channels/${channelId}/messages/${messageId}/publish`);
    toast(r.delivered ? `Published to ${plural(r.delivered, 'server')}.` : 'Published. No server follows this channel yet.', 'success', 3000);
  } catch (e) { toastError(e); }
}

// ================================================================ "joined from": a label on an invite link, and the count of who joined through each
/**
 * Pick where an invite link is going to be shared (YouTube, a friend, a website…) or type a label of your own. The link then ends in it
 * (/invite/pixelclub/youtube) and the server counts everyone who joins through it. `value` is the label ('' = none).
 */
export function JoinedFromPicker({ value, onChange }) {
  const [custom, setCustom] = useState('');
  const pick = (id) => { setCustom(''); onChange(value === id ? '' : id); };
  return (
    <div className="field joined-from">
      <span className="field-label" id="joined-from-label">Joined from</span>
      <p className="tiny muted joined-from-hint">Pick where you will share this link. The server then shows how many people joined from each place (never who).</p>
      <div className="source-groups" role="group" aria-labelledby="joined-from-label">
        {JOIN_SOURCE_GROUPS.map((g) => (
          <div key={g.id} className="source-group">
            <span className="source-group-name">{g.label}</span>
            <div className="source-chips">
              {g.sources.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={value === id} className={cx('source-chip', value === id && 'on')} onClick={() => pick(id)}>{label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <input className="input source-custom" aria-label="Your own label" maxLength={SOURCE_MAX + 6} placeholder="Or your own label, like my-stream" value={custom} spellCheck={false} autoCapitalize="none" autoCorrect="off"
        onChange={(e) => { setCustom(e.target.value); onChange(normalizeSource(e.target.value)); }} />
      {value && <p className="tiny muted joined-from-now">The link ends in <code>/{value}</code>. Everyone who joins with it is counted under <b>{sourceLabel(value)}</b>.</p>}
    </div>
  );
}

const SOURCE_RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']];

/** Server Settings → Invites: how many people joined through each label. */
export function JoinSourcesPanel({ guildId }) {
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    api.get(`/guilds/${guildId}/join-sources?days=${days}`).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [guildId, days]);
  const top = data?.sources?.[0]?.count || 1;
  return (
    <div className="settings-section join-sources">
      <div className="join-sources-head">
        <h3>Where people joined from</h3>
        <Select value={days} onChange={setDays} options={SOURCE_RANGES.map(([value, label]) => ({ value, label }))} />
      </div>
      <p className="muted small">Add a label when you share a link: <b>Invite People → Joined from</b>, or put it at the end yourself, like <span className="mono">{location.host}/invite/pixelclub/youtube</span>. Only counts are kept, never who joined.</p>
      {error && <p className="small muted">{error}</p>}
      {!data && !error && <Spinner />}
      {data && !data.total && <p className="small muted">Nobody joined in this time.</p>}
      {data && data.total > 0 && (
        <ul className="source-rows" aria-label={`Joins by label, ${SOURCE_RANGES.find((r) => r[0] === days)?.[1].toLowerCase()}`}>
          {data.sources.map((r) => (
            <li key={r.source || 'none'} className="source-row">
              <span className="source-name truncate">{r.source ? sourceLabel(r.source) : 'No label'}</span>
              <span className="source-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, Math.round((r.count / top) * 100))}%` }} /></span>
              <span className="source-count">{r.count}<span className="tiny muted"> {Math.round((r.count / data.total) * 100)}%</span></span>
            </li>
          ))}
          {data.more > 0 && <li className="source-row"><span className="source-name muted">Other labels</span><span className="source-bar" aria-hidden="true" /><span className="source-count">{data.more}</span></li>}
          <li className="source-total small muted">{plural(data.total, 'person', 'people')} joined</li>
        </ul>
      )}
      {data && data.total > 0 && <p className="tiny muted">“No label” is a link without one, and anyone who joined before labels existed.</p>}
    </div>
  );
}
