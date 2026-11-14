// User settings overlay.
import { BirthdaySettings } from './Birthday.jsx';
import { VoiceSoundSettings } from './VoiceSounds.jsx';
import { ProfileSongSettings } from './ProfileSong.jsx';
import { PopoutSettings } from './CallPopout.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, store } from '../lib/state.js';
import { api, putImage } from '../lib/api.js';
import { logout } from '../lib/actions.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, formatDate, relativeTime, copyText } from '../lib/utils.js';
import { useUI, setUI, closeSettings, uiStore, isPhone, setUnsaved, refuseIfUnsaved } from '../lib/ui.js';
import { updateSettings, DEFAULTS, getLocal, setLocal, onLocalChange, DEFAULT_KEYBINDS, KEYBIND_LABELS, getSetting } from '../lib/settings.js';
import { zoomLimit } from '../lib/zoom.js';
import { captureNextCombo, prettyCombo } from '../lib/keybinds.js';
import { requestNotificationPermission } from '../lib/notify.js';
import { inNativeApp } from '../lib/native.js';
import { pushStatus, enablePush, disablePush, setPreview, setEveryMessage, sendTestPush } from '../lib/push.js';
import { play, configureSounds } from '../lib/sounds.js';
import { listDevices, resolveDevice, chooseDevice, openMicrophone, outputSink, canChooseOutput, deviceName } from '../lib/devices.js';
import { runConnectionTest } from '../lib/connectionTest.js';
import { reacquireMic, refreshOutputs, useVoice, switchCamera, VOICE_QUALITIES, CAMERA_QUALITIES, voiceQualityOf, cameraQualityOf } from '../lib/voice.js';
import { LANGUAGES, useT } from '../lib/i18n.js';
import { Markdown } from '../lib/markdown.jsx';
import {
  Button, Field, Modal, openModal, Switch, ToggleSetting, SettingRow, Select, Slider, RadioGroup, Avatar, pickFile, Spinner, confirmDialog, Tabs, StatusDot, openPopout,
} from './ui.jsx';
import { PasswordStrength } from './Auth.jsx';
import { CustomStatusLine, StatusMenu } from './Profile.jsx';
import { ThemeSection, CustomCssSection } from './ThemeEditor.jsx';
import { ProfileThemeEditor, NameStyleEditor, DecorationPicker, ProfileEffectPicker, EMPTY_NAME_STYLE, fitMessage } from './PerkEditors.jsx';
import { ProfileEffect } from './ProfileEffect.jsx';
import { fitDecorationImage } from '../lib/decorationFit.js';
import { profileThemeProps, bannerFallback, nameStyleProps, sanitizeNameStyle } from '../lib/perks.js';
import { MyServerTag, ServerTag } from './ServerTag.jsx';
import { Message } from './Messages.jsx';
import { Icon } from './icons.jsx';
import { desktop } from '../lib/install.js';
import { CURRENT_BUILD, useUpdates, checkForUpdate, checkShellUpdate } from '../lib/updates.js';
import { updateNow, restartForUpdate } from './UpdateBanner.jsx';
import { openWhatsNew } from './WhatsNew.jsx';
import { openDownloadApps } from './modals.jsx';
import { AdminPanel } from './AdminPanel.jsx';
import { ModPanel } from './ModPanel.jsx';
import { DeveloperPortalTab, manageSomething } from './DeveloperPortal.jsx';

const TABS = [
  { group: 'userSettingsHeader', items: [['account', 'myAccount'], ['profile', 'profiles'], ['privacy', 'privacySafety'], ['devices', 'devices']] },
  { group: 'appSettings', items: [['appearance', 'appearance'], ['accessibility', 'accessibility'], ['voice', 'voiceVideo'], ['chat', 'chat'], ['notifications', 'notifications'], ['keybinds', 'keybinds'], ['language', 'language'], ['advanced', 'advanced']] },
];

export function SettingsLayout({ nav, children, onClose }) {
  // On a phone, settings open on the list of pages (when no page was asked for); picking one shows it with a Back arrow.
  const [navOpen, setNavOpen] = useState(() => isPhone() && !!uiStore.get().settings?.list);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-layer,.context-menu,.popout')) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={cx('settings-overlay', navOpen && 'nav-open')} role="dialog" aria-modal="true">
      <nav className="settings-nav" onClickCapture={(e) => { if (e.target.closest('.settings-nav-item') && refuseIfUnsaved()) { e.stopPropagation(); e.preventDefault(); } }}
        onClick={(e) => { if (e.target.closest('.settings-nav-item')) setNavOpen(false); }}><div className="settings-nav-inner">{nav}</div></nav>
      <main className="settings-content">
        <button className="settings-nav-toggle mobile-only" onClick={() => { if (!refuseIfUnsaved()) setNavOpen(true); }}><Icon name="chevronLeft" size={20} /> Back</button>
        <div className="settings-content-inner">{children}</div>
        <div className="settings-close">
          <button className="icon-btn round" onClick={() => onClose()} aria-label="Close settings"><Icon name="x" size={20} /></button>
          <span className="tiny muted">ESC</span>
        </div>
      </main>
    </div>
  );
}

export function NavItem({ active, onClick, children, danger }) {
  return <button className={cx('settings-nav-item', active && 'active', danger && 'danger')} onClick={onClick}>{children}</button>;
}

/** The first thing on a phone's settings list: who you are and your status (the desktop has these in the bottom-left panel). */
function MeCard() {
  const me = useStore((s) => s.me);
  const status = useStore((s) => (s.me.status === 'invisible' ? 'invisible' : s.presences[s.me.id]?.status || s.me.status));
  const t = useT();
  const ref = useRef(null);
  return (
    <button ref={ref} type="button" className="settings-me" onClick={() => openPopout(ref.current, ({ close }) => <StatusMenu close={close} />, { placement: 'bottom', key: 'status' })}>
      <span className="settings-me-avatar"><Avatar userId={me.id} size={52} /><StatusDot status={status} size={14} className="settings-me-status" /></span>
      <span className="settings-me-text">
        <b className="truncate">{me.displayName || me.username}</b>
        <span className="muted small truncate">@{me.username} · {me.customStatus?.text || t(`status_${status}`)}</span>
      </span>
      <Icon name="chevronDown" size={18} />
    </button>
  );
}

export function UserSettings() {
  const t = useT();
  const tab = useUI((u) => u.settings?.tab || 'account');
  const setTab = (x) => setUI({ settings: { type: 'user', tab: x } });
  const isAdmin = useStore((s) => !!s.me?.isAdmin);
  const canDev = useStore((s) => manageSomething(s));   // (Developer Portal: only for people who can add a bot somewhere)
  const isDevJr = useStore((s) => !!s.me?.isDevJr) && !isAdmin;
  const isMod = useStore((s) => !!s.me?.isMod || !!s.me?.isDevJr) && !isAdmin;   // (an admin already has everything a mod has; a Dev Jr has all of it too, and more)
  const siteReports = useStore((s) => (s.reportCounts?.site || 0) + (s.reportCounts?.appeals || 0));   // (reports + appeals waiting)
  const nav = (
    <>
      <MeCard />
      {TABS.map((g) => (
        <div key={g.group}>
          <div className="settings-nav-header">{t(g.group)}</div>
          {g.items.map(([id, label]) => <NavItem key={id} active={tab === id} onClick={() => setTab(id)}>{t(label)}</NavItem>)}
          <div className="settings-nav-sep" />
        </div>
      ))}
      {(canDev || tab === 'developer') && (
        <div>
          <div className="settings-nav-header">Developers</div>
          <NavItem active={tab === 'developer'} onClick={() => setTab('developer')}><span className="row-center"><Icon name="bot" size={15} /> Developer Portal</span></NavItem>
          <div className="settings-nav-sep" />
        </div>
      )}
      {isAdmin && (
        <div>
          <div className="settings-nav-header">Site admin</div>
          <NavItem active={tab === 'admin'} onClick={() => setTab('admin')}><span className="row-center"><Icon name="shield" size={15} /> Admin Panel</span>{siteReports > 0 && <span className="badge nav-badge" aria-label={`${siteReports} waiting`}>{siteReports}</span>}</NavItem>
          <div className="settings-nav-sep" />
        </div>
      )}
      {isMod && (
        <div>
          <div className="settings-nav-header">{isDevJr ? 'Staff' : 'Moderation'}</div>
          <NavItem active={tab === 'mod'} onClick={() => setTab('mod')}><span className="row-center"><Icon name="shield" size={15} /> {isDevJr ? 'Dev Jr Panel' : 'Mod Panel'}</span>{siteReports > 0 && <span className="badge nav-badge" aria-label={`${siteReports} waiting`}>{siteReports}</span>}</NavItem>
          <div className="settings-nav-sep" />
        </div>
      )}
      <NavItem onClick={() => setTab('shortcuts')} active={tab === 'shortcuts'}>What’s New &amp; Help</NavItem>
      <div className="settings-nav-sep" />
      <NavItem danger onClick={async () => { if (await confirmDialog({ title: t('logOut'), body: 'Are you sure you want to log out?', confirmText: t('logOut'), danger: true })) { closeSettings(true); logout(); } }}>
        {t('logOut')} <Icon name="logout" size={16} />
      </NavItem>
      <div className="settings-nav-footer tiny muted">NullChat{CURRENT_BUILD ? ` · build ${CURRENT_BUILD}` : ''}<br />{navigator.platform}</div>
    </>
  );
  const pages = { account: AccountTab, profile: ProfileTab, privacy: PrivacyTab, devices: DevicesTab, appearance: AppearanceTab, accessibility: AccessibilityTab, voice: VoiceTab, chat: ChatTab, notifications: NotificationsTab, keybinds: KeybindsTab, language: LanguageTab, advanced: AdvancedTab, shortcuts: HelpTab, ...((canDev || tab === 'developer') ? { developer: DeveloperPortalTab } : {}), ...(isAdmin ? { admin: AdminPanel } : {}), ...(isMod ? { mod: ModPanel } : {}) };
  const Page = pages[tab] || AccountTab;
  return <SettingsLayout nav={nav} onClose={closeSettings}><Page /></SettingsLayout>;
}

