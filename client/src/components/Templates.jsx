// Server templates: Server Settings → Server Template (make, share, sync, delete), the /template/<code> page, and the preview used by Create Server.
import { useEffect, useState } from 'react';
import { api, putImage } from '../lib/api.js';
import { getToken } from '../lib/api.js';
import { useStore } from '../lib/state.js';
import { navigate, Link } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { copyText, formatFull, plural } from '../lib/utils.js';
import { ChannelType } from '../../../shared/permissions.js';
import { Button, Field, Spinner, confirmDialog, Avatar, pickFile } from './ui.jsx';
import { Icon } from './icons.jsx';
import { AuthShell } from './Auth.jsx';

export const templateUrl = (code) => `${location.origin}/template/${code}`;

/** A link or just the code → the code. */
export function parseTemplate(text) {
  const t = String(text || '').trim();
  const m = /\/template\/([^/?#\s]+)/i.exec(t);
  const raw = m ? m[1] : t.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

const channelIcon = (type) => (type === ChannelType.VOICE ? 'speaker' : type === ChannelType.STAGE ? 'stage' : type === ChannelType.ANNOUNCEMENT ? 'megaphone' : type === ChannelType.FORUM ? 'forum' : 'hash');
const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

/** What a template holds: its roles and its channels under their categories. */
export function TemplateTree({ summary }) {
  const chan = (c, i) => <li key={i} className="tpl-chan"><Icon name={channelIcon(c.type)} size={14} /><span className="truncate">{c.name}</span></li>;
  return (
    <div className="tpl-tree" data-testid="template-tree">
      {summary.roles.length > 0 && (
        <div className="tpl-roles">
          {[...summary.roles].reverse().map((r, i) => <span key={i} className="tpl-role"><i style={{ background: r.color ? hex(r.color) : 'var(--interactive-normal)' }} />{r.name}</span>)}
        </div>
      )}
      <ul className="tpl-list">
        {summary.loose.map(chan)}
        {summary.categories.map((cat, i) => (
          <li key={i} className="tpl-cat">
            <div className="tpl-cat-name"><Icon name="chevronDown" size={11} strokeWidth={3} /><span className="truncate">{cat.name}</span></div>
            <ul>{cat.channels.map(chan)}</ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

const countsLine = (s) => [plural(s.channelCount, 'channel'), plural(s.categoryCount, 'category', 'categories'), plural(s.roleCount, 'role')].join(' · ');

// ---------------------------------------------------------------- Server Settings → Server Template
export function TemplateTab({ guild }) {
  const [state, setState] = useState(undefined);   // undefined: loading, null: none, object: the template
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    try {
      const { template } = await api.get(`/guilds/${guild.id}/template`);
      setState(template);
      setName(template?.name ?? `${guild.name} template`.slice(0, 100)); setDescription(template?.description ?? '');
    } catch (e) { toastError(e); setState(null); }
  };
  useEffect(() => { load(); }, [guild.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (what, fn, done) => {
    setBusy(what); setError('');
    try { const res = await fn(); if (res?.template) { setState(res.template); setName(res.template.name); setDescription(res.template.description); } if (done) toast(done, 'success', 2500); return res; }
    catch (e) { setError(e.errors?.name || e.errors?.description || e.message); return null; }
    finally { setBusy(''); }
  };
  if (state === undefined) return <><h2>Server Template</h2><Spinner size={32} /></>;
  const t = state;
  const url = t ? templateUrl(t.code) : '';
  const dirty = t && (name.trim() !== t.name || description.trim() !== (t.description || ''));
  return (
    <>
      <h2>Server Template</h2>
      <p className="muted">
        A template is a link anyone can use to start their own server set up like this one: the same roles, channels and permissions, ready to go.
      </p>
      <div className="tpl-copied-note small muted">
        <b>Copied:</b> roles and what they can do, channels and categories (topics, order, who can see them), forum tags, the verification level and AutoMod rules.<br />
        <b>Never copied:</b> messages, members, emoji, bots, webhooks, invites, or the server’s name and picture.
      </div>

      {!t && (
        <form className="tpl-form" onSubmit={(e) => { e.preventDefault(); run('create', () => api.post(`/guilds/${guild.id}/template`, { name: name.trim(), description: description.trim() }), 'Template created.'); }}>
          <Field label="Template name" required error={error}>
            <input className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" hint="What kind of server is this good for? (optional)">
            <input className="input" maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. A study group with rooms for each subject" />
          </Field>
          <Button type="submit" loading={busy === 'create'} disabled={name.trim().length < 2}>Create Template</Button>
        </form>
      )}

      {t && (
        <div className="tpl-card" data-testid="template-card">
          {t.outOfSync && (
            <div className="notice warn tpl-sync" role="status">
              <div><b>This server has changed since the template was saved.</b> People using the link still get the older set-up.</div>
              <Button size="sm" loading={busy === 'sync'} onClick={() => run('sync', () => api.put(`/guilds/${guild.id}/template`), 'Template synced.')}>Sync Template</Button>
            </div>
          )}
          <Field label="Template link">
            <div className="tpl-link">
              <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Template link" />
              <Button variant={copied ? 'success' : 'secondary'} onClick={async () => { await copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </Field>
          <div className="tpl-facts small muted">
            {t.summary && <span>{countsLine(t.summary)}</span>}
            <span>Used {plural(t.uses, 'time')}</span>
            <span title={formatFull(t.syncedAt)}>Saved {formatFull(t.syncedAt)}</span>
          </div>
          <Field label="Template name" error={error}>
            <input className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <input className="input" maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="row gap">
            <Button loading={busy === 'save'} disabled={!dirty || name.trim().length < 2} onClick={() => run('save', () => api.patch(`/guilds/${guild.id}/template`, { name: name.trim(), description: description.trim() }), 'Saved')}>Save Changes</Button>
            {!t.outOfSync && <Button variant="secondary" loading={busy === 'sync'} onClick={() => run('sync', () => api.put(`/guilds/${guild.id}/template`), 'Template synced.')}>Sync Template</Button>}
            <span className="grow" />
            <Button variant="danger" loading={busy === 'delete'} onClick={async () => {
              if (!(await confirmDialog({ title: 'Delete the template?', body: 'The link stops working. Servers that were already made from it are not affected.', confirmText: 'Delete Template', danger: true }))) return;
              await run('delete', async () => { await api.del(`/guilds/${guild.id}/template`); setState(null); setName(`${guild.name} template`.slice(0, 100)); setDescription(''); return {}; }, 'Template deleted.');
            }}>Delete</Button>
          </div>
          {t.summary && <details className="tpl-preview"><summary>What is in it</summary><TemplateTree summary={t.summary} /></details>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the /template/<code> page
export function TemplatePage({ code }) {
  const [tpl, setTpl] = useState(null);
  const [error, setError] = useState(null);
  const loggedIn = !!getToken();
  const me = useStore((s) => s.me);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const here = `/template/${code}`;
  useEffect(() => { api.get(`/templates/${encodeURIComponent(code)}`, { noAuthRedirect: true }).then(setTpl).catch((e) => setError(e.message)); }, [code]);
  useEffect(() => { if (me && !name) setName(`${me.displayName || me.username}'s server`); }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (e) => {
    e?.preventDefault();
    if (!loggedIn) { navigate(`/login?redirect=${encodeURIComponent(here)}`); return; }
    setBusy(true); setFormError('');
    try {
      const g = await api.post(`/templates/${encodeURIComponent(code)}/guilds`, { name: name.trim() });
      if (icon) await putImage(`/guilds/${g.id}/icon`, icon).catch((er) => toastError(er));
      const first = g.channels.find((c) => c.type === ChannelType.TEXT);
      navigate(`/channels/${g.id}${first ? `/${first.id}` : ''}`, { replace: true });
    } catch (er) { setFormError(er.errors?.name || er.message); setBusy(false); }
  };
  return (
    <AuthShell wide>
      <div className="auth-form invite-card tpl-page">
        {!tpl && !error && <Spinner size={40} />}
        {error && <><div className="auth-icon bad"><Icon name="link" size={32} /></div><h1>Template Not Found</h1><p className="muted center">{error}</p>
          <Button className="full" onClick={() => navigate(loggedIn ? '/channels/@me' : '/login')}>Continue to NullChat</Button></>}
        {tpl && (
          <>
            <div className="auth-icon"><Icon name="grid" size={32} /></div>
            <p className="muted small">{tpl.creator ? <><b>{tpl.creator.displayName || tpl.creator.username}</b> shared a server template</> : 'A server template'}</p>
            <h1>{tpl.name}</h1>
            {tpl.description && <p className="muted center small">{tpl.description}</p>}
            <p className="tiny muted">Based on <b>{tpl.guild.name}</b> · used {plural(tpl.uses, 'time')}</p>
            {tpl.summary && <><div className="invite-counts"><span>{countsLine(tpl.summary)}</span></div><TemplateTree summary={tpl.summary} /></>}
            <form className="tpl-start" onSubmit={create}>
              {loggedIn && (
                <>
                  <p className="small muted center">You become the owner of a new server. No messages or people are copied.</p>
                  <div className="tpl-start-row">
                    <button type="button" className="icon-upload small" aria-label="Choose a server picture" onClick={async () => { const f = await pickFile('image/*'); if (f) setIcon(f); }}>
                      {icon ? <img src={URL.createObjectURL(icon)} alt="" /> : <Icon name="upload" size={18} />}
                    </button>
                    <Field label="Server name" error={formError} className="grow"><input className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
                  </div>
                </>
              )}
              <Button type="submit" className="full" size="lg" loading={busy} disabled={loggedIn && name.trim().length < 2}>{loggedIn ? 'Create Server' : 'Log in to Use This Template'}</Button>
            </form>
            {!loggedIn && <Link className="link small" to={`/register?redirect=${encodeURIComponent(here)}`}>Need an account? Register</Link>}
            {loggedIn && me && <div className="tiny muted tpl-as"><Avatar user={me} size={16} /> Signed in as {me.displayName || me.username}</div>}
          </>
        )}
      </div>
    </AuthShell>
  );
}
