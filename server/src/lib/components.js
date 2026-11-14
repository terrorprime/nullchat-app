// Buttons, select menus and forms (pop-up windows with text boxes) that a bot can put in its messages.
//
// The shapes are Discord's (type numbers, "custom_id"…) and both spellings of the keys are accepted (custom_id or customId), so a bot written for
// either API can send them. What is stored and sent to the app is always the cleaned, camelCase form below:
//
//   message.components = [ { type: 1, components: [ button | menu … ] } … ]      (up to 5 rows)
//   button  { type: 2, style: 1 primary | 2 secondary | 3 success | 4 danger | 5 link, label?, emoji?, customId (or url for a link), disabled }
//   menu    { type: 3, customId, options: [{ label, value, description?, emoji?, default }], placeholder?, minValues, maxValues, disabled }
//   picker  { type: 5 people | 6 roles | 7 people and roles | 8 channels, customId, placeholder?, minValues, maxValues, disabled,
//             defaultValues?: [{ id, type: 'user' | 'role' | 'channel' }], channelTypes? (type 8 only: which kinds of channel to offer) }
//   modal   { customId, title, components: [ { type: 1, components: [ { type: 4, customId, label, style: 1 short | 2 paragraph, … } ] } ] }
//
// A row holds up to 5 buttons, or one menu or picker. What someone picks in a picker is checked against the server (lib/pickers.js).
import { bad } from './http.js';

export const MAX_ROWS = 5;
export const MAX_PER_ROW = 5;
export const MAX_OPTIONS = 25;
const STYLE_NAMES = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const INPUT_STYLE_NAMES = { short: 1, paragraph: 2 };

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const isHttpUrl = (v) => { try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };
/** custom_id → customId (the keys one level deep only; values like an option's text are left alone). */
const camel = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const text = (v, max, what, { min = 0, required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${what} is required.`); return undefined; }
  if (typeof v !== 'string') throw bad(`${what} must be text.`);
  const t = v.length;
  if (t > max) throw bad(`${what} can be at most ${max} characters.`);
  if (t < min) throw bad(`${what} must be at least ${min} characters.`);
  return v;
};
const int = (v, lo, hi, what, fallback) => {
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}.`);
  return v;
};
function cleanEmoji(e, what) {
  if (e === undefined || e === null) return null;
  const x = typeof e === 'string' ? { name: e } : e;
  if (!isObj(x)) throw bad(`${what} emoji must be an emoji or { name, id }.`);
  const name = text(x.name, 64, `${what} emoji name`);
  const id = x.id === undefined || x.id === null ? null : String(x.id);
  if (!name && !id) return null;
  if (id !== null && !/^\d{1,25}$/.test(id)) throw bad(`${what} emoji id must be a number.`);
  return { name: name || null, id };
}

function cleanButton(raw, where, linkOnly) {
  const c = camel(raw);
  let style = c.style;
  if (typeof style === 'string') style = STYLE_NAMES[style.toLowerCase()];
  if (style === undefined || style === null) style = c.url ? 5 : 1;
  if (!Number.isInteger(style) || style < 1 || style > 5) throw bad(`${where}: a button’s style must be 1 (primary), 2 (secondary), 3 (success), 4 (danger) or 5 (link).`);
  const label = text(c.label, 80, `${where}: a button’s label`);
  const emoji = cleanEmoji(c.emoji, `${where}: a button’s`);
  if (!label && !emoji) throw bad(`${where}: a button needs a label or an emoji.`);
  const out = { type: 2, style, label: label || null, emoji, disabled: !!c.disabled };
  if (style === 5) {
    if (c.customId) throw bad(`${where}: a link button has a url, not a custom_id.`);
    if (typeof c.url !== 'string' || c.url.length > 512 || !isHttpUrl(c.url)) throw bad(`${where}: a link button needs a url that starts with http:// or https://.`);
    out.url = c.url;
    out.customId = null;
  } else {
    if (linkOnly) throw bad('A webhook can only send link buttons (style 5). Buttons that do something need a bot to answer them.');
    if (c.url) throw bad(`${where}: only link buttons (style 5) have a url.`);
    out.customId = text(c.customId, 100, `${where}: a button’s custom_id`, { required: true });
    out.url = null;
  }
  return out;
}

