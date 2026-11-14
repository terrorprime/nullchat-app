import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getToken, setToken, setUnauthorizedHandler, api } from './lib/api.js';
import { forgetToken, refreshAccount } from './lib/accounts.js';
import { connect, disconnect, on, send } from './lib/gateway.js';
import { store, useStore, firstTextChannel, sortedGuildChannels, isChannelUnread, guildPermissions } from './lib/state.js';
import { navigate, usePath, useSearch, matchPath } from './lib/router.jsx';
import { useUI, setUI, uiStore, openUserSettings, closeSettings } from './lib/ui.js';
import { setActiveChannel } from './lib/notify.js';
import { registerAction } from './lib/keybinds.js';
import { toggleMute, toggleDeafen, toggleCamera, useVoice } from './lib/voice.js';
import { ackChannel, ackGuild, channelPath } from './lib/actions.js';
import { toast } from './lib/toast.js';
import { startActivityTracker } from './lib/activity.js';
import { useT } from './lib/i18n.js';
import { cx } from './lib/utils.js';
import { ChannelType } from '../../shared/permissions.js';
import { ModalRoot, ContextMenuRoot, PopoutRoot, Toaster, Spinner, Button, closeAllModals, useMediaQuery } from './components/ui.jsx';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage, InvitePage } from './components/Auth.jsx';
import { GuildBar, GuildSidebar, DMSidebar, VoicePanel, UserPanel } from './components/Sidebar.jsx';
import { ChannelView } from './components/Chat.jsx';
import { VoiceChannelView, StageChannelView, IncomingCalls } from './components/Voice.jsx';
import { CallPopoutHost } from './components/CallPopout.jsx';
import { FriendsPage, DiscoveryPage } from './components/Friends.jsx';
import { AppDirectoryPage } from './components/Apps.jsx';
import { UserSettings } from './components/UserSettings.jsx';
import { ServerSettings, ChannelSettings } from './components/ServerSettings.jsx';
import { openQuickSwitcher, openShortcuts, openCreateServer, openOnboarding } from './components/modals.jsx';
import { Logo, Icon } from './components/icons.jsx';
import { PhoneBanner, InstallPage } from './components/InstallApp.jsx';
import { UpdateBanner } from './components/UpdateBanner.jsx';
import { AnnouncementBar } from './components/AnnouncementBar.jsx';
import { BotModalHost } from './components/BotComponents.jsx';
import { maybeShowWhatsNew } from './components/WhatsNew.jsx';
import { CatchUpCard } from './components/CatchUp.jsx';
import { maybeCatchUp } from './lib/catchup.js';
import { startAmbience } from './lib/ambience.js';
import { announceMusic } from './components/Music.jsx';
import { loadStreaks, reportTimeZone, cheerStreak } from './lib/streaks.js';
import { announceMood } from './components/Mood.jsx';
import { onVoiceMood, onVoiceMusic, onStreak } from './lib/state.js';
import { voiceStore } from './lib/voice.js';
import { TemplatePage } from './components/Templates.jsx';
import { MobileTabBar, useSwipeNav } from './components/MobileNav.jsx';
import { startUpdateChecks } from './lib/updates.js';
import { syncPush, listenForNotificationTaps } from './lib/push.js';

const PUBLIC = ['/login', '/register', '/forgot-password'];

function resetSession(reason) {
  forgetToken(getToken());   // its sign-in no longer works (or was ended), so it is not kept for switching either
  disconnect();
  setToken(null);
  closeAllModals();
  uiStore.set({ settings: null });
  store.set({ status: 'idle', me: null, guilds: {}, channels: {}, messages: {}, users: {}, privateChannelIds: [], relationships: {} });
  if (reason) toast(reason, 'warning');
  navigate(`/login${location.pathname.startsWith('/channels') ? `?redirect=${encodeURIComponent(location.pathname + location.search)}` : ''}`, { replace: true });
}

