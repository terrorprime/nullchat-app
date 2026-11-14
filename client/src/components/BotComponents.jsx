// The buttons and menus a bot puts under a message, and the form window a bot can open when you press one.
//   <MessageComponents message />   rows of buttons / one menu or picker per row, under the message text and embeds
//   <BotModalHost />                listens for a bot opening a form (MODAL_SHOW) and shows it; mounted once, in App.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/state.js';
import { ChannelType } from '../../../shared/permissions.js';
import { on } from '../lib/gateway.js';
import { toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { Button, Modal, Field, openModal, openPopout, Avatar } from './ui.jsx';
import { Icon } from './icons.jsx';

const STYLE = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };

/** A custom emoji (an image) or a regular one (its character). */
function CompEmoji({ emoji }) {
  if (!emoji) return null;
  if (emoji.id) return <img className="emoji custom comp-emoji" src={`/emojis/${emoji.id}`} alt={`:${emoji.name || 'emoji'}:`} draggable={false} />;
  return <span className="comp-emoji" aria-hidden="true">{emoji.name}</span>;
}

/** Press a button or pick from a menu: tell the server, which tells the bot. The answer shows up as the message changing or a new message. */
async function press(message, customId, values) {
  await api.post(`/channels/${message.channelId}/messages/${message.id}/components`, { customId, ...(values ? { values } : {}) });
}

export function MessageComponents({ message, preview }) {
  const rows = message.components;
  const [busy, setBusy] = useState('');   // the custom id being sent (so a double click doesn't press twice)
  const guildId = useStore((s) => s.channels[message.channelId]?.guildId || null);
  if (!rows?.length) return null;
  const inert = !!(preview || message.pending || message.failed || message.ephemeral);
  const send = async (customId, values) => {
    if (busy || inert) return false;
    setBusy(customId);
    try { await press(message, customId, values); return true; }
    catch (e) { toastError(e, 'That didn’t go through.'); return false; }
    finally { setTimeout(() => setBusy(''), 700); }   // (a short pause even after success: the bot's answer is on its way)
  };
  return (
    <div className="comp-rows" data-testid="message-components">
      {rows.map((row, i) => (
        <div key={i} className="comp-row" role="group">
          {row.components.map((c) => (c.type === 3
            ? <CompSelect key={c.customId} menu={c} disabled={inert || c.disabled} busy={busy === c.customId} onPick={(values) => send(c.customId, values)} />
            : c.type >= 5 && c.type <= 8
              ? <CompPicker key={c.customId} menu={c} guildId={guildId} disabled={inert || c.disabled || !guildId} busy={busy === c.customId} onPick={(values) => send(c.customId, values)} />
              : <CompButton key={c.customId || c.url} button={c} disabled={inert || c.disabled} busy={busy === c.customId} locked={!!busy} onPress={() => send(c.customId)} />))}
        </div>
      ))}
    </div>
  );
}

