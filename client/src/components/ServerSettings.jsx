// Server settings and channel settings overlays.
import { BirthdayChannelSetting } from './Birthday.jsx';
import { GuildVoiceSoundsSetting } from './VoiceSounds.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, store, displayName, guildPermissions, channelPermissions } from '../lib/state.js';
import { api, putImage } from '../lib/api.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, formatTimestamp, intToHex, hexToInt, relativeTime, copyText, inviteUrl } from '../lib/utils.js';
import { useUI, setUI, closeSettings, refuseIfUnsaved } from '../lib/ui.js';
import { P, has, PERMISSION_INFO, ChannelType, highestRolePosition, ALL_PERMISSIONS } from '../../../shared/permissions.js';
import {
  Button, Field, Modal, openModal, Switch, ToggleSetting, Select, Slider, RadioGroup, Avatar, GuildIcon, pickFile, Spinner, confirmDialog, Tabs, EmptyState, openContextMenu, DurationPicker, spellDuration,
} from './ui.jsx';
import { SettingsLayout, NavItem, SaveBar } from './UserSettings.jsx';
import { userMenuItems, deleteChannel } from './menus.jsx';
import { openUserPopout } from './Profile.jsx';
import { Icon } from './icons.jsx';
import { ServerReports } from './Reports.jsx';
import { stepInList } from '../lib/reorder.js';
import { useListReorder } from '../lib/useListReorder.js';
import { IntegrationsTab } from './Integrations.jsx';
import { TemplateTab } from './Templates.jsx';
import { ServerTagEditor } from './ServerTag.jsx';
import { openBulkRemove, VanityEditor, FollowsPanel, JoinSourcesPanel } from './Community.jsx';
import { InsightsTab } from './Insights.jsx';
import { StickersTab } from './StickersTab.jsx';
import { TagsEditor } from './ForumTools.jsx';
import { pageZoom } from '../lib/zoom.js';

const ROLE_COLORS = [0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b, 0x11806a, 0x1f8b4c, 0x206694, 0x71368a, 0xad1457, 0xc27c0e, 0xa84300, 0x992d22];

// ================================================================ server settings
export function ServerSettings() {
  const { guildId, tab = 'overview' } = useUI((u) => u.settings);
  const guild = useStore((s) => s.guilds[guildId]);
  const perms = useStore((s) => guildPermissions(s, guildId));
  const isOwner = useStore((s) => s.guilds[guildId]?.ownerId === s.me.id);
  const openReports = useStore((s) => s.reportCounts?.guilds?.[guildId] || 0);
  useEffect(() => { if (!guild) closeSettings(true); }, [guild]);
  if (!guild) return null;
  const setTab = (x) => setUI({ settings: { type: 'guild', guildId, tab: x } });
  const items = [
    ['overview', 'Overview', has(perms, P.MANAGE_GUILD)],
    ['insights', 'Insights', has(perms, P.MANAGE_GUILD)],
    ['roles', 'Roles', has(perms, P.MANAGE_ROLES)],
    ['emoji', 'Emoji', has(perms, P.MANAGE_EMOJIS)],
    ['stickers', 'Stickers', has(perms, P.MANAGE_EMOJIS)],
    ['integrations', 'Integrations', has(perms, P.MANAGE_GUILD)],
    ['template', 'Server Template', has(perms, P.MANAGE_GUILD)],
    ['sep'],
    ['moderation', 'Safety Setup', has(perms, P.MANAGE_GUILD)],
    ['automod', 'AutoMod', has(perms, P.MANAGE_GUILD)],
    ['reports', 'Reports', has(perms, P.MANAGE_MESSAGES)],
    ['audit', 'Audit Log', has(perms, P.VIEW_AUDIT_LOG)],
    ['bans', 'Bans', has(perms, P.BAN_MEMBERS)],
    ['sep'],
    ['members', 'Members', true],
    ['invites', 'Invites', has(perms, P.MANAGE_GUILD)],
  ];
  const allowed = items.filter((i) => i[0] !== 'sep' && i[2]).map((i) => i[0]);
  const current = allowed.includes(tab) ? tab : allowed[0];
  const nav = (
    <>
      <div className="settings-nav-header truncate">{guild.name}</div>
      {items.map((it, i) => (it[0] === 'sep' ? <div key={i} className="settings-nav-sep" /> : it[2] && <NavItem key={it[0]} active={current === it[0]} onClick={() => setTab(it[0])}>{it[1]}{it[0] === 'reports' && openReports > 0 && <span className="badge nav-badge" aria-label={`${openReports} open`}>{openReports}</span>}</NavItem>))}
      <div className="settings-nav-sep" />
      {isOwner && <NavItem danger onClick={() => openDeleteGuild(guild)}>Delete Server <Icon name="trash" size={16} /></NavItem>}
    </>
  );
  const pages = { overview: OverviewTab, insights: InsightsTab, roles: RolesTab, emoji: EmojiTab, stickers: StickersTab, integrations: IntegrationsTab, template: TemplateTab, moderation: ModerationTab, automod: AutoModTab, reports: ServerReports, audit: AuditTab, bans: BansTab, members: MembersTab, invites: InvitesTab };
  const Page = pages[current] || MembersTab;
  return <SettingsLayout nav={nav} onClose={closeSettings}><Page guild={guild} perms={perms} /></SettingsLayout>;
}

function openDeleteGuild(guild) {
  openModal(({ close }) => {
    function Body() {
      const [name, setName] = useState(''); const [err, setErr] = useState(null); const [loading, setLoading] = useState(false);
      const go = async () => {
        setLoading(true);
        try { await api.del(`/guilds/${guild.id}`, { confirmName: name }); close(); closeSettings(true); navigate('/channels/@me'); toast(`${guild.name} was deleted.`, 'success'); }
        catch (e) { setErr(e.errors?.confirmName || e.message); } finally { setLoading(false); }
      };
      return (
        <Modal title={`Delete '${guild.name}'`} onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" loading={loading} onClick={go}>Delete Server</Button></>}>
          <div className="notice error">Are you sure you want to delete <b>{guild.name}</b>? This action cannot be undone. All channels, messages, roles and uploads will be removed.</div>
          <Field label="Enter server name" error={err}><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </Modal>
      );
    }
    return <Body />;
  });
}