function cleanSelect(raw, where, linkOnly) {
  if (linkOnly) throw bad('A webhook can only send link buttons. Menus need a bot to answer them.');
  const c = camel(raw);
  const customId = text(c.customId, 100, `${where}: a menu’s custom_id`, { required: true });
  if (!Array.isArray(c.options) || !c.options.length) throw bad(`${where}: a menu needs at least one option.`);
  if (c.options.length > MAX_OPTIONS) throw bad(`${where}: a menu can have at most ${MAX_OPTIONS} options.`);
  const seen = new Set();
  const options = c.options.map((o, i) => {
    if (!isObj(o)) throw bad(`${where}: option ${i + 1} must be an object with a label and a value.`);
    const label = text(o.label, 100, `${where}: an option’s label`, { required: true });
    const value = text(o.value, 100, `${where}: an option’s value`, { required: true });
    if (seen.has(value)) throw bad(`${where}: two options have the value “${value}”. Each value must be different.`);
    seen.add(value);
    return { label, value, description: text(o.description, 100, `${where}: an option’s description`) || null, emoji: cleanEmoji(o.emoji, `${where}: an option’s`), default: !!o.default };
  });
  const minValues = int(c.minValues, 0, MAX_OPTIONS, `${where}: min_values`, 1);
  const maxValues = int(c.maxValues, 1, MAX_OPTIONS, `${where}: max_values`, 1);
  if (minValues > maxValues) throw bad(`${where}: min_values can’t be more than max_values.`);
  if (maxValues > options.length) throw bad(`${where}: max_values is more than the number of options.`);
  if (minValues > options.length) throw bad(`${where}: min_values is more than the number of options.`);
  const chosen = options.filter((o) => o.default).length;
  if (chosen > maxValues) throw bad(`${where}: more options are marked default than max_values allows.`);
  return { type: 3, customId, options, placeholder: text(c.placeholder, 150, `${where}: a menu’s placeholder`) || null, minValues, maxValues, disabled: !!c.disabled };
}

// ---- pickers: menus of the server's own people, roles and channels (Discord's types 5 to 8) -------------------------------------------------
export const PICKER_KINDS = { 5: 'user', 6: 'role', 7: 'mentionable', 8: 'channel' };
const PICKER_DEFAULT_TYPES = { 5: ['user'], 6: ['role'], 7: ['user', 'role'], 8: ['channel'] };
// Kinds of channel a picker may be limited to (Discord's numbers; its two other thread kinds are our one kind of thread).
const CHANNEL_KINDS = { 0: 0, 2: 2, 4: 4, 5: 5, 10: 11, 11: 11, 12: 11, 13: 13, 15: 15 };