function CompButton({ button: b, disabled, busy, locked, onPress }) {
  const kind = STYLE[b.style] || 'secondary';
  const inner = (
    <>
      <CompEmoji emoji={b.emoji} />
      {b.label && <span className="comp-label">{b.label}</span>}
      {kind === 'link' && <Icon name="link" size={14} />}
    </>
  );
  if (kind === 'link') {
    return disabled
      ? <span className="comp-btn s-link disabled" aria-disabled="true">{inner}</span>
      : <a className="comp-btn s-link" href={b.url} target="_blank" rel="noopener noreferrer nofollow" title={b.url}>{inner}</a>;
  }
  return (
    <button type="button" className={cx('comp-btn', `s-${kind}`, busy && 'busy')} disabled={disabled || (locked && !busy)} aria-busy={busy || undefined} onClick={onPress}>
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------- menus
function CompSelect({ menu, disabled, busy, onPick }) {
  const ref = useRef(null);
  const chosen = menu.options.filter((o) => o.default);
  const open = () => {
    if (disabled) return;
    openPopout(ref.current, ({ close }) => <SelectList menu={menu} initial={chosen.map((o) => o.value)} onPick={onPick} close={close} />, { placement: 'bottom', key: `comp-${menu.customId}` });
  };
  return (
    <button ref={ref} type="button" className={cx('comp-select', busy && 'busy')} disabled={disabled} aria-haspopup="listbox" aria-label={menu.placeholder || 'Choose an option'} onClick={open}>
      <span className={cx('comp-select-text', !chosen.length && 'placeholder')}>
        {chosen.length ? chosen.map((o) => o.label).join(', ') : (menu.placeholder || 'Choose an option')}
      </span>
      <Icon name="chevronDown" size={16} />
    </button>
  );
}

/** One choice sends at once; a menu that takes several shows boxes and a Send button. */
function SelectList({ menu, initial, onPick, close }) {
  const multi = menu.maxValues > 1 || menu.minValues > 1;
  const [picked, setPicked] = useState(initial);
  const toggle = (v) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : (p.length >= menu.maxValues ? p : [...p, v])));
  const ready = picked.length >= menu.minValues && picked.length <= menu.maxValues;
  const send = async (values) => { close(); await onPick(values); };
  return (
    <div className="comp-menu" role="listbox" aria-multiselectable={multi || undefined} data-testid="comp-menu">
      <div className="comp-menu-list">
        {menu.options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <button key={o.value} type="button" role="option" aria-selected={on} className={cx('comp-option', on && multi && 'on')}
              onClick={() => (multi ? toggle(o.value) : send([o.value]))}>
              <CompEmoji emoji={o.emoji} />
              <span className="comp-option-text">
                <span className="comp-option-label">{o.label}</span>
                {o.description && <span className="comp-option-desc">{o.description}</span>}
              </span>
              {multi && <span className={cx('menu-check', on && 'on')}>{on && <Icon name="check" size={12} strokeWidth={3} />}</span>}
            </button>
          );
        })}
      </div>
      {multi && (
        <div className="comp-menu-foot">
          <span className="tiny muted">
            {menu.minValues === menu.maxValues ? `Pick ${menu.maxValues}` : menu.minValues > 0 ? `Pick ${menu.minValues} to ${menu.maxValues}` : `Pick up to ${menu.maxValues}`}
          </span>
          <Button size="sm" disabled={!ready} onClick={() => send(picked)}>Send</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pickers: the server's own people, roles and channels
const PICKER_PLACEHOLDER = { 5: 'Choose a person', 6: 'Choose a role', 7: 'Choose a person or role', 8: 'Choose a channel' };
const PICKER_EMPTY = { 5: 'No one found', 6: 'No roles found', 7: 'No one found', 8: 'No channels found' };
const channelIcon = (type) => (type === ChannelType.VOICE ? 'speaker' : type === ChannelType.STAGE ? 'stage' : type === ChannelType.ANNOUNCEMENT ? 'megaphone' : type === ChannelType.FORUM ? 'forum' : type === ChannelType.CATEGORY ? 'chevronDown' : 'hash');
const roleHex = (n) => (n ? `#${(n >>> 0).toString(16).padStart(6, '0')}` : null);
const SHOWN = 100;   // (a big server has thousands of people: show the first matches and let the search narrow it down)

/** What a picker offers, from what this browser already knows about the server (so only things the person can see anyway). */
function usePickerItems(menu, guildId) {
  const members = useStore((s) => s.members[guildId]);
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.guilds[guildId]?.roles);
  const channelIds = useStore((s) => s.guildChannels[guildId]);
  const channels = useStore((s) => s.channels);
  return useMemo(() => {
    const out = [];
    if (menu.type === 5 || menu.type === 7) {
      const people = Object.values(members || {}).map((m) => {
        const u = users[m.userId];
        return u ? { key: m.userId, id: m.userId, kind: 'user', group: 'People', label: m.nick || u.displayName || u.username, sub: `@${u.username}`, user: u } : null;
      }).filter(Boolean).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
      out.push(...people);
    }
    if (menu.type === 6 || menu.type === 7) {
      const list = (roles || []).filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position)
        .map((r) => ({ key: r.id, id: r.id, kind: 'role', group: 'Roles', label: r.name, color: roleHex(r.color) }));
      out.unshift(...list);   // (roles first in a mixed menu: there are fewer of them)
    }
    if (menu.type === 8) {
      for (const id of channelIds || []) {
        const c = channels[id];
        if (!c || (menu.channelTypes?.length && !menu.channelTypes.includes(c.type))) continue;
        out.push({ key: c.id, id: c.id, kind: 'channel', group: 'Channels', label: c.name, type: c.type });
      }
    }
    return out;
  }, [menu.type, menu.channelTypes, members, users, roles, channelIds, channels, guildId]);
}

function PickerIcon({ item }) {
  if (item.kind === 'user') return <Avatar user={item.user} size={24} />;
  if (item.kind === 'role') return <span className="comp-dot" style={item.color ? { background: item.color } : undefined} aria-hidden="true" />;
  return <span className="comp-ent-icon" aria-hidden="true"><Icon name={channelIcon(item.type)} size={16} /></span>;
}

function CompPicker({ menu, guildId, disabled, busy, onPick }) {
  const ref = useRef(null);
  const items = usePickerItems(menu, guildId);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const defaults = (menu.defaultValues || []).map((d) => d.id);
  const named = defaults.map((id) => byId.get(id)).filter(Boolean);
  const open = () => {
    if (disabled) return;
    openPopout(ref.current, ({ close }) => <PickerList menu={menu} items={items} initial={defaults} onPick={onPick} close={close} />, { placement: 'bottom', key: `comp-${menu.customId}` });
  };
  const label = named.length ? named.map((i) => (i.kind === 'channel' ? `#${i.label}` : i.kind === 'role' ? `@${i.label}` : i.label)).join(', ') : (menu.placeholder || PICKER_PLACEHOLDER[menu.type]);
  return (
    <button ref={ref} type="button" className={cx('comp-select', busy && 'busy')} data-picker={menu.type} disabled={disabled} aria-haspopup="listbox" aria-label={menu.placeholder || PICKER_PLACEHOLDER[menu.type]} onClick={open}>
      <span className={cx('comp-select-text', !named.length && 'placeholder')}>{label}</span>
      <Icon name="chevronDown" size={16} />
    </button>
  );
}