// ================================================================ My Account
function AccountTab() {
  const me = useStore((s) => s.me);
  const [reveal, setReveal] = useState(false);
  const masked = me.email.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => a + '*'.repeat(Math.min(b.length, 10)) + c);
  return (
    <>
      <h2>My Account</h2>
      <div className="account-card">
        <div className="account-banner" style={me.banner ? { backgroundImage: `url(${me.banner})` } : { background: me.accentColor || 'var(--accent)' }} />
        <div className="account-head">
          <Avatar userId={me.id} size={80} status />
          <div className="grow"><h3>{me.displayName || me.username}</h3><CustomStatusLine status={me.customStatus} /></div>
          <Button onClick={() => setUI({ settings: { type: 'user', tab: 'profile' } })}>Edit User Profile</Button>
        </div>
        <div className="account-fields">
          <AccountField label="Display Name" value={me.displayName || 'You haven’t added a display name yet.'} onEdit={() => setUI({ settings: { type: 'user', tab: 'profile' } })} />
          <AccountField label="Username" value={me.username} onEdit={() => openAccountEdit('username')} />
          <AccountField label="Email" value={<>{reveal ? me.email : masked} <button className="link-btn" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Reveal'}</button></>} onEdit={() => openAccountEdit('email')} />
        </div>
      </div>
      <div className="settings-section">
        <h3>Password and Authentication</h3>
        <Button onClick={() => openAccountEdit('password')}>Change Password</Button>
        <div className="mfa-box">
          <div>
            <h4>{me.mfaEnabled ? <><Icon name="shield" size={16} /> Two-factor authentication enabled</> : 'Authenticator App'}</h4>
            <p className="muted small">{me.mfaEnabled ? 'Your account is protected with an authenticator app. You’ll need a code from it (or a backup code) to log in.' : 'Protect your account with an extra layer of security. Once configured, you’ll need your password and a code from your phone to log in.'}</p>
          </div>
          {me.mfaEnabled ? <Button variant="danger" onClick={openMfaDisable}>Remove 2FA</Button> : <Button onClick={openMfaSetup}>Enable Authenticator App</Button>}
        </div>
      </div>
      <BirthdaySettings />
      <div className="settings-section">
        <h3>Account Removal</h3>
        <p className="muted small">Deleting your account is permanent. Your messages will remain but will show as “Deleted User”. You must transfer or delete any servers you own first.</p>
        <Button variant="danger" onClick={openDeleteAccount}>Delete Account</Button>
      </div>
    </>
  );
}

function AccountField({ label, value, onEdit }) {
  return (
    <div className="account-field">
      <div><div className="field-label">{label}</div><div className="account-value">{value}</div></div>
      <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
    </div>
  );
}

