// Server Settings → Integrations: add bots (accounts with a token that programs use, with slash commands) and webhooks (an address that posts into one channel).
import { useEffect, useState } from 'react';
import { useStore } from '../lib/state.js';
import { navigate } from '../lib/router.jsx';
import { closeSettings } from '../lib/ui.js';
import { api, putImage } from '../lib/api.js';
import { on } from '../lib/gateway.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, copyText } from '../lib/utils.js';
import { Button, Field, Modal, openModal, RadioGroup, Avatar, pickFile, Spinner, confirmDialog, EmptyState, Select } from './ui.jsx';
import { Icon } from './icons.jsx';

export const PRESETS = [
  { value: 'basic', label: 'Chat only', description: 'Read and send messages, add reactions, attach files and embeds. Good for most bots.' },
  { value: 'moderator', label: 'Moderator', description: 'Everything above, plus delete messages, manage threads, time out, kick and ban people.' },
  { value: 'admin', label: 'Administrator', description: 'Can do anything in this server. Only give this to a bot you wrote or fully trust.' },
];
/** Who may add an app to their servers (set by the person who made it). */
export const VISIBILITIES = [
  { value: 'private', label: 'Private', description: 'Only you can add it to a server.' },
  { value: 'link', label: 'Anyone with the link', description: 'It isn’t listed anywhere, but anyone you send its link to can add it to a server they manage.' },
  { value: 'listed', label: 'Listed in the App Directory', description: 'Anyone can find it under Discover → Apps and add it. Needs a description so people know what it does.' },
];
export const visibilityLabel = (v) => VISIBILITIES.find((x) => x.value === v)?.label || v;

export function IntegrationsTab({ guild }) {
  return (
    <>
      <h2>Integrations</h2>
      <p className="muted">
        A <b>bot</b> is a member with its own login token: it can read messages, answer slash commands and post rich cards. Bots are programs you or someone you trust runs.
      </p>
      <div className="notice">
        Bots here are built for NullChat. Bots hosted by Discord (MEE6, Dyno and so on) can’t be invited, because they only speak Discord’s own service — but a bot written for Discord’s API
        is usually a small change to move over. The setup guide in the project folder explains how, and includes an example bot.
        Looking for one that already exists? <b>Browse Apps</b> lists the ones its makers have shared. Building one? <b>User Settings → Developer Portal</b> shows every app you made in one place, with a live log of what each is asked to do.
      </div>
      <BotsPanel guild={guild} />
      <WebhooksPanel guild={guild} />
    </>
  );
}

