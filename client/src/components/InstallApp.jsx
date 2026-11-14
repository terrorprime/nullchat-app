// Getting NullChat onto a phone: a one-tap install on Android, clear steps on iPhone, and the Android app
// file (APK) when the server has one. Used by the install banner, the "Get the app" screen and /install.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { cx, copyText } from '../lib/utils.js';
import { toast } from '../lib/toast.js';
import { desktop, isStandalone, useInstall, promptInstall, installEnv, installBannerHidden, hideInstallBanner } from '../lib/install.js';
import { Button, Modal, openModal, Spinner } from './ui.jsx';
import { Icon } from './icons.jsx';
import { AuthShell } from './Auth.jsx';
import { shouldOfferPush, enablePush, hidePushPrompt, sendTestPush } from '../lib/push.js';

// ---- is there an Android app file on this server? (cached for the session) -----------------------
let apkPromise = null;
function loadApk() {
  if (!apkPromise) apkPromise = api.get('/downloads', { noAuthRedirect: true }).then((l) => (l || []).find((f) => f.platform === 'android' && !f.damaged) || null).catch(() => null);
  return apkPromise;
}
function useApk() {
  const [apk, setApk] = useState(undefined);
  useEffect(() => { let alive = true; loadApk().then((a) => alive && setApk(a)); return () => { alive = false; }; }, []);
  return apk;
}

const ShareGlyph = () => (
  <svg className="inst-glyph" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share">
    <path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);
const MenuGlyph = ({ dots }) => (dots
  ? <span className="inst-glyph inst-dots" aria-label="Menu">⋮</span>
  : <Icon name="menu" size={18} />);

function Steps({ items }) {
  return (
    <ol className="inst-steps">
      {items.map((it, i) => <li key={i}><span className="inst-num">{i + 1}</span><span>{it}</span></li>)}
    </ol>
  );
}

function IosSteps({ env }) {
  const where = env.browser === 'safari' ? 'at the bottom of Safari (top right on iPad)' : env.browser === 'other' ? 'in your browser' : `in ${{ chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge' }[env.browser]}`;
  return (
    <>
      <Steps items={[
        <>Tap the <b>Share</b> button <ShareGlyph /> {where}.</>,
        <>Scroll down and tap <b>Add to Home Screen</b>.</>,
        <>Tap <b>Add</b>. NullChat now sits on your home screen like any other app.</>,
      ]}
      />
      {env.browser !== 'safari' && <p className="tiny muted">Don’t see “Add to Home Screen”? Open this page in <b>Safari</b> and try again (older iPhones only allow it there).</p>}
    </>
  );
}

function AndroidSteps({ env }) {
  const menu = { samsung: <>Tap the <b>menu</b> <MenuGlyph /> at the bottom, then <b>Add page to</b> → <b>Home screen</b>.</>, edge: <>Tap the <b>menu</b> <MenuGlyph /> at the bottom, then <b>Add to phone</b>.</>, firefox: <>Tap the <b>menu</b> <MenuGlyph dots />, then <b>Install</b>.</> }[env.browser]
    || <>Tap the <b>menu</b> <MenuGlyph dots /> in the top right, then <b>Install app</b> (or <b>Add to Home screen</b>).</>;
  return <Steps items={[menu, <>Tap <b>Install</b>. NullChat shows up in your app list and on your home screen.</>]} />;
}

const OS_NAME = { windows: 'Windows', mac: 'Mac', linux: 'Linux' };

/**
 * Installing NullChat as an app from a computer's browser: no download, no building anything. Works on Mac, Linux and
 * Windows with Chrome, Edge, Brave or Opera (a button, or the address-bar icon), and with Safari on macOS 14+ (Add to Dock).
 */