// ---------------------------------------------------------------- overview
function OverviewTab({ guild }) {
  const textChannels = useStore((s) => (s.guildChannels[guild.id] || []).map((id) => s.channels[id]).filter((c) => c?.type === ChannelType.TEXT));
  const initial = { name: guild.name, description: guild.description || '', systemChannelId: guild.systemChannelId || '', discoverable: guild.discoverable };
  const [d, setD] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [up, setUp] = useState(null);
  useEffect(() => { setD(initial); }, [guild.name, guild.description, guild.systemChannelId, guild.discoverable]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const save = async () => {
    setSaving(true);
    try { await api.patch(`/guilds/${guild.id}`, { name: d.name, description: d.description, systemChannelId: d.systemChannelId || null, discoverable: d.discoverable }); toast('Saved', 'success', 1500); }
    catch (e) { toastError(e); } finally { setSaving(false); }
  };
  const upload = async (kind) => {
    const f = await pickFile('image/png,image/jpeg,image/gif,image/webp'); if (!f) return;
    setUp(kind);
    try { await putImage(`/guilds/${guild.id}/${kind}`, f); } catch (e) { toastError(e); } finally { setUp(null); }
  };
  return (
    <>
      <h2>Server Overview</h2>
      <div className="overview-grid">
        <div className="overview-icon">
          <GuildIcon guild={guild} size={100} />
          <div className="row gap">
            <Button size="sm" loading={up === 'icon'} onClick={() => upload('icon')}>Upload Image</Button>
            {guild.icon && <Button size="sm" variant="link" onClick={() => api.patch(`/guilds/${guild.id}`, { icon: null }).catch(toastError)}>Remove</Button>}
          </div>
          <p className="tiny muted">We recommend an image of at least 512×512.</p>
        </div>
        <div className="grow">
          <Field label="Server Name"><input className="input" maxLength={100} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
          <Field label="Description" hint="Shown on invites and in Server Discovery."><textarea className="input" rows={3} maxLength={300} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        </div>
      </div>
      <div className="settings-section">
        <h3>Server Banner</h3>
        <div className="banner-edit" style={guild.banner ? { backgroundImage: `url(${guild.banner})` } : undefined}>{!guild.banner && <span className="muted">No banner</span>}</div>
        <div className="row gap">
          <Button size="sm" loading={up === 'banner'} onClick={() => upload('banner')}>Upload Banner</Button>
          {guild.banner && <Button size="sm" variant="link" onClick={() => api.patch(`/guilds/${guild.id}`, { banner: null }).catch(toastError)}>Remove</Button>}
        </div>
      </div>
      <ServerTagEditor guild={guild} />
      <div className="settings-section">
        <h3>System Messages Channel</h3>
        <p className="muted small">This is the channel we send welcome messages to when someone joins.</p>
        <Select value={d.systemChannelId} onChange={(v) => setD({ ...d, systemChannelId: v })} options={[{ value: '', label: 'No System Messages' }, ...textChannels.map((c) => ({ value: c.id, label: `#${c.name}` }))]} />
      </div>
      <BirthdayChannelSetting guild={guild} />
      <GuildVoiceSoundsSetting guild={guild} />
      <ToggleSetting title="Show in Server Discovery" description="Anyone on this NullChat instance can find and join your server from the Discover page without an invite." checked={d.discoverable} onChange={(v) => setD({ ...d, discoverable: v })} />
      <OwnershipTransfer guild={guild} />
      <SaveBar show={dirty} saving={saving} onReset={() => setD(initial)} onSave={save} />
    </>
  );
}

function OwnershipTransfer({ guild }) {
  const isOwner = useStore((s) => guild.ownerId === s.me.id);
  if (!isOwner) return null;
  return (
    <div className="settings-section">
      <h3>Transfer Ownership</h3>
      <p className="muted small">Give this server to another member. You’ll lose owner privileges.</p>
      <Button variant="secondary" onClick={() => openModal(({ close }) => <TransferModal guild={guild} close={close} />)}>Transfer Ownership</Button>
    </div>
  );
}
function TransferModal({ guild, close }) {
  const members = useStore((s) => Object.keys(s.members[guild.id] || {}).filter((id) => id !== s.me.id).map((id) => ({ id, name: displayName(s, id, guild.id) })));
  const [userId, setUserId] = useState(members[0]?.id || '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const go = async () => {
    try { await api.post(`/guilds/${guild.id}/transfer`, { userId, password }); toast('Ownership transferred.', 'success'); close(); }
    catch (e) { setErr(e.errors?.password || e.message); }
  };
  return (
    <Modal title="Transfer Server Ownership" onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" disabled={!userId} onClick={go}>Transfer</Button></>}>
      <Field label="New owner"><Select value={userId} onChange={setUserId} options={members.map((m) => ({ value: m.id, label: m.name }))} /></Field>
      <Field label="Your password" error={err}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- roles
function RolesTab({ guild, perms }) {
  const me = useStore((s) => s.members[guild.id]?.[s.me.id]);
  const memberCounts = useStore((s) => {
    const out = {};
    for (const m of Object.values(s.members[guild.id] || {})) for (const r of m.roles) out[r] = (out[r] || 0) + 1;
    return out;
  });
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState('');
  const myTop = highestRolePosition(guild, me);
  const isOwner = guild.ownerId === me?.userId;
  const roles = [...guild.roles].sort((a, b) => b.position - a.position);
  const everyone = roles.find((r) => r.id === guild.id);
  const saved = roles.filter((r) => r.id !== guild.id);
  // While a new order is on its way to the server the list shows it already, so a dropped role doesn't jump back for a moment.
  const [pending, setPending] = useState(null);
  const byId = Object.fromEntries(saved.map((r) => [r.id, r]));
  const others = pending ? [...pending.map((id) => byId[id]).filter(Boolean), ...saved.filter((r) => !pending.includes(r.id))] : saved;
  const ids = others.map((r) => r.id);
  // Unless you own the server, the roles at and above your own highest role stay where they are, and nothing can be moved past them.
  const locked = isOwner ? 0 : saved.filter((r) => r.position >= myTop).length;
  const listRef = useRef(null);
  useEffect(() => { if (pending && saved.length === pending.length && saved.every((r, i) => r.id === pending[i])) setPending(null); }, [guild.roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveOrder = async (order) => {
    setPending(order);
    try { await api.patch(`/guilds/${guild.id}/roles`, { order }); setTimeout(() => setPending((p) => (p === order ? null : p)), 2500); }
    catch (e) { setPending(null); toastError(e); }
  };
  const searching = !!q.trim();
  const { view, ghostRef, handleProps } = useListReorder({ listRef, ids, locked, enabled: !searching, onDrop: (order) => saveOrder(order) });
  const create = async () => {
    try { const r = await api.post(`/guilds/${guild.id}/roles`, { name: 'new role', color: 0 }); setSelected(r.id); } catch (e) { toastError(e); }
  };
  const move = (id, dir) => { const next = stepInList(ids, id, dir, locked); if (next) saveOrder(next); };
  const sel = guild.roles.find((r) => r.id === selected);
  if (sel) return <RoleEditor guild={guild} role={sel} perms={perms} canEdit={guild.ownerId === me?.userId || sel.position < myTop || sel.id === guild.id} onBack={() => { if (!refuseIfUnsaved()) setSelected(null); }} roles={roles} onSelect={(id) => { if (!refuseIfUnsaved()) setSelected(id); }} />;
  return (
    <>
      <h2>Roles</h2>
      <p className="muted">Use roles to group your server members and assign permissions. Roles higher in the list override lower ones; members see the color of their highest role. Drag a role by its handle to move it.</p>
      <button className="role-default-card" onClick={() => setSelected(everyone.id)}>
        <Icon name="friends" size={24} /><div className="grow left"><b>Default Permissions</b><div className="muted small">@everyone · applies to all server members</div></div><Icon name="chevronRight" />
      </button>
      <div className="row gap mb">
        <input className="input grow" placeholder="Search Roles" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={create}>Create Role</Button>
      </div>
      <div className="roles-table">
        <div className="roles-head"><span>Roles — {others.length}</span><span>Members</span><span /></div>
        <div ref={listRef} className="roles-list">
          {others.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase())).map((r, i) => {
            const fixed = i < locked;
            return (
              <div key={r.id} data-list-row="" data-id={r.id} className={cx('roles-row', view?.id === r.id && 'dragging', fixed && 'fixed')} onClick={() => setSelected(r.id)}>
                <span className="row-center">
                  {searching ? null : fixed
                    ? <span className="role-grip locked" data-tooltip="Above your highest role, so you can't move it" aria-label={`${r.name} is above your highest role`}><Icon name="lock" size={16} /></span>
                    : <span className="role-grip" role="button" aria-label={`Drag to move ${r.name}`} {...handleProps(r.id)}><Icon name="menu" size={18} /></span>}
                  <Icon name="shield" size={18} style={{ color: r.color ? intToHex(r.color) : 'var(--text-muted)' }} /><b>{r.name}</b>
                </span>
                <span className="muted">{memberCounts[r.id] || 0} <Icon name="user" size={14} /></span>
                <span className="row-center" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn small" aria-label="Move up" disabled={searching || !stepInList(ids, r.id, -1, locked)} onClick={() => move(r.id, -1)}><Icon name="chevronDown" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
                  <button className="icon-btn small" aria-label="Move down" disabled={searching || !stepInList(ids, r.id, 1, locked)} onClick={() => move(r.id, 1)}><Icon name="chevronDown" size={16} /></button>
                  <button className="icon-btn small" aria-label="Edit role" onClick={() => setSelected(r.id)}><Icon name="edit" size={16} /></button>
                </span>
              </div>
            );
          })}
          {view?.marker && <div className="reorder-line" style={{ top: view.marker.top }} />}
        </div>
        {!others.length && <p className="muted small pad">No roles yet. Create one to give members special permissions or colors.</p>}
      </div>
      {view && createPortal(<div ref={ghostRef} className="reorder-ghost" style={{ left: view.x / pageZoom() + 12, top: view.y / pageZoom() + 8 }}><Icon name="shield" size={16} /><span className="truncate">{byId[view.id]?.name}</span></div>, document.body)}
    </>
  );
}

function RoleEditor({ guild, role, perms, canEdit, onBack, roles, onSelect }) {
  const isEveryone = role.id === guild.id;
  const fromRole = { name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions };
  // What the server answered when the role was last saved. It is the saved state until the store has the new role too, so the
  // "unsaved changes" bar goes away the moment saving works instead of waiting for the update to come back.
  const [saved, setSaved] = useState(null);
  const initial = saved && saved.id === role.id ? saved.v : fromRole;
  const [d, setD] = useState(initial);
  const [tab, setTab] = useState(isEveryone ? 'permissions' : 'display');
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { setD({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions }); setTab(isEveryone ? 'permissions' : 'display'); }, [role.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSaved(null); }, [role]);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const isAdminActor = has(perms, P.ADMINISTRATOR);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.patch(`/guilds/${guild.id}/roles/${role.id}`, isEveryone ? { permissions: d.permissions } : d);
      const fresh = { name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions };
      setSaved({ id: role.id, v: fresh }); setD(fresh);
      toast('Role saved', 'success', 1500);
    } catch (e) { toastError(e); } finally { setSaving(false); }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: `Delete ${role.name}`, body: 'Are you sure you want to delete this role? Members with it will lose its permissions.', confirmText: 'Delete', danger: true }))) return;
    try { await api.del(`/guilds/${guild.id}/roles/${role.id}`); onBack(); } catch (e) { toastError(e); }
  };
  return (
    <div className="role-editor">
      <div className="role-side">
        <button className="link-btn row-center" onClick={onBack}><Icon name="arrowLeft" size={16} /> Back</button>
        {roles.map((r) => (
          <button key={r.id} className={cx('role-side-item', r.id === role.id && 'active')} onClick={() => onSelect(r.id)}>
            <span className="role-dot" style={{ background: r.color ? intToHex(r.color) : 'var(--text-muted)' }} /><span className="truncate">{r.name}</span>
          </button>
        ))}
      </div>
      <div className="role-main">
        <div className="row-between"><h2>Edit Role — {role.name}</h2>{!isEveryone && canEdit && <button className="icon-btn danger" aria-label="Delete role" data-tooltip="Delete Role" onClick={del}><Icon name="trash" /></button>}</div>
        {!canEdit && <div className="notice warn">You can only edit roles below your highest role.</div>}
        <Tabs value={tab} onChange={setTab} tabs={[...(isEveryone ? [] : [{ value: 'display', label: 'Display' }]), { value: 'permissions', label: 'Permissions' }, ...(isEveryone ? [] : [{ value: 'members', label: 'Manage Members' }])]} />
        <fieldset disabled={!canEdit} className="plain-fieldset">
          {tab === 'display' && (
            <>
              <Field label="Role Name" required><input className="input" maxLength={100} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <Field label="Role Color" hint="Members use the color of the highest role they have.">
                <div className="color-grid">
                  <button className={cx('color-swatch default', d.color === 0 && 'active')} onClick={() => setD({ ...d, color: 0 })} aria-label="Default color" />
                  <label className="color-swatch custom" style={{ background: d.color ? intToHex(d.color) : undefined }}><input type="color" value={intToHex(d.color || 0x99aab5)} onChange={(e) => setD({ ...d, color: hexToInt(e.target.value) })} /><Icon name="edit" size={14} /></label>
                  {ROLE_COLORS.map((c) => <button key={c} className={cx('color-swatch', d.color === c && 'active')} style={{ background: intToHex(c) }} onClick={() => setD({ ...d, color: c })} aria-label={intToHex(c)} />)}
                </div>
              </Field>
              <ToggleSetting title="Display role members separately from online members" checked={d.hoist} onChange={(v) => setD({ ...d, hoist: v })} />
              <ToggleSetting title="Allow anyone to @mention this role" description="Members with “Mention @everyone” can always ping all roles." checked={d.mentionable} onChange={(v) => setD({ ...d, mentionable: v })} />
            </>
          )}
          {tab === 'permissions' && (
            <>
              <div className="row gap mb"><input className="input grow" placeholder="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} />
                <Button variant="link" onClick={() => setD({ ...d, permissions: 0 })}>Clear permissions</Button></div>
              {PERMISSION_INFO.map((g) => {
                const items = g.items.filter(([, label, desc]) => !q || label.toLowerCase().includes(q.toLowerCase()) || desc.toLowerCase().includes(q.toLowerCase()));
                if (!items.length) return null;
                return (
                  <div key={g.group} className="settings-section">
                    <h3>{g.group}</h3>
                    {items.map(([key, label, desc]) => {
                      const flag = P[key];
                      const on = has(d.permissions, flag);
                      const cantGrant = !isAdminActor && guild.ownerId !== store.get().me.id && !has(perms, flag);
                      return <ToggleSetting key={key} title={label} description={desc} checked={on} disabled={cantGrant && !on}
                        onChange={(v) => setD({ ...d, permissions: v ? d.permissions | flag : d.permissions & ~flag & ALL_PERMISSIONS })} />;
                    })}
                  </div>
                );
              })}
            </>
          )}
          {tab === 'members' && <RoleMembers guild={guild} role={role} />}
        </fieldset>
      </div>
      <SaveBar show={dirty && canEdit} saving={saving} onReset={() => setD(initial)} onSave={save} />
    </div>
  );
}

