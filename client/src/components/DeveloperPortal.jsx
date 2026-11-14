// User Settings → Developer Portal: your apps (bots) and the webhooks in the servers you manage in one place, with what each app has registered
// and a live log of what it has been asked to do. An app can be in many servers; from here you add it to one, choose who else may add it, or delete it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, guildPermissions } from '../lib/state.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, copyText, relativeTime, plural } from '../lib/utils.js';
import { P, has } from '../../../shared/permissions.js';
import { Button, openModal, Avatar, GuildIcon, Spinner, confirmDialog, EmptyState, Tabs } from './ui.jsx';
import { Icon } from './icons.jsx';
import { CreateBotModal, EditBotModal, showToken, webhookUrl, visibilityLabel } from './Integrations.jsx';
import { openAddToServer, appLink } from './Apps.jsx';

/** Servers where this person has Manage Server (the only ones whose bots they can see here). */
export function managedServers(s) {
  return Object.values(s.guilds).filter((g) => has(guildPermissions(s, g.id), P.MANAGE_GUILD)).sort((a, b) => a.name.localeCompare(b.name));
}
export const manageSomething = (s) => managedServers(s).length > 0;

export function DeveloperPortalTab() {
  const [tab, setTab] = useState('bots');
  return (
    <div data-testid="developer-portal">
      <h2>Developer Portal</h2>
      <p className="muted">
        Build for NullChat. Here are the apps you made or manage and the webhooks in every server you manage: add an app to a server, reset a token, see what it has registered, and watch what it is asked to do while you test.
      </p>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bots', label: 'Apps' }, { value: 'webhooks', label: 'Webhooks' }, { value: 'build', label: 'Build' }]} />
      {tab === 'bots' && <BotsSection />}
      {tab === 'webhooks' && <WebhooksSection />}
      {tab === 'build' && <BuildSection />}
    </div>
  );
}

// ---------------------------------------------------------------- apps (bots)
function BotsSection() {
  const [bots, setBots] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.get('/developer/bots').then(setBots).catch((e) => { toastError(e); setBots([]); }), []);
  useEffect(() => { load(); }, [load]);
  const replace = (b) => setBots((list) => (list || []).map((x) => (x.id === b.id ? { ...x, ...b } : x)));

  const newBot = () => {
    openModal(({ close }) => <CreateBotModal close={close} onCreated={(bot, token) => {
      close();
      setBots((l) => [bot, ...(l || [])]); setOpen(bot.id);
      showToken({ title: `Token for ${bot.user?.displayName || 'your app'}`, token });
    }} />);
  };

  if (!bots) return <Spinner size={32} />;
  const mine = bots.filter((b) => b.mine).length;
  return (
    <div data-testid="portal-bots">
      <div className="row-between mb">
        <h3 style={{ margin: 0 }}>{bots.length ? `${plural(bots.length, 'app')}${mine && mine < bots.length ? `, ${mine} made by you` : ''}` : 'Apps'}</h3>
        <Button onClick={newBot}><Icon name="plus" size={16} /> New App</Button>
      </div>
      {!bots.length ? (
        <EmptyState icon="bot" title="No apps yet">
          An app is a bot: a member that a program you run can log in as. It reads messages, answers slash commands and buttons, and posts rich cards.
          Make one to get its token, then add it to any server you manage, or share it so others can add it to theirs.
        </EmptyState>
      ) : (
        <div className="integ-list">
          {bots.map((b) => (
            <PortalBot key={b.id} bot={b} open={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} onChange={replace} onReload={load}
              onRemoved={() => { setBots((l) => l.filter((x) => x.id !== b.id)); if (open === b.id) setOpen(null); }} />
          ))}
        </div>
      )}
      <p className="tiny muted dev-note">An app can be in many servers at once, each giving it its own role. Add it to one with Add to Server; under Edit you choose whether it stays private, can be added by anyone with its link, or is listed in Discover → Apps.</p>
    </div>
  );
}