/** A search box over the list. One pick sends at once; a picker that takes several shows boxes and a Send button (like the menu with your own options). */
function PickerList({ menu, items, initial, onPick, close }) {
  const multi = menu.maxValues > 1 || menu.minValues > 1;
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(initial);
  const needle = q.trim().toLowerCase().replace(/^[@#]/, '');
  const found = useMemo(() => (needle ? items.filter((i) => i.label.toLowerCase().includes(needle) || (i.sub || '').toLowerCase().includes(needle)) : items), [items, needle]);
  const shown = found.slice(0, SHOWN);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : (p.length >= menu.maxValues ? p : [...p, id])));
  const ready = picked.length >= menu.minValues && picked.length <= menu.maxValues;
  const send = async (values) => { close(); await onPick(values); };
  let lastGroup = null;
  return (
    <div className="comp-menu" role="listbox" aria-multiselectable={multi || undefined} data-testid="comp-picker">
      <div className="comp-search">
        <input className="input" autoFocus type="search" placeholder={menu.type === 8 ? 'Search channels' : menu.type === 6 ? 'Search roles' : 'Search'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      <div className="comp-menu-list">
        {shown.map((i) => {
          const on = picked.includes(i.id);
          const head = menu.type === 7 && i.group !== lastGroup ? <div key={`g-${i.group}`} className="comp-group">{i.group}</div> : null;
          lastGroup = i.group;
          return (
            <div key={i.key} className="comp-item">
              {head}
              <button type="button" role="option" aria-selected={on} className={cx('comp-option', on && multi && 'on')} data-kind={i.kind} onClick={() => (multi ? toggle(i.id) : send([i.id]))}>
                <PickerIcon item={i} />
                <span className="comp-option-text">
                  <span className="comp-option-label">{i.kind === 'channel' ? `#${i.label}` : i.label}</span>
                  {i.sub && <span className="comp-option-desc">{i.sub}</span>}
                </span>
                {multi && <span className={cx('menu-check', on && 'on')}>{on && <Icon name="check" size={12} strokeWidth={3} />}</span>}
              </button>
            </div>
          );
        })}
        {!shown.length && <div className="comp-empty small muted">{PICKER_EMPTY[menu.type]}</div>}
        {found.length > SHOWN && <div className="comp-empty tiny muted">Showing the first {SHOWN}. Type to narrow it down.</div>}
      </div>
      {multi && (
        <div className="comp-menu-foot">
          <span className="tiny muted">
            {menu.minValues === menu.maxValues ? `Pick ${menu.maxValues}` : menu.minValues > 0 ? `Pick ${menu.minValues} to ${menu.maxValues}` : `Pick up to ${menu.maxValues}`}
          </span>
          <Button size="sm" disabled={!ready} onClick={() => send(picked)}>Send</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forms
const openForms = new Map();   // interaction id -> close function (so the server can close the window once the answer is in)

/** Mounted once. A bot answers a button press with a form: the server sends it to the person who pressed. */
export function BotModalHost() {
  useEffect(() => {
    const offShow = on('MODAL_SHOW', (form) => {
      openForms.get(form.id)?.();
      const close = openModal(({ close: c }) => <BotForm form={form} close={c} />, { onClose: () => openForms.delete(form.id) });
      openForms.set(form.id, close);
    });
    const offClose = on('MODAL_CLOSE', ({ id }) => openForms.get(id)?.());
    return () => { offShow(); offClose(); };
  }, []);
  return null;
}

function BotForm({ form, close }) {
  const boxes = form.components.map((r) => r.components[0]);
  const [values, setValues] = useState(() => Object.fromEntries(boxes.map((b) => [b.customId, b.value || ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await api.post(`/interactions/${form.id}/modal`, { values }); close(); }
    catch (err) { setError(err.message || 'Could not send the form.'); setBusy(false); }
  };
  const botName = form.bot?.displayName || form.bot?.username || 'the bot';
  return (
    <Modal title={form.title} onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={submit}>Send</Button></>}>
      <form onSubmit={submit} className="bot-form" data-testid="bot-form">
        <div className="bot-form-from">
          <Avatar user={form.bot} size={20} />
          <span className="small muted">Your answers go to <b>{botName}</b>.</span>
        </div>
        {boxes.map((b, i) => (
          <Field key={b.customId} label={b.label} required={b.required}>
            {b.style === 2
              ? <textarea className="input" rows={5} autoFocus={i === 0} maxLength={b.maxLength} placeholder={b.placeholder || ''} value={values[b.customId]} onChange={(e) => setValues((v) => ({ ...v, [b.customId]: e.target.value }))} />
              : <input className="input" autoFocus={i === 0} maxLength={b.maxLength} placeholder={b.placeholder || ''} value={values[b.customId]} onChange={(e) => setValues((v) => ({ ...v, [b.customId]: e.target.value }))} />}
          </Field>
        ))}
        {error && <div className="form-error" role="alert">{error}</div>}
        <input type="submit" hidden />
      </form>
    </Modal>
  );
}