function openAccountEdit(kind) {
  openModal(({ close }) => <AccountEditModal kind={kind} close={close} />);
}
function AccountEditModal({ kind, close }) {
  const me = useStore((s) => s.me);
  const [val, setVal] = useState(kind === 'username' ? me.username : kind === 'email' ? me.email : '');
  const [val2, setVal2] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    if (kind === 'password' && val !== val2) { setErrors({ newPassword2: 'Passwords do not match.' }); return; }
    setLoading(true); setErrors({});
    try {
      const body = { password };
      if (kind === 'username') body.username = val;
      if (kind === 'email') body.email = val;
      if (kind === 'password') body.newPassword = val;
      const u = await api.patch('/users/@me/account', body);
      store.set({ me: { ...store.get().me, ...u } });
      toast(kind === 'password' ? 'Password changed. Other devices were logged out.' : kind === 'email' ? 'Email changed.' : 'Username changed.', 'success');
      close();
    } catch (err) { setErrors(Object.keys(err.errors).length ? err.errors : { _: err.message }); }
    finally { setLoading(false); }
  };
  const titles = { username: 'Change your username', email: 'Change your email address', password: 'Update your password' };
  return (
    <Modal title={titles[kind]} subtitle={kind === 'password' ? 'Enter your current password and a new password.' : 'Enter a new value and your existing password.'} onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={loading} onClick={submit}>Done</Button></>}>
      <form onSubmit={submit}>
        {errors._ && <div className="notice error">{errors._}</div>}
        {kind === 'password' ? (
          <>
            <Field label="Current Password" error={errors.password} required><input className="input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="New Password" error={errors.newPassword} required><input className="input" type="password" autoComplete="new-password" value={val} onChange={(e) => setVal(e.target.value)} /><PasswordStrength value={val} /></Field>
            <Field label="Confirm New Password" error={errors.newPassword2} required><input className="input" type="password" autoComplete="new-password" value={val2} onChange={(e) => setVal2(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label={kind === 'username' ? 'Username' : 'Email'} error={errors[kind]} required>
              <input className="input" autoFocus type={kind === 'email' ? 'email' : 'text'} value={val} onChange={(e) => setVal(kind === 'username' ? e.target.value.toLowerCase() : e.target.value)} />
            </Field>
            <Field label="Current Password" error={errors.password} required><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function openMfaSetup() { openModal(({ close }) => <MfaSetup close={close} />); }
function MfaSetup({ close }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState({});
  const [loading, setLoading] = useState(false);
  useEffect(() => { api.post('/auth/mfa/setup').then(setSetup).catch((e) => { toastError(e); close(); }); }, [close]);
  const enable = async () => {
    setLoading(true); setErr({});
    try { const r = await api.post('/auth/mfa/enable', { code, password }); setCodes(r.backupCodes); }
    catch (e) { setErr(Object.keys(e.errors).length ? e.errors : { code: e.message }); }
    finally { setLoading(false); }
  };
  if (codes) {
    return (
      <Modal title="Save your backup codes" onClose={close} size="sm" footer={<><Button variant="secondary" onClick={() => { copyText(codes.join('\n')); toast('Copied', 'success'); }}>Copy</Button><Button onClick={close}>Done</Button></>}>
        <p className="muted small">Two-factor authentication is on. If you lose your phone, each of these codes can be used once instead of an authenticator code. Store them somewhere safe!</p>
        <div className="backup-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      </Modal>
    );
  }
  return (
    <Modal title="Enable Two-Factor Auth" onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={loading} disabled={!setup} onClick={enable}>Activate</Button></>}>
      {!setup ? <Spinner /> : (
        <>
          <ol className="mfa-steps">
            <li><b>Download an authenticator app</b><p className="muted small">e.g. Google Authenticator, Microsoft Authenticator, Authy or 1Password.</p></li>
            <li><b>Add NullChat to the app</b><p className="muted small">Choose “Enter a setup key” and type this key (time-based):</p>
              <div className="copy-row"><code className="secret">{setup.secret.match(/.{1,4}/g).join(' ')}</code><Button size="sm" variant="secondary" onClick={() => { copyText(setup.secret); toast('Key copied', 'success'); }}>Copy</Button></div>
              <p className="muted tiny">On a phone? <a className="link" href={setup.otpauthUrl}>Open in your authenticator app</a></p>
            </li>
            <li><b>Enter the 6-digit code</b>
              <Field error={err.code}><input className="input" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="Your password" error={err.password}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            </li>
          </ol>
        </>
      )}
    </Modal>
  );
}
function openMfaDisable() {
  openModal(({ close }) => {
    function Body() {
      const [code, setCode] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState({}); const [loading, setLoading] = useState(false);
      const go = async () => { setLoading(true); try { await api.post('/auth/mfa/disable', { code, password }); toast('Two-factor authentication removed.', 'success'); close(); } catch (e) { setErr(Object.keys(e.errors).length ? e.errors : { code: e.message }); } finally { setLoading(false); } };
      return (
        <Modal title="Remove 2FA" onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" loading={loading} onClick={go}>Remove 2FA</Button></>}>
          <Field label="Authenticator code" error={err.code}><input className="input" autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Password" error={err.password}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </Modal>
      );
    }
    return <Body />;
  });
}
function openDeleteAccount() {
  openModal(({ close }) => {
    function Body() {
      const [password, setPassword] = useState(''); const [err, setErr] = useState(null); const [loading, setLoading] = useState(false);
      const go = async () => { setLoading(true); try { await api.del('/users/@me', { password }); close(); closeSettings(true); logout(); } catch (e) { setErr(e.errors?.password || e.message); } finally { setLoading(false); } };
      return (
        <Modal title="Delete Account" onClose={close} size="sm" footer={<><Button variant="link" onClick={close}>Cancel</Button><Button variant="danger" loading={loading} onClick={go}>Delete Account</Button></>}>
          <div className="notice error">Are you sure? This permanently deletes your account and can’t be undone.</div>
          <Field label="Password" error={err}><input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </Modal>
      );
    }
    return <Body />;
  });
}

// ================================================================ Profile
function ProfileTab() {
  const me = useStore((s) => s.me);
  const initial = {
    displayName: me.displayName || '', pronouns: me.pronouns || '', bio: me.bio || '', accentColor: me.accentColor || '#7c6cff',
    profileTheme: me.profileTheme || null,
    nameStyle: me.nameStyle || EMPTY_NAME_STYLE,
    avatarDecoration: me.avatarDecoration || null,
    profileEffect: me.profileEffect || null,
  };
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/users/@me', {
        displayName: draft.displayName || null, pronouns: draft.pronouns, bio: draft.bio, accentColor: draft.accentColor,
        profileTheme: draft.profileTheme,
        nameStyle: sanitizeNameStyle(draft.nameStyle),
        avatarDecoration: draft.avatarDecoration,
        profileEffect: draft.profileEffect,
      });
      toast('Profile saved', 'success', 2000);
    } catch (e) { toastError(e); } finally { setSaving(false); }
  };
  const uploadDecoration = async () => {
    const f = await pickFile('image/png,image/gif,image/webp');
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { toast('That image is over 3 MB. Please pick a smaller one.', 'error'); return; }
    setUploading('decoration');
    try {
      const res = await putImage('/users/@me/decoration', f);
      // fit the new picture around the avatar straight away: most pictures are not centred on their own ring
      const fit = res.avatarDecoration?.url ? await fitDecorationImage(res.avatarDecoration.url) : null;
      setDraft((d) => ({ ...d, avatarDecoration: fit ? { ...res.avatarDecoration, scale: fit.scale, x: fit.x, y: fit.y } : res.avatarDecoration }));
      toast(`Decoration uploaded. ${fitMessage(fit)}`, fit ? 'success' : 'info', fit ? 3000 : 6000);
    } catch (e) { toastError(e); } finally { setUploading(null); }
  };
  const upload = async (kind) => {
    const f = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    setUploading(kind);
    try { await putImage(`/users/@me/${kind}`, f); toast(`${kind === 'avatar' ? 'Avatar' : 'Banner'} updated`, 'success', 2000); }
    catch (e) { toastError(e); } finally { setUploading(null); }
  };
  const preview = { ...me, ...draft, nameStyle: sanitizeNameStyle(draft.nameStyle) };
  const tp = profileThemeProps(preview);
  const ns = nameStyleProps(preview, null);
  return (
    <>
      <h2>Profiles</h2>
      <div className="profile-editor">
        <div className="profile-form">
          <Field label="Display Name"><input className="input" maxLength={32} value={draft.displayName} placeholder={me.username} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} /></Field>
          <Field label="Pronouns"><input className="input" maxLength={40} value={draft.pronouns} placeholder="Add your pronouns" onChange={(e) => setDraft({ ...draft, pronouns: e.target.value })} /></Field>
          <div className="settings-divider" />
          <div className="field-label">Avatar</div>
          <div className="row gap">
            <Button loading={uploading === 'avatar'} onClick={() => upload('avatar')}>Change Avatar</Button>
            {me.avatar && <Button variant="link" onClick={() => api.patch('/users/@me', { avatar: null }).catch(toastError)}>Remove Avatar</Button>}
          </div>
          <div className="settings-divider" />
          <div className="field-label">Profile Banner</div>
          <div className="row gap">
            <Button loading={uploading === 'banner'} onClick={() => upload('banner')}>Change Banner</Button>
            {me.banner && <Button variant="link" onClick={() => api.patch('/users/@me', { banner: null }).catch(toastError)}>Remove Banner</Button>}
          </div>
          <p className="tiny muted">GIFs work here too, your avatar and banner will move. Up to 10 MB for avatars and 15 MB for banners.</p>
          <div className="settings-divider" />
          <Field label="Banner Color" hint="Shown when you don’t have a banner image and no profile theme is set.">
            <div className="row gap"><input type="color" className="color-input" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} /><code>{draft.accentColor}</code></div>
          </Field>
          <div className="settings-divider" />
          <Field label="About Me" hint="You can use markdown and links if you’d like.">
            <textarea className="input" rows={4} maxLength={190} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} />
            <span className="char-hint tiny muted">{190 - draft.bio.length}</span>
          </Field>
          <div className="settings-divider" />
          <div className="field-label">Profile Theme</div>
          <p className="tiny muted">Colours your profile card for everyone who opens it. Free for everybody.</p>
          <ProfileThemeEditor value={draft.profileTheme} onChange={(v) => setDraft({ ...draft, profileTheme: v })} />
          <div className="settings-divider" />
          <div className="field-label">Avatar Decoration</div>
          <p className="tiny muted">Pick one, design your own with <strong>Custom</strong>, or upload your own artwork with <strong>Your image</strong>. It shows around your avatar everywhere.</p>
          <DecorationPicker value={draft.avatarDecoration} user={{ ...me, avatarDecoration: null }} isAdmin={!!me.isAdmin} onUpload={uploadDecoration} uploading={uploading === 'decoration'} onChange={(v) => setDraft({ ...draft, avatarDecoration: v })} />
          <div className="settings-divider" />
          <div className="field-label">Profile Effect</div>
          <p className="tiny muted">An animated layer over your whole profile card, for everyone who opens it. Hover one to see it move.</p>
          <ProfileEffectPicker value={draft.profileEffect} onChange={(v) => setDraft({ ...draft, profileEffect: v })} />
          <div className="settings-divider" />
          <div className="field-label">Display Name Style</div>
          <NameStyleEditor value={draft.nameStyle} sampleName={draft.displayName || me.username} onChange={(v) => setDraft({ ...draft, nameStyle: v })} />
          <div className="settings-divider" />
          <div className="field-label">Server Tag</div>
          <MyServerTag />
          <div className="settings-divider" />
          <div className="field-label">Profile Song</div>
          <ProfileSongSettings />
        </div>
        <div className="profile-preview">
          <div className="field-label">Preview</div>
          <div className={cx('user-popout static', tp.className)} style={tp.style}>
            <ProfileEffect effect={preview.profileEffect} keep />
            <div className="profile-banner" style={me.banner ? { backgroundImage: `url(${me.banner})`, height: 120 } : { background: bannerFallback(preview), height: 60 }} />
            <div className="popout-avatar-wrap"><div className="popout-avatar"><Avatar user={preview} size={80} status /></div></div>
            <div className="popout-body">
              <div className={cx('popout-name keep-name-style', ns.className)} style={ns.style}>{preview.displayName || me.username}</div>
              <div className="popout-username">{me.username}{preview.pronouns && <span className="muted"> • {preview.pronouns}</span>} <ServerTag tag={me.serverTag} plain /></div>
              <CustomStatusLine status={me.customStatus} />
              <div className="popout-card">
                {preview.bio && <div className="profile-section"><h4>About Me</h4><div className="bio"><Markdown text={preview.bio} /></div></div>}
                <div className="profile-section"><h4>Member Since</h4><div className="small">{formatDate(me.createdAt)}</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <SaveBar show={dirty} saving={saving} onReset={() => setDraft(initial)} onSave={save} />
    </>
  );
}

export function SaveBar({ show, onReset, onSave, saving }) {
  const key = useRef(null);
  if (!key.current) key.current = Symbol('save-bar');
  const [shake, setShake] = useState(0);
  const [nagging, setNagging] = useState(false);
  // While it is showing, the page has unsaved changes: leaving it is refused (see refuseIfUnsaved), and the bar shakes and says why.
  useEffect(() => {
    setUnsaved(key.current, !!show);
    if (!show) return undefined;
    let timer = 0;
    const onRefused = () => { setShake((n) => n + 1); setNagging(true); clearTimeout(timer); timer = setTimeout(() => setNagging(false), 2600); };
    window.addEventListener('nullchat:unsaved', onRefused);
    return () => { clearTimeout(timer); window.removeEventListener('nullchat:unsaved', onRefused); setUnsaved(key.current, false); };
  }, [show]);
  if (!show) return null;
  return (
    <div key={shake} className={cx('save-bar', shake > 0 && 'shake')} role="status">
      <span>{nagging ? 'Save or reset your changes first.' : 'Careful — you have unsaved changes!'}</span>
      <div className="row gap"><Button variant="link" onClick={onReset}>Reset</Button><Button variant="success" loading={saving} onClick={onSave}>Save Changes</Button></div>
    </div>
  );
}