function PortalBot({ bot, open, onToggle, onChange, onReload, onRemoved }) {
  const online = useStore((s) => (s.presences[bot.id] ? s.presences[bot.id].status !== 'offline' : bot.online));
  const user = useStore((s) => s.users[bot.id]) || bot.user;
  const owner = useStore((s) => s.users[bot.ownerId]);
  const name = user.displayName || user.username;
  const installs = bot.installs || [];
  const where = bot.installCount === 0 ? 'Not in a server yet' : bot.installCount === 1 && installs[0] ? installs[0].guild.name : plural(bot.installCount, 'server');
  const resetToken = async () => {
    const ok = await confirmDialog({ title: `Reset ${name}’s token?`, body: 'The current token stops working right away and the bot is disconnected. You’ll get a new token to put into the bot program.', confirmText: 'Reset Token', danger: true });
    if (!ok) return;
    try { const r = await api.post(`/developer/bots/${bot.id}/token`); onChange({ ...r.bot, installs: bot.installs }); showToken({ title: `New token for ${name}`, token: r.token }); } catch (e) { toastError(e); }
  };
  // The one who made it deletes the app everywhere; someone who only manages the server it is in takes it out of that server.
  const remove = async () => {
    if (bot.mine) {
      const ok = await confirmDialog({
        title: `Delete ${name}?`,
        body: `${name} leaves ${bot.installCount ? plural(bot.installCount, 'server') : 'every server'}, its token stops working, its slash commands disappear and it can’t be added again. Messages it already sent stay.`,
        confirmText: 'Delete App', danger: true,
      });
      if (!ok) return;
      try { await api.del(`/developer/bots/${bot.id}`); onRemoved(); toast('App deleted', 'success', 1500); } catch (e) { toastError(e); }
      return;
    }
    const g = installs[0];
    if (!g) return;
    const ok = await confirmDialog({ title: `Remove ${name} from ${g.guild.name}?`, body: `${name} leaves ${g.guild.name} and its slash commands there disappear. Messages it already sent stay.`, confirmText: 'Remove from Server', danger: true });
    if (!ok) return;
    try { await api.del(`/guilds/${g.guildId}/bots/${bot.id}`); onRemoved(); toast('Removed from this server', 'success', 1500); } catch (e) { toastError(e); }
  };
  const share = () => { copyText(appLink(bot.id)); toast('App link copied', 'success', 1500); };
  return (
    <div className={cx('dev-bot', open && 'open')} data-testid="portal-bot">
      <div className="integ-card">
        <Avatar userId={bot.id} user={user} size={48} status />
        <div className="integ-main">
          <div className="integ-title">
            <b className="truncate">{name}</b><span className="bot-tag">BOT</span>
            <span className={cx('pill', online && 'green')}>{online ? 'Online' : 'Offline'}</span>
            <span className="pill" title="Where this app is">{where}</span>
            {bot.mine && <span className={cx('pill', bot.visibility === 'listed' && 'green')} title="Who may add this app to their servers">{visibilityLabel(bot.visibility)}</span>}
            {bot.hidden && <span className="pill warn" title="Staff took it out of the App Directory">Hidden by staff</span>}
          </div>
          {bot.description && <div className="small muted">{bot.description}</div>}
          <div className="tiny muted integ-meta">
            <span>Token <code>nb_••••{bot.tokenHint}</code></span>
            <span>{plural(bot.commandCount, 'slash command')}</span>
            <span>{bot.mine ? 'Made by you' : owner ? `Added by ${owner.displayName || owner.username}` : 'Added'} {formatDate(bot.createdAt)}</span>
            {!online && bot.lastSeenAt && <span>Last seen {relativeTime(bot.lastSeenAt)}</span>}
          </div>
        </div>
        <div className="integ-actions">
          <Button variant={open ? 'primary' : 'secondary'} size="sm" aria-expanded={open} onClick={onToggle}>{open ? 'Hide Details' : 'Details'}</Button>
          <Button size="sm" onClick={() => openAddToServer(bot.id, onReload)}><Icon name="plus" size={14} /> Add to Server</Button>
          <Button variant="secondary" size="sm" onClick={() => openModal(({ close }) => <EditBotModal bot={bot} close={close} onSaved={onChange} />)}>Edit</Button>
          <Button variant="secondary" size="sm" onClick={resetToken}>Reset Token</Button>
          {bot.visibility !== 'private' && <Button variant="secondary" size="sm" onClick={share}><Icon name="link" size={14} /> Copy Link</Button>}
          <Button variant="secondary" size="sm" onClick={() => { copyText(bot.id); toast('Bot ID copied', 'success', 1500); }}>Copy ID</Button>
          {(bot.mine || installs.length > 0) && <Button variant="danger" size="sm" onClick={remove}>{bot.mine ? 'Delete App' : 'Remove'}</Button>}
        </div>
      </div>
      {open && <BotDetails bot={bot} online={online} onChange={onChange} onReload={onReload} />}
    </div>
  );
}

