// Custom app themes: ready-made presets, a small editor and theme codes to share.
import { useEffect, useRef, useState } from 'react';
import { cx, copyText } from '../lib/utils.js';
import { toast } from '../lib/toast.js';
import { updateSettings } from '../lib/settings.js';
import { mixHex } from '../lib/perks.js';
import {
  THEME_PRESETS, DEFAULT_CUSTOM_THEME, buildTheme, sanitizeCustomTheme, exportThemeCode, parseThemeCode,
} from '../lib/themes.js';
import { sanitizeCss, customCssSuppressed, CSS_MAX, CSS_EXAMPLES } from '../lib/customCss.js';
import { Button, Slider, ToggleSetting } from './ui.jsx';

function sameTheme(a, b) {
  return !!a && !!b && a.bg === b.bg && JSON.stringify(a.gradient || null) === JSON.stringify(b.gradient || null);
}

function PresetTile({ preset, active, onPick }) {
  const clean = sanitizeCustomTheme(preset.theme);
  const t = buildTheme(clean);
  const side = t.gradient || t.vars['--bg-tertiary'];
  const mid = t.gradient || t.vars['--bg-secondary'];
  return (
    <button type="button" className={cx('preset-tile', active && 'active')} onClick={onPick} aria-pressed={active} title={preset.label}>
      <span className="preset-preview" style={{ '--pv-main': clean.bg, '--pv-side': side, '--pv-mid': mid, '--pv-accent': preset.accent, '--pv-text': t.vars['--text-muted'] }}>
        <i className="pp-side" /><i className="pp-mid" />
        <i className="pp-main"><b /><b /><u /></i>
      </span>
      <span className="small">{preset.label}</span>
    </button>
  );
}

