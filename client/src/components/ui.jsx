// Shared UI primitives: modals, context menus, popouts, avatars, form controls.
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { createStore, useStoreOf } from '../lib/store.js';
import { useStore } from '../lib/state.js';
import { useToasts, dismissToast, toast } from '../lib/toast.js';
import { saveFile, downloadUrl, saveName } from '../lib/saveFile.js';
import { cx, colorFor, initials } from '../lib/utils.js';
import { pageZoom } from '../lib/zoom.js';
import { sanitizeDecoration, ADMIN_DECORATION_ID } from '../lib/perks.js';
import { Icon } from './icons.jsx';

// ---------------------------------------------------------------- modals
const modalStore = createStore({ stack: [] });
let modalSeq = 0;
/** Open a modal. `render` receives ({ close }) and returns JSX. Returns a close function. */
export function openModal(render, { onClose } = {}) {
  const id = ++modalSeq;
  const close = () => {
    modalStore.set((s) => ({ stack: s.stack.filter((m) => m.id !== id) }));
    onClose?.();
  };
  modalStore.set((s) => ({ stack: [...s.stack, { id, render, close }] }));
  return close;
}
export function closeAllModals() { modalStore.set({ stack: [] }); }
export const useHasModal = () => useStoreOf(modalStore, (s) => s.stack.length > 0);

export function ModalRoot() {
  const stack = useStoreOf(modalStore, (s) => s.stack);
  useEffect(() => {
    if (!stack.length) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); stack[stack.length - 1].close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack]);
  return stack.map((m, i) => (
    <div key={m.id} className="modal-layer" style={{ zIndex: 1000 + i }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) m.close(); }}>
      {m.render({ close: m.close })}
    </div>
  ));
}

export function Modal({ title, subtitle, children, footer, onClose, size = 'md', className, bodyClass }) {
  return (
    <div className={cx('modal', `modal-${size}`, className)} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      {onClose && <button className="modal-close icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={22} /></button>}
      {(title || subtitle) && (
        <div className="modal-header">
          {title && <h2>{title}</h2>}
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
      )}
      <div className={cx('modal-body', bodyClass)}>{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  );
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openModal(({ close }) => (
      <Modal title={title} onClose={() => { finish(false); close(); }} size="sm"
        footer={<>
          <Button variant="link" onClick={() => { finish(false); close(); }}>{cancelText}</Button>
          <Button variant={danger ? 'danger' : 'primary'} autoFocus onClick={() => { finish(true); close(); }}>{confirmText}</Button>
        </>}>
        <div className="confirm-body">{body}</div>
      </Modal>
    ), { onClose: () => finish(false) });
  });
}

/** Promise-based single text input prompt. */
export function promptDialog({ title, label, initial = '', placeholder, confirmText = 'Save', maxLength = 100, description }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    function PromptBody({ close }) {
      const [v, setV] = useState(initial);
      const submit = (e) => { e?.preventDefault(); finish(v); close(); };
      return (
        <Modal title={title} onClose={() => { finish(null); close(); }} size="sm"
          footer={<><Button variant="link" onClick={() => { finish(null); close(); }}>Cancel</Button><Button onClick={submit}>{confirmText}</Button></>}>
          <form onSubmit={submit}>
            {description && <p className="muted small mb">{description}</p>}
            <Field label={label}><input className="input" autoFocus value={v} maxLength={maxLength} placeholder={placeholder} onChange={(e) => setV(e.target.value)} /></Field>
          </form>
        </Modal>
      );
    }
    openModal(({ close }) => <PromptBody close={close} />, { onClose: () => finish(null) });
  });
}

// ---------------------------------------------------------------- context menus
const menuStore = createStore({ menu: null });
/** items: [{ label, onClick, icon, danger, disabled, checked, hint, items (submenu), render, type: 'separator' }] */
export function openContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const x = e.clientX ?? e.currentTarget?.getBoundingClientRect().left ?? 0;
  const y = e.clientY ?? e.currentTarget?.getBoundingClientRect().bottom ?? 0;
  const pos = (x === 0 && y === 0 && e.currentTarget?.getBoundingClientRect) ? e.currentTarget.getBoundingClientRect() : null;
  // A menu opened by clicking a button remembers where that button is, so near the bottom of the screen (the buttons beside the message
  // box) it can open above the button instead of on top of it.
  const btn = e.type === 'click' && e.currentTarget?.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
  menuStore.set({ menu: { x: pos ? pos.left : x, y: pos ? pos.bottom : y, anchorTop: btn ? btn.top : null, items: items.filter(Boolean) } });
}
export function closeContextMenu() { menuStore.set({ menu: null }); }

