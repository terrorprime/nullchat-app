// Reports: how many are waiting for you (the badges), live updates when one arrives, and where to go to read them.
// Moderators of a server (anyone who can manage messages there) see that server's reports in Server Settings → Reports;
// the site admin and the site mods see every report on this NullChat (messages in any server, direct messages, things a server owner wrote)
// in the Admin Panel / Mod Panel.
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { openGuildSettings, openUserSettings, uiStore } from './ui.js';

store.set({ reportCounts: { guilds: {}, site: null, appeals: 0 }, reportsTick: 0, appealsTick: 0, adminTab: null, modTab: null });

export function loadReportCounts() {
  if (!store.get().me) return Promise.resolve();
  return api.get('/reports/summary').then((r) => store.set({ reportCounts: { guilds: r.guilds || {}, site: r.site ?? null, appeals: r.appeals || 0, overlap: r.overlap || 0 } })).catch(() => {});
}
const bump = () => store.set({ reportsTick: store.get().reportsTick + 1 });

on('READY', loadReportCounts);
on('REPORT_CREATE', (d) => {
  loadReportCounts(); bump();
  const where = d.guildName || (d.target === 'site' ? 'this NullChat' : 'a server');   // (a report in a server names it, for site staff too; a direct message is "this NullChat")
  toast(`A message was reported in ${where}.`, 'info', 9000, { actionLabel: 'Review', onClick: () => openReports(d.target === 'site' ? { site: true } : { guildId: d.guildId }) });
});
on('REPORT_UPDATE', () => { loadReportCounts(); bump(); });
// Someone who is suspended wrote an appeal (or another moderator answered one): staff see the badge change and the list refresh.
on('APPEAL_UPDATE', (d) => {
  loadReportCounts(); store.set({ appealsTick: store.get().appealsTick + 1 });
  if (d.kind === 'new') toast(`${d.username || 'Someone'} appealed a suspension.`, 'info', 9000, { actionLabel: 'Review', onClick: openAppeals });
});
// Raid protection paused a server's new members (a rush of joins): the people who manage it hear at once.
on('RAID_ALERT', (d) => {
  toast(`${d.guildName}: ${d.joins} people joined within a minute, so new members are paused for 10 minutes.`, 'warning', 15000, { actionLabel: 'Review', onClick: () => openGuildSettings(d.guildId, 'moderation') });
});
// An admin made this person a mod, or took it back: the counts change, and they are told what it means.
on('MOD_UPDATE', (d) => {
  loadReportCounts(); bump();
  if (d.isDevJr) toast('You’re now a Dev Jr. Your Dev Jr Panel is in Settings.', 'success', 9000, { actionLabel: 'Open', onClick: () => openUserSettings('mod') });
  else if (d.isMod) toast('You’re now a moderator. Your Mod Panel is in Settings.', 'success', 9000, { actionLabel: 'Open', onClick: () => openUserSettings('mod') });
  else {
    toast(d.removed === 'devjr' ? 'You’re no longer a Dev Jr.' : 'You’re no longer a moderator.', 'info');
    // (their panel is gone: if it is open right now, go back to My Account instead of leaving a page that only shows errors)
    const st = uiStore.get().settings;
    if (st?.type === 'user' && st.tab === 'mod') uiStore.set({ settings: { ...st, tab: 'account' } });
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadReportCounts(); });

/** Open the place where these reports are handled. */
export function openReports({ guildId, site } = {}) {
  if (site || !guildId) {
    // (the admin handles these in the Admin Panel, a mod in the Mod Panel)
    if (store.get().me?.isAdmin) { store.set({ adminTab: 'reports' }); openUserSettings('admin'); }
    else { store.set({ modTab: 'reports' }); openUserSettings('mod'); }
  }
  else openGuildSettings(guildId, 'reports');
}

/** Open the appeals queue (Admin Panel or Mod Panel). */
export function openAppeals() {
  if (store.get().me?.isAdmin) { store.set({ adminTab: 'appeals' }); openUserSettings('admin'); }
  else { store.set({ modTab: 'appeals' }); openUserSettings('mod'); }
}

/** Total waiting for this person, over every server they moderate and the site. */
export const totalReports = (c) => Object.values(c?.guilds || {}).reduce((a, b) => a + b, 0) + (c?.site || 0) - (c?.overlap || 0);   // (a server's report that is also in the site list counts once)
/** Everything waiting for staff on the site (every report, plus appeals). */
export const siteWaiting = (c) => (c?.site || 0) + (c?.appeals || 0);