// ---------------------------------------------------------------- bots
function BotsPanel({ guild }) {
  const [bots, setBots] = useState(null);
  const load = () => api.get(`/guilds/${guild.id}/bots`).then(setBots).catch((e) => { toastError(e); setBots([]); });
  useEffect(() => { setBots(null); load(); }, [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // a bot registering or changing its slash commands updates the count shown on its card
  useEffect(() => on('COMMANDS_UPDATE', (d) => { if (d.guildId === guild.id) load(); }), [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (b) => setBots((list) => (list || []).map((x) => (x.id === b.id ? b : x)));
  const add = () => openModal(({ close }) => (
    <CreateBotModal guild={guild} close={close} onCreated={(b, token) => { setBots((l) => [...(l || []), b]); close(); showToken({ title: `${b.user.displayName || b.user.username} is ready`, token }); }} />
  ));
  return (
    <div className="settings-section">
      <div className="row-between mb">
        <h3 style={{ margin: 0 }}>Bots{bots ? ` — ${bots.length} / 25` : ''}</h3>
        <div className="row gap">
          <Button variant="secondary" onClick={() => { closeSettings(); navigate('/apps'); }}><Icon name="compass" size={16} /> Browse Apps</Button>
          <Button onClick={add}><Icon name="plus" size={16} /> Add Bot</Button>
        </div>
      </div>
      {!bots ? <Spinner /> : !bots.length ? (
        <EmptyState icon="bot" title="No bots yet">Browse Apps to add one somebody has shared, or Add Bot to make your own and get its token for your bot program.</EmptyState>
      ) : (
        <div className="integ-list">{bots.map((b) => <BotCard key={b.id} bot={b} guild={guild} onChange={update} onRemoved={() => setBots((l) => l.filter((x) => x.id !== b.id))} />)}</div>
      )}
    </div>
  );
}

function BotCard({ bot, guild, onChange, onRemoved }) {
  const online = useStore((s) => (s.presences[bot.id] ? s.presences[bot.id].status !== 'offline' : bot.online));
  const user = useStore((s) => s.users[bot.id]) || bot.user;
  const adder = useStore((s) => s.users[bot.installedBy || bot.ownerId]);
  const name = user.displayName || user.username;
  const canManage = bot.canManage !== false;
  const resetToken = async () => {
    const ok = await confirmDialog({ title: `Reset ${name}’s token?`, body: 'The current token stops working right away and the bot is disconnected. You’ll get a new token to put into the bot program.', confirmText: 'Reset Token', danger: true });
    if (!ok) return;
    try { const r = await api.post(`/guilds/${guild.id}/bots/${bot.id}/token`); onChange(r.bot); showToken({ title: `New token for ${name}`, token: r.token }); } catch (e) { toastError(e); }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove ${name} from ${guild.name}?`,
      body: `${name} leaves this server and its slash commands here disappear. Messages it already sent stay. The app itself isn’t deleted: it stays with whoever made it${bot.installCount > 1 ? `, and its other ${bot.installCount - 1 === 1 ? 'server keeps' : 'servers keep'} it` : ''}.`,
      confirmText: 'Remove from Server', danger: true,
    });
    if (!ok) return;
    try { await api.del(`/guilds/${guild.id}/bots/${bot.id}`); onRemoved(); toast('Removed from this server', 'success', 1500); } catch (e) { toastError(e); }
  };
  return (
    <div className="integ-card">
      <Avatar userId={bot.id} user={user} size={48} status />
      <div className="integ-main">
        <div className="integ-title">
          <b className="truncate">{name}</b><span className="bot-tag">BOT</span>
          <span className={cx('pill', online && 'green')}>{online ? 'Online' : 'Offline'}</span>
          {bot.installCount > 1 && <span className="pill" title="The same app is also in other servers">In {bot.installCount} servers</span>}
          {canManage && bot.visibility !== 'private' && <span className={cx('pill', bot.visibility === 'listed' && 'green')} title="Who may add this app to their servers">{visibilityLabel(bot.visibility)}</span>}
        </div>
        {bot.description && <div className="small muted">{bot.description}</div>}
        <div className="tiny muted integ-meta">
          {bot.tokenHint && <span>Token <code>nb_••••{bot.tokenHint}</code></span>}
          <span>{bot.commandCount} slash command{bot.commandCount === 1 ? '' : 's'}</span>
          <span>Added {formatDate(bot.installedAt || bot.createdAt)}{adder ? ` by ${adder.displayName || adder.username}` : ''}</span>
          {!canManage && <span>Made by someone else: you can remove it from this server, not change it</span>}
        </div>
      </div>
      <div className="integ-actions">
        {canManage && <Button variant="secondary" size="sm" onClick={() => openModal(({ close }) => <EditBotModal guild={guild} bot={bot} close={close} onSaved={onChange} />)}>Edit</Button>}
        {canManage && <Button variant="secondary" size="sm" onClick={resetToken}>Reset Token</Button>}
        <Button variant="danger" size="sm" onClick={remove}>Remove</Button>
      </div>
    </div>
  );
}

/** Make a bot. With a `guild` it joins that server at once; without one (Developer Portal) it is an app that isn't in any server yet. */
export function CreateBotModal({ guild, close, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState('basic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    if (name.trim().length < 2) { setError('Give it a name (at least 2 characters).'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post(guild ? `/guilds/${guild.id}/bots` : '/developer/bots', { name: name.trim(), description: description.trim(), preset });
      onCreated(r.bot, r.token);
    } catch (err) { setError(err.message || 'Could not add the bot.'); setBusy(false); }
  };
  return (
    <Modal title={guild ? 'Add a Bot' : 'New App'} subtitle={guild ? 'It joins this server as a member with its own role. You can fine-tune that role under Roles.' : 'You get its token now. It isn’t in any server until you add it to one: yours, or any you manage.'} onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={submit}>{guild ? 'Add Bot' : 'Create App'}</Button></>}>
      <form onSubmit={submit} className="integ-form">
        <Field label="Name" required error={error}>
          <input className="input" autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Helper" />
        </Field>
        <Field label="What does it do?" hint="Optional. Only server managers see this.">
          <input className="input" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="field-label">{guild ? 'Permissions' : 'Permissions it asks for in each server'}</div>
        <RadioGroup value={preset} onChange={setPreset} options={PRESETS} />
        <input type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Change an app. From a server's Integrations (`guild` given) or the Developer Portal (no `guild`). Who may add it, and with which permissions, are the owner's to change. */
export function EditBotModal({ guild, bot, close, onSaved }) {
  const user = useStore((s) => s.users[bot.id]) || bot.user;
  const meId = useStore((s) => s.me?.id);
  const isOwner = bot.ownerId === meId;
  const base = guild ? `/guilds/${guild.id}/bots/${bot.id}` : `/developer/bots/${bot.id}`;
  const [name, setName] = useState(user.displayName || user.username);
  const [description, setDescription] = useState(bot.description || '');
  const [visibility, setVisibility] = useState(bot.visibility || 'private');
  const [preset, setPreset] = useState(bot.permPreset || 'basic');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const changeAvatar = async () => {
    const f = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    setAvatarBusy(true);
    try { const r = await putImage(`${base}/avatar`, f); onSaved(guild ? r : { ...bot, ...r }); } catch (e) { toastError(e); }
    setAvatarBusy(false);
  };
  const save = async () => {
    setBusy(true);
    const body = { name: name.trim(), description: description.trim() };
    if (isOwner) {
      if (visibility !== bot.visibility) body.visibility = visibility;
      if (preset !== bot.permPreset) body.permPreset = preset;
    }
    try { const r = await api.patch(base, body); onSaved(guild ? r : { ...bot, ...r }); close(); } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title="Edit Bot" onClose={close} footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="integ-form">
        <div className="row gap">
          <Avatar userId={bot.id} user={user} size={64} />
          <Button variant="secondary" size="sm" loading={avatarBusy} onClick={changeAvatar}>Change Picture</Button>
        </div>
        <Field label="Name" required><input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" hint={visibility === 'listed' ? 'Shown in the App Directory.' : 'Shown to people who open its link, and in the directory if you list it.'}>
          <input className="input" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {isOwner && (
          <>
            <div className="field-label">Who can add it to a server</div>
            <RadioGroup value={visibility} onChange={setVisibility} options={VISIBILITIES} />
            <div className="field-label">Permissions for servers that add it</div>
            <RadioGroup value={preset} onChange={setPreset} options={PRESETS} />
            <p className="tiny muted" style={{ margin: 0 }}>Servers that already have it keep the role they gave it; this is for the next ones.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- webhooks
export const webhookUrl = (h) => `${location.origin}/api/webhooks/${h.id}/${h.token}`;

/** The text and announcement channels of this server, in the order the sidebar shows them. */
export function useWebhookChannels(guildId) {
  return useStore((s) => (s.guildChannels[guildId] || []).map((id) => s.channels[id]).filter((c) => c && (c.type === 0 || c.type === 5))
    .sort((a, b) => (a.position - b.position) || (a.id < b.id ? -1 : 1)));
}

function WebhooksPanel({ guild }) {
  const [hooks, setHooks] = useState(null);
  const channels = useWebhookChannels(guild.id);
  const people = useStore((s) => s.users);
  const load = () => api.get(`/guilds/${guild.id}/webhooks`).then(setHooks).catch((e) => { toastError(e); setHooks([]); });
  useEffect(() => { setHooks(null); load(); }, [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const replace = (h) => setHooks((list) => (list || []).map((x) => (x.id === h.id ? h : x)));
  const add = () => openModal(({ close }) => (
    <CreateWebhookModal guild={guild} channels={channels} close={close} onCreated={(h) => { setHooks((l) => [...(l || []), h]); close(); }} />
  ));
  return (
    <div className="settings-section" data-testid="webhooks-panel">
      <div className="row-between mb">
        <h3 style={{ margin: 0 }}>Webhooks{hooks ? ` — ${hooks.length} / 25` : ''}</h3>
        <Button onClick={add} disabled={!channels.length}><Icon name="plus" size={16} /> Create Webhook</Button>
      </div>
      <p className="small muted">
        A <b>webhook</b> is a web address that posts into one channel. Monitoring tools, build servers, forms and scripts can send to it, no bot needed. Anyone who has the address can post, so keep it private.
      </p>
      {!hooks ? <Spinner /> : !hooks.length ? (
        <EmptyState icon="link" title="No webhooks yet">Create one, copy its address and paste it into the tool that should post here.</EmptyState>
      ) : (
        <div className="integ-list">
          {hooks.map((h) => (
            <WebhookCard key={h.id} hook={h} guild={guild} channels={channels} owner={people[h.createdBy]} onChange={replace} onRemoved={() => setHooks((l) => l.filter((x) => x.id !== h.id))} />
          ))}
        </div>
      )}
      <details className="integ-help">
        <summary>How to send a message</summary>
        <p className="small muted">Send a JSON request to the address. Only <code>content</code> or <code>embeds</code> is needed; <code>username</code> and <code>avatar_url</code> change who it looks like for that message.</p>
        <pre className="code-block">{`curl -X POST "<webhook address>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content": "Build 42 passed", "username": "CI"}'`}</pre>
        <p className="small muted">Senders made for Discord’s webhooks work too: paste the address and swap <code>/api/webhooks/</code> for <code>/api/v10/webhooks/</code> if the tool asks for Discord’s format. Add <code>?wait=true</code> to get the message back instead of an empty answer.</p>
      </details>
    </div>
  );
}

function WebhookCard({ hook, guild, channels, owner, onChange, onRemoved }) {
  const channel = useStore((s) => s.channels[hook.channelId]);
  const [copied, setCopied] = useState(false);
  const copy = () => { copyText(webhookUrl(hook)); setCopied(true); toast('Webhook address copied', 'success', 1500); setTimeout(() => setCopied(false), 2000); };
  const reset = async () => {
    const ok = await confirmDialog({ title: `Reset the address of ${hook.name}?`, body: 'The current address stops working right away. Anything that posts to it needs the new address.', confirmText: 'Reset Address', danger: true });
    if (!ok) return;
    try { onChange(await api.post(`/guilds/${guild.id}/webhooks/${hook.id}/token`)); toast('New address ready. Copy it again.', 'success', 2500); } catch (e) { toastError(e); }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete ${hook.name}?`, body: 'Its address stops working right away. Messages it already posted stay.', confirmText: 'Delete Webhook', danger: true });
    if (!ok) return;
    try { await api.del(`/guilds/${guild.id}/webhooks/${hook.id}`); onRemoved(); toast('Webhook deleted', 'success', 1500); } catch (e) { toastError(e); }
  };
  return (
    <div className="integ-card" data-testid="webhook-card">
      <Avatar src={hook.avatar} name={hook.name} userId={hook.id} size={48} />
      <div className="integ-main">
        <div className="integ-title">
          <b className="truncate">{hook.name}</b>
          <span className="pill">{channel ? `#${channel.name}` : 'a channel'}</span>
        </div>
        <div className="tiny muted integ-meta">
          <span>Added {formatDate(hook.createdAt)}{owner ? ` by ${owner.displayName || owner.username}` : ''}</span>
          <span>{hook.lastUsedAt ? `Last used ${formatDate(hook.lastUsedAt)}` : 'Not used yet'}</span>
          {hook.uses > 0 && <span>{hook.uses} message{hook.uses === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <div className="integ-actions">
        <Button variant={copied ? 'success' : 'primary'} size="sm" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy Address'}</Button>
        <Button variant="secondary" size="sm" onClick={() => openModal(({ close }) => <EditWebhookModal guild={guild} hook={hook} channels={channels} close={close} onSaved={onChange} />)}>Edit</Button>
        <Button variant="secondary" size="sm" onClick={reset}>Reset Address</Button>
        <Button variant="danger" size="sm" onClick={remove}>Delete</Button>
      </div>
    </div>
  );
}

function ChannelPick({ channels, value, onChange }) {
  return <Select value={value} onChange={onChange} options={channels.map((c) => ({ value: c.id, label: `# ${c.name}${c.type === 5 ? ' (announcements)' : ''}` }))} />;
}

function CreateWebhookModal({ guild, channels, close, onCreated }) {
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState(() => channels[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) { setError('Give it a name.'); return; }
    setBusy(true); setError('');
    try { onCreated(await api.post(`/guilds/${guild.id}/webhooks`, { name: name.trim(), channelId })); toast('Webhook created. Copy its address from the list.', 'success', 3000); }
    catch (err) { setError(err.message || 'Could not create the webhook.'); setBusy(false); }
  };
  return (
    <Modal title="Create a Webhook" subtitle="Its messages show this name (a sender can use another name for a single message)." onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={submit}>Create Webhook</Button></>}>
      <form onSubmit={submit} className="integ-form">
        <Field label="Name" required error={error}>
          <input className="input" autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Build alerts" />
        </Field>
        <Field label="Channel" hint="Where its messages go. You can change this later.">
          <ChannelPick channels={channels} value={channelId} onChange={setChannelId} />
        </Field>
        <input type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditWebhookModal({ guild, hook, channels, close, onSaved }) {
  const [name, setName] = useState(hook.name);
  const [channelId, setChannelId] = useState(hook.channelId);
  const [avatar, setAvatar] = useState(hook.avatar);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const changeAvatar = async () => {
    const f = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    setAvatarBusy(true);
    try { const h = await putImage(`/guilds/${guild.id}/webhooks/${hook.id}/avatar`, f); setAvatar(h.avatar); onSaved({ ...hook, avatar: h.avatar }); } catch (e) { toastError(e); }
    setAvatarBusy(false);
  };
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { onSaved(await api.patch(`/guilds/${guild.id}/webhooks/${hook.id}`, { name: name.trim(), channelId })); close(); } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title="Edit Webhook" onClose={close} footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="integ-form">
        <div className="row gap">
          <Avatar src={avatar} name={name || hook.name} userId={hook.id} size={64} />
          <Button variant="secondary" size="sm" loading={avatarBusy} onClick={changeAvatar}>Change Picture</Button>
        </div>
        <Field label="Name" required><input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Channel"><ChannelPick channels={channels} value={channelId} onChange={setChannelId} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- showing a secret once
/** A bot token. The server never shows it again, so this says so before it closes. */
export function showToken({ title, token }) {
  openModal(({ close }) => <TokenModal title={title} token={token} close={close} />);
}

function TokenModal({ title, token, close }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { copyText(token); setCopied(true); toast('Token copied', 'success', 1500); };
  return (
    <Modal title={title} size="md" onClose={close} footer={<Button onClick={close}>{copied ? 'Done' : 'I’ve saved it'}</Button>}>
      <div className="integ-form">
        <div className="notice warn">This is the only time the token is shown. Copy it now and keep it private — anyone with it can act as this bot. If you lose it, use <b>Reset Token</b> to get a new one.</div>
        <div className="token-box">
          <code className="mono" data-testid="secret">{token}</code>
          <Button variant={copied ? 'success' : 'primary'} size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <p className="small muted">
          In your bot program, send it as <code>Authorization: Bot &lt;token&gt;</code> for the REST API, or as the <code>token</code> in the <code>identify</code> message of the live connection. The <code>examples</code> folder in the project has a small bot to start from.
        </p>
      </div>
    </Modal>
  );
}