function RoleMembers({ guild, role }) {
  const members = useStore((s) => Object.values(s.members[guild.id] || {}));
  const [q, setQ] = useState('');
  const withRole = members.filter((m) => m.roles.includes(role.id));
  const s = store.get();
  const setRoles = (m, roles) => api.patch(`/guilds/${guild.id}/members/${m.userId}`, { roles }).catch(toastError);
  const add = () => openModal(({ close }) => {
    function Body() {
      const [sel, setSel] = useState([]);
      const [search, setSearch] = useState('');
      const candidates = members.filter((m) => !m.roles.includes(role.id) && (!search || displayName(s, m.userId, guild.id).toLowerCase().includes(search.toLowerCase())));
      return (
        <Modal title="Add Members" subtitle={role.name} onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button disabled={!sel.length} onClick={async () => { for (const id of sel) { const m = store.get().members[guild.id][id]; await setRoles(m, [...m.roles, role.id]); } close(); }}>Add</Button></>}>
          <input className="input mb" autoFocus placeholder="Search members" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="select-list">{candidates.map((m) => (
            <label key={m.userId} className={cx('select-item', sel.includes(m.userId) && 'selected')}>
              <Avatar userId={m.userId} guildId={guild.id} size={28} /><span className="grow">{displayName(s, m.userId, guild.id)}</span>
              <input type="checkbox" checked={sel.includes(m.userId)} onChange={(e) => setSel(e.target.checked ? [...sel, m.userId] : sel.filter((x) => x !== m.userId))} />
            </label>
          ))}</div>
        </Modal>
      );
    }
    return <Body />;
  });
  return (
    <>
      <div className="row gap mb"><input className="input grow" placeholder="Search Members" value={q} onChange={(e) => setQ(e.target.value)} /><Button onClick={add}>Add Members</Button></div>
      {withRole.filter((m) => !q || displayName(s, m.userId, guild.id).toLowerCase().includes(q.toLowerCase())).map((m) => (
        <div key={m.userId} className="list-row static">
          <Avatar userId={m.userId} size={32} /><span className="grow">{displayName(s, m.userId, guild.id)} <span className="muted small">{s.users[m.userId]?.username}</span></span>
          <button className="icon-btn small" aria-label="Remove role" onClick={() => setRoles(m, m.roles.filter((r) => r !== role.id))}><Icon name="x" size={16} /></button>
        </div>
      ))}
      {!withRole.length && <p className="muted small">No members have this role yet.</p>}
    </>
  );
}

