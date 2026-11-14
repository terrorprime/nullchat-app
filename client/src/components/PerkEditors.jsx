// Editors for the free profile extras (profile theme, name style, avatar decoration, profile effect).
// They are controlled components: ProfileTab owns the draft and the Save button.
import { useRef, useState } from 'react';
import { cx } from '../lib/utils.js';
import {
  AVATAR_DECORATIONS, ADMIN_DECORATION_ID, ADMIN_DECORATION_LABEL, DECO_RING_STYLES, DECO_MOTIONS, DECO_ACCESSORIES,
  IMAGE_DECORATION_MIN_SCALE, IMAGE_DECORATION_MAX_SCALE, DECO_WIDTH_LABELS, DECO_GLOW_LABELS, DEFAULT_CUSTOM_DECORATION, DECO_TEMPLATES, randomCustomDecoration, NAME_FONTS, LEGACY_NAME_FONTS, NAME_EFFECTS, PRISM_COLORS, PRISM_DEFAULT_COLORS, PROFILE_THEME_PRESETS, NAME_COLOR_PRESETS,
  nameStyleProps, isHex, PROFILE_EFFECTS,
} from '../lib/perks.js';
import { Avatar, Button, Slider } from './ui.jsx';
import { Icon } from './icons.jsx';
import { ProfileEffect } from './ProfileEffect.jsx';
import { fitDecorationImage } from '../lib/decorationFit.js';
import { toast } from '../lib/toast.js';

const sameTheme = (a, b) => a && b && a.primary === b.primary && a.secondary === b.secondary;
const DEFAULT_THEME = { primary: '#5865f2', secondary: '#eb459e' };

