// Phone navigation, the way Discord does it: the server + channel list is its own screen, the chat slides over it,
// a swipe (or the back arrow) goes back, and a tab bar along the bottom switches between Home, Friends, Inbox and You.
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useStore, unreadMentionTotal } from '../lib/state.js';
import { navigate, matchPath } from '../lib/router.jsx';
import { uiStore, setUI, openUserSettings, isPhone } from '../lib/ui.js';
import { cx } from '../lib/utils.js';
import { Avatar, StatusDot } from './ui.jsx';
import { Icon } from './icons.jsx';
import { pageZoom } from '../lib/zoom.js';
import { openInboxModal } from './Inbox.jsx';

/** Bottom tabs. `active` is 'home' (servers + channels) or 'friends'; Inbox and You open on top of what you were doing. */
export function MobileTabBar({ active }) {
  const pending = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 3).length);
  const mentions = useStore((s) => unreadMentionTotal(s));
  const meId = useStore((s) => s.me?.id);
  const status = useStore((s) => (s.me.status === 'invisible' ? 'invisible' : s.presences[s.me.id]?.status || s.me.status));
  const tab = (id, label, onClick, icon, badge = 0) => (
    <button key={id} type="button" role="tab" aria-selected={active === id} aria-label={label} className={cx('tab-btn', active === id && 'active')} onClick={onClick}>
      <span className="tab-icon">{icon}{badge > 0 && <span className="mention-badge tab-badge">{badge > 99 ? '99+' : badge}</span>}</span>
      <span className="tab-label">{label}</span>
    </button>
  );
  return (
    <nav className="tab-bar" role="tablist" aria-label="Main">
      {tab('home', 'Home', () => setUI({ mobileNav: true, navGuild: null }), <Icon name="home" size={24} />)}
      {tab('friends', 'Friends', () => { navigate('/channels/@me'); setUI({ mobileNav: false, navGuild: null }); }, <Icon name="friends" size={24} />, pending)}
      {tab('inbox', 'Inbox', () => openInboxModal(), <Icon name="inbox" size={24} />, mentions)}
      {tab('you', 'You', () => openUserSettings(), <span className="tab-me"><Avatar userId={meId} size={26} /><StatusDot status={status} size={10} className="tab-me-status" /></span>)}
    </nav>
  );
}

// ---------------------------------------------------------------- swipes
// Things a swipe must leave alone: text fields, open panels and menus, and anything that scrolls sideways itself.
const SKIP = '.modal-layer, .popout, .context-menu, .thread-panel, .search-panel, .member-list, .settings-overlay, input, textarea, select, video, [contenteditable="true"], .no-swipe, .reorder-on';
function scrollsSideways(el, stop) {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}
const hasOpenChat = () => !!matchPath('/channels/:guildId/:channelId?', location.pathname)?.channelId;
const canShowMembers = () => {
  const m = matchPath('/channels/:guildId/:channelId?', location.pathname);
  return !!m?.channelId && m.guildId !== '@me';
};

/**
 * Swipe right in a chat (or page) to get back to the servers and channels, left on that screen to return to the chat,
 * and left in a server chat to open the member list. The screens follow your finger.
 * Swiping a message to the left replies to it (like Discord); a left swipe that starts anywhere else in a server chat
 * (the header, empty space, a message you can't reply to) opens the member list.
 */