export default function App() {
  const path = usePath();
  const status = useStore((s) => s.status);
  const hasMe = useStore((s) => !!s.me);
  const token = getToken();

  useEffect(() => {
    setUnauthorizedHandler(() => { if (getToken()) resetSession('Your session expired. Please log in again.'); });
    const off = on('INVALID_SESSION', (d) => resetSession(d?.reason && d.reason !== 'Logged out' ? `You were logged out: ${d.reason}` : null));
    if (getToken()) connect();
    startUpdateChecks();
    listenForNotificationTaps();
    return off;
  }, []);
  // Keep this device's closed-app notifications attached to whoever is logged in (browsers sometimes change the address).
  useEffect(() => { if (hasMe) syncPush(); }, [hasMe]);
  // The name and picture shown in the account switcher follow the account (if it was added there).
  const meName = useStore((s) => s.me?.displayName), meUsername = useStore((s) => s.me?.username), meAvatar = useStore((s) => s.me?.avatar);
  useEffect(() => { const me = store.get().me; if (me) refreshAccount(me); }, [meName, meUsername, meAvatar, hasMe]);
  // Another tab signed in as someone else (or out): this one must not go on showing, and sending as, the account it started with.
  useEffect(() => {
    const started = getToken();
    const onStorage = (e) => { if (e.storageArea === localStorage && e.key === 'nullchat.token' && getToken() !== started) location.reload(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Routes that work with or without a session.
  const inviteMatch = matchPath('/invite/:code/:source?', path);   // (the second part is the "joined from" label: /invite/pixelclub/youtube)
  if (inviteMatch) return <Shell banner><InvitePage code={inviteMatch.code} source={inviteMatch.source} /></Shell>;
  const templateMatch = matchPath('/template/:code', path);
  if (templateMatch) return <Shell banner><TemplatePage code={templateMatch.code} /></Shell>;
  if (path === '/reset-password') return <Shell banner><ResetPasswordPage /></Shell>;
  if (path === '/install') return <Shell banner><InstallPage /></Shell>;

  if (!token) {
    if (!PUBLIC.includes(path)) { setTimeout(() => navigate(path === '/' ? '/login' : `/login?redirect=${encodeURIComponent(path + location.search)}`, { replace: true })); return <Shell />; }
    return <Shell banner>{path === '/register' ? <RegisterPage /> : path === '/forgot-password' ? <ForgotPasswordPage /> : <LoginPage />}</Shell>;
  }
  if (PUBLIC.includes(path) || path === '/') { setTimeout(() => navigate('/channels/@me', { replace: true })); return <Shell />; }
  if (!hasMe || status === 'connecting') return <Shell><Loading /></Shell>;
  return <Shell><AppShell path={path} /></Shell>;
}

function Shell({ children, banner }) {
  return (
    <>
      {banner && <UpdateBanner floating />}
      {banner && <AnnouncementBar floating />}
      {children}
      <ModalRoot />
      <BotModalHost />
      <PopoutRoot />
      <ContextMenuRoot />
      <Toaster />
    </>
  );
}

const TIPS = [
  'Press Ctrl+K to jump to any channel, DM or server.',
  'Right-click almost anything for more options.',
  'Hold Shift when deleting a message to skip the confirmation.',
  'Wrap text in ||double bars|| to make a spoiler.',
  'Press ↑ in an empty message box to edit your last message.',
  'Drag server icons to reorder them.',
];
function Loading() {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 6000); return () => clearTimeout(t); }, []);
  return (
    <div className="loading-screen">
      <div className="loading-logo"><Logo size={72} /></div>
      <div className="loading-label">DID YOU KNOW</div>
      <p className="muted">{tip}</p>
      {slow && <div className="loading-slow"><p className="small muted">Still connecting… Is the NullChat server running?</p><Button size="sm" variant="secondary" onClick={() => resetSession()}>Back to login</Button></div>}
    </div>
  );
}

function AppShell({ path }) {
  const t = useT();
  const search = useSearch();
  const guildIdRef = useRef(null);   // (the server on screen, for listeners set up once)
  const status = useStore((s) => s.status);
  const me = useStore((s) => s.me);
  const settings = useUI((u) => u.settings);
  const mobileNav = useUI((u) => u.mobileNav);
  const navGuild = useUI((u) => u.navGuild);
  const phone = useMediaQuery('(max-width: 768px)');
  const inVoice = useVoice((v) => !!v.channelId);
  const m = matchPath('/channels/:guildId/:channelId?', path);
  const appsRoute = matchPath('/apps/:botId?', path);   // the App Directory and one app's page (Discover → Apps)
  const isDiscovery = path === '/discovery' || !!appsRoute;
  const guildId = m?.guildId || (isDiscovery ? 'discovery' : '@me');
  const channelId = m?.channelId;
  const threadId = search.get('thread');
  const guild = useStore((s) => (guildId && guildId !== '@me' ? s.guilds[guildId] : null));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : null));
  const onboarded = useRef(false);

  // Phones: the servers + channels list is a screen of its own. Which server it lists can differ from the one that is
  // open until you pick a channel (tapping a server only changes the list, like Discord, so nothing gets marked as read).
  guildIdRef.current = guildId;
  const atHome = guildId === '@me' && !channelId; // Friends / Home, nothing opened
  const viewGuildId = phone && mobileNav && navGuild ? navGuild : guildId;
  const viewGuild = useStore((s) => (viewGuildId && viewGuildId !== '@me' && viewGuildId !== 'discovery' ? s.guilds[viewGuildId] : null));
  const viewingOpen = viewGuildId === guildId;
  const firstPath = useRef(true);
  useLayoutEffect(() => {
    if (!phone) return;
    // Opening the app (or logging in) with nothing open shows the list; a link to a chat shows the chat.
    if (firstPath.current) { firstPath.current = false; setUI({ mobileNav: atHome, navGuild: null }); return; }
    // Anything else that takes you somewhere (a notification, a link, the quick switcher) shows that place.
    if (!atHome) setUI({ mobileNav: false });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  // The phone's Back button / swipe-back from a chat lands on the list.
  useEffect(() => {
    if (!phone) return undefined;
    const onPop = () => { const mm = matchPath('/channels/:guildId/:channelId?', location.pathname); setUI({ mobileNav: !!mm && mm.guildId === '@me' && !mm.channelId }); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [phone]);
  useEffect(() => {
    if (!mobileNav && uiStore.get().navGuild) setUI({ navGuild: null });
    else if (navGuild && navGuild !== '@me' && !store.get().guilds[navGuild]) setUI({ navGuild: null });
  }, [mobileNav, navGuild]);
  useSwipeNav(phone);

  // Desktop app: show "Playing X" while a known game is running.
  useEffect(() => startActivityTracker(), []);
  // Mood rooms: the room sound of the voice channel you are in, and a note when someone in your room changes it.
  useEffect(() => { startAmbience(); onVoiceMood((d) => { if (voiceStore.get().channelId === d.channelId) announceMood(d); }); }, []);

  // The music queue of your voice channel: a note when someone else adds or skips. Streaks: load them, and cheer at the round numbers.
  useEffect(() => { onVoiceMusic((d) => { if (voiceStore.get().channelId === d.channelId) announceMusic(d); }); }, []);
  useEffect(() => { onStreak((d) => cheerStreak(d, guildIdRef.current)); }, []);
  useEffect(() => { if (status === 'ready') { loadStreaks(); reportTimeZone(); } }, [status]);

  // Unknown route → home
  useEffect(() => {
    if (!m && !isDiscovery) navigate('/channels/@me', { replace: true });
  }, [m, isDiscovery]);

  // Resolve guild → default channel; handle missing guilds / channels.
  useEffect(() => {
    if (!m || guildId === '@me') return;
    const s = store.get();
    if (!s.guilds[guildId]) { navigate('/channels/@me', { replace: true }); return; }
    if (!channelId || !s.channels[channelId]) {
      const last = uiStore.get().lastChannel[guildId];
      const target = (last && s.channels[last]) ? last : firstTextChannel(s, guildId)?.id;
      if (target) navigate(`/channels/${guildId}/${target}`, { replace: true });
    }
  }, [guildId, channelId, guild, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming into a server: the catch-up card, when there is a backlog worth one (lib/catchup.js decides).
  const guildReady = !!guild;
  useEffect(() => { if (guildReady && guildId !== '@me') maybeCatchUp(guildId); }, [guildId, guildReady]);

  useEffect(() => {
    if (m && guildId === '@me' && channelId && !store.get().channels[channelId]) {
      api.get(`/channels/${channelId}`).then((c) => store.set({ channels: { ...store.get().channels, [c.id]: c }, privateChannelIds: [c.id, ...store.get().privateChannelIds.filter((x) => x !== c.id)] }))
        .catch(() => navigate('/channels/@me', { replace: true }));
    }
  }, [guildId, channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember last channel per guild + tell notifications which channel is visible.
  useEffect(() => {
    if (guildId && guildId !== '@me' && channelId) uiStore.set({ lastChannel: { ...uiStore.get().lastChannel, [guildId]: channelId } });
    // On a phone, a chat that is covered by the list isn't being looked at (new messages stay unread).
    setActiveChannel(phone && mobileNav ? null : threadId || channelId || null);
    return () => setActiveChannel(null);
  }, [guildId, channelId, threadId, phone, mobileNav]);

  // First-run onboarding.
  useEffect(() => {
    if (me && !me.onboarded && !onboarded.current) { onboarded.current = true; setTimeout(openOnboarding, 400); }
  }, [me]);

  // "What's new" after an update: once per release per account (what it says is in lib/changelog.js).
  const ready = useStore((s) => s.status === 'ready');
  useEffect(() => {
    if (!ready || !me?.onboarded) return undefined;
    const t = setTimeout(maybeShowWhatsNew, 1500);
    return () => clearTimeout(t);
  }, [ready, me?.id, me?.onboarded]);

  // Idle detection (sets "idle" after 10 minutes without activity).
  useEffect(() => {
    let afk = false; let timer;
    const reset = () => {
      clearTimeout(timer);
      if (afk) { afk = false; send('presence', { afk: false }); }
      timer = setTimeout(() => { afk = true; send('presence', { afk: true }); }, 10 * 60 * 1000);
    };
    const evs = ['mousemove', 'keydown', 'pointerdown', 'focus'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, []);

  // Global keybinds.
  useEffect(() => {
    const offs = [
      registerAction('quickSwitcher', () => openQuickSwitcher()),
      registerAction('toggleMute', () => toggleMute()),
      registerAction('toggleDeafen', () => toggleDeafen()),
      registerAction('toggleCamera', () => toggleCamera()),
      registerAction('openSettings', () => openUserSettings()),
      registerAction('showShortcuts', () => openShortcuts()),
      registerAction('createServer', () => openCreateServer()),
      registerAction('markServerRead', () => { const g = location.pathname.split('/')[2]; if (g && g !== '@me') ackGuild(g); }),
      registerAction('prevChannel', () => cycleChannel(-1, false)),
      registerAction('nextChannel', () => cycleChannel(1, false)),
      registerAction('prevUnread', () => cycleChannel(-1, true)),
      registerAction('nextUnread', () => cycleChannel(1, true)),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  let main;
  if (appsRoute) main = <AppDirectoryPage key={appsRoute.botId || 'list'} botId={appsRoute.botId} />;
  else if (isDiscovery) main = <DiscoveryPage />;
  else if (guildId === '@me') main = channelId ? (channel ? <ChannelView key={channelId} channelId={channelId} /> : <div className="chat empty"><Spinner /></div>) : <FriendsPage />;
  else if (channel?.type === ChannelType.VOICE) main = <VoiceChannelView key={channelId} channelId={channelId} />;
  else if (channel?.type === ChannelType.STAGE) main = <StageChannelView key={channelId} channelId={channelId} />;
  else if (channel && channel.type !== ChannelType.CATEGORY) main = <ChannelView key={channelId} channelId={channelId} threadId={threadId} />;
  else main = <NoChannel guildId={guildId} />;

  return (
    <div className={cx('app', mobileNav && 'nav-open', inVoice && 'in-voice')}>
      {status === 'reconnecting' && <div className="conn-banner"><Spinner size={14} /> {t('reconnecting')}</div>}
      <AnnouncementBar />
      <UpdateBanner />
      <PhoneBanner />
      <CatchUpCard />
      <div className="app-body">
        <div className="nav-drawer">
          <GuildBar activeGuildId={viewGuildId} />
          <div className="sidebar">
            {viewGuild ? <GuildSidebar guildId={viewGuildId} channelId={viewingOpen ? channelId : undefined} threadId={viewingOpen ? threadId : undefined} /> : <DMSidebar channelId={viewGuildId === '@me' && viewingOpen ? channelId : null} />}
            <VoicePanel />
            <UserPanel />
          </div>
        </div>
        <main className="main">{main}</main>
      </div>
      {phone && <div className="swipe-reply-hint" aria-hidden="true"><Icon name="reply" size={18} /></div>}
      {phone && (mobileNav || atHome) && <MobileTabBar active={mobileNav ? 'home' : 'friends'} />}
      <IncomingCalls />
      <CallPopoutHost />
      {settings?.type === 'user' && <UserSettings />}
      {settings?.type === 'guild' && <ServerSettings />}
      {settings?.type === 'channel' && <ChannelSettings />}
    </div>
  );
}

function NoChannel({ guildId }) {
  const canManage = useStore((s) => (guildPermissions(s, guildId) & (1 << 4)) !== 0);
  return (
    <div className="chat empty">
      <div className="empty-state">
        <div className="empty-icon"><Icon name="hash" size={40} /></div>
        <h3>No text channels</h3>
        <p className="muted">You find yourself in a strange place. You don’t have access to any text channels, or there are none in this server.</p>
        {canManage && <p className="muted small">Right-click the channel list to create one.</p>}
      </div>
    </div>
  );
}

function cycleChannel(dir, unreadOnly) {
  const s = store.get();
  const [, , g, c] = location.pathname.split('/');
  if (!g) return;
  let list;
  if (g === '@me') list = s.privateChannelIds.map((id) => s.channels[id]).filter(Boolean);
  else {
    const { uncategorized, categories } = sortedGuildChannels(s, g);
    list = [...uncategorized, ...categories.flatMap((x) => x.channels)].filter((x) => x.type === ChannelType.TEXT || x.type === ChannelType.ANNOUNCEMENT || x.type === ChannelType.VOICE || x.type === ChannelType.STAGE || x.type === ChannelType.FORUM);
  }
  if (unreadOnly) list = list.filter((x) => x.id === c || isChannelUnread(s, x.id));
  if (!list.length) return;
  const idx = list.findIndex((x) => x.id === c);
  const next = list[(idx + dir + list.length) % list.length];
  if (next) navigate(channelPath(next));
}

export { ackChannel, closeSettings };