function MenuList({ items, x, y, anchorTop = null, onDone, sub }) {
  const ref = useRef(null);
  // Measured at the top-left corner first, so a menu opened near the right/bottom edge can't make a phone zoom out (a fixed box that
  // sticks out of the screen widens the layout viewport) before it has been moved back inside.
  const [pos, setPos] = useState({ left: 0, top: 0, visible: false });
  const [openSub, setOpenSub] = useState(null);
  const z = pageZoom();   // pos is in screen pixels; the style below is in CSS pixels (see lib/zoom.js)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // the size in screen pixels from the layout (getBoundingClientRect would be the box still mid-"pop in", 96% of its size)
    const r = { width: el.offsetWidth * z, height: el.offsetHeight * z };
    let left = x; let top = y;
    if (left + r.width > window.innerWidth - 8) left = sub ? x - r.width - (sub.parentWidth || 0) : window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) {
      // No room below: above the button that opened it if it fits there (otherwise slid up just far enough to fit, as for a right-click).
      const above = anchorTop == null ? -1 : anchorTop - 6 - r.height;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ left: Math.max(8, left), top, visible: true });
  }, [x, y, sub, anchorTop]);
  // Collapse consecutive / edge separators.
  const clean = items.filter((it, i, arr) => !(it.type === 'separator' && (i === 0 || i === arr.length - 1 || arr[i - 1]?.type === 'separator')));
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.left / z, top: pos.top / z, visibility: pos.visible ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()} role="menu">
      {clean.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="menu-sep" />;
        if (it.render) return <div key={i} className="menu-custom" onMouseEnter={() => setOpenSub(null)}>{it.render()}</div>;
        return (
          <div key={i} role="menuitem"
            className={cx('menu-item', it.danger && 'danger', it.disabled && 'disabled', openSub === i && 'active')}
            onMouseEnter={() => setOpenSub(it.items ? i : null)}
            onClick={(e) => {
              if (it.disabled || it.items) return;
              e.stopPropagation();
              onDone();
              it.onClick?.(e);
            }}>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.checked !== undefined && <span className={cx('menu-check', it.checked && 'on')}>{it.checked && <Icon name="check" size={14} strokeWidth={3} />}</span>}
            {it.icon && it.checked === undefined && <Icon name={it.icon} size={16} />}
            {it.items && <Icon name="chevronRight" size={14} />}
            {it.items && openSub === i && <SubMenu items={it.items} onDone={onDone} />}
          </div>
        );
      })}
    </div>
  );
}
function SubMenu({ items, onDone }) {
  const anchor = useRef(null);
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => { setRect(anchor.current?.parentElement.getBoundingClientRect()); }, []);
  return (
    <span ref={anchor}>
      {rect && createPortal(<MenuList items={items} x={rect.right + 4} y={rect.top - 6} onDone={onDone} sub={{ parentWidth: rect.width + 8 }} />, document.body)}
    </span>
  );
}

// Phones fire fake mouse events (mousedown, mouseup, click) right after a finger is lifted. When a
// menu opens from a long press, those fake events used to count as "a tap outside the menu" and
// closed it the instant you let go, or even tapped an item that happened to sit under your finger.
// So we note which touch is down, and ignore the fake events that follow the touch that opened a menu.
let touchSeq = 0;
let touchDown = false;
let touchEndedAt = 0;
if (typeof window !== 'undefined') {
  const opts = { capture: true, passive: true };
  window.addEventListener('touchstart', () => { touchSeq += 1; touchDown = true; }, opts);
  const end = () => { touchDown = false; touchEndedAt = Date.now(); };
  window.addEventListener('touchend', end, opts);
  window.addEventListener('touchcancel', end, opts);
}