// ================================================================ Privacy & Safety
function PrivacyTab() {
  const privacy = useStore((s) => ({ ...DEFAULTS.privacy, ...(s.settings.privacy || {}) }));
  const blocked = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 2).map((r) => s.users[r.id]).filter(Boolean));
  const fr = { ...DEFAULTS.privacy.friendRequests, ...(privacy.friendRequests || {}) };
  const setP = (patch) => updateSettings({ privacy: { ...privacy, ...patch } });
  return (
    <>
      <h2>Privacy &amp; Safety</h2>
      <div className="settings-section">
        <h3>Direct Messages</h3>
        <ToggleSetting title="Allow direct messages from server members" description="People who share a server with you can message you even if you aren’t friends. Friends can always message you."
          checked={privacy.allowDMsFromServerMembers !== false} onChange={(v) => setP({ allowDMsFromServerMembers: v })} />
      </div>
      <div className="settings-section">
        <h3>Who can send you a friend request</h3>
        <ToggleSetting title="Everyone" checked={fr.everyone !== false} onChange={(v) => setP({ friendRequests: { ...fr, everyone: v } })} />
        <ToggleSetting title="Friends of Friends" checked={fr.mutualFriends !== false} disabled={fr.everyone !== false} onChange={(v) => setP({ friendRequests: { ...fr, mutualFriends: v } })} />
        <ToggleSetting title="Server Members" checked={fr.mutualServers !== false} disabled={fr.everyone !== false} onChange={(v) => setP({ friendRequests: { ...fr, mutualServers: v } })} />
      </div>
      <div className="settings-section">
        <h3>Discovery &amp; activity</h3>
        <ToggleSetting title="Suggest me to people with similar interests" description="Lets NullChat show you in other people’s “People you may know” list when you share servers or friends. Turn this off and you will not appear, and you won’t see suggestions either."
          checked={privacy.suggestMe !== false} onChange={(v) => setP({ suggestMe: v })} />
        <ToggleSetting title="Share the game I’m playing" description="The desktop app shows “Playing …” under your name while a game runs. Only the game’s name is sent, nothing else from your computer."
          checked={privacy.shareActivity !== false} onChange={(v) => { setP({ shareActivity: v }); if (!v) api.patch('/users/@me/presence', { activity: null }).catch(() => {}); }} />
        <ToggleSetting title="Hide me from server leaderboards" description="You still earn xp, you just won’t be listed."
          checked={!!privacy.hideLeaderboard} onChange={(v) => setP({ hideLeaderboard: v })} />
        <ToggleSetting title="Hide my level" description="Your level badge won’t show on your profile."
          checked={!!privacy.hideLevel} onChange={(v) => setP({ hideLevel: v })} />
      </div>
      <div className="settings-section">
        <h3>Blocked Users — {blocked.length}</h3>
        {blocked.length === 0 ? <p className="muted small">You haven’t blocked anyone.</p> : blocked.map((u) => (
          <div key={u.id} className="list-row static">
            <Avatar user={u} size={32} /><span className="grow">{u.displayName || u.username} <span className="muted small">{u.username}</span></span>
            <Button size="sm" variant="secondary" onClick={() => api.del(`/users/@me/relationships/${u.id}`).catch(toastError)}>Unblock</Button>
          </div>
        ))}
      </div>
      <div className="settings-section">
        <h3>Your data</h3>
        <p className="muted small">Download a copy of what this server holds about you as one file: your profile and settings, friends, the servers you’re in, saved and scheduled messages, and every message you’ve written. It doesn’t include other people’s messages (apart from ones you saved) or the uploaded files themselves, and never your password.</p>
        <Button variant="secondary" onClick={openDownloadMyData}><Icon name="download" size={16} /> Download my data</Button>
      </div>
      <div className="settings-section">
        <h3>How we handle your data</h3>
        <p className="muted small">NullChat stores your account, messages and uploads on the server you’re connected to. Passwords are hashed with scrypt, sessions use random tokens, and voice/video streams travel peer-to-peer (encrypted with DTLS-SRTP) — they are never recorded by the server.</p>
      </div>
    </>
  );
}

function openDownloadMyData() { openModal(({ close }) => <DownloadMyData close={close} />); }
function DownloadMyData({ close }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const { url } = await api.post('/users/@me/export', { password });
      const a = document.createElement('a');
      a.href = url; a.download = 'nullchat-data.json'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Your download is starting. Big accounts can take a moment.', 'success', 4000);
      close();
    } catch (e) { setErr(e.errors?.password || e.message); setBusy(false); }
  };
  return (
    <Modal title="Download my data" size="sm" onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button onClick={go} loading={busy} disabled={!password}>Download</Button></>}>
      <p className="muted small">The file includes your private messages, so keep it somewhere safe. Enter your password to confirm it’s you.</p>
      <Field label="Your password" error={err}>
        <input className="input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && password) go(); }} />
      </Field>
    </Modal>
  );
}

