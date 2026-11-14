// Application modals.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, putImage } from '../lib/api.js';
import { store, useStore, displayName, firstTextChannel, guildPermissions, channelPermissions } from '../lib/state.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, copyText, inviteUrl, parseInvite, relativeTime, formatFull } from '../lib/utils.js';
import { channelPath, sendMessage } from '../lib/actions.js';
import { prettyCombo } from '../lib/keybinds.js';
import { DEFAULT_KEYBINDS, KEYBIND_LABELS, getSetting } from '../lib/settings.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';
import { Modal, Button, Field, Avatar, GuildIcon, openModal, Switch, Select, RadioGroup, pickFile, Spinner, openPopout, DurationPicker, spellDuration } from './ui.jsx';
import { EmojiPicker, EmojiGlyph } from './EmojiPicker.jsx';
import { Icon, Logo } from './icons.jsx';
import { installEnv } from '../lib/install.js';
import { inNativeApp } from '../lib/native.js';
import { openInstallSheet } from './InstallApp.jsx';
import { openServerProfile, JoinedFromPicker } from './Community.jsx';
import { parseTemplate, TemplateTree } from './Templates.jsx';

// ---------------------------------------------------------------- create / join server
const TEMPLATES = [
  { id: 'default', label: 'Create My Own', icon: 'sparkle' },
  { id: 'gaming', label: 'Gaming', icon: 'grid' },
  { id: 'friends', label: 'Friends', icon: 'friends' },
  { id: 'study', label: 'Study Group', icon: 'folder' },
  { id: 'community', label: 'Local Community', icon: 'globe' },
];

export function openCreateServer() { openModal(({ close }) => <CreateServerModal close={close} />); }