export function ContextMenuRoot() {
  const menu = useStoreOf(menuStore, (s) => s.menu);
  useEffect(() => {
    if (!menu) return undefined;
    const openedByTouch = touchDown ? touchSeq : -1;
    const fromOpeningTouch = () => openedByTouch === touchSeq && !touchDown && Date.now() - touchEndedAt < 700;
    const close = (e) => {
      if (fromOpeningTouch()) return;
      if (!e.target.closest?.('.context-menu')) closeContextMenu();
    };
    const swallow = (e) => { if (fromOpeningTouch()) { e.stopPropagation(); e.preventDefault(); } };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, [menu]);
  if (!menu) return null;
  return <div className="menu-layer"><MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} anchorTop={menu.anchorTop} onDone={closeContextMenu} /></div>;
}

// ---------------------------------------------------------------- popouts
const popoutStore = createStore({ popout: null });
let popoutSeq = 0;
/** Open a floating panel anchored to an element. render receives ({ close }). */
export function openPopout(anchorEl, render, { placement = 'right', align = 'start', offset = 8, key } = {}) {
  const cur = popoutStore.get().popout;
  if (key && cur?.key === key) { closePopout(); return; }
  const rect = anchorEl.getBoundingClientRect();
  popoutStore.set({ popout: { id: ++popoutSeq, rect, render, placement, align, offset, key } });
}
export function closePopout() { popoutStore.set({ popout: null }); }