export function DesktopInstall({ heading = true }) {
  const env = installEnv();
  const { prompt, installed } = useInstall();
  if (desktop) return null;
  if (isStandalone() || installed) return <div className="notice success">NullChat is installed on this computer. 🎉 Open it from your app menu, Dock or Start menu.</div>;
  const install = async () => { if (await promptInstall()) toast('NullChat installed!', 'success'); };
  const name = OS_NAME[env.os] || 'computer';
  let body;
  if (prompt) {
    body = (
      <>
        <Button size="lg" className="full" onClick={install}><Icon name="download" size={16} /> Install NullChat</Button>
        <p className="tiny muted">It gets its own window and icon in your {env.os === 'mac' ? 'Dock and Launchpad' : env.os === 'linux' ? 'app menu' : 'Start menu'}, and notifications work like any other app.</p>
      </>
    );
  } else if (env.browser === 'safari') {
    body = (
      <Steps items={[
        <>In the menu bar at the top of the screen click <b>File</b>.</>,
        <>Choose <b>Add to Dock…</b>, then click <b>Add</b>. NullChat now opens in its own window from your Dock.</>,
        <>Don’t see it? That needs <b>macOS 14 (Sonoma)</b> or newer with Safari 17. On an older Mac, use Chrome or Edge instead.</>,
      ]}
      />
    );
  } else if (env.browser === 'firefox') {
    body = <p className="small">Firefox can’t install web apps on {name}. Open this page in <b>Chrome</b>, <b>Edge</b> or <b>Brave</b> and use <b>Install</b> there{env.os === 'windows' ? '' : ', or download the desktop app below if your server has one'}.</p>;
  } else if (env.browser === 'chrome' || env.browser === 'edge' || env.browser === 'opera') {
    body = (
      <Steps items={[
        <>Look at the right end of the address bar for the <b>install</b> icon (a small screen with a down arrow) and click it.</>,
        env.browser === 'edge'
          ? <>Or open the <b>⋯</b> menu → <b>Apps</b> → <b>Install this site as an app</b>.</>
          : <>Or open the <b>⋮</b> menu → <b>Cast, save and share</b> (or <b>Save and share</b>) → <b>Install NullChat…</b></>,
        <>Click <b>Install</b>. NullChat opens in its own window and stays in your {env.os === 'mac' ? 'Dock' : env.os === 'linux' ? 'app menu' : 'Start menu'}.</>,
      ]}
      />
    );
  } else {
    body = <p className="small">Open this page in <b>Chrome</b>, <b>Edge</b> or <b>Brave</b> (or <b>Safari</b> on a Mac) to install NullChat as an app. Other browsers can’t.</p>;
  }
  return (
    <section className="inst-card" data-desktop-install>
      {heading && <h3><Icon name="screen" size={18} /> Install from your browser{env.os in OS_NAME ? ` · ${name}` : ''}</h3>}
      {body}
    </section>
  );
}