// ---------------------------------------------------------------- emoji
function EmojiTab({ guild }) {
  const [uploading, setUploading] = useState(false);
  const upload = async () => {
    const files = await pickFile('image/png,image/jpeg,image/gif,image/webp', true);
    if (!files?.length) return;
    setUploading(true);
    for (const f of files) {
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32).padEnd(2, '_');
      try { await api.post(`/guilds/${guild.id}/emojis?name=${encodeURIComponent(name)}`, f); }
      catch (e) { toastError(e); }
    }
    setUploading(false);
  };
  const rename = async (e, name) => {
    if (name === e.name) return;
    try { await api.patch(`/guilds/${guild.id}/emojis/${e.id}`, { name }); } catch (err) { toastError(err); }
  };
  const emojis = guild.emojis || [];
  return (
    <>
      <h2>Emoji</h2>
      <p className="muted">Add up to 100 custom emoji that anyone can use in this server. Animated GIFs work too. Emoji must be under 512 KB; names must be at least 2 characters (letters, numbers, underscores).</p>
      <Button loading={uploading} onClick={upload}>Upload Emoji</Button>
      <div className="settings-section">
        <h3>Emoji — {emojis.length} / 100</h3>
        {!emojis.length ? <EmptyState icon="smile">No custom emoji yet.</EmptyState> : (
          <div className="emoji-table">
            {emojis.map((e) => (
              <div key={e.id} className="emoji-row">
                <img src={e.url} alt={e.name} />
                <input className="input" defaultValue={e.name} maxLength={32} onBlur={(ev) => rename(e, ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()} />
                <button className="icon-btn danger" aria-label="Delete emoji" onClick={async () => { if (await confirmDialog({ title: `Delete :${e.name}:?`, body: 'This emoji will be removed from the server.', confirmText: 'Delete', danger: true })) api.del(`/guilds/${guild.id}/emojis/${e.id}`).catch(toastError); }}><Icon name="trash" size={18} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- moderation & automod
const TIMEOUT_PRESETS = [[600, '10 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day'], [604800, '1 week']];
/** Raid protection: stop new people joining, by hand or automatically when lots join at once (server/src/lib/raid.js). */
function NewMembersSection({ guild }) {
  const s = guild.safety || {};
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(String(s.raidThreshold || 10));
  const [, tick] = useState(0);
  useEffect(() => { setN(String(s.raidThreshold || 10)); }, [s.raidThreshold]);
  // an automatic pause ends by itself: redraw when it does
  useEffect(() => {
    const ms = (s.raidUntil || 0) - Date.now();
    if (ms <= 0) return undefined;
    const t = setTimeout(() => tick((x) => x + 1), Math.min(ms + 500, 2_000_000_000));
    return () => clearTimeout(t);
  }, [s.raidUntil]);
  const raidActive = (s.raidUntil || 0) > Date.now();
  const patch = async (body) => { setBusy(true); try { await api.patch(`/guilds/${guild.id}/safety`, body); } catch (e) { toastError(e); setN(String(s.raidThreshold || 10)); } finally { setBusy(false); } };
  const commit = () => {
    const v = Number.parseInt(n, 10);
    if (!Number.isFinite(v) || v < 3 || v > 100) { toast('Pick a number from 3 to 100.', 'error', 3000); setN(String(s.raidThreshold || 10)); return; }
    if (v !== (s.raidThreshold || 10)) patch({ raidThreshold: v });
  };
  return (
    <div className="settings-section new-members">
      <h3>New members</h3>
      {raidActive && (
        <div className="notice warn safety-banner" role="status">
          <div><b>Raid protection paused new members</b> until {new Date(s.raidUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, because a lot of people joined at once. Nobody new can join with an invite until then.</div>
          <Button size="sm" loading={busy} onClick={() => patch({ liftRaid: true })}>Let people join again</Button>
        </div>
      )}
      <ToggleSetting
        title="Pause new members"
        description="Nobody who isn’t in the server yet can join, with an invite or from Discover, until you turn this off. People already in the server are not affected."
        checked={!!s.invitesPaused} onChange={(v) => patch({ invitesPaused: v })} divider={false}
      />
      <ToggleSetting
        title="Raid protection"
        description="If a lot of people join within a minute, new members are paused for 10 minutes and everyone who manages this server is told right away. Turn it on if strangers keep flooding the server."
        checked={!!s.raidGuard} onChange={(v) => patch({ raidGuard: v })}
      />
      {s.raidGuard && (
        <div className="safety-threshold">
          <label htmlFor="raid-n" className="small">Pause when this many people join within a minute</label>
          <input id="raid-n" className="input" type="number" inputMode="numeric" min={3} max={100} value={n} disabled={busy}
            onChange={(e) => setN(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
        </div>
      )}
    </div>
  );
}

function ModerationTab({ guild }) {
  const set = (verificationLevel) => api.patch(`/guilds/${guild.id}`, { verificationLevel }).catch(toastError);
  return (
    <>
      <h2>Safety Setup</h2>
      <NewMembersSection guild={guild} />
      <div className="settings-section">
        <h3>Verification Level</h3>
        <p className="muted small">Members must meet these criteria before they can send messages in text channels or DM other members. Members with a role, or who can manage the server, skip this.</p>
        <RadioGroup value={guild.verificationLevel} onChange={set} options={[
          { value: 0, label: 'None', description: 'Unrestricted' },
          { value: 2, label: 'Medium', description: 'Must be registered on NullChat for longer than 5 minutes.' },
          { value: 3, label: 'High', description: 'Must also be a member of this server for longer than 10 minutes.' },
        ]} />
      </div>
      <div className="settings-section">
        <h3>Other tools</h3>
        <p className="muted small">• Slowmode is set per channel (Edit Channel → Overview).<br />• Right-click a member to <b>timeout</b>, <b>kick</b> or <b>ban</b> them.<br />• Configure automatic filtering in <b>AutoMod</b>.<br />• Every moderation action is recorded in the <b>Audit Log</b>.</p>
      </div>
    </>
  );
}

function AutoModTab({ guild }) {
  const am = guild.automod || {};
  const initial = { blockedWords: (am.blockedWords || []).join('\n'), blockInvites: !!am.blockInvites, blockLinks: !!am.blockLinks, mentionLimit: am.mentionLimit ?? 20, timeoutOnMentionSpam: !!am.timeoutOnMentionSpam, spamFilter: am.spamFilter !== false, warnLimit: am.warnLimit || 0, warnTimeout: am.warnTimeout || 3600, mentionTimeout: am.mentionTimeout || 600, exemptRoles: am.exemptRoles || [] };
  const [d, setD] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const roles = guild.roles.filter((r) => r.id !== guild.id);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/guilds/${guild.id}`, { automod: { ...d, blockedWords: d.blockedWords.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean).slice(0, 200) } });
      toast('AutoMod saved', 'success', 1500);
    } catch (e) { toastError(e); } finally { setSaving(false); }
  };
  return (
    <>
      <h2>AutoMod</h2>
      <p className="muted">AutoMod automatically blocks messages before they’re sent. Members who can manage the server are never filtered. Every block is logged in the Audit Log.</p>
      <div className="automod-card">
        <h3><Icon name="shield" size={18} /> Block Custom Words</h3>
        <p className="muted small">One word or phrase per line (or comma separated). Use * as a wildcard, e.g. <code>bad*</code>.</p>
        <textarea className="input mono" rows={5} value={d.blockedWords} onChange={(e) => setD({ ...d, blockedWords: e.target.value })} placeholder={'word\nanother phrase\nprefix*'} />
      </div>
      <div className="automod-card">
        <ToggleSetting title="Block spam" description="Blocks the same message being sent repeatedly in a short time." checked={d.spamFilter} onChange={(v) => setD({ ...d, spamFilter: v })} divider={false} />
        <ToggleSetting title="Block invite links" description="Blocks invite links to other communities." checked={d.blockInvites} onChange={(v) => setD({ ...d, blockInvites: v })} />
        <ToggleSetting title="Block all links" checked={d.blockLinks} onChange={(v) => setD({ ...d, blockLinks: v })} />
      </div>
      <div className="automod-card">
        <h3>Mention Spam</h3>
        <p className="muted small">Block messages with more than this many unique mentions (0 = off).</p>
        <Slider value={d.mentionLimit} min={0} max={50} onChange={(v) => setD({ ...d, mentionLimit: v })} />
        <ToggleSetting title="Also time out the member" description={`For ${spellDuration(d.mentionTimeout)}.`} checked={d.timeoutOnMentionSpam} onChange={(v) => setD({ ...d, timeoutOnMentionSpam: v })} />
        {d.timeoutOnMentionSpam && <DurationPicker value={d.mentionTimeout} onChange={(v) => setD({ ...d, mentionTimeout: v })} presets={TIMEOUT_PRESETS} />}
      </div>
      <div className="automod-card" data-warn-settings>
        <h3><Icon name="shield" size={18} /> Warnings</h3>
        <p className="muted small">Moderators can warn a member (right-click the member → Warn). Time a member out automatically when they reach this many warnings within 30 days (0 = never).</p>
        <Slider value={d.warnLimit} min={0} max={10} onChange={(v) => setD({ ...d, warnLimit: v })} />
        {d.warnLimit > 0 && (
          <>
            <p className="muted small">Time them out for</p>
            <DurationPicker value={d.warnTimeout} onChange={(v) => setD({ ...d, warnTimeout: v })} presets={TIMEOUT_PRESETS} />
          </>
        )}
      </div>
      <div className="automod-card">
        <h3>Exempt Roles</h3>
        {!roles.length ? <p className="muted small">No roles yet.</p> : (
          <div className="chip-row">{roles.map((r) => (
            <button key={r.id} className={cx('chip', d.exemptRoles.includes(r.id) && 'active')} onClick={() => setD({ ...d, exemptRoles: d.exemptRoles.includes(r.id) ? d.exemptRoles.filter((x) => x !== r.id) : [...d.exemptRoles, r.id] })}>
              <span className="role-dot" style={{ background: r.color ? intToHex(r.color) : 'var(--text-muted)' }} /> {r.name}
            </button>
          ))}</div>
        )}
      </div>
      <SaveBar show={dirty} saving={saving} onReset={() => setD(initial)} onSave={save} />
    </>
  );
}

// ---------------------------------------------------------------- audit log
const ACTION_LABELS = {
  GUILD_UPDATE: 'updated the server', GUILD_SAFETY: 'changed who can join', GUILD_TAG: 'changed the server tag', RAID_GUARD: 'paused new members after a rush of joins', GUILD_OWNER_TRANSFER: 'transferred ownership to', CHANNEL_CREATE: 'created a channel', CHANNEL_UPDATE: 'updated a channel',
  CHANNEL_DELETE: 'deleted a channel', CHANNEL_REORDER: 'reordered channels', CHANNEL_OVERWRITE_UPDATE: 'updated channel permissions', CHANNEL_OVERWRITE_DELETE: 'removed channel permissions',
  BOT_ADD: 'added the bot', BOT_UPDATE: 'updated the bot', BOT_REMOVE: 'removed the bot', BOT_TOKEN_RESET: 'reset the token of the bot', BOT_COMMAND_DELETE: 'deleted a slash command of the bot',
  WEBHOOK_CREATE: 'created the webhook', WEBHOOK_UPDATE: 'changed the webhook', WEBHOOK_DELETE: 'deleted the webhook', WEBHOOK_TOKEN_RESET: 'reset the address of the webhook',
  TEMPLATE_CREATE: 'created the server template', TEMPLATE_UPDATE: 'changed the server template', TEMPLATE_SYNC: 'synced the server template', TEMPLATE_DELETE: 'deleted the server template',
  MEMBER_KICK: 'kicked', MEMBER_BAN_ADD: 'banned', MEMBER_BAN_REMOVE: 'unbanned', MEMBER_UPDATE: 'updated', MEMBER_ROLE_UPDATE: 'updated roles for',
  MEMBER_WARN: 'warned', MEMBER_WARN_REMOVE: 'removed a warning from', MEMBER_NOTE: 'wrote a moderator note about', MEMBER_TIMEOUT: 'timed out', MEMBER_TIMEOUT_REMOVE: 'removed the timeout for', MEMBER_VOICE_UPDATE: 'changed voice state of', MEMBER_DISCONNECT: 'disconnected', MEMBER_MOVE: 'moved',
  ROLE_CREATE: 'created a role', ROLE_UPDATE: 'updated a role', ROLE_DELETE: 'deleted a role', ROLE_REORDER: 'reordered roles', INVITE_CREATE: 'created an invite', INVITE_DELETE: 'deleted an invite',
  EMOJI_CREATE: 'added an emoji', EMOJI_UPDATE: 'renamed an emoji', EMOJI_DELETE: 'removed an emoji', STICKER_CREATE: 'added a sticker', STICKER_UPDATE: 'changed a sticker', STICKER_DELETE: 'removed a sticker', MESSAGE_DELETE: 'deleted a message by', MESSAGE_BULK_DELETE: 'bulk deleted messages',
  MESSAGE_PIN: 'pinned a message', MESSAGE_UNPIN: 'unpinned a message', THREAD_PIN: 'pinned a forum post', THREAD_UNPIN: 'unpinned a forum post', MESSAGE_PUBLISH: 'published an announcement',
  GUILD_VANITY: 'changed the server’s own invite link', CHANNEL_FOLLOW: 'started following an announcement channel in', CHANNEL_FOLLOWED: 'got a new follower on',
  CHANNEL_UNFOLLOW: 'stopped following an announcement channel in', CHANNEL_UNFOLLOWED: 'lost a follower on',
  REPORT_RESOLVE: 'resolved a report about', REPORT_DISMISS: 'dismissed a report about', REPORT_REOPEN: 'reopened a report about', AUTOMOD_BLOCK_MESSAGE: 'blocked a message from', THREAD_DELETE: 'deleted a thread',
};
function AuditTab({ guild }) {
  const [entries, setEntries] = useState(null);
  const [users, setUsers] = useState({});
  const [filter, setFilter] = useState({ action: '', userId: '' });
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState(null);
  const members = useStore((s) => Object.keys(s.members[guild.id] || {}).map((id) => ({ value: id, label: displayName(s, id, guild.id) })));
  const load = async (before) => {
    const q = new URLSearchParams();
    if (before) q.set('before', before);
    if (filter.action) q.set('action', filter.action);
    if (filter.userId) q.set('userId', filter.userId);
    try {
      const r = await api.get(`/guilds/${guild.id}/audit-logs?${q}`);
      setUsers((u) => ({ ...u, ...Object.fromEntries(r.users.map((x) => [x.id, x])) }));
      setEntries((e) => (before ? [...(e || []), ...r.entries] : r.entries));
      setMore(r.entries.length === 50);
    } catch (e) { toastError(e); }
  };
  useEffect(() => { setEntries(null); load(); }, [filter.action, filter.userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = store.get();
  const uname = (id, action) => (id ? users[id]?.displayName || users[id]?.username || s.users[id]?.username || 'Unknown' : action === 'RAID_GUARD' ? 'Raid protection' : 'AutoMod');
  const targetLabel = (e) => {
    if (e.targetType === 'user') return <b>{uname(e.targetId)}</b>;
    if (e.targetType === 'channel') return <b>{s.channels[e.targetId] ? `#${s.channels[e.targetId].name}` : e.changes?.name ? `#${e.changes.name}` : ''}</b>;
    if (e.targetType === 'role') return <b>{guild.roles.find((r) => r.id === e.targetId)?.name || e.changes?.name || ''}</b>;
    if (e.targetType === 'invite') return <code>{e.targetId}</code>;
    if (e.targetType === 'emoji') return <b>:{e.changes?.name}:</b>;
    if (e.targetType === 'sticker') return <b>{e.changes?.name}</b>;
    if (e.targetType === 'webhook') return <b>{e.changes?.name || 'a webhook'}</b>;
    if (e.targetType === 'template') return <b>{e.changes?.name || 'the template'}</b>;
    return null;
  };
  return (
    <>
      <h2>Audit Log</h2>
      <div className="row gap mb">
        <Select value={filter.userId} onChange={(v) => setFilter({ ...filter, userId: v })} options={[{ value: '', label: 'All Users' }, ...members]} />
        <Select value={filter.action} onChange={(v) => setFilter({ ...filter, action: v })} options={[{ value: '', label: 'All Actions' }, ...Object.keys(ACTION_LABELS).map((k) => ({ value: k, label: k.toLowerCase().replace(/_/g, ' ') }))]} />
      </div>
      {!entries ? <Spinner /> : !entries.length ? <EmptyState icon="clock">No logs yet. Moderation and settings changes will show up here.</EmptyState> : (
        <div className="audit-list">
          {entries.map((e) => (
            <div key={e.id} className={cx('audit-entry', open === e.id && 'open')} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <div className="audit-main">
                {e.userId ? <Avatar user={users[e.userId]} userId={e.userId} size={32} /> : <span className="automod-avatar"><Icon name="shield" size={18} /></span>}
                <div className="grow">
                  <div><b>{uname(e.userId, e.action)}</b> {ACTION_LABELS[e.action] || e.action} {targetLabel(e)}</div>
                  <div className="tiny muted">{formatTimestamp(e.createdAt)}</div>
                </div>
                {(e.changes || e.reason) && <Icon name={open === e.id ? 'chevronDown' : 'chevronRight'} size={16} />}
              </div>
              {open === e.id && (e.changes || e.reason) && (
                <div className="audit-details">
                  {e.reason && <div><span className="muted">Reason:</span> {e.reason}</div>}
                  {e.changes && Object.entries(e.changes).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> <code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code></div>)}
                </div>
              )}
            </div>
          ))}
          {more && <Button variant="secondary" onClick={() => load(entries[entries.length - 1]?.id)}>Load more</Button>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- bans
function BansTab({ guild }) {
  const [bans, setBans] = useState(null);
  const [q, setQ] = useState('');
  const load = () => api.get(`/guilds/${guild.id}/bans`).then(setBans).catch(toastError);
  useEffect(() => { load(); }, [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h2>Server Ban List</h2>
      <p className="muted">Bans are by account. Banned users can’t rejoin with invites.</p>
      <input className="input mb" placeholder="Search Bans by Username" value={q} onChange={(e) => setQ(e.target.value)} />
      {!bans ? <Spinner /> : !bans.length ? <EmptyState icon="hammer" title="No bans. Yet.">But if you need to, you can ban members from their right-click menu.</EmptyState> : bans
        .filter((b) => !q || b.user.username.includes(q.toLowerCase()))
        .map((b) => (
          <div key={b.user.id} className="list-row static">
            <Avatar user={b.user} size={32} />
            <div className="grow"><b>{b.user.displayName || b.user.username}</b> <span className="muted small">{b.user.username}</span><div className="tiny muted">{b.reason ? `Reason: ${b.reason}` : 'No reason given'} · {relativeTime(b.createdAt)}</div></div>
            <Button size="sm" variant="secondary" onClick={async () => { try { await api.del(`/guilds/${guild.id}/bans/${b.user.id}`); load(); } catch (e) { toastError(e); } }}>Revoke Ban</Button>
          </div>
        ))}
    </>
  );
}

// ---------------------------------------------------------------- members
function MembersTab({ guild }) {
  const members = useStore((s) => Object.values(s.members[guild.id] || {}));
  const canRemove = useStore((s) => { const p = guildPermissions(s, guild.id); return has(p, P.KICK_MEMBERS) || has(p, P.BAN_MEMBERS); });
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const s = store.get();
  const list = useMemo(() => members
    .filter((m) => (!roleFilter || m.roles.includes(roleFilter)) && (!q || displayName(s, m.userId, guild.id).toLowerCase().includes(q.toLowerCase()) || s.users[m.userId]?.username.includes(q.toLowerCase())))
    .sort((a, b) => a.joinedAt - b.joinedAt), [members, q, roleFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="members-title">
        <h2>Server Members</h2>
        {canRemove && <Button size="sm" variant="secondary" onClick={() => openBulkRemove(guild.id)}><Icon name="userMinus" size={16} /> Remove members…</Button>}
      </div>
      <div className="row gap mb">
        <input className="input grow" placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={roleFilter} onChange={setRoleFilter} options={[{ value: '', label: 'All roles' }, ...guild.roles.filter((r) => r.id !== guild.id).map((r) => ({ value: r.id, label: r.name }))]} />
      </div>
      <div className="members-table">
        <div className="members-head"><span>Name</span><span className="hide-sm">Member Since</span><span>Roles</span><span /></div>
        {list.map((m) => (
          <div key={m.userId} className="members-row" onContextMenu={(e) => openContextMenu(e, userMenuItems(m.userId, { guildId: guild.id }))}>
            <span className="row-center" onClick={(e) => openUserPopout(e.currentTarget, m.userId, guild.id)}>
              <Avatar userId={m.userId} guildId={guild.id} size={32} status />
              <span><b>{displayName(s, m.userId, guild.id)}</b>{guild.ownerId === m.userId && <Icon name="crown" size={14} className="owner-crown" />}<div className="tiny muted">{s.users[m.userId]?.username}</div></span>
            </span>
            <span className="small muted hide-sm">{formatDate(m.joinedAt)}</span>
            <span className="role-chips small">
              {guild.roles.filter((r) => m.roles.includes(r.id)).sort((a, b) => b.position - a.position).slice(0, 3).map((r) => <span key={r.id} className="role-chip"><span className="role-dot" style={{ background: r.color ? intToHex(r.color) : 'var(--text-muted)' }} />{r.name}</span>)}
              {m.roles.length > 3 && <span className="muted">+{m.roles.length - 3}</span>}
              {m.timeoutUntil && <span className="pill warn">Timed out</span>}
            </span>
            <button className="icon-btn small" aria-label="Member actions" onClick={(e) => openContextMenu(e, userMenuItems(m.userId, { guildId: guild.id }))}><Icon name="more" size={18} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- invites
function InvitesTab({ guild }) {
  const [invites, setInvites] = useState(null);
  const canVanity = useStore((s) => has(guildPermissions(s, guild.id), P.MANAGE_GUILD));
  const load = () => api.get(`/guilds/${guild.id}/invites`).then(setInvites).catch(toastError);
  useEffect(() => { load(); }, [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h2>Invites</h2>
      {canVanity && <VanityEditor guild={guild} uses={guild.vanityCode ? invites?.find((i) => i.code === guild.vanityCode)?.uses : undefined} />}
      <JoinSourcesPanel guildId={guild.id} />
      <p className="muted">Here’s a list of all active invite links. You can revoke any one.</p>
      {guild.safety?.paused && (
        <div className="notice warn">
          New members are paused{guild.safety.invitesPaused ? '' : ' by raid protection'}, so these links won’t work right now.{' '}
          <button type="button" className="link-btn" onClick={() => setUI({ settings: { type: 'guild', guildId: guild.id, tab: 'moderation' } })}>Change this in Safety Setup</button>
        </div>
      )}
      {!invites ? <Spinner /> : !invites.length ? <EmptyState icon="link">No invites yet. Create one from the server menu → Invite People.</EmptyState> : (
        <div className="invites-table">
          <div className="invites-head"><span>Inviter</span><span>Code</span><span>Uses</span><span className="hide-sm">Expires</span><span /></div>
          {invites.filter((i) => !i.expiresAt || i.expiresAt > Date.now()).map((i) => (
            <div key={i.code} className="invites-row">
              <span className="row-center"><Avatar user={i.inviter} size={24} /><span className="truncate">{i.inviter?.username || 'Unknown'}</span></span>
              <span><button className="link-btn mono" onClick={() => { copyText(inviteUrl(i.code)); toast('Invite link copied', 'success', 1500); }}>{i.code}</button>{i.vanity && <span className="pill vanity-pill">Server link</span>}<div className="tiny muted">#{i.channelName}</div></span>
              <span>{i.uses}{i.maxUses ? ` / ${i.maxUses}` : ''}</span>
              <span className="hide-sm small">{i.expiresAt ? relativeTime(i.expiresAt) : 'Never'}</span>
              <button className="icon-btn small danger" aria-label="Revoke invite" data-tooltip="Revoke" onClick={async () => { try { await api.del(`/invites/${i.code}`); load(); } catch (e) { toastError(e); } }}><Icon name="x" size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ================================================================ channel settings
export function ChannelSettings() {
  const { channelId, tab = 'overview' } = useUI((u) => u.settings);
  const channel = useStore((s) => s.channels[channelId]);
  const perms = useStore((s) => channelPermissions(s, channelId));
  useEffect(() => { if (!channel) closeSettings(true); }, [channel]);
  if (!channel) return null;
  const setTab = (x) => setUI({ settings: { type: 'channel', channelId, tab: x } });
  const isCat = channel.type === ChannelType.CATEGORY;
  const nav = (
    <>
      <div className="settings-nav-header truncate">{isCat ? channel.name : `${channel.type === ChannelType.VOICE ? '🔊' : channel.type === ChannelType.STAGE ? '🎙️' : channel.type === ChannelType.ANNOUNCEMENT ? '📣' : '#'} ${channel.name}`}</div>
      <NavItem active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</NavItem>
      {has(perms, P.MANAGE_ROLES) && <NavItem active={tab === 'permissions'} onClick={() => setTab('permissions')}>Permissions</NavItem>}
      <div className="settings-nav-sep" />
      <NavItem danger onClick={() => { if (closeSettings()) deleteChannel(channel.id); }}>Delete {isCat ? 'Category' : 'Channel'} <Icon name="trash" size={16} /></NavItem>
    </>
  );
  return (
    <SettingsLayout nav={nav} onClose={closeSettings}>
      {tab === 'permissions' && has(perms, P.MANAGE_ROLES) ? <ChannelPermissions key={channel.id} channel={channel} perms={perms} /> : <ChannelOverview channel={channel} />}
    </SettingsLayout>
  );
}

const SLOWMODES = [[0, 'Off'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [21600, '6h']];
function ChannelOverview({ channel }) {
  const categories = useStore((s) => (s.guildChannels[channel.guildId] || []).map((id) => s.channels[id]).filter((c) => c?.type === ChannelType.CATEGORY));
  const initial = { name: channel.name, topic: channel.topic || '', rateLimit: channel.rateLimit || 0, nsfw: !!channel.nsfw, userLimit: channel.userLimit || 0, bitrate: channel.bitrate || 64000, parentId: channel.parentId || '',
    tags: (channel.availableTags || []).map((t) => ({ id: t.id, name: t.name, emoji: t.emoji || null })), requireTag: !!channel.requireTag, forumSort: channel.forumSort || 0,
    announcement: channel.type === ChannelType.ANNOUNCEMENT };
  const [d, setD] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setD(initial); }, [channel.id, channel.type, channel.name, channel.topic, channel.rateLimit, channel.parentId, channel.availableTags, channel.requireTag, channel.forumSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const isForum = channel.type === ChannelType.FORUM;
  const isAnn = channel.type === ChannelType.ANNOUNCEMENT;
  const isText = channel.type === ChannelType.TEXT || isAnn; const isStage = channel.type === ChannelType.STAGE;
  const isVoice = channel.type === ChannelType.VOICE || isStage; const isCat = channel.type === ChannelType.CATEGORY;
  const save = async () => {
    setSaving(true);
    const body = { name: d.name };
    if (isText) Object.assign(body, { topic: d.topic, rateLimit: d.rateLimit, nsfw: d.nsfw });
    if (isText && d.announcement !== initial.announcement) body.announcement = d.announcement;
    if (isForum) Object.assign(body, {
      topic: d.topic, rateLimit: d.rateLimit, requireTag: d.requireTag, forumSort: d.forumSort,
      availableTags: d.tags.filter((t) => t.name.trim()).map((t) => ({ ...(t.id ? { id: t.id } : {}), name: t.name.trim(), emoji: t.emoji || null })),
    });
    if (isVoice) Object.assign(body, { userLimit: d.userLimit, bitrate: d.bitrate });
    if (!isCat && d.parentId !== initial.parentId) body.parentId = d.parentId || null;
    try { await api.patch(`/channels/${channel.id}`, body); toast('Channel saved', 'success', 1500); } catch (e) { toastError(e); } finally { setSaving(false); }
  };
  const slowIdx = Math.max(0, SLOWMODES.findIndex(([v]) => v === d.rateLimit));
  return (
    <>
      <h2>Overview</h2>
      <Field label={isCat ? 'Category Name' : 'Channel Name'}><input className="input" maxLength={100} value={d.name} onChange={(e) => setD({ ...d, name: isText || isForum ? e.target.value.toLowerCase().replace(/\s/g, '-') : e.target.value })} /></Field>
      {!isCat && <Field label="Category"><Select value={d.parentId} onChange={(v) => setD({ ...d, parentId: v })} options={[{ value: '', label: 'No category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} /></Field>}
      {isText && (
        <>
          <Field label="Channel Topic" hint="Let everyone know how to use this channel. Markdown works."><textarea className="input" rows={3} maxLength={1024} value={d.topic} onChange={(e) => setD({ ...d, topic: e.target.value })} /></Field>
          <div className="settings-section">
            <h3>Slowmode</h3>
            <Slider value={slowIdx} min={0} max={SLOWMODES.length - 1} onChange={(i) => setD({ ...d, rateLimit: SLOWMODES[i][0] })} format={(i) => SLOWMODES[i][1]} />
            <p className="tiny muted">Members will be restricted to sending one message per this interval, unless they have Manage Channel or Manage Messages.</p>
          </div>
          <ToggleSetting title="Age-Restricted Channel" description="Members will need to confirm they are over the legal age to view content in this channel." checked={d.nsfw} onChange={(v) => setD({ ...d, nsfw: v })} />
          <ToggleSetting title={<><Icon name="megaphone" size={16} /> Announcement channel</>} checked={d.announcement} onChange={(v) => setD({ ...d, announcement: v })}
            description={d.announcement !== initial.announcement && !d.announcement
              ? 'Servers that follow this channel stop getting its posts when you save. Posts they already have stay.'
              : 'People in other servers can follow this channel. Members with Manage Messages (and the author) press Publish on a post to send a copy to every follower.'} />
        </>
      )}
      {isForum && (
        <>
          <Field label="Post Guidelines" hint="Shown at the top of the forum, so people know what belongs here. Markdown works."><textarea className="input" rows={3} maxLength={1024} value={d.topic} onChange={(e) => setD({ ...d, topic: e.target.value })} /></Field>
          <div className="settings-section">
            <h3>Tags</h3>
            <p className="tiny muted">People choose up to 5 tags when they start a post, and anyone can filter the forum by tag. Examples: Question, Bug, Idea, Solved.</p>
            <TagsEditor value={d.tags} onChange={(tags) => setD({ ...d, tags })} />
          </div>
          <ToggleSetting title="Require a tag" description="Every new post must have at least one tag. (Does nothing while the forum has no tags.)" checked={d.requireTag} onChange={(v) => setD({ ...d, requireTag: v })} />
          <div className="settings-section">
            <h3>Default sort order</h3>
            <Select value={String(d.forumSort)} onChange={(v) => setD({ ...d, forumSort: Number(v) })} options={[{ value: '0', label: 'Recent activity' }, { value: '1', label: 'Newest posts' }]} />
            <p className="tiny muted">How posts are ordered when someone opens the forum. They can switch it themselves.</p>
          </div>
          <div className="settings-section">
            <h3>Slowmode</h3>
            <Slider value={slowIdx} min={0} max={SLOWMODES.length - 1} onChange={(i) => setD({ ...d, rateLimit: SLOWMODES[i][0] })} format={(i) => SLOWMODES[i][1]} />
            <p className="tiny muted">Members can start one post per this interval, unless they have Manage Channel, Manage Messages or Manage Threads. To make a forum read-only, turn off Create Threads for @everyone in Permissions.</p>
          </div>
        </>
      )}
      {isVoice && (
        <>
          <div className="settings-section"><h3>Bitrate</h3><Slider value={d.bitrate / 1000} min={8} max={384} onChange={(v) => setD({ ...d, bitrate: v * 1000 })} format={(v) => `${v}kbps`} /></div>
          <div className="settings-section"><h3>{isStage ? 'Audience limit' : 'User Limit'}</h3>
            <Slider value={d.userLimit} min={0} max={99} onChange={(v) => setD({ ...d, userLimit: v })} format={(v) => (v ? `${v} people` : isStage ? '50 (default)' : '∞')} />
            <p className="tiny muted">{isStage
              ? 'The most people who can be on the stage at once, speakers included. Audio goes straight from each speaker to each listener, so a very large stage needs the speakers to have a fast connection.'
              : 'Limits the number of users that can connect. Members with Move Members can bypass it.'}</p></div>
        </>
      )}
      {isText && <FollowsPanel channel={channel} />}
      <SaveBar show={dirty} saving={saving} onReset={() => setD(initial)} onSave={save} />
    </>
  );
}

// A list of permission overwrites [{ id, type, allow, deny }] compared without caring about order, and without counting an
// @everyone overwrite that allows and denies nothing (that is the same as having none).
const NO_OVERWRITES = [];
function sameOverwrites(a, b, everyoneId) {
  const norm = (list) => list.filter((o) => !(o.id === everyoneId && !o.allow && !o.deny)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const x = norm([...a]), y = norm([...b]);
  return x.length === y.length && x.every((o, i) => o.id === y[i].id && o.type === y[i].type && o.allow === y[i].allow && o.deny === y[i].deny);
}

function ChannelPermissions({ channel, perms }) {
  const guild = useStore((s) => s.guilds[channel.guildId]);
  const parent = useStore((s) => (channel.parentId ? s.channels[channel.parentId] : null));
  const [selected, setSelected] = useState(channel.guildId);
  const [q, setQ] = useState('');
  // Nothing is sent until Save: the changes are kept here, on top of what is saved.
  const [edits, setEdits] = useState({});       // targetId -> { type, allow, deny } for each role/member changed or added
  const [removed, setRemoved] = useState([]);   // targetIds whose overwrite is to be deleted
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(null); // the list the server answered with, standing in for the saved state until the store has it too
  const stored = channel.overwrites || NO_OVERWRITES;
  useEffect(() => { setJustSaved(null); }, [stored]);
  const base = justSaved || stored;
  const ow = useMemo(() => {
    const m = new Map(base.map((o) => [o.id, o]));
    for (const id of removed) m.delete(id);
    for (const [id, v] of Object.entries(edits)) if (!removed.includes(id)) m.set(id, { id, ...v });
    return [...m.values()];
  }, [base, edits, removed]);
  const dirty = !sameOverwrites(ow, base, guild.id);
  const reset = () => { setEdits({}); setRemoved([]); };

  const synced = parent && sameOverwrites(base, parent.overwrites || [], null);
  const targets = [
    ...guild.roles.filter((r) => r.id === guild.id || ow.some((o) => o.id === r.id)).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, type: 0, name: r.id === guild.id ? '@everyone' : r.name, color: r.color })),
    ...ow.filter((o) => o.type === 1).map((o) => ({ id: o.id, type: 1, name: displayName(store.get(), o.id, guild.id) })),
  ];
  const current = ow.find((o) => o.id === selected) || { allow: 0, deny: 0 };
  const target = targets.find((t) => t.id === selected) || targets[0];
  const setPerm = (flag, state) => {
    let { allow, deny } = current;
    allow &= ~flag; deny &= ~flag;
    if (state === 'allow') allow |= flag;
    if (state === 'deny') deny |= flag;
    setEdits((e) => ({ ...e, [target.id]: { type: target.type, allow, deny } }));
  };
  const add = (id, type) => {
    setRemoved((r) => r.filter((x) => x !== id));
    setEdits((e) => ({ ...e, [id]: { type, allow: 0, deny: 0 } }));
    setSelected(id);
  };
  const addTarget = (e) => {
    const s = store.get();
    const roleItems = guild.roles.filter((r) => r.id !== guild.id && !ow.some((o) => o.id === r.id)).map((r) => ({ label: `@${r.name}`, onClick: () => add(r.id, 0) }));
    const memberItems = Object.keys(s.members[guild.id] || {}).filter((id) => !ow.some((o) => o.id === id)).slice(0, 30).map((id) => ({ label: displayName(s, id, guild.id), onClick: () => add(id, 1) }));
    openContextMenu(e, [{ label: 'Roles', items: roleItems.length ? roleItems : [{ label: 'No more roles', disabled: true }] }, { label: 'Members', items: memberItems.length ? memberItems : [{ label: 'No more members', disabled: true }] }]);
  };
  const removeTarget = () => {
    setRemoved((r) => [...r, target.id]);
    setEdits((e) => { const next = { ...e }; delete next[target.id]; return next; });
    setSelected(guild.id);
  };
  const setPrivate = (v) => {
    const e = ow.find((o) => o.id === guild.id) || { allow: 0, deny: 0 };
    setEdits((all) => ({ ...all, [guild.id]: { type: 0, allow: v ? e.allow & ~P.VIEW_CHANNEL : e.allow, deny: v ? e.deny | P.VIEW_CHANNEL : e.deny & ~P.VIEW_CHANNEL } }));
  };

  const save = async () => {
    setSaving(true);
    const work = new Map(base.map((o) => [o.id, o]));   // the saved state as it stands after each step
    const want = new Map(ow.map((o) => [o.id, o]));
    let last = null, failed = false;
    try {
      for (const [id, o] of want) {
        const was = work.get(id);
        if (was && was.type === o.type && was.allow === o.allow && was.deny === o.deny) continue;
        if (!was && id === guild.id && !o.allow && !o.deny) continue;
        last = await api.put(`/channels/${channel.id}/permissions/${id}`, { type: o.type, allow: o.allow, deny: o.deny });
        work.set(id, { id, type: o.type, allow: o.allow & ~o.deny, deny: o.deny });
      }
      for (const id of [...work.keys()]) {
        if (want.has(id)) continue;
        last = await api.del(`/channels/${channel.id}/permissions/${id}`);
        work.delete(id);
      }
    } catch (e) { failed = true; toastError(e); }
    // Whatever got through is now the saved state; if something failed, the rest stays as unsaved changes.
    setJustSaved(last?.overwrites || [...work.values()]);
    if (!failed) { reset(); toast('Permissions saved', 'success', 1500); }
    setSaving(false);
  };

  const isVoice = channel.type === ChannelType.VOICE || channel.type === ChannelType.STAGE;
  const groups = PERMISSION_INFO.filter((g) => g.group !== 'Advanced' && (isVoice ? g.group !== 'Text Channels' : g.group !== 'Voice Channels'))
    .map((g) => ({ ...g, items: g.items.filter(([k]) => !['MANAGE_GUILD', 'VIEW_AUDIT_LOG', 'MANAGE_EMOJIS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'MODERATE_MEMBERS'].includes(k)) }));
  const isPrivate = has(ow.find((o) => o.id === guild.id)?.deny || 0, P.VIEW_CHANNEL);
  return (
    <>
      <h2>Channel Permissions</h2>
      {parent && (
        <div className={cx('notice row-between', synced ? 'success' : 'warn')}>
          <span>{synced ? <>Permissions synced with category: <b>{parent.name}</b></> : <>Permissions not synced with category: <b>{parent.name}</b></>}</span>
          {!synced && <Button size="sm" disabled={dirty || saving} data-tooltip={dirty ? 'Save or reset your changes first' : undefined}
            onClick={async () => { try { await api.patch(`/channels/${channel.id}`, { syncPermissions: true }); toast('Synced with the category', 'success', 1500); } catch (e) { toastError(e); } }}>Sync Now</Button>}
        </div>
      )}
      <ToggleSetting title={<><Icon name="lock" size={16} /> Private {channel.type === ChannelType.CATEGORY ? 'Category' : 'Channel'}</>} description="Only members and roles you add below will be able to view it."
        checked={isPrivate} onChange={setPrivate} />
      <div className="perm-editor">
        <div className="perm-targets">
          <div className="row-between"><span className="field-label">Roles / Members</span><button className="icon-btn small" aria-label="Add role or member" onClick={addTarget}><Icon name="plus" size={16} /></button></div>
          {targets.map((t) => (
            <button key={t.id} className={cx('perm-target', selected === t.id && 'active')} onClick={() => setSelected(t.id)}>
              {t.type === 1 ? <Avatar userId={t.id} size={18} /> : <span className="role-dot" style={{ background: t.color ? intToHex(t.color) : 'var(--text-muted)' }} />}
              <span className="truncate">{t.name}</span>
            </button>
          ))}
        </div>
        <div className="perm-list">
          <div className="row gap mb">
            <input className="input grow" placeholder="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} />
            {target && target.id !== guild.id && <Button variant="link" onClick={removeTarget}>Remove</Button>}
          </div>
          {groups.map((g) => {
            const items = g.items.filter(([, l]) => !q || l.toLowerCase().includes(q.toLowerCase()));
            if (!items.length) return null;
            return (
              <div key={g.group} className="settings-section">
                <h3>{g.group}</h3>
                {items.map(([key, label, desc]) => {
                  const flag = P[key];
                  const state = has(current.allow, flag) ? 'allow' : has(current.deny, flag) ? 'deny' : 'inherit';
                  const cannot = !has(perms, flag) && guild.ownerId !== store.get().me.id;
                  return (
                    <div key={key} className="perm-row">
                      <div className="grow"><div>{label}</div><div className="tiny muted">{desc}</div></div>
                      <div className={cx('tristate', cannot && 'disabled')} role="radiogroup" aria-label={label}>
                        <button className={cx('deny', state === 'deny' && 'on')} disabled={cannot} onClick={() => setPerm(flag, 'deny')} aria-label="Deny"><Icon name="x" size={14} strokeWidth={3} /></button>
                        <button className={cx('inherit', state === 'inherit' && 'on')} disabled={cannot} onClick={() => setPerm(flag, 'inherit')} aria-label="Inherit">/</button>
                        <button className={cx('allow', state === 'allow' && 'on')} disabled={cannot} onClick={() => setPerm(flag, 'allow')} aria-label="Allow"><Icon name="check" size={14} strokeWidth={3} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <SaveBar show={dirty} saving={saving} onReset={reset} onSave={save} />
    </>
  );
}

export { Switch };