export function ThemeSection({ theme, customTheme, accent }) {
  const [code, setCode] = useState('');
  const ct = sanitizeCustomTheme(customTheme) || sanitizeCustomTheme(DEFAULT_CUSTOM_THEME);
  const active = theme === 'custom';
  const edit = (patch) => updateSettings({ theme: 'custom', customTheme: { ...ct, ...patch } });
  const gradient = ct.gradient;

  const toggleGradient = (on) => {
    if (!on) return edit({ gradient: null });
    edit({ gradient: { a: mixHex(ct.bg, '#000000', 0.4), b: mixHex(ct.bg, accent, 0.4), angle: 160 } });
  };
  const share = async () => {
    const text = exportThemeCode(ct, accent);
    if (await copyText(text)) toast('Theme code copied. Paste it in a chat to share it!', 'success', 3000);
    else setCode(text);
  };
  const importCode = () => {
    const t = parseThemeCode(code);
    if (!t) { toast('That is not a valid theme code.', 'error'); return; }
    updateSettings({ theme: 'custom', customTheme: { bg: t.bg, accent: t.accent, gradient: t.gradient }, ...(t.accent ? { accentColor: t.accent } : {}) });
    setCode('');
    toast('Theme applied', 'success', 2000);
  };

  return (
    <div className="settings-section">
      <h3>Custom Themes</h3>
      <p className="muted small">Pick a look, or make your own below. Free for everybody, and only you see it.</p>
      <div className="preset-grid">
        {THEME_PRESETS.map((p) => (
          <PresetTile
            key={p.id} preset={p} active={active && sameTheme(ct, sanitizeCustomTheme(p.theme)) && accent === p.accent}
            onPick={() => updateSettings({ theme: 'custom', customTheme: { ...p.theme, accent: p.accent }, accentColor: p.accent })}
          />
        ))}
      </div>

      <div className="theme-editor">
        <div className="field-label">Make your own</div>
        <div className="row gap wrap perk-colors">
          <label className="perk-color">
            <span className="tiny muted">Background</span>
            <input type="color" className="color-input" value={ct.bg} onChange={(e) => edit({ bg: e.target.value })} aria-label="Theme background colour" />
          </label>
          <span className="tiny muted theme-hint">Sidebars, inputs and text colours follow automatically. Change the accent in the section below.</span>
        </div>
        <ToggleSetting title="Sidebar gradient" description="Paints the server list, channel list and members with a gradient." checked={!!gradient} onChange={toggleGradient} />
        {gradient && (
          <div className="perk-block">
            <div className="row gap wrap perk-colors">
              <label className="perk-color">
                <span className="tiny muted">From</span>
                <input type="color" className="color-input" value={gradient.a} onChange={(e) => edit({ gradient: { ...gradient, a: e.target.value } })} aria-label="Gradient start colour" />
              </label>
              <label className="perk-color">
                <span className="tiny muted">To</span>
                <input type="color" className="color-input" value={gradient.b} onChange={(e) => edit({ gradient: { ...gradient, b: e.target.value } })} aria-label="Gradient end colour" />
              </label>
            </div>
            <div className="field-label small-label">Angle</div>
            <Slider value={gradient.angle} min={0} max={360} step={15} onChange={(v) => edit({ gradient: { ...gradient, angle: v } })} format={(v) => `${v}°`} />
          </div>
        )}
      </div>

      <div className="theme-share">
        <div className="field-label">Share or import a theme</div>
        <div className="row gap wrap">
          <Button variant="secondary" onClick={share} disabled={!active}>Copy my theme code</Button>
        </div>
        <div className="row gap theme-import">
          <input className="input" value={code} placeholder="Paste a theme code (starts with nct1:)" onChange={(e) => setCode(e.target.value)} aria-label="Theme code" />
          <Button onClick={importCode} disabled={!code.trim()}>Apply</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Custom CSS: a box for your own styles, applied on top of NullChat's as you type. Only checked CSS is saved (nothing that loads from another
 * website, see lib/customCss.js), so a half-typed or refused style never replaces the one that works.
 */
export function CustomCssSection({ value }) {
  const on = value?.on !== false;
  const saved = value?.css || '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState('');
  const latest = useRef({ draft: saved, saved, on });
  const timer = useRef(null);
  const fileInput = useRef(null);
  latest.current.on = on;

  // another device (or a reset) changed the saved CSS: follow it unless the person has typed something that is not saved yet
  useEffect(() => {
    if (latest.current.draft === latest.current.saved) { setDraft(saved); latest.current.draft = saved; setError(''); }
    latest.current.saved = saved;
  }, [saved]);

  const commit = (text) => {
    const r = sanitizeCss(text);
    if (!r.ok) { setError(r.error); return false; }
    setError('');
    if (r.css !== latest.current.saved) { latest.current.saved = r.css; updateSettings({ customCss: { on: latest.current.on, css: r.css } }); }
    return true;
  };
  const type = (text) => {
    latest.current.draft = text; setDraft(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(text), 350);
  };
  useEffect(() => () => { clearTimeout(timer.current); if (latest.current.draft !== latest.current.saved) commit(latest.current.draft); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => { if (await copyText(draft)) toast('CSS copied.', 'success', 2000); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/css' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'nullchat-theme.css' });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const load = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (f.size > CSS_MAX * 4) { toast('That file is too big for custom CSS.', 'error'); return; }
    const text = await f.text();
    type(text); clearTimeout(timer.current); commit(text);
  };
  const addExample = (id) => {
    const ex = CSS_EXAMPLES.find((x) => x.id === id);
    if (ex) type(`${draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n` : ''}${ex.css}`);
  };
  const suppressed = customCssSuppressed();

  return (
    <div className="settings-section custom-css">
      <h3>Custom CSS</h3>
      <p className="muted small">Change anything about how NullChat looks with your own styles. They run after NullChat’s own, apply as you type, follow your account to every device, and only you see them. Colors can be changed through variables such as <code>--accent</code> and <code>--bg-primary</code>.</p>
      <ToggleSetting title="Use my custom CSS" description="Switch it off to go back to the plain theme without losing what you wrote." checked={on} onChange={(v) => { latest.current.on = v; updateSettings({ customCss: { on: v, css: latest.current.saved } }); }} />
      {suppressed && <div className="css-note" role="status">Custom CSS is switched off on this device right now (<code>?nocss</code> in the address, or Ctrl+Alt+Shift+C). Press Ctrl+Alt+Shift+C again, or open NullChat without <code>?nocss</code>, to bring it back.</div>}
      <textarea
        className="input css-editor" value={draft} onChange={(e) => type(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
        placeholder={'/* for example */\n.member-list { display: none; }'} aria-label="Custom CSS" aria-invalid={!!error} aria-describedby="css-help"
        rows={12}
      />
      <div className="row gap wrap css-meta" id="css-help">
        {error ? <span className="css-error" role="alert">{error} Your last working CSS is still in use.</span>
          : <span className="tiny muted">{draft.length.toLocaleString()} / {CSS_MAX.toLocaleString()} characters. It can’t load anything from other websites. If a style locks you out, open NullChat with <code>?nocss</code> at the end of the address, or press Ctrl+Alt+Shift+C.</span>}
      </div>
      <div className="row gap wrap">
        <select className="input css-examples" value="" onChange={(e) => addExample(e.target.value)} aria-label="Add an example">
          <option value="">Add an example…</option>
          {CSS_EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <Button variant="secondary" onClick={copy} disabled={!draft.trim()}>Copy</Button>
        <Button variant="secondary" onClick={download} disabled={!draft.trim()}>Save as file</Button>
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>Load a file</Button>
        <Button variant="secondary" onClick={() => { type(''); clearTimeout(timer.current); commit(''); }} disabled={!draft}>Clear</Button>
        <input ref={fileInput} type="file" accept=".css,text/css,text/plain" hidden onChange={load} aria-label="Load a CSS file" />
      </div>
    </div>
  );
}