export function PopoutRoot() {
  const p = useStoreOf(popoutStore, (s) => s.popout);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!p || !ref.current) { setPos(null); return; }
    const z = pageZoom();
    const el = { width: ref.current.offsetWidth * z, height: ref.current.offsetHeight * z };   // layout size in screen pixels (not mid-animation)
    const { rect, placement, align, offset } = p;
    const vw = window.innerWidth; const vh = window.innerHeight;
    let left; let top;
    if (vw < 600 && el.width > vw - 40) { left = (vw - el.width) / 2; top = Math.max(8, (vh - el.height) / 2); }
    else if (placement === 'right') { left = rect.right + offset; top = align === 'end' ? rect.bottom - el.height : rect.top; }
    else if (placement === 'left') { left = rect.left - el.width - offset; top = align === 'end' ? rect.bottom - el.height : rect.top; }
    else if (placement === 'top') { top = rect.top - el.height - offset; left = align === 'end' ? rect.right - el.width : align === 'center' ? rect.left + rect.width / 2 - el.width / 2 : rect.left; }
    else { top = rect.bottom + offset; left = align === 'end' ? rect.right - el.width : align === 'center' ? rect.left + rect.width / 2 - el.width / 2 : rect.left; }
    if (placement === 'right' && left + el.width > vw - 8) left = rect.left - el.width - offset;
    if (placement === 'left' && left < 8) left = rect.right + offset;
    left = Math.min(Math.max(8, left), vw - el.width - 8);
    top = Math.min(Math.max(8, top), vh - el.height - 8);
    setPos({ left, top });
  }, [p]);
  useEffect(() => {
    if (!p) return undefined;
    const onDown = (e) => {
      // (a tap on a toast, such as "Undo" after un-starring a GIF, is not a tap outside)
      if (ref.current?.contains(e.target) || e.target.closest?.('.context-menu,.modal-layer,.toaster')) return;
      closePopout();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopout(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [p]);
  if (!p) return null;
  return (
    <div className="popout" ref={ref} key={p.id} style={pos ? { left: pos.left / pageZoom(), top: pos.top / pageZoom() } : { left: -9999, top: -9999 }}>
      {p.render({ close: closePopout })}
    </div>
  );
}

// ---------------------------------------------------------------- avatars & status
export function StatusDot({ status, mobile, size = 10, className }) {
  if (!status) return null;
  return <span className={cx('status-dot', `status-${status}`, mobile && status === 'online' && 'mobile', className)} style={{ '--sd': `${size}px` }} title={status} />;
}

const DECO_WIDTH_MULT = [0, 0.6, 1, 1.5];
/** The pieces drawn around an avatar: a ready-made decoration (by id) or a user-designed one. */
function DecoLayers({ deco }) {
  if (deco === ADMIN_DECORATION_ID) {
    return (
      <>
        <span className="avatar-deco deco-admin" aria-hidden="true" />
        <span className="avatar-crest" aria-hidden="true"><i className="cr-orbit" /><i className="cr-wing l" /><i className="cr-wing r" /><i className="cr-crown" /><i className="cr-gem" /></span>
      </>
    );
  }
  if (deco.kind === 'image') {
    // the user's own picture: `scale` avatar-widths wide, centred on the avatar and moved by (x, y) avatar-widths (the URL is checked by the sanitizer)
    return <span className="avatar-imgdeco" aria-hidden="true" style={{ '--sc': deco.scale, '--ox': deco.x || 0, '--oy': deco.y || 0, backgroundImage: `url("${deco.url}")` }} />;
  }
  if (typeof deco === 'string') return <span className={`avatar-deco deco-${deco}`} aria-hidden="true"><i /><i /><i /></span>;
  const [a, b = a, c = b] = deco.colors;
  return (
    <>
      <span
        className={cx('avatar-deco deco-custom', `dc-${deco.style}`, deco.motion !== 'none' && `dcm-${deco.motion}`, deco.glow === 0 && 'dcg-off')} aria-hidden="true"
        style={{ '--c1': a, '--c2': b, '--c3': c, '--dw': DECO_WIDTH_MULT[deco.width], '--dg': deco.glow }}
      />
      {deco.acc !== 'none' && <span className={`avatar-acc acc-${deco.acc}`} aria-hidden="true" style={{ '--ac': deco.accColor }}><i /><i /><i /></span>}
    </>
  );
}

/** `guildId` shows the picture the person chose for that server, if they chose one. */
export function Avatar({ userId, user: userProp, size = 40, status: showStatus = false, speaking = false, className, onClick, onContextMenu, src: srcProp, name: nameProp, guildId }) {
  const user = useStore((s) => userProp || (userId ? s.users[userId] : null));
  const serverPic = useStore((s) => (guildId && (userId || userProp?.id) ? s.members[guildId]?.[userId || userProp.id]?.avatar || null : null));
  const presence = useStore((s) => (showStatus && (userId || userProp?.id) ? s.presences[userId || userProp.id] : null));
  const id = userId || user?.id || nameProp;
  const name = nameProp || user?.displayName || user?.username || '?';
  const src = srcProp !== undefined ? srcProp : (serverPic || user?.avatar);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  const status = showStatus ? (presence?.status || 'offline') : null;
  // Free avatar decoration (drawn around the picture; too small to read below ~28px).
  const deco = size >= 28 ? sanitizeDecoration(user?.avatarDecoration) : null;
  return (
    <div className={cx('avatar', deco && 'has-deco', speaking && 'speaking', onClick && 'clickable', className)} style={{ width: size, height: size, ...(deco ? { '--av': `${size}px` } : null) }} onClick={onClick} onContextMenu={onContextMenu}>
      {src && !broken
        ? <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
        : <div className="avatar-fallback" style={{ background: colorFor(id), fontSize: size * 0.4 }}>{initials(name)}</div>}
      {deco && <DecoLayers deco={deco} />}
      {status && <StatusDot status={status} mobile={presence?.mobile} size={Math.max(8, Math.round(size * 0.3))} />}
    </div>
  );
}

export function GuildIcon({ guild, size = 48, className }) {
  if (!guild) return null;
  return (
    <div className={cx('guild-icon', className)} style={{ width: size, height: size }}>
      {guild.icon ? <img src={guild.icon} alt="" draggable={false} /> : <span style={{ fontSize: Math.max(10, size * 0.32) }}>{initials(guild.name)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- controls
export function Button({ variant = 'primary', size, loading, children, className, type = 'button', disabled, ...rest }) {
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, size && `btn-${size}`, loading && 'loading', className)} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={16} /> : children}
    </button>
  );
}

export function IconButton({ icon, label, onClick, active, danger, size = 20, className, badge, disabled, tooltipSide = 'bottom', ...rest }) {
  return (
    <button type="button" className={cx('icon-btn', active && 'active', danger && 'danger', className)} onClick={onClick} aria-label={label}
      data-tooltip={label} data-tooltip-side={tooltipSide} disabled={disabled} {...rest}>
      <Icon name={icon} size={size} />
      {badge ? <span className="icon-badge">{badge}</span> : null}
    </button>
  );
}

export function Spinner({ size = 24 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={typeof label === 'string' ? label : undefined} disabled={disabled} className={cx('switch', checked && 'on')}
      onClick={() => !disabled && onChange(!checked)}>
      <span className="switch-knob">{checked ? <Icon name="check" size={12} strokeWidth={3} /> : <Icon name="x" size={12} strokeWidth={3} />}</span>
    </button>
  );
}

export function Field({ label, error, hint, children, required, className }) {
  return (
    <label className={cx('field', error && 'has-error', className)}>
      {label && (
        <span className="field-label">
          {label}{required && <span className="req"> *</span>}
          {error && <span className="field-error"> — {error}</span>}
        </span>
      )}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SettingRow({ title, description, children, divider = true }) {
  return (
    <div className={cx('setting-row', divider && 'divider')}>
      <div className="setting-row-main">
        <div className="setting-title">{title}</div>
        {children}
      </div>
      {description && <div className="setting-desc">{description}</div>}
    </div>
  );
}

export function ToggleSetting({ title, description, checked, onChange, disabled }) {
  return (
    <SettingRow title={title} description={description}>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </SettingRow>
  );
}

export function Select({ value, onChange, options, className, disabled }) {
  return (
    <select className={cx('input select', className)} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Slider({ value, min = 0, max = 100, step = 1, onChange, format, marks }) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%` }} />
      <span className="slider-value">{format ? format(value) : value}</span>
      {marks && <div className="slider-marks">{marks.map((m) => <span key={m}>{format ? format(m) : m}</span>)}</div>}
    </div>
  );
}

// ---- how long: ready-made lengths plus "Custom" (a number and minutes / hours / days / weeks). The value is in seconds.
export const DURATION_MAX = 28 * 24 * 3600;   // timeouts can last at most 28 days
const DURATION_UNITS = [['60', 'minutes'], ['3600', 'hours'], ['86400', 'days'], ['604800', 'weeks']];
/** 5400 → "90 minutes", 3600 → "1 hour" */
export function spellDuration(sec) {
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  for (const [n, word] of [[604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (sec % n === 0) return `${sec / n} ${word}${sec / n === 1 ? '' : 's'}`;
  }
  return `${Math.round(sec / 60)} minutes`;
}
export function DurationPicker({ value, onChange, presets, min = 60, max = DURATION_MAX }) {
  const isPreset = presets.some(([sec]) => sec === value);
  const [custom, setCustom] = useState(!isPreset);
  // the biggest unit the value is a whole number of
  const fit = (sec) => { const u = [...DURATION_UNITS].reverse().find(([n]) => sec >= Number(n) && sec % Number(n) === 0) || DURATION_UNITS[0]; return { unit: u[0], amount: String(Math.max(1, Math.round(sec / Number(u[0])))) }; };
  const [draft, setDraft] = useState(() => fit(value));
  const total = Math.round(Number(draft.amount) * Number(draft.unit));
  const bad = custom && (!Number.isFinite(total) || total < min || total > max);
  const set = (next) => { setDraft(next); const t = Math.round(Number(next.amount) * Number(next.unit)); if (Number.isFinite(t) && t >= min && t <= max) onChange(t); };
  return (
    <div className="duration-picker" data-duration>
      <div className="chip-row">
        {presets.map(([sec, label]) => <button key={sec} type="button" className={cx('chip', !custom && value === sec && 'active')} onClick={() => { setCustom(false); onChange(sec); }}>{label}</button>)}
        <button type="button" className={cx('chip', custom && 'active')} data-duration-custom onClick={() => { setCustom(true); setDraft(fit(value)); }}>Custom</button>
      </div>
      {custom && (
        <div className="duration-custom">
          <input className="input" type="number" inputMode="numeric" min="1" step="1" value={draft.amount} aria-label="How long" data-duration-amount onChange={(e) => set({ ...draft, amount: e.target.value })} />
          <select className="input" value={draft.unit} aria-label="Unit" data-duration-unit onChange={(e) => set({ ...draft, unit: e.target.value })}>
            {DURATION_UNITS.map(([n, word]) => <option key={n} value={n}>{word}</option>)}
          </select>
          {bad && <span className="error-text small" data-duration-error>Pick a length from {spellDuration(min)} to {spellDuration(max)}.</span>}
        </div>
      )}
    </div>
  );
}

export function RadioGroup({ value, onChange, options }) {
  return (
    <div className="radio-group" role="radiogroup">
      {options.map((o) => (
        <div key={o.value} role="radio" aria-checked={value === o.value} tabIndex={0} className={cx('radio-item', value === o.value && 'selected')}
          onClick={() => onChange(o.value)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(o.value); } }}>
          <span className="radio-circle" />
          <div><div className="radio-label">{o.label}</div>{o.description && <div className="radio-desc">{o.description}</div>}</div>
        </div>
      ))}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cx('tabs', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={cx('tab', value === t.value && 'active', t.className)} onClick={() => onChange(t.value)}>
          {t.label}{t.badge ? <span className="badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'sparkle', title, children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={40} /></div>
      {title && <h3>{title}</h3>}
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- toasts
export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.type}`, t.onClick && 'toast-action')} onClick={() => { dismissToast(t.id); try { t.onClick?.(); } catch (e) { console.error(e); } }}>
          <Icon name={t.type === 'error' ? 'x' : t.type === 'success' ? 'check' : t.type === 'warning' ? 'help' : 'bell'} size={16} />
          <span>{t.message}</span>
          {t.onClick && t.actionLabel && <b className="toast-cta">{t.actionLabel}</b>}
          {t.actions?.map((a) => (
            <button key={a.label} type="button" className="toast-cta secondary" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); try { a.onClick(); } catch (err) { console.error(err); } }}>{a.label}</button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- image viewer
/**
 * The picture in the viewer. Pinch (or scroll the wheel) to zoom, drag to move around while zoomed, double-tap or
 * double-click to zoom in and out, and drag it up or down when it is not zoomed to throw it away. It moves with
 * direct style changes rather than state, so it stays smooth under a finger.
 */
function ZoomableImage({ url, alt, onClose }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const img = ref.current;
    if (!img) return undefined;
    const MAX = 6;
    const v = { s: 1, x: 0, y: 0 };
    const pts = new Map();
    let pinch = null, drag = null, lastTap = null;
    const apply = (animate) => {
      img.style.transition = animate ? 'transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none';
      const z = pageZoom();   // v.x / v.y are screen pixels, translate() is in CSS pixels
      img.style.transform = `translate(${v.x / z}px, ${v.y / z}px) scale(${v.s})`;
      img.style.cursor = v.s > 1.02 ? 'grab' : 'zoom-in';
    };
    // How far the picture may be moved: only as far as its edges reaching the edges of the screen.
    const clamp = () => {
      const z = pageZoom();
      const lx = Math.max(0, (img.offsetWidth * z * v.s - window.innerWidth) / 2);
      const ly = Math.max(0, (img.offsetHeight * z * v.s - window.innerHeight) / 2);
      v.x = Math.max(-lx, Math.min(lx, v.x)); v.y = Math.max(-ly, Math.min(ly, v.y));
    };
    // Where the picture's centre would be with no zoom or movement.
    const home = () => { const r = img.getBoundingClientRect(); return { x: r.left + r.width / 2 - v.x, y: r.top + r.height / 2 - v.y }; };
    const zoomAt = (px, py, next) => {
      const c = home(), ns = Math.max(1, Math.min(MAX, next));
      v.x = px - c.x - (ns / v.s) * (px - c.x - v.x);
      v.y = py - c.y - (ns / v.s) * (py - c.y - v.y);
      v.s = ns;
    };
    const reset = (animate = true) => { v.s = 1; v.x = 0; v.y = 0; img.style.opacity = ''; apply(animate); };
    const twoPoints = () => { const [a, b] = [...pts.values()]; return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };

    const down = (e) => {
      img.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const { mx, my, d } = twoPoints(), c = home();
        pinch = { d0: d, s0: v.s, c, q: { x: (mx - c.x - v.x) / v.s, y: (my - c.y - v.y) / v.s } };
        drag = null;
      } else if (pts.size === 1) {
        drag = { x0: e.clientX, y0: e.clientY, tx: v.x, ty: v.y, t: performance.now(), moved: false };
      }
    };
    const move = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const { mx, my, d } = twoPoints();
        const ns = Math.max(0.8, Math.min(MAX, pinch.s0 * (d / pinch.d0)));
        v.s = ns; v.x = mx - pinch.c.x - ns * pinch.q.x; v.y = my - pinch.c.y - ns * pinch.q.y;
        if (ns >= 1) clamp();
        apply(false);
        return;
      }
      if (!drag || pts.size !== 1) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      if (v.s > 1.02) { v.x = drag.tx + dx; v.y = drag.ty + dy; clamp(); apply(false); }
      else if (drag.moved) { v.x = 0; v.y = dy; img.style.opacity = String(Math.max(0.35, 1 - Math.abs(dy) / 340)); apply(false); }
    };
    const up = (e, cancelled) => {
      if (!pts.delete(e.pointerId)) return;
      if (pinch) {
        if (pts.size < 2) {
          pinch = null;
          if (v.s < 1.05) reset(); else { clamp(); apply(true); }
          const rest = [...pts.values()][0];
          drag = rest ? { x0: rest.x, y0: rest.y, tx: v.x, ty: v.y, t: performance.now(), moved: true } : null;
        }
        return;
      }
      if (!drag) return;
      const d = drag; drag = null;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0, dt = Math.max(1, performance.now() - d.t);
      if (!cancelled && v.s <= 1.02 && Math.abs(dy) > Math.abs(dx) && (Math.abs(dy) > 110 || (Math.abs(dy) > 50 && Math.abs(dy) / dt > 0.6))) { closeRef.current(); return; }
      if (!d.moved) {
        if (cancelled) return;
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = null;
          if (v.s > 1.05) reset(); else { zoomAt(e.clientX, e.clientY, 2.5); clamp(); apply(true); }
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
        return;
      }
      if (v.s <= 1.02) reset(); else { clamp(); apply(true); }
    };
    const wheel = (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, v.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      if (v.s < 1.02) { v.s = 1; v.x = 0; v.y = 0; } else clamp();
      apply(false);
    };
    const upEv = (e) => up(e, false), cancelEv = (e) => up(e, true);
    img.addEventListener('pointerdown', down); img.addEventListener('pointermove', move);
    img.addEventListener('pointerup', upEv); img.addEventListener('pointercancel', cancelEv);
    img.addEventListener('wheel', wheel, { passive: false });
    return () => {
      img.removeEventListener('pointerdown', down); img.removeEventListener('pointermove', move);
      img.removeEventListener('pointerup', upEv); img.removeEventListener('pointercancel', cancelEv);
      img.removeEventListener('wheel', wheel);
    };
  }, [url]);
  return <img ref={ref} className="zoom-img" src={url} alt={alt} draggable={false} onClick={(e) => e.stopPropagation()} />;
}