// ================================================================ Devices
function DevicesTab() {
  const [sessions, setSessions] = useState(null);
  const load = () => api.get('/auth/sessions').then(setSessions).catch(toastError);
  useEffect(() => { load(); }, []);
  const describe = (ua = '') => {
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return { os, br, mobile: /Mobile|Android|iPhone/.test(ua) };
  };
  return (
    <>
      <h2>Devices</h2>
      <p className="muted">Here are all the devices that are currently logged in with your NullChat account. You can log out of each one individually or all other devices.</p>
      {!sessions ? <Spinner /> : (
        <>
          {['current', 'other'].map((group) => {
            const list = sessions.filter((s) => (group === 'current' ? s.current : !s.current));
            if (!list.length) return null;
            return (
              <div key={group} className="settings-section">
                <h3>{group === 'current' ? 'Current Device' : 'Other Devices'}</h3>
                {list.map((s) => {
                  const d = describe(s.userAgent);
                  return (
                    <div key={s.id} className="device-row">
                      <span className="device-icon"><Icon name={d.mobile ? 'mobile' : 'screen'} size={22} /></span>
                      <div className="grow"><b>{d.os} · {d.br}</b><div className="tiny muted">{s.ip || 'Unknown location'} · {s.current ? 'Active now' : `Last used ${relativeTime(s.lastUsedAt)}`} · Signed in {formatDate(s.createdAt)}</div></div>
                      {!s.current && <button className="icon-btn" aria-label="Log out device" data-tooltip="Log out" onClick={() => api.del(`/auth/sessions/${s.id}`).then(load).catch(toastError)}><Icon name="x" /></button>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {sessions.some((s) => !s.current) && (
            <div className="settings-section">
              <h3>Log out of all known devices</h3>
              <p className="muted small">You’ll have to log back in on all logged-out devices.</p>
              <Button variant="danger" onClick={async () => { if (await confirmDialog({ title: 'Log out all known devices?', body: 'Every other device will be logged out.', confirmText: 'Log Out All', danger: true })) { await api.post('/auth/sessions/logout-others').catch(toastError); load(); } }}>Log Out All Known Devices</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ================================================================ Appearance
const ACCENTS = ['#c2ff3d', '#3ddc97', '#38d0ff', '#7c6cff', '#ff6b9a', '#ff9b3d', '#ff5d6c', '#f4f5f7'];
function useSetting(path) {
  return useStore((s) => {
    let v = s.settings; let d = DEFAULTS;
    for (const p of path.split('.')) { v = v?.[p]; d = d?.[p]; }
    return v === undefined ? d : v;
  });
}
function AppearanceTab() {
  const theme = useSetting('theme');
  const customTheme = useSetting('customTheme');
  const customCss = useSetting('customCss');
  const accent = useSetting('accentColor');
  const display = useSetting('messageDisplay');
  const fontSize = useSetting('fontSize');
  const spacing = useSetting('groupSpacing');
  const zoom = useSetting('zoom');
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => { const f = () => setWinW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const zoomMax = zoomLimit(winW);
  const hour24 = useSetting('hour24');
  const me = useStore((s) => s.me);
  const sample = useMemo(() => [
    { id: '1', channelId: 'preview', author: me, content: 'Look at me, I’m a beautiful butterfly 🦋', type: 0, createdAt: Date.now() - 60000, reactions: [], attachments: [], embeds: [] },
    { id: '2', channelId: 'preview', author: me, content: 'Fluttering in the moonlight 🌙 — try **bold**, _italics_ and `code`!', type: 0, createdAt: Date.now() - 30000, reactions: [], attachments: [], embeds: [] },
  ], [me]);
  return (
    <>
      <h2>Appearance</h2>
      <div className="appearance-preview">{sample.map((m, i) => <Message key={m.id} message={m} grouped={i > 0} channel={null} preview />)}</div>
      <div className="settings-section">
        <h3>Theme</h3>
        <div className="theme-swatches">
          {[['dark', 'Void'], ['midnight', 'Black'], ['light', 'Bone'], ['custom', 'Custom'], ['system', 'Sync with OS']].map(([v, l]) => (
            <button key={v} className={cx('theme-swatch', `swatch-${v}`, theme === v && 'active')} onClick={() => updateSettings({ theme: v })} aria-label={l}>
              <span className="swatch-circle">{theme === v && <Icon name="check" size={16} strokeWidth={3} />}</span><span className="small">{l}</span>
            </button>
          ))}
        </div>
      </div>
      <ThemeSection theme={theme} customTheme={customTheme} accent={accent} />
      <CustomCssSection value={customCss} />
      <div className="settings-section">
        <h3>Accent Color</h3>
        <div className="accent-row">
          {ACCENTS.map((c) => <button key={c} className={cx('accent-dot', accent === c && 'active')} style={{ background: c }} onClick={() => updateSettings({ accentColor: c })} aria-label={c}>{accent === c && <Icon name="check" size={14} strokeWidth={3} />}</button>)}
          <label className="accent-custom" data-tooltip="Custom color"><input type="color" value={accent} onChange={(e) => updateSettings({ accentColor: e.target.value })} /><Icon name="edit" size={14} /></label>
        </div>
      </div>
      <div className="settings-section">
        <h3>Message Display</h3>
        <RadioGroup value={display} onChange={(v) => updateSettings({ messageDisplay: v })} options={[
          { value: 'cozy', label: 'Cozy', description: 'Modern, beautiful, and easy on your eyes.' },
          { value: 'compact', label: 'Compact', description: 'Fit more messages on screen at one time. #IRC' },
        ]} />
      </div>
      <div className="settings-section">
        <h3>Chat Font Scaling</h3>
        <Slider value={fontSize} min={12} max={24} onChange={(v) => updateSettings({ fontSize: v })} format={(v) => `${v}px`} />
        <h3>Space Between Message Groups</h3>
        <Slider value={spacing} min={0} max={24} step={4} onChange={(v) => updateSettings({ groupSpacing: v })} format={(v) => `${v}px`} />
        <h3>Zoom Level</h3>
        <Slider value={zoom} min={50} max={200} step={10} onChange={(v) => updateSettings({ zoom: v })} format={(v) => `${v}%`} />
        {zoom > zoomMax
          ? <p className="tiny muted">This window is only wide enough for {zoomMax}%, so that is what you are seeing. Make the window wider (or full screen) to use {zoom}%.</p>
          : <p className="tiny muted">Tip: your browser’s Ctrl + / Ctrl − also zooms.</p>}
      </div>
      <ToggleSetting title="Use 24-hour clock" checked={hour24} onChange={(v) => updateSettings({ hour24: v })} />
    </>
  );
}

// ================================================================ Accessibility
function AccessibilityTab() {
  const a = useStore((s) => ({ ...DEFAULTS.accessibility, ...(s.settings.accessibility || {}) }));
  const set = (patch) => updateSettings({ accessibility: { ...a, ...patch } });
  return (
    <>
      <h2>Accessibility</h2>
      <div className="settings-section">
        <h3>Saturation</h3>
        <p className="muted small">Reduce the saturation of colors within the application, for those with color sensitivities.</p>
        <Slider value={a.saturation} min={0} max={100} step={5} onChange={(v) => set({ saturation: v })} format={(v) => `${v}%`} />
      </div>
      <div className="settings-section">
        <h3>Reduced Motion</h3>
        <RadioGroup value={a.reducedMotion} onChange={(v) => set({ reducedMotion: v })} options={[
          { value: 'system', label: 'Sync with computer', description: 'Follow your operating system’s reduced-motion setting.' },
          { value: 'on', label: 'Enable reduced motion', description: 'Reduces animations, transitions and hover effects.' },
          { value: 'off', label: 'Full motion' },
        ]} />
      </div>
      <ToggleSetting title="Profile effects" description="Show the animated effects people put on their profile cards: falling petals, snow, sparkles and so on. Turn this off to see every profile plainly. Reduced motion and High contrast turn them off too. The picker and the preview in your own profile editor stay as they are." checked={a.profileEffects !== false} onChange={(v) => set({ profileEffects: v })} />
      <ToggleSetting title="Show role colors in names" description="Display member names in the color of their highest role." checked={a.roleColors !== 'off'} onChange={(v) => set({ roleColors: v ? 'on' : 'off' })} />
      <ToggleSetting title="High contrast mode" description="Increase contrast between text and backgrounds and add visible borders." checked={a.highContrast} onChange={(v) => set({ highContrast: v })} />
      <div className="settings-section">
        <h3>Text Readability</h3>
        <p className="muted small">Make what you read easier on the eyes.</p>
      </div>
      <ToggleSetting title="Display name styles" description="Show the custom fonts, colors and effects people give their names. Turn this off to see every name in the standard font and its normal color. The preview in your own profile editor stays as it is." checked={a.nameStyles !== false} onChange={(v) => set({ nameStyles: v })} />
      <ToggleSetting title="Always underline links" description="Make links stand out more by always underlining them." checked={a.underlineLinks} onChange={(v) => set({ underlineLinks: v })} />
      <ToggleSetting title="Dyslexia-friendly font" description="Use a font with wider letter spacing and heavier bottoms." checked={a.dyslexicFont} onChange={(v) => set({ dyslexicFont: v })} />
      <div className="settings-section">
        <h3>Screen readers</h3>
        <p className="muted small">NullChat uses semantic landmarks, labelled buttons and live regions for new messages. Press <kbd>Ctrl</kbd> + <kbd>/</kbd> to see all keyboard shortcuts.</p>
      </div>
    </>
  );
}

// ================================================================ Voice & Video
function useLocalSettings() {
  const [l, setL] = useState(getLocal());
  useEffect(() => onLocalChange(setL), []);
  return [l, (patch) => setLocal(patch)];
}

function VoiceTab() {
  const [l, set] = useLocalSettings();
  const [devices, setDevices] = useState({ input: [], output: [], video: [] });
  const [needsPermission, setNeedsPermission] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(-100);
  const [camOn, setCamOn] = useState(false);
  const videoRef = useRef(null);
  const testRef = useRef(null);
  const inVoice = useVoice((v) => !!v.channelId);
  const liveLevel = useVoice((v) => v.inputLevel);
  const pttKey = useStore((s) => s.settings?.keybinds?.pushToTalk || '');
  const iceServers = useStore((s) => s.iceServers);
  const [check, setCheck] = useState(null);   // null | { running } | the result of runConnectionTest
  const runCheck = async () => {
    setCheck({ running: true });
    try { setCheck(await runConnectionTest(iceServers || [])); } catch { setCheck(null); toast('The check could not run in this browser.', 'error'); }
  };

  const enumerate = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await listDevices();
    // Every device the system has, by name. A chosen one that is not connected right now stays in the list (marked), so the
    // choice is visible and comes back by itself when the device does; meanwhile the default one is used.
    const map = (kind) => {
      const out = list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ value: d.deviceId, label: deviceName(d.label) || `${kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Camera'} ${i + 1}` }));
      const r = resolveDevice(kind, list);
      const saved = getLocal()[kind === 'audioinput' ? 'inputDeviceId' : kind === 'audiooutput' ? 'outputDeviceId' : 'videoDeviceId'];
      if (r.present === false && saved && saved !== 'default') out.push({ value: saved, label: `${r.label || 'Chosen device'} (not connected)` });
      return out;
    };
    setDevices({ input: map('audioinput'), output: map('audiooutput'), video: map('videoinput') });
    setNeedsPermission(list.some((d) => !d.label));
  };
  useEffect(() => {
    enumerate();
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate);
  }, []);
  const askPermission = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true })); s.getTracks().forEach((t) => t.stop()); enumerate(); }
    catch { toast(/Mac/i.test(navigator.platform || '') ? 'Permission was denied. Allow the microphone for this site in your browser, and for the browser (or NullChat) in System Settings → Privacy & Security → Microphone.' : 'Permission was denied. Allow microphone/camera access in your browser’s site settings.', 'error', 9000); }
  };

  // Mic test: measure level and optionally play back.
  useEffect(() => {
    if (!testing) return undefined;
    let stop = false; let stream; let ctx; let raf;
    (async () => {
      try {
        stream = (await openMicrophone()).stream;   // (the chosen microphone, opened whichever way it accepts; the default one if it is not there)
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
        const gain = ctx.createGain(); gain.gain.value = l.inputVolume / 100; src.connect(gain);
        const dest = ctx.createMediaStreamDestination(); gain.connect(dest);
        const el = new Audio(); el.srcObject = dest.stream; if (el.setSinkId && outputSink()) el.setSinkId(outputSink()).catch(() => {}); el.play().catch(() => {});
        testRef.current = el;
        const buf = new Float32Array(1024);
        const loop = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; const rms = Math.sqrt(s / buf.length); setLevel(rms > 0 ? 20 * Math.log10(rms) : -100); raf = requestAnimationFrame(loop); };
        loop();
        enumerate();
      } catch { toast('Could not access your microphone.', 'error'); setTesting(false); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); if (testRef.current) { testRef.current.srcObject = null; testRef.current = null; } };
  }, [testing, l.inputDeviceId, l.outputDeviceId, l.inputVolume, l.echoCancellation, l.noiseSuppression, l.autoGainControl]);

  // Camera preview.
  useEffect(() => {
    if (!camOn) return undefined;
    let stream;
    navigator.mediaDevices.getUserMedia({ video: { deviceId: l.videoDeviceId !== 'default' ? { exact: l.videoDeviceId } : undefined } })
      .then((s) => { stream = s; if (videoRef.current) videoRef.current.srcObject = s; enumerate(); })
      .catch(() => { toast('Could not access your camera.', 'error'); setCamOn(false); });
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [camOn, l.videoDeviceId]);

  const shownLevel = testing ? level : inVoice ? liveLevel : -100;
  const pct = (db) => Math.max(0, Math.min(100, ((db + 100) / 100) * 100));
  const changeInput = (v) => { chooseDevice('audioinput', v); if (inVoice) setTimeout(reacquireMic, 50); };
  const changeOutput = (v) => { chooseDevice('audiooutput', v); configureSounds({ deviceId: outputSink() || 'default' }); setTimeout(refreshOutputs, 50); };
  const outputChoice = canChooseOutput();
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  return (
    <>
      <h2>Voice &amp; Video</h2>
      {!window.isSecureContext && <div className="notice error">Microphone and camera only work on <b>https://</b> or <b>http://localhost</b>. You’re on an insecure address, so voice and video are disabled by your browser.</div>}
      {needsPermission && <div className="notice row-between"><span>Allow NullChat to access your devices to pick them by name.</span><Button size="sm" onClick={askPermission}>Allow Access</Button></div>}
      <div className="settings-section">
        <h3>Voice Settings</h3>
        <div className="two-col">
          <Field label="Input Device"><Select value={l.inputDeviceId} onChange={changeInput} options={[{ value: 'default', label: 'Default' }, ...devices.input.filter((d) => d.value !== 'default')]} /></Field>
          <Field label="Output Device">
            {outputChoice
              ? <Select value={l.outputDeviceId} onChange={changeOutput} options={[{ value: 'default', label: 'Default' }, ...devices.output.filter((d) => d.value !== 'default')]} />
              : <p className="tiny muted" data-output-fixed>This browser always plays through your system’s sound output. Choose your headphones {isMac ? 'in the Sound menu at the top of the screen (or System Settings → Sound)' : 'in your system’s sound settings'}, or use Chrome, Edge or the NullChat app to pick one here.</p>}
          </Field>
          <Field label="Input Volume"><Slider value={l.inputVolume} min={0} max={200} onChange={(v) => set({ inputVolume: v })} format={(v) => `${v}%`} /></Field>
          <Field label="Output Volume"><Slider value={l.outputVolume} min={0} max={100} onChange={(v) => set({ outputVolume: v })} format={(v) => `${v}%`} /></Field>
        </div>
        <div className="mic-test">
          <div><div className="field-label">Mic Test</div><p className="muted small">Having mic issues? Start a test and say something silly — we’ll play your voice back to you.</p></div>
          <div className="row gap">
            <Button onClick={() => setTesting(!testing)}>{testing ? 'Stop Testing' : 'Let’s Check'}</Button>
            <div className="level-meter"><span style={{ width: `${pct(shownLevel)}%` }} /></div>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <h3>Input Mode</h3>
        <RadioGroup value={l.inputMode} onChange={(v) => set({ inputMode: v })} options={[{ value: 'vad', label: 'Voice Activity' }, { value: 'ptt', label: 'Push to Talk' }]} />
        {l.inputMode === 'ptt' ? (
          <div className="ptt-row">
            <Field label="Shortcut"><KeybindRecorder action="pushToTalk" value={pttKey} /></Field>
            <Field label="Push to Talk Release Delay"><Slider value={l.pttReleaseDelay} min={0} max={2000} step={20} onChange={(v) => set({ pttReleaseDelay: v })} format={(v) => `${v}ms`} /></Field>
          </div>
        ) : (
          <>
            <ToggleSetting title="Automatically determine input sensitivity" checked={l.autoSensitivity} onChange={(v) => set({ autoSensitivity: v })} />
            {!l.autoSensitivity && (
              <div className="sensitivity">
                <div className="sens-track"><span className="sens-level" style={{ width: `${pct(shownLevel)}%` }} /><span className="sens-threshold" style={{ left: `${pct(l.vadThreshold)}%` }} /></div>
                <Slider value={l.vadThreshold} min={-100} max={0} onChange={(v) => set({ vadThreshold: v })} format={(v) => `${v}dB`} />
                <p className="tiny muted">Start a mic test (above) to see your level. Sound louder than the marker transmits.</p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="settings-section">
        <h3>Voice Processing</h3>
        <ToggleSetting title="Echo Cancellation" checked={l.echoCancellation} onChange={(v) => { set({ echoCancellation: v }); if (inVoice) setTimeout(reacquireMic, 50); }} />
        <ToggleSetting title="Noise Suppression" description="Suppresses background noise (fans, keyboards) from your mic." checked={l.noiseSuppression} onChange={(v) => { set({ noiseSuppression: v }); if (inVoice) setTimeout(reacquireMic, 50); }} />
        <ToggleSetting title="Automatic Gain Control" checked={l.autoGainControl} onChange={(v) => { set({ autoGainControl: v }); if (inVoice) setTimeout(reacquireMic, 50); }} />
        <ToggleSetting title="Voice Enhancement" description="Evens out quiet and loud speech, removes low rumble and stops shouting or laughing from distorting, so you sound clear and steady to everyone." checked={l.voiceEnhance !== false} onChange={(v) => { set({ voiceEnhance: v }); if (inVoice) setTimeout(reacquireMic, 50); }} />
        <ToggleSetting title="Protect My Voice on a Bad Connection" description="Sends each bit of your voice twice, so a dropped packet doesn’t become a gap or a robotic blip. Uses about twice the voice data; off in Standard quality. Takes effect the next time you join a call." checked={l.voiceProtect !== false} onChange={(v) => set({ voiceProtect: v })} />
        <div className="quality-pick">
          <Field label="Voice Quality">
            <Select value={voiceQualityOf(l.voiceQuality).value} onChange={(v) => set({ voiceQuality: v })} options={VOICE_QUALITIES.map((q) => ({ value: q.value, label: q.label }))} />
          </Field>
          <p className="tiny muted">How clearly others hear you. Higher sounds fuller and uses a little more of your upload. It changes right away, even in a call.</p>
        </div>
      </div>
      <VoiceSoundSettings />
      <PopoutSettings />
      <div className="settings-section">
        <h3>Video Settings</h3>
        <div className="camera-preview">
          {camOn ? <video ref={videoRef} autoPlay playsInline muted className={cx(l.mirrorCamera && 'mirror')} /> : <div className="camera-off"><Icon name="video" size={40} /><Button onClick={() => setCamOn(true)}>Test Video</Button></div>}
        </div>
        <div className="quality-pick">
          <Field label="Camera Quality">
            <Select value={cameraQualityOf(l.cameraQuality).value} onChange={(v) => set({ cameraQuality: v })} options={CAMERA_QUALITIES.map((q) => ({ value: q.value, label: q.label }))} />
          </Field>
          <p className="tiny muted">Everyone in a call gets your video straight from you, so with more people each one gets a smaller share of your upload. This is the most you can send, not a promise. 1080p needs a fast connection and a computer that keeps up. It changes right away, even while your camera is on.</p>
        </div>
        <Field label="Camera"><Select value={l.videoDeviceId} onChange={(v) => { chooseDevice('videoinput', v); switchCamera(v); }} options={[{ value: 'default', label: 'Default' }, ...devices.video.filter((d) => d.value !== 'default')]} /></Field>
        <ToggleSetting title="Mirror my video preview" checked={l.mirrorCamera} onChange={(v) => set({ mirrorCamera: v })} />
        {camOn && <Button variant="secondary" onClick={() => setCamOn(false)}>Stop Preview</Button>}
      </div>
      <div className="settings-section">
        <h3>Connection</h3>
        <p className="muted small">Voice and video connect directly between people. Not sure calls will work from where you are (a phone on mobile data, school or work Wi-Fi)? Check it here.</p>
        <div className="row gap">
          <Button onClick={runCheck} disabled={!!check?.running}>{check?.running ? 'Checking…' : check ? 'Check again' : 'Check my connection'}</Button>
          {check && !check.running && <Button variant="secondary" onClick={() => { copyText(check.report); toast('Copied', 'success'); }}>Copy details</Button>}
        </div>
        {check && !check.running && (
          <div className={cx('conn-check', `cc-${check.level}`)} role="status" aria-live="polite">
            <b className="cc-headline">{check.headline}</b>
            {check.checks.map((c) => (
              <div key={c.key} className={cx('cc-row', c.ok === true && 'cc-ok', c.ok === false && 'cc-bad', c.ok === null && 'cc-warn')}>
                <span className="cc-mark" aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '!'}</span>
                <div><div className="cc-title">{c.title}</div>{c.detail && <div className="tiny muted">{c.detail}</div>}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ================================================================ Chat
function ChatTab() {
  const c = useStore((s) => ({ ...DEFAULTS.chat, ...(s.settings.chat || {}) }));
  const set = (patch) => updateSettings({ chat: { ...c, ...patch } });
  return (
    <>
      <h2>Chat</h2>
      <div className="settings-section"><h3>Display images, videos, and lolcats</h3>
        <ToggleSetting title="When uploaded directly to NullChat" description="Show images and videos inline. Otherwise they appear as file cards." checked={c.inlineMedia} onChange={(v) => set({ inlineMedia: v })} />
      </div>
      <div className="settings-section"><h3>Embeds and Link Previews</h3>
        <ToggleSetting title="Show embeds and preview website links pasted into chat" description="Also turns the Join cards under invite links on or off." checked={c.linkPreviews} onChange={(v) => set({ linkPreviews: v })} />
      </div>
      <div className="settings-section"><h3>Emoji</h3>
        <ToggleSetting title="Automatically convert emoticons in your messages to emoji" description="For example, when you type :) NullChat will convert it to 🙂." checked={c.convertEmoticons} onChange={(v) => set({ convertEmoticons: v })} />
      </div>
      <div className="settings-section"><h3>Catching Up</h3>
        <ToggleSetting title="Show a catch-up card when I come back to a busy server" description="A short “while you were gone” summary: the busiest conversations, where you were mentioned, what was pinned and the quiet replies waiting for you. You can always open it from the server’s menu (Catch Up)." checked={c.catchUp !== false} onChange={(v) => set({ catchUp: v })} />
      </div>
      <div className="settings-section"><h3>Streaks</h3>
        <ToggleSetting title="Show streaks" description="A flame with a number next to a friend you have written with, or a server that has been active, several days in a row." checked={c.streaks !== false} onChange={(v) => set({ streaks: v })} />
      </div>
      <div className="settings-section"><h3>Text Box</h3>
        <ToggleSetting title="Spellcheck" checked={c.spellcheck} onChange={(v) => set({ spellcheck: v })} />
        <ToggleSetting title="Keep the cursor in the message box" description="Clicking around the chat doesn't take it away, a letter typed or text pasted anywhere goes into the box, and it comes back when a menu or window closes. Computers only." checked={c.keepComposerFocus} onChange={(v) => set({ keepComposerFocus: v })} />
        <ToggleSetting title="Show a send message button" description="Always shown on touch devices." checked={c.showSendButton} onChange={(v) => set({ showSendButton: v })} />
      </div>
    </>
  );
}

// ================================================================ Notifications
const SOUND_NAMES = [['message', 'Message'], ['mention', 'Mention'], ['join', 'User Join'], ['leave', 'User Leave'], ['mute', 'Mute'], ['unmute', 'Unmute'], ['deafen', 'Deafen'], ['undeafen', 'Undeafen'], ['disconnect', 'Disconnect'], ['ptt', 'Push to Talk'], ['stream', 'Stream Started'], ['ring', 'Incoming Ring']];
// Notifications while NullChat is closed (phones, and browsers): see lib/push.js
function PushSection() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const refresh = async () => setSt(await pushStatus());
  useEffect(() => { refresh(); }, []);
  if (!st || st.support.reason === 'desktop' || st.support.reason === 'dev') return null;
  const reason = st.support.reason;
  const run = async (fn) => {
    setBusy(true); setResult('');
    try { await fn(); } catch (e) { toast(e.message || 'Could not change notifications.', 'error'); }
    await refresh(); setBusy(false);
  };
  const test = async () => {
    setBusy(true); setResult('');
    try {
      const r = await sendTestPush();
      setResult(r.sent ? 'Sent. It should arrive in a few seconds.' : r.devices ? 'The notification service did not accept it. Try turning notifications off and on again.' : 'This account has no device set up yet.');
    } catch (e) { setResult(e.message || 'Could not send the test.'); }
    setBusy(false);
  };
  return (
    <div className="settings-section">
      <h3>When NullChat is closed</h3>
      {reason === 'ios-install' && (
        <div className="notice">
          <strong>On iPhone and iPad, add NullChat to your Home Screen first.</strong>
          <ol className="small" style={{ margin: '8px 0 0 18px', padding: 0 }}>
            <li>Open this page in <b>Safari</b>.</li>
            <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
            <li>Open NullChat from your Home Screen, log in, and come back to this screen to turn notifications on.</li>
          </ol>
          <div className="muted small" style={{ marginTop: 6 }}>Needs iOS or iPadOS 16.4 or newer.</div>
        </div>
      )}
      {reason === 'unsupported' && <p className="muted small">{st.native ? 'This copy of the app was built without notifications. Update the app.' : 'This browser can’t send notifications while it’s closed. Chrome, Edge, Firefox and Safari (iOS 16.4+, from the Home Screen) can.'}</p>}
      {st.native && st.serverReady === false && <p className="muted small">This server isn’t set up to send notifications to phone apps yet. Whoever runs it can turn them on by following docs/PHONE_APPS.md.</p>}
      {st.support.ok && (
        <>
          <ToggleSetting title="Notify me on this device"
            description={st.permission === 'denied' ? 'Notifications are blocked for NullChat. Allow them in your phone or browser settings, then switch this on.' : 'Get a notification for direct messages, @mentions and replies even when NullChat isn’t open. Do Not Disturb and muted servers and channels are respected.'}
            checked={st.subscribed} disabled={busy || st.permission === 'denied' || (st.native && st.serverReady === false)} onChange={(on) => run(on ? enablePush : disablePush)} />
          {st.subscribed && (
            <>
              <ToggleSetting title="Notify me for every message" description="Also notify for all messages in servers and channels you haven’t muted or set to “Only @mentions”. Can get busy in big servers."
                checked={st.everyMessage} disabled={busy} onChange={(v) => run(() => setEveryMessage(v))} />
              <ToggleSetting title="Show message text in notifications" description="Turn off to only show “New message” on your lock screen."
                checked={st.preview} disabled={busy} onChange={(v) => run(() => setPreview(v))} />
              <SettingRow title="Check that it works" description={result || 'Sends a notification to this account’s devices right now. Close or minimise NullChat to see it arrive.'} divider={false}>
                <Button variant="secondary" size="sm" loading={busy} onClick={test}>Send test notification</Button>
              </SettingRow>
            </>
          )}
        </>
      )}
    </div>
  );
}

function NotificationsTab() {
  const n = useStore((s) => ({ ...DEFAULTS.notifications, ...(s.settings.notifications || {}) }));
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const set = (patch) => updateSettings({ notifications: { ...n, ...patch } });
  return (
    <>
      <h2>Notifications</h2>
      <PushSection />
      {!inNativeApp() && <ToggleSetting title="Enable Desktop Notifications" description={perm === 'denied' ? 'Notifications are blocked by your browser. Allow them in the site settings (🔒 icon in the address bar).' : perm === 'unsupported' ? 'Your browser does not support notifications.' : 'Show a notification when you get a message while NullChat is in the background.'}
        checked={n.desktop && perm === 'granted'} disabled={perm === 'denied' || perm === 'unsupported'}
        onChange={async (v) => { if (v) { const p = await requestNotificationPermission(); setPerm(p); if (p !== 'granted') return; } set({ desktop: v }); }} />}
      <ToggleSetting title="Let close friends through Do Not Disturb" description="While you are on Do Not Disturb, direct messages and mentions from the friends you starred still notify you. Star a friend on the Friends page." checked={!!n.closeFriendsBreakDnd} onChange={(v) => set({ closeFriendsBreakDnd: v })} />
      <ToggleSetting title="Enable Unread Message Badge" description="Shows a count of mentions and requests in the browser tab title." checked={n.unreadBadge} onChange={(v) => set({ unreadBadge: v })} />
      <div className="settings-section">
        <h3>Sounds</h3>
        <ToggleSetting title="Enable all sounds" checked={n.sounds} onChange={(v) => set({ sounds: v })} />
        {n.sounds && SOUND_NAMES.map(([k, label]) => (
          <SettingRow key={k} title={<span className="row-center">{label}<button className="icon-btn small" aria-label={`Preview ${label}`} onClick={() => { if (k === 'ring') import('../lib/sounds.js').then((m) => { m.startRinging(); setTimeout(m.stopRinging, 2000); }); else play(k); }}><Icon name="volume" size={14} /></button></span>}>
            <Switch checked={!n.disabledSounds?.[k]} onChange={(v) => set({ disabledSounds: { ...(n.disabledSounds || {}), [k]: !v } })} />
          </SettingRow>
        ))}
      </div>
      <div className="settings-section">
        <h3>Per-server notifications</h3>
        <p className="muted small">Right-click any server icon → Notification Settings to choose between All Messages, Only @mentions, or Nothing, or to mute it entirely. Channels can be muted the same way.</p>
      </div>
    </>
  );
}

// ================================================================ Keybinds
function KeybindRecorder({ action, value }) {
  const [rec, setRec] = useState(false);
  const binds = useStore((s) => s.settings?.keybinds || {});
  const start = () => {
    setRec(true);
    captureNextCombo((combo) => {
      setRec(false);
      updateSettings({ keybinds: { ...DEFAULT_KEYBINDS, ...binds, [action]: combo || '' } });
    });
  };
  return (
    <button className={cx('keybind-rec', rec && 'recording')} onClick={start}>
      <span>{rec ? 'Press keys… (Esc to clear)' : prettyCombo(value)}</span>
      <Icon name="keyboard" size={16} />
    </button>
  );
}
function KeybindsTab() {
  const binds = useStore((s) => ({ ...DEFAULT_KEYBINDS, ...(s.settings?.keybinds || {}) }));
  return (
    <>
      <h2>Keybinds</h2>
      <p className="muted">Click a shortcut and press the new key combination. Keybinds work while NullChat is focused.</p>
      <div className="keybind-list">
        {Object.keys(DEFAULT_KEYBINDS).map((k) => (
          <div key={k} className="keybind-row">
            <span className="grow">{KEYBIND_LABELS[k]}</span>
            <KeybindRecorder action={k} value={binds[k]} />
          </div>
        ))}
      </div>
      <Button variant="secondary" onClick={() => updateSettings({ keybinds: DEFAULT_KEYBINDS })}>Reset to defaults</Button>
    </>
  );
}

// ================================================================ Language
function LanguageTab() {
  const locale = useSetting('locale');
  return (
    <>
      <h2>Language</h2>
      <h3>Select a language</h3>
      <RadioGroup value={locale} onChange={(v) => updateSettings({ locale: v })} options={LANGUAGES.map((l) => ({ value: l.code, label: <span className="row-between grow"><span>{l.native}</span><span className="muted small">{l.name}</span></span> }))} />
      <p className="tiny muted mt">Dates and times follow the selected language. Some text may still appear in English.</p>
    </>
  );
}

// ================================================================ Updates (browser and desktop app)
function UpdatesSection() {
  const u = useUpdates();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { desktop?.info().then(setInfo).catch(() => {}); }, []);
  const check = async () => {
    setBusy(true); setMsg('');
    const [web, shell] = await Promise.all([checkForUpdate({ force: true }), checkShellUpdate()]);
    setBusy(false);
    if (web === 'available') setMsg('A new version is ready. Use Update now.');
    else if (shell === 'available' || shell === 'restarting') setMsg('An app update was found.');
    else if (web === 'unsupported') setMsg('Update checks are off when running from the development server.');
    else if (web === 'error') setMsg('Couldn’t reach the server to check. Try again in a moment.');
    else setMsg('You’re on the latest version.');
  };
  const webReady = u.web === 'available';
  const shellReady = u.shell?.state === 'ready';
  return (
    <div className="settings-section">
      <h3>Updates</h3>
      <p className="muted small">
        {desktop && info ? `Desktop app ${info.version} · ` : ''}Web version <code className="mono">{CURRENT_BUILD || 'dev'}</code>
        {webReady || shellReady ? ' · an update is ready' : ''}
      </p>
      <div className="row gap">
        {webReady && <Button onClick={updateNow}>Update now</Button>}
        {shellReady && <Button onClick={restartForUpdate}>Restart to update</Button>}
        <Button variant="secondary" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check for updates'}</Button>
        <Button variant="secondary" onClick={openWhatsNew}>What’s new</Button>
      </div>
      {msg && <p className="small muted mt" role="status">{msg}</p>}
      <p className="tiny muted mt">NullChat also checks by itself every few minutes and shows an <b>Update</b> bar at the top when you deploy something new.</p>
    </div>
  );
}

// ================================================================ Advanced
function DesktopSection() {
  const [info, setInfo] = useState(null);
  useEffect(() => { desktop?.info().then(setInfo); }, []);
  if (!desktop) {
    return (
      <div className="settings-section">
        <h3>Apps</h3>
        <p className="muted small">Install NullChat as an app on this device, or download the desktop app.</p>
        <Button variant="secondary" onClick={openDownloadApps}>Download Apps</Button>
      </div>
    );
  }
  if (!info) return null;
  return (
    <div className="settings-section">
      <h3>Desktop App</h3>
      <p className="muted small">NullChat {info.version} · {info.mode === 'host' ? 'Hosting a server on this computer' : `Connected to ${info.url}`}</p>
      {info.mode === 'host' && (
        <>
          <div className="notice">
            Friends on your network can join at {info.lan.length ? info.lan.map((ip) => <code key={ip} className="mono">http://{ip}:{info.port}</code>).reduce((a, b) => [a, ' or ', b]) : <code>http://&lt;this-PC&gt;:{info.port}</code>}.
            {' '}To let people join over the internet, forward port {info.port} on your router or deploy NullChat online (see README).
          </div>
          <Button variant="secondary" onClick={() => desktop.openDataFolder()}>Open Data Folder</Button>
        </>
      )}
      <ToggleSetting title="Open NullChat when your computer starts" description="Starts minimized in the system tray, so you never miss a message." checked={info.openAtLogin} onChange={(v) => { desktop.setPref('openAtLogin', v); setInfo({ ...info, openAtLogin: v }); }} />
      <ToggleSetting title="Minimize to tray when closing" description={info.mode === 'host' ? 'Closing the window keeps NullChat (and your server) running in the system tray. Quit from the tray icon.' : 'Closing the window keeps NullChat running in the system tray. Quit from the tray icon.'} checked={info.closeToTray} onChange={(v) => { desktop.setPref('closeToTray', v); setInfo({ ...info, closeToTray: v }); }} />
      {!info.locked && (
        <div className="row gap mt">
          <Button variant="secondary" onClick={() => desktop.switchServer()}>Switch Server…</Button>
        </div>
      )}
      {!info.updates && <p className="tiny muted mt">Automatic updates are off because this build has no update server configured.</p>}
    </div>
  );
}

function AdvancedTab() {
  const dev = useSetting('developerMode');
  return (
    <>
      <h2>Advanced</h2>
      <UpdatesSection />
      <DesktopSection />
      <ToggleSetting title="Developer Mode" description="Adds “Copy ID” to context menus for users, servers, channels and messages." checked={dev} onChange={(v) => updateSettings({ developerMode: v })} />
      <div className="settings-section">
        <h3>Reset local data</h3>
        <p className="muted small">Clears device settings (audio devices, volumes, collapsed categories) stored in this browser. Your account settings are kept.</p>
        <Button variant="secondary" onClick={() => { localStorage.removeItem('nullchat.device'); localStorage.removeItem('nullchat.recentEmoji'); toast('Local data cleared. Reloading…', 'success'); setTimeout(() => location.reload(), 800); }}>Clear Local Data</Button>
      </div>
    </>
  );
}

function HelpTab() {
  const [tab, setTab] = useState('start');
  return (
    <>
      <h2>Help</h2>
      <div className="notice row gap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span>See what changed in the latest update.</span>
        <Button size="sm" variant="secondary" onClick={openWhatsNew}>What’s new</Button>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'start', label: 'Getting Started' }, { value: 'md', label: 'Formatting' }, { value: 'keys', label: 'Shortcuts' }]} />
      {tab === 'start' && (
        <div className="help-text">
          <p><b>Servers</b> are communities with text and voice channels. Click <b>+</b> in the server bar to create one or join with an invite.</p>
          <p><b>Voice channels</b> are drop-in: click one to join. Use the controls at the bottom-left to mute, deafen, turn on video or share your screen.</p>
          <p><b>Friends &amp; DMs</b>: add friends by username on the Friends page. Start a voice or video call from any DM header.</p>
          <p><b>Roles &amp; permissions</b>: open Server Settings → Roles to create roles and decide what each can do. Channels can override permissions in their settings.</p>
          <p><b>Moderation</b>: right-click a member to timeout, kick or ban. Server Settings has AutoMod, the audit log, bans, invites, and <b>Reports</b> (messages people have reported).</p>
          <p><b>Forward or report a message</b>: right-click a message (on a phone, press and hold it) and choose Forward to send a copy to someone else, or Report Message to tell the server’s moderators and this NullChat’s admin about it. The person you report is never told.</p>
          <p><b>Polls</b>: press <b>+</b> next to the message box and choose Create Poll, or type <code>/poll Lunch? | Pizza | Tacos</code>.</p>
          <p><b>Save for later</b>: right-click a message and choose Save for Later or Remind Me. Your saved messages are in Inbox → Saved (on a phone, tap Saved in the Home sidebar).</p>
          <p><b>Send later</b>: type a message and press the clock button next to Send (or type <code>/schedule Your message</code>). Waiting messages are in Inbox → Scheduled.</p>
          <p><b>Your data</b>: Settings → Privacy &amp; Safety → Download my data gives you a copy of everything you’ve written and set up.</p>
        </div>
      )}
      {tab === 'md' && (
        <div className="help-text">
          {[['**bold**', 'bold'], ['*italics*', 'italics'], ['__underline__', 'underline'], ['~~strike~~', 'strikethrough'], ['||spoiler||', 'spoiler'], ['`code`', 'inline code'], ['```js\\ncode block\\n```', 'code block'], ['> quote', 'block quote'], ['# Heading', 'heading'], ['- list item', 'list'], ['[text](https://example.com)', 'masked link'], ['<t:1700000000:R>', 'timestamp']].map(([src, label]) => (
            <div key={label} className="md-help-row"><code>{src}</code><span className="muted small">{label}</span></div>
          ))}
        </div>
      )}
      {tab === 'keys' && <div className="help-text"><p>Press <kbd>Ctrl</kbd> + <kbd>/</kbd> anywhere to see every shortcut, or customise them in Keybinds.</p></div>}
    </>
  );
}

export { getSetting };