const REPLY_AT = 64; // px a message has to be pulled before letting go replies
export function useSwipeNav(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const body = document.querySelector('.app-body');
    const main = document.querySelector('.app-body > .main');
    const drawer = document.querySelector('.app-body > .nav-drawer');
    const hint = document.querySelector('.swipe-reply-hint');
    if (!body || !main || !drawer) return undefined;
    let g = null;

    const clearInline = () => {
      for (const el of [main, drawer]) { el.style.transform = ''; el.style.transition = ''; el.style.visibility = ''; }
    };
    // Put a pulled message (and the little reply arrow that appears behind it) back where they were.
    const settleReply = (state, animate = true) => {
      const el = state?.msg;
      if (el) {
        if (animate) { el.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)'; setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 200); }
        else { el.style.transition = ''; el.style.transform = ''; }
        el.style.transform = animate ? 'translateX(0)' : '';
      }
      if (hint) { hint.style.opacity = ''; hint.style.transform = ''; hint.classList.remove('armed'); }
    };
    const start = (e) => {
      g = null;
      if (!isPhone() || e.touches.length !== 1) return;
      const t = e.target;
      if (t.closest?.(SKIP) || scrollsSideways(t, body)) return;
      const msg = uiStore.get().mobileNav ? null : t.closest?.('.message[data-replyable]') || null;
      g = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), kind: null, dx: 0, msg, armed: false };
    };
    const move = (e) => {
      if (!g) return;
      const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
      if (!g.kind) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { g = null; return; } // it's a scroll
        if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
        const ui = uiStore.get();
        if (ui.mobileNav) g.kind = dx < 0 && hasOpenChat() ? 'toChat' : null;
        else if (dx > 0) g.kind = ui.mobileMembers ? 'closeMembers' : 'toNav';
        else if (ui.mobileMembers) g.kind = null;
        else if (g.msg) g.kind = 'reply';
        else g.kind = canShowMembers() ? 'members' : null;
        if (!g.kind) { g = null; return; }
      }
      g.dx = dx;
      if (g.kind === 'reply') {
        const pull = Math.min(110, Math.max(0, -dx));
        const shown = pull < REPLY_AT ? pull : REPLY_AT + (pull - REPLY_AT) * 0.35; // a little give once it is far enough
        g.msg.style.transition = 'none';
        g.msg.style.transform = `translateX(${-shown / pageZoom()}px)`;   // (finger movement is in screen pixels)
        const armed = pull >= REPLY_AT;
        if (armed !== g.armed) { g.armed = armed; if (armed) navigator.vibrate?.(8); }
        if (hint) {
          hint.style.top = `${Math.round(g.y / pageZoom() - 17)}px`;
          hint.style.opacity = String(Math.min(1, pull / 40));
          hint.style.transform = `scale(${armed ? 1.08 : 0.6 + 0.4 * Math.min(1, pull / REPLY_AT)})`;
          hint.classList.toggle('armed', armed);
        }
        return;
      }
      if (g.kind === 'toNav' || g.kind === 'toChat') {
        const W = window.innerWidth;
        const k = g.kind === 'toNav' ? Math.min(1, Math.max(0, dx / W)) : Math.min(1, Math.max(0, 1 + dx / W)); // how far the list is showing, 0..1
        main.style.transition = drawer.style.transition = 'none';
        main.style.visibility = drawer.style.visibility = 'visible';
        main.style.transform = `translateX(${k * 100}%)`;
        drawer.style.transform = `translateX(${(1 - k) * -28}%)`;
      }
    };
    const end = () => {
      const s = g; g = null;
      if (!s?.kind) return;
      const W = window.innerWidth, dt = Math.max(1, performance.now() - s.t), v = s.dx / dt; // px per ms
      if (s.kind === 'reply') {
        const reply = -s.dx >= REPLY_AT || (v < -0.5 && -s.dx > 40);
        settleReply(s);
        const id = s.msg.dataset.mid;
        if (reply && id) window.dispatchEvent(new CustomEvent('nullchat:swipe-reply', { detail: { id } }));
        return;
      }
      if (s.kind === 'members') { if (s.dx < -70 || (v < -0.5 && s.dx < -40)) setUI({ mobileMembers: true }); return; }
      if (s.kind === 'closeMembers') { if (s.dx > 70 || (v > 0.5 && s.dx > 40)) setUI({ mobileMembers: false }); return; }
      const toNav = s.kind === 'toNav';
      const go = toNav ? s.dx > W * 0.33 || (v > 0.45 && s.dx > 40) : -s.dx > W * 0.33 || (v < -0.45 && s.dx < -40);
      // Commit the state in the same frame the finger's position is released, so the slide carries on from where it was.
      flushSync(() => { if (go) setUI({ mobileNav: toNav, ...(toNav ? { navGuild: null } : {}) }); });
      clearInline();
    };
    const cancel = () => { if (g?.kind === 'toNav' || g?.kind === 'toChat') clearInline(); if (g?.kind === 'reply') settleReply(g); g = null; };
    body.addEventListener('touchstart', start, { passive: true });
    body.addEventListener('touchmove', move, { passive: true });
    body.addEventListener('touchend', end, { passive: true });
    body.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      body.removeEventListener('touchstart', start); body.removeEventListener('touchmove', move);
      body.removeEventListener('touchend', end); body.removeEventListener('touchcancel', cancel);
      if (g?.kind === 'reply') settleReply(g, false);
      clearInline();
    };
  }, [enabled]);
}
