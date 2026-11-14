// In-app screen share picker for the NullChat desktop app: every screen and window with a live preview,
// instead of a system dialog. The desktop shell supplies the sources (see desktop/screenshare.cjs).
import { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/utils.js';
import { Button, Modal, Select, Spinner, Switch, Tabs, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';

export const SHARE_QUALITIES = [
  { value: 'smooth', label: '720p · 30 fps (lowest bandwidth)', width: 1280, height: 720, fps: 30 },
  { value: 'standard', label: '1080p · 60 fps (recommended)', width: 1920, height: 1080, fps: 60 },
  { value: 'sharp', label: '1440p · 60 fps (sharpest text)', width: 2560, height: 1440, fps: 60 },
];
export const qualityOf = (v) => SHARE_QUALITIES.find((q) => q.value === v) || SHARE_QUALITIES[1];

const PREF_KEY = 'nullchat.screenshare';
export function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return { audio: !!p.audio, quality: qualityOf(p.quality).value }; } catch { return { audio: false, quality: 'standard' }; }
}
export function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

/**
 * Opens the picker. Resolves to { id, name, type, audio, quality } or null when cancelled.
 * Only call this when window.nullchatDesktop.screenSources exists.
 */
// The call's own window shows the picker itself when the share was asked for there (components/CallPopout.jsx registers this).
let host = null;
export function setPickerHost(fn) { host = fn; }
export function pickScreenSource(from) {
  const own = from && host ? host(from) : null;
  if (own) return own;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openModal(({ close }) => <PickerModal onPick={(v) => { finish(v); close(); }} onCancel={() => { finish(null); close(); }} />, { onClose: () => finish(null) });
  });
}

function PickerModal({ onPick, onCancel }) {
  const desktop = window.nullchatDesktop;
  const [state, setState] = useState({ loading: true, sources: [], audio: false, error: null });
  const [tab, setTab] = useState('screen');
  const [selected, setSelected] = useState(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const firstLoad = useRef(true);

  // Load the list, then keep the previews fresh while the picker is open.
  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = async () => {
      try {
        const r = await desktop.screenSources();
        if (!alive) return;
        if (!r?.ok) {
          setState({ loading: false, sources: [], audio: false, error: r?.error || 'failed' });
          return; // permission / failure: do not keep retrying
        }
        setState({ loading: false, sources: r.sources, audio: !!r.audio, error: null });
        if (firstLoad.current) {
          firstLoad.current = false;
          if (!r.sources.some((s) => s.type === 'screen') && r.sources.length) setTab('window');
        }
        // Anything that was selected but has since closed is dropped.
        setSelected((cur) => (cur && r.sources.some((s) => s.id === cur) ? cur : null));
      } catch {
        if (alive) setState({ loading: false, sources: [], audio: false, error: 'failed' });
        return;
      }
      timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screens = state.sources.filter((s) => s.type === 'screen');
  const windows = state.sources.filter((s) => s.type === 'window');
  const shown = tab === 'screen' ? screens : windows;
  const chosen = state.sources.find((s) => s.id === selected) || null;
  const setPref = (patch) => setPrefs((p) => { const n = { ...p, ...patch }; savePrefs(n); return n; });
  const go = (src = chosen) => { if (src) onPick({ id: src.id, name: src.name, type: src.type, audio: state.audio && prefs.audio, quality: prefs.quality }); };

  let body;
  if (state.loading) body = <div className="ss-state"><Spinner /><span className="muted small">Looking for screens and windows…</span></div>;
  else if (state.error === 'permission') {
    body = (
      <div className="ss-state">
        <Icon name="screen" size={32} />
        <b>NullChat needs permission to record your screen</b>
        <span className="muted small">Open System Settings → Privacy &amp; Security → Screen Recording, turn on NullChat, then restart the app and try again.</span>
      </div>
    );
  } else if (state.error) {
    body = <div className="ss-state"><b>Couldn’t list your screens</b><span className="muted small">Close this and try again.</span></div>;
  } else if (!shown.length) {
    body = <div className="ss-state"><span className="muted small">{tab === 'screen' ? 'No screens found.' : 'No other windows are open. Open the app you want to share, then it will show up here.'}</span></div>;
  } else {
    body = (
      <div className="ss-grid" role="listbox" aria-label={tab === 'screen' ? 'Screens' : 'Windows'}>
        {shown.map((s) => (
          <button
            key={s.id} type="button" role="option" aria-selected={selected === s.id} className={cx('ss-tile', selected === s.id && 'active')}
            onClick={() => setSelected(s.id)} onDoubleClick={() => go(s)} title={s.name}
          >
            <span className="ss-thumb">
              {s.thumb ? <img src={s.thumb} alt="" draggable={false} /> : <Icon name="screen" size={28} />}
              {selected === s.id && <span className="ss-check"><Icon name="check" size={14} strokeWidth={3} /></span>}
            </span>
            <span className="ss-name">
              {s.icon ? <img className="ss-icon" src={s.icon} alt="" draggable={false} /> : <Icon name="screen" size={14} />}
              <span>{s.name}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <Modal
      title="Share your screen" subtitle="Everyone in the call will see what you pick." onClose={onCancel} size="lg" className="ss-modal"
      footer={<><Button variant="link" onClick={onCancel}>Cancel</Button><Button disabled={!chosen} onClick={() => go()}><Icon name="screen" size={16} /> Share {chosen ? (chosen.type === 'screen' ? 'screen' : 'window') : ''}</Button></>}
    >
      <Tabs
        value={tab} onChange={setTab}
        tabs={[{ value: 'screen', label: `Screens${state.loading ? '' : ` (${screens.length})`}` }, { value: 'window', label: `Windows${state.loading ? '' : ` (${windows.length})`}` }]}
      />
      {body}
      <div className="ss-options">
        <label className="ss-opt">
          <span className="ss-opt-label">Quality</span>
          <Select value={prefs.quality} onChange={(v) => setPref({ quality: v })} options={SHARE_QUALITIES.map((q) => ({ value: q.value, label: q.label }))} />
        </label>
        {state.audio && (
          <div className="ss-opt ss-sound">
            <span className="ss-opt-label">Share computer sound</span>
            <Switch checked={prefs.audio} onChange={(v) => setPref({ audio: v })} label="Share computer sound" />
            <span className="tiny muted ss-sound-hint">Shares everything you hear. People in the call may hear themselves, so use it for videos and games.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