// ---- slash commands and the live log of one bot
function BotDetails({ bot, online, onChange, onReload }) {
  return (
    <div className="dev-details" data-testid="portal-details">
      <Servers bot={bot} onReload={onReload} />
      <Commands bot={bot} onCount={(n) => onChange({ id: bot.id, commandCount: n })} />
      <Activity bot={bot} online={online} />
    </div>
  );
}

/** The servers this app is in that you manage, each with a way to take it out; the rest are only counted. */
function Servers({ bot, onReload }) {
  const installs = bot.installs || [];
  const others = bot.installCount - installs.length;
  const take = async (i) => {
    const ok = await confirmDialog({ title: `Remove ${bot.user?.displayName || 'this app'} from ${i.guild.name}?`, body: 'It leaves that server and its slash commands there disappear. The app and its token stay here.', confirmText: 'Remove from Server', danger: true });
    if (!ok) return;
    try { await api.del(`/guilds/${i.guildId}/bots/${bot.id}`); toast('Removed from the server', 'success', 1500); onReload(); } catch (e) { toastError(e); }
  };
  return (
    <section className="dev-section dev-servers-wrap" data-testid="portal-servers">
      <h4>Servers</h4>
      {!installs.length && !others ? (
        <p className="small muted">Not in any server yet. Use Add to Server{bot.visibility === 'private' ? '' : ', or send people its link'}.</p>
      ) : (
        <ul className="dev-servers">
          {installs.map((i) => (
            <li key={i.guildId} data-guild={i.guildId}>
              <GuildIcon guild={i.guild} size={28} />
              <span className="truncate grow">{i.guild.name}</span>
              <span className="tiny muted">Added {formatDate(i.installedAt)}</span>
              <Button variant="secondary" size="sm" onClick={() => take(i)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {others > 0 && <p className="tiny muted">{installs.length ? 'And ' : ''}{plural(others, 'server')} you don’t manage {installs.length ? '' : 'use it'}.</p>}
      {bot.visibility !== 'private' && (
        <p className="tiny muted dev-share">Its link: <code>{appLink(bot.id)}</code> <button type="button" className="link-btn" onClick={() => { copyText(appLink(bot.id)); toast('App link copied', 'success', 1500); }}>Copy</button></p>
      )}
    </section>
  );
}

const optionText = (o) => `${o.name}${o.required ? '' : '?'}: ${o.type}${o.choices?.length ? ` (${o.choices.length} choices)` : ''}`;

function Commands({ bot, onCount }) {
  const [cmds, setCmds] = useState(null);
  const load = () => api.get(`/developer/bots/${bot.id}/commands`).then(setCmds).catch((e) => { toastError(e); setCmds([]); });
  useEffect(() => { setCmds(null); load(); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const del = async (c) => {
    const ok = await confirmDialog({ title: `Delete /${c.name}?`, body: 'It disappears from the slash command list right away. The bot registers its commands again whenever it starts, so one it still defines will come back.', confirmText: 'Delete Command', danger: true });
    if (!ok) return;
    try { await api.del(`/developer/bots/${bot.id}/commands/${encodeURIComponent(c.name)}`); setCmds((l) => { const n = l.filter((x) => x.id !== c.id); onCount(n.length); return n; }); toast('Command deleted', 'success', 1500); } catch (e) { toastError(e); }
  };
  return (
    <section className="dev-section" data-testid="portal-commands">
      <h4>Slash commands</h4>
      {!cmds ? <Spinner /> : !cmds.length ? (
        <p className="small muted">None registered. A bot registers its commands when it starts (<code>PUT /api/bot/commands</code>); the example bot shows how.</p>
      ) : (
        <ul className="dev-cmds">
          {cmds.map((c) => (
            <li key={c.id}>
              <div className="dev-cmd-main">
                <code>/{c.name}</code>
                <span className="small muted truncate">{c.description}</span>
                {c.options?.length > 0 && <span className="tiny muted truncate">{c.options.map(optionText).join(' · ')}</span>}
              </div>
              <button className="icon-btn" aria-label={`Delete /${c.name}`} title="Delete this command" onClick={() => del(c)}><Icon name="trash" size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND = { command: 'Command', button: 'Button', menu: 'Menu', form: 'Form' };
const HOW = { message: 'sent a message', defer: 'said “thinking…”', update: 'updated the message', defer_update: 'acknowledged it', modal: 'opened a form' };
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ms = (n) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export function ActivityRow({ e }) {
  const state = e.status === 'answered' ? `Answered in ${ms(e.ms)} — ${HOW[e.how] || 'replied'}`
    : e.status === 'waiting' ? 'Waiting for an answer…'
      : e.status === 'timeout' ? `No answer within ${ms(e.ms)}`
        : e.status === 'offline' ? 'The bot was not connected'
          : `Failed: ${e.error || 'something went wrong'}`;
  return (
    <li className={cx('dev-act', `s-${e.status}`)} data-testid="portal-activity-row">
      <span className="tiny muted dev-act-time">{clock(e.at)}</span>
      <span className="pill">{KIND[e.kind] || e.kind}</span>
      <code className="truncate">{e.name}</code>
      <span className="small muted truncate dev-act-by">{e.userName ? `by ${e.userName}` : ''}</span>
      <span className="small dev-act-state">{state}</span>
    </li>
  );
}

/** What the bot has been asked to do lately. Polls while open and the tab is showing. */
function Activity({ bot, online }) {
  const [log, setLog] = useState(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try { const r = await api.get(`/developer/bots/${bot.id}/activity`); if (alive.current) setLog(r.entries); } catch { if (alive.current) setLog((l) => l || []); }
  }, [bot.id]);
  useEffect(() => {
    alive.current = true; setLog(null); load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 2500);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);
  return (
    <section className="dev-section" data-testid="portal-activity">
      <h4>Recent activity <span className="dev-live" title="Updates every few seconds">live</span></h4>
      <p className="tiny muted dev-keep">The last 50. Cleared when the server restarts.</p>
      {!online && <div className="notice small">This bot is not connected right now, so anyone using its commands, buttons or menus is told it is offline. Start your bot program with its token.</div>}
      {!log ? <Spinner /> : !log.length ? (
        <p className="small muted">Nothing yet. When someone uses a slash command, button, menu or form from this bot it shows up here with how fast the bot answered. It never shows what they typed.</p>
      ) : (
        <ul className="dev-acts">{log.map((e) => <ActivityRow key={e.id} e={e} />)}</ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- webhooks
function WebhooksSection() {
  const [hooks, setHooks] = useState(null);
  useEffect(() => { api.get('/developer/webhooks').then(setHooks).catch((e) => { toastError(e); setHooks([]); }); }, []);
  if (!hooks) return <Spinner size={32} />;
  return (
    <div data-testid="portal-webhooks">
      <h3>{hooks.length ? plural(hooks.length, 'webhook') : 'Webhooks'}</h3>
      <p className="small muted">A webhook is a web address that posts into one channel, with no bot. Create and edit them in a server’s Server Settings → Integrations; here you can copy an address or send a test message through it.</p>
      {!hooks.length ? (
        <EmptyState icon="link" title="No webhooks yet">Open Server Settings → Integrations → Create Webhook in a server you manage.</EmptyState>
      ) : (
        <div className="integ-list">{hooks.map((h) => <PortalHook key={h.id} hook={h} />)}</div>
      )}
    </div>
  );
}

function PortalHook({ hook }) {
  const channel = useStore((s) => s.channels[hook.channelId]);
  const [busy, setBusy] = useState(false);
  const [uses, setUses] = useState(hook.uses);
  const test = async () => {
    setBusy(true);
    try {
      const r = await fetch(webhookUrl(hook), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Test message from the Developer Portal. If you can read this, the webhook works.' }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `The address answered ${r.status}.`); }
      setUses((n) => n + 1);
      toast(`Test message sent${channel ? ` to #${channel.name}` : ''}`, 'success', 2500);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="integ-card" data-testid="portal-hook">
      <Avatar src={hook.avatar} name={hook.name} userId={hook.id} size={48} />
      <div className="integ-main">
        <div className="integ-title">
          <b className="truncate">{hook.name}</b>
          <span className="pill">{channel ? `#${channel.name}` : 'a channel'}</span>
          <span className="pill" title="The server this webhook is in">{hook.guild.name}</span>
        </div>
        <div className="tiny muted integ-meta">
          <span>Added {formatDate(hook.createdAt)}</span>
          <span>{hook.lastUsedAt ? `Last used ${relativeTime(hook.lastUsedAt)}` : 'Not used yet'}</span>
          {uses > 0 && <span>{plural(uses, 'message')}</span>}
        </div>
      </div>
      <div className="integ-actions">
        <Button variant="secondary" size="sm" onClick={() => { copyText(webhookUrl(hook)); toast('Webhook address copied', 'success', 1500); }}><Icon name="copy" size={14} /> Copy Address</Button>
        <Button size="sm" loading={busy} onClick={test}>Send Test Message</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- build
function BuildSection() {
  const origin = location.origin;
  const ws = origin.replace(/^http/, 'ws') + '/gateway';
  const copy = (text, what) => { copyText(text); toast(`${what} copied`, 'success', 1500); };
  const curl = `curl -X POST "${origin}/api/channels/<channel id>/messages" \\\n  -H "Authorization: Bot <your token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content": "Hello from my bot"}'`;
  return (
    <div data-testid="portal-build">
      <h3>Addresses</h3>
      <div className="dev-addr">
        <div><span className="small muted">API</span><code>{origin}/api</code><Button variant="secondary" size="sm" onClick={() => copy(`${origin}/api`, 'API address')}><Icon name="copy" size={14} /> Copy</Button></div>
        <div><span className="small muted">Live connection</span><code>{ws}</code><Button variant="secondary" size="sm" onClick={() => copy(ws, 'Live connection address')}><Icon name="copy" size={14} /> Copy</Button></div>
      </div>
      <h3>Send a first message</h3>
      <pre className="code-block">{curl}</pre>
      <Button variant="secondary" size="sm" onClick={() => copy(curl.replace(/\\\n\s*/g, ''), 'Command')}><Icon name="copy" size={14} /> Copy Command</Button>
      <h3>Where to read more</h3>
      <ul className="dev-links small">
        <li><b>docs/BOTS.md</b> in your NullChat folder: the API, slash commands, buttons, menus and forms, webhooks.</li>
        <li><b>docs/DISCORD_BOTS.md</b>: moving a bot written for discord.js or discord.py (change the addresses and the token).</li>
        <li><b>examples/example-bot/bot.mjs</b>: a one-file bot with commands, buttons and a menu. Needs only Node.js 22.</li>
      </ul>
      <div className="notice small">Anyone with a bot’s token can act as that bot. Never put it in a web page, a public repository or a screenshot. If it leaks, use Reset Token.</div>
    </div>
  );
}