function cleanPicker(raw, where, linkOnly) {
  if (linkOnly) throw bad('A webhook can only send link buttons. Menus need a bot to answer them.');
  const c = camel(raw);
  const type = raw.type;
  const customId = text(c.customId, 100, `${where}: a menu’s custom_id`, { required: true });
  const minValues = int(c.minValues, 0, MAX_OPTIONS, `${where}: min_values`, 1);
  const maxValues = int(c.maxValues, 1, MAX_OPTIONS, `${where}: max_values`, 1);
  if (minValues > maxValues) throw bad(`${where}: min_values can’t be more than max_values.`);
  let defaultValues = [];
  if (c.defaultValues !== undefined && c.defaultValues !== null) {
    if (!Array.isArray(c.defaultValues)) throw bad(`${where}: default_values must be a list of { id, type }.`);
    const seen = new Set();
    defaultValues = c.defaultValues.map((d, i) => {
      if (!isObj(d)) throw bad(`${where}: default value ${i + 1} must be { id, type }.`);
      const id = typeof d.id === 'number' ? String(d.id) : d.id;
      if (typeof id !== 'string' || !/^\d{1,25}$/.test(id)) throw bad(`${where}: a default value’s id must be a number.`);
      if (!PICKER_DEFAULT_TYPES[type].includes(d.type)) throw bad(`${where}: a default value’s type must be ${PICKER_DEFAULT_TYPES[type].map((t) => `“${t}”`).join(' or ')} for this menu.`);
      if (seen.has(`${d.type}:${id}`)) throw bad(`${where}: the same default value is listed twice.`);
      seen.add(`${d.type}:${id}`);
      return { id, type: d.type };
    });
    if (defaultValues.length > maxValues) throw bad(`${where}: more default values than max_values allows.`);
  }
  const out = { type, customId, placeholder: text(c.placeholder, 150, `${where}: a menu’s placeholder`) || null, minValues, maxValues, disabled: !!c.disabled, defaultValues };
  if (c.channelTypes !== undefined && c.channelTypes !== null) {
    if (type !== 8) throw bad(`${where}: channel_types only belongs on a menu of channels (type 8).`);
    if (!Array.isArray(c.channelTypes)) throw bad(`${where}: channel_types must be a list of numbers.`);
    const kinds = [...new Set(c.channelTypes.map((k) => CHANNEL_KINDS[k]))];
    if (kinds.some((k) => k === undefined)) throw bad(`${where}: channel_types can hold 0 (text), 2 (voice), 4 (category), 5 (announcement), 11 (thread), 13 (stage) or 15 (forum).`);
    out.channelTypes = kinds;
  } else if (type === 8) out.channelTypes = [];
  return out;
}

/** Check and clean a message's rows of buttons, menus and pickers. `linkOnly`: a webhook's message (only link buttons). Returns the stored form. */
export function cleanComponents(list, { linkOnly = false } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('components must be a list of rows.');
  if (list.length > MAX_ROWS) throw bad(`A message can have at most ${MAX_ROWS} rows of buttons or menus.`);
  const ids = new Set();
  const note = (id, where) => { if (id && ids.has(id)) throw bad(`${where}: the custom_id “${id}” is used twice in this message. Each one must be different.`); if (id) ids.add(id); };
  return list.map((rawRow, ri) => {
    const where = `Row ${ri + 1}`;
    if (!isObj(rawRow)) throw bad(`${where} must be an object like { type: 1, components: [ … ] }.`);
    if (rawRow.type !== 1) throw bad(`${where} must have type 1 (an action row).`);
    const kids = rawRow.components;
    if (!Array.isArray(kids) || !kids.length) throw bad(`${where} is empty. A row needs at least one button or menu.`);
    if (kids.length > MAX_PER_ROW) throw bad(`${where} can have at most ${MAX_PER_ROW} buttons.`);
    const out = kids.map((k) => {
      if (!isObj(k)) throw bad(`${where} has something that is not a button or menu.`);
      if (k.type === 2) return cleanButton(k, where, linkOnly);
      if (k.type === 3) return cleanSelect(k, where, linkOnly);
      if (k.type >= 5 && k.type <= 8) return cleanPicker(k, where, linkOnly);
      if (k.type === 4) throw bad(`${where}: text boxes only go in a form (a modal), not in a message.`);
      throw bad(`${where}: a component’s type must be 2 (button), 3 (menu) or 5 to 8 (a menu of people, roles or channels).`);
    });
    if (out.some((k) => k.type !== 2) && out.length > 1) throw bad(`${where}: a menu needs a row of its own.`);
    out.forEach((k) => note(k.customId, where));
    return { type: 1, components: out };
  });
}

/** The button or menu with this custom id (null if there is none). */
export function findComponent(rows, customId) {
  for (const row of rows || []) for (const c of row.components || []) if (c.customId && c.customId === customId) return c;
  return null;
}