/** Everything a visitor needs to get the app, tailored to their device. */
export function InstallSteps() {
  const env = installEnv();
  const { prompt, installed } = useInstall();
  const apk = useApk();
  const link = `${location.origin}/install`;

  if (desktop) return <div className="notice success">You’re already using the NullChat app. 🎉</div>;
  if (isStandalone() || installed) return <div className="notice success">NullChat is installed on this device. 🎉 Open it from your home screen or app list.</div>;

  const install = async () => { if (await promptInstall()) toast('NullChat installed!', 'success'); };
  const android = (
    <section className="inst-card">
      <h3><Icon name="phone" size={18} /> Android</h3>
      {prompt && env.android && <Button size="lg" className="full" onClick={install}>Install NullChat</Button>}
      {!(prompt && env.android) && <AndroidSteps env={env} />}
      {apk === undefined ? <Spinner size={18} /> : apk && (
        <div className="inst-apk">
          <a className={cx('btn btn-lg full', prompt && env.android ? 'btn-secondary' : 'btn-primary')} href={apk.url} download><Icon name="download" size={16} /> Download the Android app · {Math.max(1, Math.round(apk.size / 1048576))} MB</a>
          <p className="tiny muted">Android may ask you to allow installs from this browser. The file comes from this NullChat server.</p>
        </div>
      )}
    </section>
  );
  const ios = (
    <section className="inst-card">
      <h3><Icon name="phone" size={18} /> iPhone &amp; iPad</h3>
      <IosSteps env={env} />
    </section>
  );
  const first = env.ios ? [ios, android] : [android, ios];
  return (
    <div className="inst">
      {env.inApp && (
        <div className="notice warn">You’re inside another app’s browser, which can’t install anything. Tap the <b>⋯</b> menu and choose <b>Open in Safari / Open in browser</b>, then come back to this page.</div>
      )}
      {!env.mobile && <DesktopInstall />}
      {env.mobile ? first[0] : first}
      {env.mobile && (
        <details className="inst-other">
          <summary>{env.ios ? 'On an Android phone?' : 'On an iPhone or iPad?'}</summary>
          {first[1]}
        </details>
      )}
      {!env.mobile && (
        <div className="inst-share">
          <div className="small muted">Open this page on your phone:</div>
          <div className="copy-row row gap"><input className="input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Install page link" />
            <Button variant="secondary" onClick={async () => toast((await copyText(link)) ? 'Link copied' : 'Select the link and copy it', 'success', 2000)}><Icon name="copy" size={16} /> Copy</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function openInstallSheet() {
  openModal(({ close }) => (
    <Modal title="Get the NullChat app" subtitle="Put NullChat on your home screen. It opens full screen, like any other app." onClose={close} size="md" className="inst-modal">
      <InstallSteps />
    </Modal>
  ));
}

/** Slim bar at the top of the app for phone visitors who haven't installed it. */
export function InstallBanner() {
  const env = installEnv();
  const { prompt, installed } = useInstall();
  const [hidden, setHidden] = useState(installBannerHidden);
  if (desktop || !env.mobile || isStandalone() || installed || hidden) return null;
  const go = async () => { if (prompt) { if (await promptInstall()) toast('NullChat installed!', 'success'); } else openInstallSheet(); };
  return (
    <div className="notice-banner install-banner" role="region" aria-label="Install the app">
      <Icon name="phone" size={18} />
      <span className="install-banner-text">{env.ios ? 'Get the app for notifications' : 'Get the NullChat app'}</span>
      <button className="banner-btn" onClick={go}>{prompt ? 'Install' : 'How to'}</button>
      <button className="banner-close" aria-label="Dismiss" onClick={() => { hideInstallBanner(); setHidden(true); }}><Icon name="x" size={16} /></button>
    </div>
  );
}

/** /install: a page you can send to friends. Works without an account. */
export function InstallPage() {
  return (
    <AuthShell wide>
      <div className="inst-page">
        <h1>Get the NullChat app</h1>
        <p className="muted center">Free, and it takes about ten seconds.</p>
        <InstallSteps />
        <p className="small muted center"><a className="link" href="/login">Back to NullChat</a></p>
      </div>
    </AuthShell>
  );
}

/**
 * The slim bar at the top on a phone: first "Turn on notifications" (so messages reach you while NullChat is closed), and once that is
 * answered or put off, the "Get the app" bar. One at a time.
 */
export function PhoneBanner() {
  const [offer, setOffer] = useState(shouldOfferPush);
  const [busy, setBusy] = useState(false);
  // (in the phone app we only learn whether notifications can be offered a moment after it starts)
  useEffect(() => {
    const again = () => setOffer(shouldOfferPush());
    window.addEventListener('nullchat-push-offer', again);
    return () => window.removeEventListener('nullchat-push-offer', again);
  }, []);
  if (!offer) return <InstallBanner />;
  const later = () => { hidePushPrompt(); setOffer(false); };
  const turnOn = async () => {
    setBusy(true);
    try {
      await enablePush();
      setOffer(false);
      toast('Notifications are on. You’ll hear about DMs, @mentions and replies when NullChat is closed. A test is on its way.', 'success', 6000);
      sendTestPush().catch(() => {});
    } catch (e) {
      toast(e.message || 'Couldn’t turn notifications on.', 'error', 6000);
      later();
    }
    setBusy(false);
  };
  return (
    <div className="notice-banner install-banner push-banner" role="region" aria-label="Notifications">
      <Icon name="bell" size={18} />
      <span className="install-banner-text">Get notified when you’re away</span>
      <button className="banner-btn" onClick={turnOn} disabled={busy}>{busy ? 'One moment…' : 'Turn on'}</button>
      <button className="banner-close" aria-label="Not now" onClick={later}><Icon name="x" size={16} /></button>
    </div>
  );
}