// ---------------------------------------------------------------- profile theme
export function ProfileThemeEditor({ value, onChange }) {
  const set = (patch) => onChange({ ...(value || DEFAULT_THEME), ...patch });
  return (
    <div className="perk-block">
      <div className="perk-presets" role="listbox" aria-label="Profile theme presets">
        <button type="button" role="option" aria-selected={!value} className={cx('theme-chip none', !value && 'active')} onClick={() => onChange(null)} title="No theme">
          <span>None</span>
        </button>
        {PROFILE_THEME_PRESETS.map((p) => (
          <button
            key={p.id} type="button" role="option" aria-selected={sameTheme(value, p)} title={p.label}
            className={cx('theme-chip', sameTheme(value, p) && 'active')}
            style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})` }}
            onClick={() => onChange({ primary: p.primary, secondary: p.secondary })}
          ><span className="sr-only">{p.label}</span></button>
        ))}
      </div>
      <div className="row gap wrap perk-colors">
        <label className="perk-color">
          <span className="tiny muted">Primary</span>
          <input type="color" className="color-input" value={value?.primary || DEFAULT_THEME.primary} onChange={(e) => set({ primary: e.target.value })} aria-label="Primary profile colour" />
        </label>
        <label className="perk-color">
          <span className="tiny muted">Secondary</span>
          <input type="color" className="color-input" value={value?.secondary || DEFAULT_THEME.secondary} onChange={(e) => set({ secondary: e.target.value })} aria-label="Secondary profile colour" />
        </label>
        {value && <Button variant="link" onClick={() => onChange(null)}>Remove theme</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- name style
export const EMPTY_NAME_STYLE = { font: 'default', effect: 'none', colors: [] };

const GRADIENT_START = ['#7b61ff', '#00d1ff'];
/** Which effect button is lit: two colours with no effect is the Gradient button. */
const effectButton = (v) => (v.effect === 'none' && v.colors.length >= 2 ? 'gradient' : v.effect);

export function NameStyleEditor({ value, onChange, sampleName }) {
  const v = value || EMPTY_NAME_STYLE;
  const set = (patch) => onChange({ ...v, ...patch });
  const [a, b] = v.colors;
  const prism = v.effect === 'prism';
  const lit = effectButton(v);
  const setColor = (i, hex) => {
    const next = [...v.colors];
    next[i] = hex;
    // Second colour only makes sense with a first one.
    set({ colors: next.filter(isHex).slice(0, 2) });
  };
  const prismColors = () => (v.colors.length >= 2 ? Array.from({ length: PRISM_COLORS }, (_, i) => v.colors[i % v.colors.length]) : [...PRISM_DEFAULT_COLORS]);   // one colour alone would be flat: start from the rainbow
  const setPrism = (i, hex) => { const next = prismColors(); next[i] = hex; set({ colors: next }); };
  const pick = (id) => {
    if (id === 'none') set({ effect: 'none', colors: v.colors.slice(0, 1) });                   // Solid: one colour
    else if (id === 'gradient') set({ effect: 'none', colors: [a || GRADIENT_START[0], b || (a === GRADIENT_START[1] ? GRADIENT_START[0] : GRADIENT_START[1])] });
    else if (id === 'prism') set({ effect: 'prism', colors: prismColors() });
    else set({ effect: id, colors: v.colors.slice(0, 2) });
  };
  // The buttons show each effect on its own name, in the colours picked so far.
  const sample = (effect, colors) => nameStyleProps({ nameStyle: { font: 'default', effect, colors } }, null);
  const previewColors = v.colors.length ? v.colors : [];
  const effects = [
    { id: 'none', label: 'Solid', ...sample('none', previewColors.slice(0, 1)) },
    { id: 'gradient', label: 'Gradient', ...sample('none', previewColors.length >= 2 ? previewColors : GRADIENT_START) },
    ...NAME_EFFECTS.filter((e) => e.id !== 'none').map((e) => ({ id: e.id, label: e.label, ...sample(e.id, e.id === 'prism' ? previewColors : previewColors.slice(0, 2)) })),
  ];
  const fonts = NAME_FONTS.concat(LEGACY_NAME_FONTS.filter((f) => f.id === v.font).map((f) => ({ ...f, label: `${f.label} (old)` })));
  const ns = nameStyleProps({ nameStyle: v }, null);
  return (
    <div className="perk-block">
      <div className="perk-sample msg-author-sample">
        <span className={cx('msg-author keep-name-style', ns.className)} style={ns.style}>{sampleName}</span>
      </div>
      <div className="field-label small-label">Font</div>
      <div className="perk-options" role="radiogroup" aria-label="Name font">
        {fonts.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={v.font === f.id} className={cx('perk-option keep-name-style', v.font === f.id && 'active', f.id !== 'default' && `nfont-${f.id}`)} onClick={() => set({ font: f.id })}>{f.label}</button>
        ))}
      </div>
      <div className="field-label small-label">Effect</div>
      <div className="perk-options" role="radiogroup" aria-label="Name effect">
        {effects.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={lit === f.id} className={cx('perk-option', lit === f.id && 'active')} onClick={() => pick(f.id)}>
            <span className={cx('keep-name-style', f.className)} style={f.style}>{f.label}</span>
          </button>
        ))}
      </div>
      {prism ? (
        <>
          <div className="field-label small-label">Colours <span className="muted">(Prism blends five)</span></div>
          <div className="row gap wrap perk-colors" data-testid="prism-colors">
            {prismColors().map((c, i) => (
              <label key={i} className="perk-color">
                <span className="tiny muted">{i + 1}</span>
                <input type="color" className="color-input" value={c} onChange={(e) => setPrism(i, e.target.value)} aria-label={`Prism colour ${i + 1}`} />
              </label>
            ))}
            <Button variant="link" onClick={() => set({ colors: [...PRISM_DEFAULT_COLORS] })}>Rainbow</Button>
          </div>
        </>
      ) : (
        <>
          <div className="field-label small-label">Colour <span className="muted">(pick two for a gradient)</span></div>
          <div className="row gap wrap perk-colors">
            <label className="perk-color">
              <span className="tiny muted">First</span>
              <input type="color" className="color-input" value={a || '#ffffff'} onChange={(e) => setColor(0, e.target.value)} aria-label="First name colour" />
            </label>
            <label className="perk-color">
              <span className="tiny muted">Second</span>
              <input type="color" className="color-input" value={b || a || '#ffffff'} disabled={!a} onChange={(e) => setColor(1, e.target.value)} aria-label="Second name colour" />
            </label>
            <div className="perk-swatches">
              {NAME_COLOR_PRESETS.map((c) => (
                <button key={c} type="button" className={cx('perk-swatch', a === c && 'active')} style={{ background: c }} aria-label={c} onClick={() => set({ colors: [c, ...(b ? [b] : [])].slice(0, 2) })} />
              ))}
            </div>
            {(a || b) && <Button variant="link" onClick={() => set({ colors: [] })}>Clear colours</Button>}
          </div>
        </>
      )}
      <p className="tiny muted">{prism ? 'Prism uses its own colours, so it ignores your role colour.' : 'Without a colour, your name keeps the colour of your top role.'}</p>
    </div>
  );
}

// ---------------------------------------------------------------- avatar decoration
export function DecorationPicker({ value, onChange, user, isAdmin = false, onUpload, uploading = false }) {
  const isImage = !!value && typeof value === 'object' && value.kind === 'image';
  const isCustom = !!value && typeof value === 'object' && !isImage;
  // Remember the last design, so trying a ready-made one and coming back doesn't lose it.
  const lastCustom = useRef(DEFAULT_CUSTOM_DECORATION);
  if (isCustom) lastCustom.current = value;
  const Tile = ({ id, label, deco, active, onPick }) => (
    <button key={id} type="button" role="option" aria-selected={active} data-deco={id} className={cx('deco-tile', active && 'active')} onClick={onPick}>
      <Avatar user={{ ...user, avatarDecoration: deco }} size={48} />
      <span>{label}</span>
    </button>
  );
  return (
    <div className="perk-block">
      <div className="deco-grid" role="listbox" aria-label="Avatar decorations">
        {Tile({ id: 'none', label: 'None', deco: null, active: !value, onPick: () => onChange(null) })}
        {isAdmin && Tile({ id: ADMIN_DECORATION_ID, label: ADMIN_DECORATION_LABEL, deco: ADMIN_DECORATION_ID, active: value === ADMIN_DECORATION_ID, onPick: () => onChange(ADMIN_DECORATION_ID) })}
        {Tile({ id: 'custom', label: 'Custom', deco: lastCustom.current, active: isCustom, onPick: () => onChange(lastCustom.current) })}
        {onUpload && Tile({ id: 'image', label: uploading ? 'Uploading…' : isImage ? 'Your image' : 'Upload image', deco: isImage ? value : null, active: isImage, onPick: () => { if (!uploading && !isImage) onUpload(); } })}
        {AVATAR_DECORATIONS.map((d) => Tile({ id: d.id, label: d.label, deco: d.id, active: value === d.id, onPick: () => onChange(d.id) }))}
      </div>
      {isAdmin && value === ADMIN_DECORATION_ID && <p className="tiny muted">The Admin Crest is yours alone — nobody else can pick it.</p>}
      {isCustom && <DecorationEditor value={value} onChange={onChange} user={user} />}
      {isImage && <ImageDecorationPanel value={value} onChange={onChange} user={user} onUpload={onUpload} uploading={uploading} />}
    </div>
  );
}

// ---------------------------------------------------------------- the decoration maker
function DecorationEditor({ value: v, onChange, user }) {
  const set = (patch) => {
    const next = { ...v, ...patch };
    // A solid or double ring looks the same turned, so "Spin" only makes sense for the others.
    if ((next.style === 'solid' || next.style === 'double') && next.motion === 'spin') next.motion = 'none';
    onChange(next);
  };
  const setColor = (i, hex) => set({ colors: v.colors.map((c, j) => (j === i ? hex : c)) });
  const canSpin = v.style !== 'solid' && v.style !== 'double';
  const colorHint = { solid: 'Solid uses the first colour.', double: 'Double uses the first two colours.', gradient: 'Gradient blends up to three colours.', dashed: 'Dashes blend up to three colours.' }[v.style];
  const mine = { ...user, avatarDecoration: v };
  return (
    <div className="deco-maker" aria-label="Design your decoration">
      <div className="deco-preview" aria-label="Preview">
        <Avatar user={mine} size={96} />
        <Avatar user={mine} size={40} />
        <Avatar user={mine} size={32} />
      </div>
      <div className="deco-maker-head">
        <div className="field-label small-label">Start from</div>
        <Button variant="secondary" size="sm" onClick={() => onChange(randomCustomDecoration())}>Surprise me</Button>
      </div>
      <div className="deco-templates" role="listbox" aria-label="Starting points">
        {DECO_TEMPLATES.map((t) => (
          <button key={t.id} type="button" role="option" aria-selected={false} data-template={t.id} className="deco-mini" onClick={() => onChange(t.design)}>
            <Avatar user={{ ...user, avatarDecoration: { ...t.design, motion: 'none' } }} size={40} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="field-label small-label">Ring</div>
      <div className="perk-options" role="radiogroup" aria-label="Ring style">
        {DECO_RING_STYLES.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={v.style === o.id} className={cx('perk-option', v.style === o.id && 'active')} onClick={() => set({ style: o.id })}>{o.label}</button>
        ))}
      </div>
      <div className="field-label small-label">Colours <span className="muted">({colorHint})</span></div>
      <div className="row gap wrap perk-colors">
        {v.colors.map((c, i) => (
          <label key={i} className="perk-color">
            <span className="tiny muted">Colour {i + 1}</span>
            <input type="color" className="color-input" value={c} onChange={(e) => setColor(i, e.target.value)} aria-label={`Ring colour ${i + 1}`} />
          </label>
        ))}
        {v.colors.length < 3 && <Button variant="link" onClick={() => set({ colors: [...v.colors, v.colors[v.colors.length - 1]] })}>Add colour</Button>}
        {v.colors.length > 1 && <Button variant="link" onClick={() => set({ colors: v.colors.slice(0, -1) })}>Remove last</Button>}
      </div>
      <div className="field-label small-label">Thickness</div>
      <Slider value={v.width} min={1} max={3} step={1} onChange={(n) => set({ width: n })} format={(n) => DECO_WIDTH_LABELS[n]} />
      <div className="field-label small-label">Glow</div>
      <Slider value={v.glow} min={0} max={3} step={1} onChange={(n) => set({ glow: n })} format={(n) => DECO_GLOW_LABELS[n]} />
      <div className="field-label small-label">Motion</div>
      <div className="perk-options" role="radiogroup" aria-label="Motion">
        {DECO_MOTIONS.map((o) => {
          const off = o.id === 'spin' && !canSpin;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={v.motion === o.id} disabled={off} title={off ? 'A solid or double ring looks the same when it turns' : undefined}
              className={cx('perk-option', v.motion === o.id && 'active')} onClick={() => set({ motion: o.id })}>{o.label}</button>
          );
        })}
      </div>
      <div className="field-label small-label">Accessory</div>
      <div className="perk-options" role="radiogroup" aria-label="Accessory">
        {DECO_ACCESSORIES.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={v.acc === o.id} className={cx('perk-option', v.acc === o.id && 'active')} onClick={() => set({ acc: o.id })}>{o.label}</button>
        ))}
      </div>
      {v.acc !== 'none' && (
        <div className="row gap wrap perk-colors">
          <label className="perk-color">
            <span className="tiny muted">Accessory colour</span>
            <input type="color" className="color-input" value={v.accColor} onChange={(e) => set({ accColor: e.target.value })} aria-label="Accessory colour" />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- your own picture
/** What to tell the person after trying to fit a picture around their avatar. */
export function fitMessage(fit) {
  if (!fit) return 'Couldn’t tell where your avatar goes in this picture, so it is centred. Use the sliders to place it.';
  return fit.mode === 'ring' ? 'Fitted around your avatar.' : 'This picture has no closed ring, so your avatar is placed in its empty middle. Adjust with the sliders if needed.';
}

function ImageDecorationPanel({ value: v, onChange, user, onUpload, uploading }) {
  const mine = { ...user, avatarDecoration: v };
  const [fitting, setFitting] = useState(false);
  const fit = async () => {
    setFitting(true);
    const f = await fitDecorationImage(v.url);
    setFitting(false);
    if (f) onChange({ ...v, scale: f.scale, x: f.x, y: f.y });
    toast(fitMessage(f), f ? 'success' : 'info', f ? 2500 : 5000);
  };
  const shift = (key) => (n) => onChange({ ...v, [key]: Math.round(n * 100) / 100 });
  const pct = (n) => `${Math.round(n * 100)}%`;
  return (
    <div className="deco-maker" aria-label="Your decoration image">
      <div className="deco-preview" aria-label="Preview">
        <Avatar user={mine} size={96} />
        <Avatar user={mine} size={40} />
        <Avatar user={mine} size={32} />
      </div>
      <Button variant="secondary" size="sm" loading={fitting} onClick={fit}>Fit around my avatar</Button>
      <div className="field-label small-label">Size</div>
      <Slider value={v.scale} min={IMAGE_DECORATION_MIN_SCALE} max={IMAGE_DECORATION_MAX_SCALE} step={0.01} onChange={(n) => onChange({ ...v, scale: Math.round(n * 100) / 100 })} format={pct} />
      <div className="field-label small-label">Left / right</div>
      <Slider value={v.x || 0} min={-1} max={1} step={0.01} onChange={shift('x')} format={pct} />
      <div className="field-label small-label">Up / down</div>
      <Slider value={v.y || 0} min={-1} max={1} step={0.01} onChange={shift('y')} format={pct} />
      <div className="deco-image-actions">
        <Button variant="secondary" size="sm" loading={uploading} onClick={onUpload}>Replace image</Button>
        <Button variant="link" onClick={() => onChange(null)}>Remove</Button>
      </div>
      <p className="tiny muted">“Fit around my avatar” finds the ring in your picture and sizes and places it so it sits exactly around your avatar. Use a PNG, GIF or WebP with a see-through middle so your avatar shows through (a frame, wings, ears…). Up to 3 MB; GIFs can move.</p>
    </div>
  );
}

// ---------------------------------------------------------------- profile effect
/** One animated overlay on the profile card, or none. Each thumbnail is a still snapshot that plays while you hover or focus it. */
export function ProfileEffectPicker({ value, onChange }) {
  return (
    <div className="perk-block">
      <div className="fx-grid" role="listbox" aria-label="Profile effects">
        <button type="button" role="option" aria-selected={!value} data-effect="none" className={cx('fx-tile', !value && 'active')} onClick={() => onChange(null)}>
          <span className="fx-thumb"><Icon name="x" size={22} /></span>
          <span>None</span>
        </button>
        {PROFILE_EFFECTS.map((e) => (
          <button key={e.id} type="button" role="option" aria-selected={value === e.id} data-effect={e.id} className={cx('fx-tile', value === e.id && 'active')} onClick={() => onChange(e.id)}>
            <span className="fx-thumb"><ProfileEffect effect={e.id} keep paused /></span>
            <span>{e.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