export function openImageViewer(url, filename, description) {
  openModal(({ close }) => (
    <div className="image-viewer" onClick={close}>
      <ZoomableImage url={url} alt={description || filename || ''} onClose={close} />
      {description && <div className="image-viewer-alt" onClick={(e) => e.stopPropagation()}>{description}</div>}
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <a href={url} target="_blank" rel="noopener noreferrer">Open original</a>
        <a href={downloadUrl(url, saveName(url, filename))} download={saveName(url, filename)} data-save-file onClick={(e) => { e.preventDefault(); saveFile(url, filename).catch(() => toast('Could not save that. Try “Open original”.', 'error')); }}>Download</a>
      </div>
    </div>
  ));
}

// ---------------------------------------------------------------- hooks
export function useClickOutside(ref, fn, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) fn(e); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [ref, fn, active]);
}

export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => alive && setState({ loading: false, data, error: null }))
      .catch((error) => alive && setState({ loading: false, data: null, error }));
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { ...state, reload, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function useMediaQuery(q) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}

/** Long-press (touch) → context menu handler props, for devices without right-click. */
export function useLongPress(onLongPress, ms = 480) {
  const timer = useRef(null);
  const start = useRef(null);
  const clear = () => { clearTimeout(timer.current); timer.current = null; };
  return {
    onTouchStart: (e) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      const target = e.currentTarget;
      clear();
      timer.current = setTimeout(() => {
        navigator.vibrate?.(15);
        onLongPress({ preventDefault() {}, stopPropagation() {}, clientX: start.current.x, clientY: start.current.y, currentTarget: target, target: e.target });
      }, ms);
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (start.current && (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10)) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  };
}

/** File picker helper. */
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(multiple ? [...input.files] : input.files[0] || null);
    input.click();
  });
}