function CreateServerModal({ close }) {
  const me = useStore((s) => s.me);
  const [step, setStep] = useState('template');
  const [template, setTemplate] = useState('default');
  const [name, setName] = useState(`${me.displayName || me.username}'s server`);
  const [icon, setIcon] = useState(null);
  const [invite, setInvite] = useState('');
  const [tplLink, setTplLink] = useState('');
  const [tpl, setTpl] = useState(null);   // a server template looked up from its link: the new server is made from it
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const iconUrl = useMemo(() => (icon ? URL.createObjectURL(icon) : null), [icon]);

  const create = async () => {
    setLoading(true); setError(null);
    try {
      const g = tpl ? await api.post(`/templates/${encodeURIComponent(tpl.code)}/guilds`, { name }) : await api.post('/guilds', { name, template });
      if (icon) await putImage(`/guilds/${g.id}/icon`, icon).catch((e) => toastError(e));
      close();
      const first = g.channels.find((c) => c.type === 0);
      navigate(`/channels/${g.id}${first ? `/${first.id}` : ''}`);
    } catch (e) { setError(e.errors?.name || e.message); }
    finally { setLoading(false); }
  };
  const join = async () => {
    const { code, source } = parseInvite(invite);
    if (!code) { setError('Please enter a valid invite link or code.'); return; }
    setLoading(true); setError(null);
    try {
      const res = await api.post(`/invites/${encodeURIComponent(code)}`, source ? { source } : undefined);
      close();
      navigate(`/channels/${res.guildId}${res.channelId ? `/${res.channelId}` : ''}`);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const lookUpTemplate = async () => {
    const code = parseTemplate(tplLink);
    if (!code) { setError('Please enter a template link.'); return; }
    setLoading(true); setError(null);
    try { setTpl(await api.get(`/templates/${encodeURIComponent(code)}`)); }
    catch (e) { setTpl(null); setError(e.message); }
    finally { setLoading(false); }
  };
  if (step === 'tpl') {
    return (
      <Modal title="Use a Template" subtitle="Paste a server template link to start a server set up the same way." onClose={close} size="sm"
        footer={<><Button variant="link" onClick={() => { setStep('template'); setError(null); setTpl(null); }}>Back</Button>
          {tpl ? <Button onClick={() => { setStep('details'); setError(null); }}>Use This Template</Button> : <Button loading={loading} onClick={lookUpTemplate}>Look Up</Button>}</>}>
        <Field label="Template link" error={error} required>
          <input className="input" autoFocus placeholder={`${location.origin}/template/aBcDeFgHiJkL`} value={tplLink}
            onChange={(e) => { setTplLink(e.target.value); setTpl(null); }} onKeyDown={(e) => e.key === 'Enter' && (tpl ? setStep('details') : lookUpTemplate())} />
        </Field>
        {tpl && (
          <div className="tpl-found" data-testid="template-found">
            <b>{tpl.name}</b>
            {tpl.description && <div className="muted small">{tpl.description}</div>}
            <div className="tiny muted">Based on {tpl.guild.name}{tpl.creator ? ` · by ${tpl.creator.displayName || tpl.creator.username}` : ''}</div>
            <TemplateTree summary={tpl.summary} />
          </div>
        )}
      </Modal>
    );
  }
  if (step === 'join') {
    return (
      <Modal title="Join a Server" subtitle="Enter an invite below to join an existing server" onClose={close} size="sm"
        footer={<><Button variant="link" onClick={() => { setStep('template'); setError(null); }}>Back</Button><Button loading={loading} onClick={join}>Join Server</Button></>}>
        <Field label="Invite link" error={error} required>
          <input className="input" autoFocus placeholder={`${location.origin}/invite/hTKzmak`} value={invite} onChange={(e) => setInvite(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && join()} />
        </Field>
        <p className="field-label">Invites should look like</p>
        <p className="muted small">hTKzmak<br />{location.origin}/invite/hTKzmak</p>
        <button className="discover-cta" onClick={() => { close(); navigate('/discovery'); }}>
          <Icon name="compass" size={28} /><div><b>Don’t have an invite?</b><div className="muted small">Check out discoverable communities.</div></div><Icon name="chevronRight" />
        </button>
      </Modal>
    );
  }
  if (step === 'details') {
    return (
      <Modal title="Customize Your Server" subtitle="Give your new server a personality with a name and an icon. You can always change it later." onClose={close} size="sm"
        footer={<><Button variant="link" onClick={() => setStep(tpl ? 'tpl' : 'template')}>Back</Button><Button loading={loading} onClick={create} disabled={name.trim().length < 2}>Create</Button></>}>
        <div className="center mb">
          <button className="icon-upload" onClick={async () => { const f = await pickFile('image/*'); if (f) setIcon(f); }}>
            {iconUrl ? <img src={iconUrl} alt="" /> : <><Icon name="upload" size={24} /><span>UPLOAD</span></>}
          </button>
        </div>
        <Field label="Server Name" error={error} required>
          <input className="input" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </Field>
      </Modal>
    );
  }
  return (
    <Modal title="Create Your Server" subtitle="Your server is where you and your friends hang out. Make yours and start talking." onClose={close} size="sm">
      <div className="template-list">
        {TEMPLATES.map((t) => (
          <button key={t.id} className="template-item" onClick={() => { setTemplate(t.id); setStep('details'); }}>
            <span className="template-icon"><Icon name={t.icon} size={24} /></span><b>{t.label}</b><Icon name="chevronRight" />
          </button>
        ))}
      </div>
      <div className="modal-alt">
        <h3>Have an invite already?</h3>
        <Button variant="secondary" className="full" onClick={() => setStep('join')}>Join a Server</Button>
        <h3>Have a template link?</h3>
        <Button variant="secondary" className="full" onClick={() => { setStep('tpl'); setError(null); }}>Use a Template</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- invite
export function openInviteModal(guildId, channelId) {
  const s = store.get();
  let cid = channelId;
  if (!cid || s.channels[cid]?.type === ChannelType.CATEGORY) cid = firstTextChannel(s, guildId)?.id;
  if (!cid) { toast('This server has no channels to invite people to.', 'error'); return; }
  openModal(({ close }) => <InviteModal guildId={guildId} channelId={cid} close={close} />);
}

function InviteModal({ guildId, channelId, close }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const channel = useStore((s) => s.channels[channelId]);
  const friends = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 1).map((r) => s.users[r.id]).filter(Boolean));
  const [invite, setInvite] = useState(null);
  const [opts, setOpts] = useState({ maxAge: 7 * 86400, maxUses: 0 });
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState('');   // the "joined from" label on the link (YouTube, a friend…); '' = none
  const [sent, setSent] = useState({});
  const [q, setQ] = useState('');
  const create = async (o = opts, unique = false) => {
    try { setInvite(await api.post(`/channels/${channelId}/invites`, { ...o, unique })); }
    catch (e) { toastError(e); close(); }
  };
  // A server with its own link (Server Settings → Invites) shares that one: it never expires. "Edit invite link" makes a one-off instead.
  const own = guild?.vanityCode || null;
  useEffect(() => { if (own) setInvite({ code: own, expiresAt: null, vanity: true }); else create(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = invite ? inviteUrl(invite.code, source) : '';
  const sendTo = async (u) => {
    setSent((x) => ({ ...x, [u.id]: 'sending' }));
    try {
      const dm = await api.post('/users/@me/channels', { recipientId: u.id });
      await api.post(`/channels/${dm.id}/messages`, { content: link });
      setSent((x) => ({ ...x, [u.id]: 'sent' }));
    } catch (e) { toastError(e); setSent((x) => ({ ...x, [u.id]: null })); }
  };
  if (editing) {
    return (
      <Modal title="Invite link settings" onClose={close} size="sm"
        footer={<><Button variant="link" onClick={() => setEditing(false)}>Cancel</Button><Button onClick={() => { create(opts, true); setEditing(false); }}>Generate a New Link</Button></>}>
        <Field label="Expire after">
          <Select value={String(opts.maxAge)} onChange={(v) => setOpts({ ...opts, maxAge: Number(v) })}
            options={[['1800', '30 minutes'], ['3600', '1 hour'], ['21600', '6 hours'], ['43200', '12 hours'], ['86400', '1 day'], ['604800', '7 days'], ['0', 'Never']].map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Max number of uses">
          <Select value={String(opts.maxUses)} onChange={(v) => setOpts({ ...opts, maxUses: Number(v) })}
            options={[['0', 'No limit'], ['1', '1 use'], ['5', '5 uses'], ['10', '10 uses'], ['25', '25 uses'], ['50', '50 uses'], ['100', '100 uses']].map(([value, label]) => ({ value, label }))} />
        </Field>
      </Modal>
    );
  }
  const shown = friends.filter((f) => !q || (f.displayName || f.username).toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={`Invite friends to ${guild?.name || 'server'}`} subtitle={channel ? `Recipients will land in #${channel.name}` : null} onClose={close} size="sm">
      {friends.length > 0 && (
        <>
          <input className="input mb" placeholder="Search for friends" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="invite-friends">
            {shown.map((u) => (
              <div key={u.id} className="invite-friend">
                <Avatar user={u} size={32} /><span className="grow">{u.displayName || u.username}<span className="muted small"> {u.username}</span></span>
                <Button size="sm" variant={sent[u.id] === 'sent' ? 'secondary' : 'success'} disabled={!!sent[u.id] || !invite} onClick={() => sendTo(u)}>{sent[u.id] === 'sent' ? 'Sent' : 'Invite'}</Button>
              </div>
            ))}
          </div>
        </>
      )}
      <JoinedFromPicker value={source} onChange={setSource} />
      <Field label="Or, send a server invite link to a friend">
        <div className="copy-row">
          <input className="input" readOnly value={link || 'Generating…'} onFocus={(e) => e.target.select()} />
          <Button variant={copied ? 'success' : 'primary'} disabled={!invite} onClick={() => { copyText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
      </Field>
      <p className="muted small">
        {invite ? (invite.vanity ? 'This is your server’s own link, and it never expires.' : invite.expiresAt ? `Your invite link expires ${relativeTime(invite.expiresAt)}.` : 'Your invite link will never expire.') : ''}{' '}
        <button className="link-btn" onClick={() => setEditing(true)}>{invite?.vanity ? 'Make a one-off link instead.' : 'Edit invite link.'}</button>
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------- create channel / category
export function openCreateChannel(guildId, parentId = null, type = 0) {
  openModal(({ close }) => <CreateChannelModal guildId={guildId} parentId={parentId} initialType={type} close={close} />);
}

function CreateChannelModal({ guildId, parentId, initialType, close }) {
  const parent = useStore((s) => (parentId ? s.channels[parentId] : null));
  const roles = useStore((s) => s.guilds[guildId]?.roles.filter((r) => r.id !== guildId) || []);
  const [type, setType] = useState(initialType);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [allowed, setAllowed] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isCat = type === ChannelType.CATEGORY;
  const submit = async () => {
    setLoading(true); setError(null);
    try {
      const ch = await api.post(`/guilds/${guildId}/channels`, { name, type, parentId: isCat ? null : parentId, private: priv, allowedRoles: allowed });
      close();
      if (ch.type === ChannelType.TEXT || ch.type === ChannelType.FORUM || ch.type === ChannelType.ANNOUNCEMENT) navigate(`/channels/${guildId}/${ch.id}`);
    } catch (e) { setError(e.errors?.name || e.message); }
    finally { setLoading(false); }
  };
  return (
    <Modal title={isCat ? 'Create Category' : 'Create Channel'} subtitle={parent && !isCat ? `in ${parent.name}` : null} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={loading} disabled={!name.trim()} onClick={submit}>{isCat ? 'Create Category' : 'Create Channel'}</Button></>}>
      {!isCat && (
        <Field label="Channel Type">
          <RadioGroup value={type} onChange={setType} options={[
            { value: 0, label: <span className="row-center"><Icon name="hash" size={20} /> Text</span>, description: 'Send messages, images, GIFs, emoji, opinions, and puns' },
            { value: 5, label: <span className="row-center"><Icon name="megaphone" size={20} /> Announcement</span>, description: 'Post news that people in other servers can follow and get a copy of' },
            { value: 2, label: <span className="row-center"><Icon name="speaker" size={20} /> Voice</span>, description: 'Hang out together with voice, video, and screen share' },
            { value: 13, label: <span className="row-center"><Icon name="stage" size={20} /> Stage</span>, description: 'A few people speak while everyone else listens. Listeners can raise a hand to ask for a turn' },
            { value: 15, label: <span className="row-center"><Icon name="forum" size={20} /> Forum</span>, description: 'A place for posts. Each post has a title, optional tags and its own conversation, so topics stay easy to find' },
          ]} />
        </Field>
      )}
      <Field label={isCat ? 'Category Name' : 'Channel Name'} error={error} required>
        <div className="input-with-icon">
          {!isCat && <Icon name={type === 2 ? 'speaker' : type === 13 ? 'stage' : type === 5 ? 'megaphone' : type === 15 ? 'forum' : 'hash'} size={16} />}
          <input className="input" autoFocus maxLength={100} placeholder={isCat ? 'New Category' : 'new-channel'} value={name}
            onChange={(e) => setName(type === 0 || type === 5 || type === 15 ? e.target.value.toLowerCase().replace(/\s/g, '-') : e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
        </div>
      </Field>
      <div className="setting-inline">
        <div><div className="row-center"><Icon name="lock" size={16} /> <b>Private {isCat ? 'Category' : 'Channel'}</b></div>
          <div className="muted small">Only selected roles and you will be able to view this {isCat ? 'category' : 'channel'}.</div></div>
        <Switch checked={priv} onChange={setPriv} />
      </div>
      {priv && roles.length > 0 && (
        <div className="role-picker">
          {roles.map((r) => (
            <label key={r.id} className="checkbox">
              <input type="checkbox" checked={allowed.includes(r.id)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, r.id] : allowed.filter((x) => x !== r.id))} />
              <span className="role-dot" style={{ background: r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--text-muted)' }} /> {r.name}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- moderation (kick / ban / timeout)
export function openModeration(kind, guildId, userId) {
  openModal(({ close }) => <ModerationModal kind={kind} guildId={guildId} userId={userId} close={close} />);
}

const TIMEOUTS = [[60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']];

function ModerationModal({ kind, guildId, userId, close }) {
  const name = useStore((s) => displayName(s, userId, guildId));
  const username = useStore((s) => s.users[userId]?.username);
  const guildName = useStore((s) => s.guilds[guildId]?.name);
  const [reason, setReason] = useState('');
  const [del, setDel] = useState('0');
  const [dur, setDur] = useState(600);
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setLoading(true);
    try {
      if (kind === 'kick') await api.del(`/guilds/${guildId}/members/${userId}`, { reason: reason || undefined });
      if (kind === 'ban') await api.put(`/guilds/${guildId}/bans/${userId}`, { reason: reason || undefined, deleteMessageSeconds: Number(del) });
      if (kind === 'timeout') await api.patch(`/guilds/${guildId}/members/${userId}`, { timeoutUntil: Date.now() + dur * 1000, reason: reason || undefined });
      toast(kind === 'kick' ? `${name} was kicked.` : kind === 'ban' ? `${name} was banned.` : `${name} was timed out.`, 'success');
      close();
    } catch (e) { toastError(e); }
    finally { setLoading(false); }
  };
  const title = kind === 'kick' ? `Kick ${name} from Server` : kind === 'ban' ? `Ban ${name}?` : `Timeout ${name}`;
  return (
    <Modal title={title} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" loading={loading} onClick={submit}>{kind === 'kick' ? 'Kick' : kind === 'ban' ? 'Ban' : 'Timeout'}</Button></>}>
      {kind === 'kick' && <p className="muted">Are you sure you want to kick <b>@{username}</b> from {guildName}? They will be able to rejoin with a new invite.</p>}
      {kind === 'ban' && (
        <>
          <p className="muted">Banning <b>@{username}</b> removes them from {guildName} and stops them from rejoining.</p>
          <Field label="Delete message history">
            <Select value={del} onChange={setDel} options={[['0', 'Don’t delete any'], ['3600', 'Previous hour'], ['21600', 'Previous 6 hours'], ['86400', 'Previous 24 hours'], ['259200', 'Previous 3 days'], ['604800', 'Previous 7 days']].map(([value, label]) => ({ value, label }))} />
          </Field>
        </>
      )}
      {kind === 'timeout' && (
        <>
          <p className="muted">Members who are timed out can’t send messages, react, join voice, or speak until the timeout ends.</p>
          <DurationPicker value={dur} onChange={setDur} presets={TIMEOUTS} min={10} />
          <p className="muted small" data-timeout-summary>They will be timed out for {spellDuration(dur)}.</p>
        </>
      )}
      <Field label="Reason (optional)"><textarea className="input" rows={3} maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export async function changeNickname(guildId, userId) {
  const s = store.get();
  const self = userId === s.me.id;
  if (self) { openServerProfile(guildId); return; }   // your own name and picture for this server live together
  const current = s.members[guildId]?.[userId]?.nick || '';
  openModal(({ close }) => <NicknameModal guildId={guildId} userId={userId} self={self} current={current} close={close} />);
}
function NicknameModal({ guildId, userId, self, current, close }) {
  const [v, setV] = useState(current);
  const [loading, setLoading] = useState(false);
  const username = useStore((s) => s.users[userId]?.displayName || s.users[userId]?.username);
  const hasPic = useStore((s) => !!s.members[guildId]?.[userId]?.avatar) && !self;
  const removePic = async () => {
    setLoading(true);
    try { await api.del(`/guilds/${guildId}/members/${userId}/avatar`); toast('Server picture removed', 'success', 2000); close(); }
    catch (e) { toastError(e); } finally { setLoading(false); }
  };
  const save = async (val) => {
    setLoading(true);
    try { await api.patch(`/guilds/${guildId}/members/${self ? '@me' : userId}`, { nick: val || null }); close(); }
    catch (e) { toastError(e); } finally { setLoading(false); }
  };
  return (
    <Modal title="Change Nickname" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={loading} onClick={() => save(v.trim())}>Save</Button></>}>
      <Field label="Nickname"><input className="input" autoFocus maxLength={32} placeholder={username} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save(v.trim())} /></Field>
      <button className="link-btn" onClick={() => save('')}>Reset Nickname</button>
      {hasPic && (
        <p className="small muted mt">
          They use a different picture in this server. <button className="link-btn" disabled={loading} onClick={removePic}>Remove their server picture</button>
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- group DMs
export function openGroupDMModal(existingChannelId = null) {
  openModal(({ close }) => <GroupDMModal existing={existingChannelId} close={close} />);
}
function GroupDMModal({ existing, close }) {
  const channel = useStore((s) => (existing ? s.channels[existing] : null));
  const friends = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 1).map((r) => s.users[r.id]).filter(Boolean));
  const [sel, setSel] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const already = new Set(channel?.recipients || []);
  const max = 9 - (channel ? channel.recipients.length : 0);
  const list = friends.filter((f) => !already.has(f.id) && (!q || (f.displayName || f.username).toLowerCase().includes(q.toLowerCase()) || f.username.includes(q.toLowerCase())));
  const toggle = (id) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= max ? x : [...x, id]));
  const submit = async () => {
    setLoading(true);
    try {
      if (channel?.type === ChannelType.GROUP_DM) {
        for (const id of sel) await api.put(`/channels/${channel.id}/recipients/${id}`);
        close();
      } else {
        const recips = channel ? [...new Set([...channel.recipients, ...sel])] : sel;
        if (recips.length === 1 && !channel) {
          const dm = await api.post('/users/@me/channels', { recipientId: recips[0] });
          close(); navigate(`/channels/@me/${dm.id}`); return;
        }
        const ch = await api.post('/users/@me/channels', { recipients: recips });
        close(); navigate(`/channels/@me/${ch.id}`);
      }
    } catch (e) { toastError(e); } finally { setLoading(false); }
  };
  return (
    <Modal title="Select Friends" subtitle={`You can add ${Math.max(0, max - sel.length)} more friends.`} onClose={close} size="sm"
      footer={<Button className="full" loading={loading} disabled={!sel.length} onClick={submit}>{channel?.type === ChannelType.GROUP_DM ? 'Add' : sel.length > 1 || channel ? 'Create Group DM' : 'Create DM'}</Button>}>
      <input className="input mb" autoFocus placeholder="Type the username of a friend" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="select-list">
        {list.length === 0 && <div className="muted center small pad">{friends.length ? 'No friends found.' : 'You need friends to create a group DM. Add some from the Friends page!'}</div>}
        {list.map((u) => (
          <label key={u.id} className={cx('select-item', sel.includes(u.id) && 'selected')}>
            <Avatar user={u} size={32} status /><span className="grow">{u.displayName || u.username} <span className="muted small">{u.username}</span></span>
            <input type="checkbox" checked={sel.includes(u.id)} onChange={() => toggle(u.id)} />
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- custom status
export function openCustomStatus() { openModal(({ close }) => <CustomStatusModal close={close} />); }
function CustomStatusModal({ close }) {
  const me = useStore((s) => s.me);
  const cs = me.customStatus || {};
  const [text, setText] = useState(cs.text || '');
  const [emoji, setEmoji] = useState(cs.emoji || '');
  const [clear, setClear] = useState('today');
  const [status, setStatus] = useState(me.status);
  const emojiBtn = useRef(null);
  const save = async () => {
    const durations = { never: null, '30m': 30 * 60e3, '1h': 3600e3, '4h': 4 * 3600e3 };
    let expiresAt = null;
    if (clear === 'today') { const d = new Date(); d.setHours(23, 59, 59, 999); expiresAt = d.getTime(); }
    else if (durations[clear]) expiresAt = Date.now() + durations[clear];
    try {
      await api.patch('/users/@me/presence', { status, customStatus: text || emoji ? { text: text || null, emoji: emoji || null, expiresAt } : null });
      close();
    } catch (e) { toastError(e); }
  };
  return (
    <Modal title="Set a custom status" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <Field label={`What’s cookin’, ${me.displayName || me.username}?`}>
        <div className="input-with-button">
          <button ref={emojiBtn} className="emoji-btn" onClick={() => openPopout(emojiBtn.current, ({ close: c }) => <EmojiPicker onSelect={({ key }) => setEmoji(key)} onClose={c} />, { placement: 'bottom' })}>
            {emoji ? <EmojiGlyph emoji={emoji} size={20} /> : <Icon name="smile" size={20} />}
          </button>
          <input className="input" autoFocus maxLength={128} placeholder="Support has arrived!" value={text} onChange={(e) => setText(e.target.value)} />
          {(text || emoji) && <button className="icon-btn" onClick={() => { setText(''); setEmoji(''); }} aria-label="Clear"><Icon name="x" size={16} /></button>}
        </div>
      </Field>
      <Field label="Clear after">
        <Select value={clear} onChange={setClear} options={[{ value: 'today', label: 'Today' }, { value: '4h', label: '4 hours' }, { value: '1h', label: '1 hour' }, { value: '30m', label: '30 minutes' }, { value: 'never', label: 'Don’t clear' }]} />
      </Field>
      <Field label="Status">
        <Select value={status} onChange={setStatus} options={['online', 'idle', 'dnd', 'invisible'].map((v) => ({ value: v, label: { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible' }[v] }))} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- threads
export function openCreateThread(channelId, message) {
  openModal(({ close }) => <CreateThreadModal channelId={channelId} message={message} close={close} />);
}
function CreateThreadModal({ channelId, message, close }) {
  const ch = useStore((s) => s.channels[channelId]);
  const [name, setName] = useState(message ? (message.content || 'New Thread').replace(/[<>*_~`|#]/g, '').slice(0, 40) : '');
  const [first, setFirst] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    setLoading(true);
    try {
      const t = await api.post(`/channels/${channelId}/threads`, { name: name.trim() || 'New Thread', messageId: message?.id });
      if (first.trim()) await sendMessage(t.id, first.trim());
      close();
      navigate(`/channels/${ch.guildId}/${channelId}?thread=${t.id}`);
    } catch (e) { toastError(e); } finally { setLoading(false); }
  };
  return (
    <Modal title="Create Thread" subtitle={`in #${ch?.name}`} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={loading} onClick={submit}>Create Thread</Button></>}>
      <Field label="Thread Name" required><input className="input" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="New Thread" /></Field>
      {!message && <Field label="Starter Message"><textarea className="input" rows={3} value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Start the conversation" /></Field>}
    </Modal>
  );
}

// ---------------------------------------------------------------- quick switcher
export function openQuickSwitcher() { openModal(({ close }) => <QuickSwitcher close={close} />); }

function QuickSwitcher({ close }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const s = store.get();
  const items = useMemo(() => {
    const out = [];
    for (const id of s.privateChannelIds) {
      const c = s.channels[id];
      if (!c) continue;
      const name = c.type === ChannelType.DM ? displayName(s, c.recipients[0]) : c.name || c.recipients.map((r) => displayName(s, r)).join(', ');
      out.push({ kind: 'dm', key: `c${id}`, label: name, sub: c.type === ChannelType.DM ? s.users[c.recipients[0]]?.username : 'Group', userId: c.type === ChannelType.DM ? c.recipients[0] : null, go: () => navigate(`/channels/@me/${id}`) });
    }
    for (const r of Object.values(s.relationships)) {
      if (r.type !== 1) continue;
      if (out.some((o) => o.userId === r.id)) continue;
      out.push({ kind: 'user', key: `u${r.id}`, label: displayName(s, r.id), sub: s.users[r.id]?.username, userId: r.id, go: () => import('../lib/actions.js').then((a) => a.openDM(r.id)) });
    }
    for (const g of Object.values(s.guilds)) {
      out.push({ kind: 'guild', key: `g${g.id}`, label: g.name, guild: g, go: () => navigate(`/channels/${g.id}`) });
      for (const cid of s.guildChannels[g.id] || []) {
        const c = s.channels[cid];
        if (!c || c.type === ChannelType.CATEGORY) continue;
        out.push({ kind: c.type === ChannelType.VOICE ? 'voice' : 'text', key: `c${cid}`, label: c.name, sub: g.name, parent: s.channels[c.parentId]?.name, go: () => navigate(channelPath(c)) });
      }
    }
    for (const c of Object.values(s.channels)) {
      if (c.type === ChannelType.THREAD) out.push({ kind: 'thread', key: `t${c.id}`, label: c.name, sub: s.guilds[c.guildId]?.name, go: () => navigate(channelPath(c)) });
    }
    return out;
  }, [s]);
  const filtered = useMemo(() => {
    let query = q.trim().toLowerCase();
    let kinds = null;
    if (query.startsWith('@')) { kinds = ['dm', 'user']; query = query.slice(1); }
    else if (query.startsWith('#')) { kinds = ['text', 'thread']; query = query.slice(1); }
    else if (query.startsWith('!')) { kinds = ['voice']; query = query.slice(1); }
    else if (query.startsWith('*')) { kinds = ['guild']; query = query.slice(1); }
    let list = items.filter((i) => !kinds || kinds.includes(i.kind));
    if (query) {
      list = list.map((i) => ({ i, idx: i.label.toLowerCase().indexOf(query), sub: (i.sub || '').toLowerCase().includes(query) }))
        .filter((x) => x.idx >= 0 || x.sub).sort((a, b) => (a.idx < 0) - (b.idx < 0) || a.idx - b.idx || a.i.label.length - b.i.label.length).map((x) => x.i);
    } else {
      // Show unread / recent first.
      list = list.filter((i) => i.kind !== 'user').slice(0, 30);
    }
    return list.slice(0, 50);
  }, [q, items]);
  useEffect(() => setSel(0), [q]);
  const go = (it) => { close(); it.go(); };
  return (
    <div className="quick-switcher" role="dialog" aria-label="Quick switcher">
      <input className="qs-input" autoFocus placeholder="Where would you like to go?" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(filtered.length - 1, x + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
          if (e.key === 'Enter' && filtered[sel]) go(filtered[sel]);
        }} />
      <div className="qs-list">
        {filtered.length === 0 && <div className="muted center pad">No results for “{q}”</div>}
        {filtered.map((it, i) => (
          <div key={it.key} className={cx('qs-item', i === sel && 'selected')} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
            {it.userId ? <Avatar userId={it.userId} size={20} status /> : it.guild ? <GuildIcon guild={it.guild} size={20} />
              : <Icon name={it.kind === 'voice' ? 'speaker' : it.kind === 'thread' ? 'thread' : it.kind === 'dm' ? 'friends' : 'hash'} size={18} />}
            <span className="qs-label">{it.label}</span>
            {it.parent && <span className="muted tiny">{it.parent}</span>}
            {it.sub && <span className="qs-sub">{it.sub}</span>}
          </div>
        ))}
      </div>
      <div className="qs-tip muted tiny"><b>PROTIP:</b> Start searches with @, #, ! or * to narrow results to users, text channels, voice channels or servers.</div>
    </div>
  );
}

// ---------------------------------------------------------------- keyboard shortcuts
export function openShortcuts() {
  openModal(({ close }) => {
    const binds = { ...DEFAULT_KEYBINDS, ...(getSetting('keybinds') || {}) };
    const extra = [['Send message', 'Enter'], ['New line', 'Shift + Enter'], ['Edit last message', '↑ (empty composer)'], ['Cancel reply / edit', 'Esc'], ['Send without notifications', '@silent prefix']];
    return (
      <Modal title="Keyboard Shortcuts" onClose={close} size="md">
        <div className="shortcut-grid">
          {Object.entries(binds).map(([k, v]) => (
            <div key={k} className="shortcut-row"><span>{KEYBIND_LABELS[k] || k}</span><kbd>{prettyCombo(v)}</kbd></div>
          ))}
          {extra.map(([a, b]) => <div key={a} className="shortcut-row"><span>{a}</span><kbd>{b}</kbd></div>)}
        </div>
        <p className="muted small">Change these in User Settings → Keybinds.</p>
      </Modal>
    );
  });
}

// ---------------------------------------------------------------- onboarding
export function openOnboarding() { openModal(({ close }) => <Onboarding close={close} />, { onClose: () => api.post('/users/@me/onboarded').catch(() => {}) }); }

function Onboarding({ close }) {
  const me = useStore((s) => s.me);
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState(me.displayName || '');
  const [uploading, setUploading] = useState(false);
  const [discover, setDiscover] = useState(null);
  useEffect(() => { if (step === 2) api.get('/discovery').then(setDiscover).catch(() => setDiscover([])); }, [step]);
  const finish = () => { api.post('/users/@me/onboarded').catch(() => {}); close(); };
  const saveProfile = async () => {
    if (displayName !== (me.displayName || '')) await api.patch('/users/@me', { displayName: displayName || null }).catch(toastError);
    setStep(2);
  };
  const steps = [
    <div key="0" className="onboard-step center">
      <div className="onboard-hero"><Logo size={56} /></div>
      <h2>Welcome to NullChat, {me.displayName || me.username}!</h2>
      <p className="muted">NullChat is where you talk, hang out in voice, and share your screen with friends and communities. Let’s get you set up — it only takes a moment.</p>
      <ul className="onboard-list">
        <li><Icon name="chat" size={18} /> Text channels, threads, reactions and replies</li>
        <li><Icon name="speaker" size={18} /> Drop-in voice channels with video and screen share</li>
        <li><Icon name="friends" size={18} /> Friends, direct messages and group calls</li>
      </ul>
      <Button size="lg" onClick={() => setStep(1)}>Get Started</Button>
    </div>,
    <div key="1" className="onboard-step center">
      <h2>Make it yours</h2>
      <p className="muted">Add a picture and a display name so friends recognize you.</p>
      <button className="onboard-avatar" disabled={uploading} onClick={async () => {
        const f = await pickFile('image/*'); if (!f) return;
        setUploading(true);
        try { await putImage('/users/@me/avatar', f); } catch (e) { toastError(e); } finally { setUploading(false); }
      }}>
        <Avatar userId={me.id} size={96} />
        <span className="onboard-avatar-edit">{uploading ? <Spinner size={18} /> : <Icon name="upload" size={18} />}</span>
      </button>
      <Field label="Display Name"><input className="input" maxLength={32} value={displayName} placeholder={me.username} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      <div className="row gap"><Button variant="link" onClick={() => setStep(2)}>Skip</Button><Button onClick={saveProfile}>Next</Button></div>
    </div>,
    <div key="2" className="onboard-step center">
      <h2>Find your people</h2>
      <p className="muted">Create a server for you and your friends, join a public community, or add friends by username.</p>
      <div className="onboard-actions">
        <button className="template-item" onClick={() => { finish(); openCreateServer(); }}><span className="template-icon"><Icon name="plus" /></span><b>Create a server</b><Icon name="chevronRight" /></button>
        <button className="template-item" onClick={() => { finish(); navigate('/channels/@me?tab=add'); }}><span className="template-icon"><Icon name="userPlus" /></span><b>Add a friend</b><Icon name="chevronRight" /></button>
      </div>
      {discover === null ? <Spinner /> : discover.filter((g) => !g.joined).slice(0, 3).map((g) => (
        <div key={g.id} className="onboard-guild">
          <GuildIcon guild={g} size={40} /><div className="grow left"><b>{g.name}</b><div className="muted small">{g.memberCount} members</div></div>
          <Button size="sm" onClick={async () => { try { const r = await api.post(`/discovery/${g.id}/join`); finish(); navigate(`/channels/${r.guildId}${r.channelId ? `/${r.channelId}` : ''}`); } catch (e) { toastError(e); } }}>Join</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={finish}>I’ll explore on my own</Button>
    </div>,
  ];
  return (
    <Modal onClose={finish} size="md" className="onboarding">
      <div className="onboard-dots">{[0, 1, 2].map((i) => <span key={i} className={cx(i === step && 'on')} />)}</div>
      {steps[step]}
    </Modal>
  );
}

// ---------------------------------------------------------------- misc helpers
export function openTextModal(title, body) {
  openModal(({ close }) => <Modal title={title} onClose={close} size="sm" footer={<Button onClick={close}>Okay</Button>}>{body}</Modal>);
}

export function canManageGuild(s, guildId) {
  const p = guildPermissions(s, guildId);
  return has(p, P.MANAGE_GUILD) || has(p, P.MANAGE_ROLES) || has(p, P.MANAGE_CHANNELS) || has(p, P.BAN_MEMBERS) || has(p, P.VIEW_AUDIT_LOG) || has(p, P.MANAGE_EMOJIS) || has(p, P.KICK_MEMBERS) || has(p, P.MANAGE_MESSAGES);
}
export { channelPermissions, formatFull };

// ---------------------------------------------------------------- download apps
export function openDownloadApps() {
  if (inNativeApp()) { toast('You’re already using the NullChat app.', 'success'); return; }
  // Phones get the install steps (home screen / Android app); computers get the desktop installers.
  if (installEnv().mobile) { openInstallSheet(); return; }
  openModal(({ close }) => <DownloadApps close={close} />);
}

function detectOS() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS/i.test(ua)) return 'mac';
  return 'linux';
}

function macChip() {
  // Browsers report "Intel" on every Mac; the GPU name reveals Apple Silicon in most browsers.
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    if (/Apple M\d|Apple GPU/i.test(r)) return 'arm64';
    if (/Intel|AMD|Radeon/i.test(r)) return 'x64';
  } catch { /* ignore */ }
  return 'arm64'; // most Macs sold since 2020
}

function fileLabel(f) {
  if (f.label) return f.label;
  if (f.platform === 'mac') {
    const arch = /arm64/i.test(f.name) ? 'Apple Silicon (M1 – M4)' : /x64|intel/i.test(f.name) ? 'Intel Mac' : 'Mac';
    return `${arch} · ${/\.dmg$/i.test(f.name) ? 'DMG' : 'ZIP'}`;
  }
  if (f.platform === 'windows') return `Windows installer${/arm64/i.test(f.name) ? ' (ARM)' : ''}`;
  return /\.deb$/i.test(f.name) ? 'Debian / Ubuntu (.deb)' : 'AppImage';
}

/** The checksum of each file, and how to compare it, for when an installer says it is damaged (a download that was cut short). */
function CheckDownload({ files, platform }) {
  const list = files.filter((f) => f.sha256);
  if (!list.length) return null;
  const name = list[0].name;
  const how = platform === 'windows' ? <>In PowerShell: <code>Get-FileHash "$HOME\Downloads\{name}"</code></>
    : platform === 'linux' ? <>In a terminal: <code>sha256sum ~/Downloads/{name}</code></>
      : <>In Terminal: <code>shasum -a 256 ~/Downloads/{name}</code></>;
  return (
    <details className="download-check">
      <summary className="tiny muted">Won’t open, or says it is damaged? Check the download</summary>
      <p className="tiny muted">That message means the file was cut short on its way here. Delete it and download it again. To be sure, compare this number with your copy ({how}). If they match, the file is fine (capital letters don’t matter).</p>
      {list.map((f) => (
        <div key={f.name} className="download-hash">
          <span className="tiny">{f.name}</span>
          <input className="input tiny mono" readOnly value={f.sha256} aria-label={`SHA-256 of ${f.name}`} onFocus={(e) => e.target.select()} />
        </div>
      ))}
    </details>
  );
}

function DownloadApps({ close }) {
  const [files, setFiles] = useState(null);
  const os = detectOS();
  const chip = os === 'mac' ? macChip() : null;
  useEffect(() => { api.get('/downloads', { noAuthRedirect: true }).then(setFiles).catch(() => setFiles([])); }, []);
  // A file the server knows is damaged (cut short, or not the build its update file describes) is not offered: the installer would only say it failed its integrity check.
  const damagedOf = (p) => (files || []).filter((f) => f.platform === p && f.damaged);
  const byPlatform = (p) => (files || []).filter((f) => f.platform === p && !f.damaged).sort((a, b) => {
    // Full installers come before launchers. Mac: the right chip's DMG first. Linux: the AppImage first (it runs on any distro).
    const score = (f) => (f.launcher ? 10 : 0) + (p === 'mac' ? ((f.name.includes(chip) ? 0 : 2) + (/\.dmg$/i.test(f.name) ? 0 : 1)) : p === 'linux' ? (/\.appimage$/i.test(f.name) ? 0 : 1) : 0);
    return score(a) - score(b);
  });
  // Windows, macOS and Linux always get a card, so it is clear what exists and what doesn't; Android only
  // appears when the server has an APK. The visitor's own system comes first.
  const platforms = [
    { id: 'windows', label: 'Windows', desktop: true },
    { id: 'mac', label: 'macOS', desktop: true },
    { id: 'linux', label: 'Linux', desktop: true },
    { id: 'android', label: 'Android', desktop: false },
  ].filter((p) => p.desktop || byPlatform(p.id).length > 0).sort((a, b) => (b.id === os) - (a.id === os));
  return (
    <Modal title="Get the NullChat app" subtitle="Use NullChat like a regular app — with its own window, Dock / taskbar icon and notifications." onClose={close} size="md">
      <div className="download-section">
        <div className="download-head"><Icon name="screen" size={22} /><div><b>Desktop app</b><div className="muted small">The full NullChat app for Windows, Mac and Linux. It can also host your own server on your computer.</div></div></div>
        {files === null ? <Spinner /> : (
          <div className="download-grid">
            {platforms.map((p) => (
              <div key={p.id} className={cx('download-card', p.id === os && 'recommended')} data-platform={p.id}>
                <div className="row gap"><b>{p.label}</b>{p.id === os && <span className="pill green">Your system</span>}</div>
                {byPlatform(p.id).map((f, i) => (
                  <a key={f.name} className={cx('btn btn-sm', i === 0 ? 'btn-primary' : 'btn-secondary')} href={f.url} download>
                    <Icon name="download" size={14} /> {fileLabel(f)} · {Math.max(1, Math.round(f.size / 1048576))}&nbsp;MB
                  </a>
                ))}
                {byPlatform(p.id).length === 0 && damagedOf(p.id).length > 0 && (
                  <p className="tiny muted" data-damaged={p.id}>The {p.label} installer on this server is damaged, so it isn’t being offered. Server admins: run <b>Deploy to Fly.io.bat</b> again (and don’t run <b>Build Installer.bat</b> at the same time).</p>
                )}
                {byPlatform(p.id).length === 0 && damagedOf(p.id).length === 0 && (
                  <p className="tiny muted" data-unavailable={p.id}>The {p.label} installer isn’t on this server yet. Server admins: see “Desktop app” in the README.</p>
                )}
                {p.id === 'mac' && byPlatform('mac').some((f) => !f.launcher) && (
                  <p className="tiny muted">
                    Not sure which? Apple menu  → <b>About This Mac</b>: “Chip: Apple M…” means Apple Silicon, “Processor: Intel” means Intel.
                    {' '}Open the DMG and drag NullChat into Applications. The first time, if macOS says it can’t verify the developer: open <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.
                  </p>
                )}
                {p.id === 'mac' && byPlatform('mac').some((f) => f.launcher) && (
                  <p className="tiny muted" data-launcher-note="mac">
                    A light version: it opens NullChat in its own window using Chrome, Edge or Brave, which must be installed. It has no tray icon and can’t host a server. Unzip it and drag NullChat into Applications. The first time, if macOS says it can’t verify the developer: open <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.
                  </p>
                )}
                {p.id === 'windows' && byPlatform('windows').length > 0 && <p className="tiny muted">If Windows SmartScreen appears, click <b>More info → Run anyway</b>.</p>}
                <CheckDownload files={byPlatform(p.id)} platform={p.id} />
                {p.id === 'linux' && byPlatform('linux').some((f) => !f.launcher) && <p className="tiny muted">AppImage: make it runnable (<code>chmod +x NullChat-*.AppImage</code>) and open it. On Ubuntu 24.04+ use the .deb (<code>sudo apt install ./NullChat-*.deb</code>) or start the AppImage with <code>--no-sandbox</code>.</p>}
                {p.id === 'linux' && byPlatform('linux').some((f) => f.launcher) && (
                  <p className="tiny muted" data-launcher-note="linux">
                    A light version: it opens NullChat in its own window using Chrome, Chromium, Edge or Brave, which must be installed. It has no tray icon and can’t host a server. .deb: open it, or run <code>sudo apt install ./NullChat-*.deb</code>. Other distros: unpack the .tar.gz and run <code>./install.sh</code>.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