/** What someone picked in a menu: every value must be one of its options, and how many is limited by min / max. Returns the values. */
export function checkSelection(menu, values) {
  const list = Array.isArray(values) ? values.map(String) : [];
  const allowed = new Set(menu.options.map((o) => o.value));
  if (new Set(list).size !== list.length) throw bad('Pick each option only once.');
  if (list.some((v) => !allowed.has(v))) throw bad('That choice isn’t in the menu any more.');
  if (list.length < menu.minValues) throw bad(`Pick at least ${menu.minValues}.`);
  if (list.length > menu.maxValues) throw bad(`Pick at most ${menu.maxValues}.`);
  return list;
}

// ---- forms (modals) -------------------------------------------------------------------------------------------------------------------------
/** Check and clean a form: a title, and up to 5 text boxes (each in a row of its own). */
export function cleanModal(raw) {
  if (!isObj(raw)) throw bad('A form needs { custom_id, title, components }.');
  const m = camel(raw);
  const customId = text(m.customId, 100, 'The form’s custom_id', { required: true });
  const title = text(m.title, 45, 'The form’s title', { required: true });
  if (!Array.isArray(m.components) || !m.components.length) throw bad('A form needs at least one text box.');
  if (m.components.length > MAX_ROWS) throw bad(`A form can have at most ${MAX_ROWS} text boxes.`);
  const ids = new Set();
  const components = m.components.map((rawRow, i) => {
    const where = `Form row ${i + 1}`;
    if (!isObj(rawRow) || rawRow.type !== 1 || !Array.isArray(rawRow.components) || rawRow.components.length !== 1) throw bad(`${where} must be { type: 1, components: [ one text box ] }.`);
    const k = rawRow.components[0];
    if (!isObj(k) || k.type !== 4) throw bad(`${where}: a form can only hold text boxes (type 4).`);
    const c = camel(k);
    let style = c.style;
    if (typeof style === 'string') style = INPUT_STYLE_NAMES[style.toLowerCase()];
    if (style === undefined || style === null) style = 1;
    if (style !== 1 && style !== 2) throw bad(`${where}: a text box’s style must be 1 (short) or 2 (paragraph).`);
    const id = text(c.customId, 100, `${where}: a text box’s custom_id`, { required: true });
    if (ids.has(id)) throw bad(`${where}: the custom_id “${id}” is used twice in this form.`);
    ids.add(id);
    const minLength = int(c.minLength, 0, 4000, `${where}: min_length`, 0);
    const maxLength = int(c.maxLength, 1, 4000, `${where}: max_length`, style === 2 ? 4000 : 1000);
    if (minLength > maxLength) throw bad(`${where}: min_length can’t be more than max_length.`);
    const value = text(c.value, 4000, `${where}: a text box’s value`);
    if (value && value.length > maxLength) throw bad(`${where}: the starting text is longer than max_length.`);
    return { type: 1, components: [{
      type: 4, customId: id, label: text(c.label, 45, `${where}: a text box’s label`, { required: true }), style, minLength, maxLength,
      required: c.required === undefined ? true : !!c.required, value: value || null, placeholder: text(c.placeholder, 100, `${where}: a text box’s placeholder`) || null,
    }] };
  });
  return { customId, title, components };
}

/** What someone typed in a form: { custom_id: text }. Throws, in words they can act on, when a box is missing or the wrong length. */
export function readModalValues(modal, given) {
  const src = isObj(given) ? given : {};
  const out = {};
  for (const row of modal.components) {
    const box = row.components[0];
    const v = typeof src[box.customId] === 'string' ? src[box.customId].replace(/\r\n/g, '\n') : '';
    if (!v.trim()) {
      if (box.required) throw bad(`“${box.label}” is required.`);
      out[box.customId] = '';
      continue;
    }
    if (v.length < box.minLength) throw bad(`“${box.label}” must be at least ${box.minLength} characters.`);
    if (v.length > box.maxLength) throw bad(`“${box.label}” can be at most ${box.maxLength} characters.`);
    out[box.customId] = v;
  }
  return out;
}
