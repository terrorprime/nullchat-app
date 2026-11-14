// A text box that shows @mentions (people, roles, @everyone / @here, #channels) as highlighted chips, and edits each one as a single character,
// the way Discord does: Backspace or Delete takes the whole mention away, the arrow keys jump over it, a click inside it lands on its edge,
// and selecting any part of it selects all of it. The words are still ordinary text in an ordinary <textarea> (so typing, emoji, phone
// keyboards, spell check, undo and copying keep working as they always did); the chips are drawn on top of it. They only exist while the box
// holds a mention: with none, nothing is drawn and the box is exactly the plain text box it was.
//   <MentionTextarea inputRef={ref} value={text} spans={mentionSpans(...)} onEdit={(next, caret) => ...} {...textareaProps} />
// `spans` come from lib/mentionText.js and say where the mentions are; `onEdit` is only a fallback for browsers that cannot do an undoable edit.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { cx } from '../lib/utils.js';

// What the layer on top copies from the box, so every letter lands exactly where the box's own letter is.
const MIRROR = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontKerning', 'fontFeatureSettings', 'fontVariantLigatures', 'letterSpacing', 'wordSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'textAlign', 'direction', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
const WORD = /\w/;

export function MentionTextarea({ inputRef, value, spans, onEdit, onKeyDown, className, wrapClassName, ...rest }) {
  const own = useRef(null);
  const ref = inputRef || own;
  const overlay = useRef(null);
  const inner = useRef(null);
  const live = useRef({});
  live.current = { value, spans, onEdit };
  const composing = useRef(false);
  const busy = useRef(false);
  const chips = spans.length > 0;

  // Lay the layer over the box's text area, with the box's own type and padding (and follow its scrolling).
  const sync = () => {
    const ta = ref.current, ov = overlay.current, inn = inner.current;
    if (!ta || !ov || !inn) return;
    const cs = getComputedStyle(ta);
    for (const k of MIRROR) ov.style[k] = cs[k];
    ov.style.left = `${ta.offsetLeft + ta.clientLeft}px`;
    ov.style.top = `${ta.offsetTop + ta.clientTop}px`;
    ov.style.width = `${ta.clientWidth}px`;
    ov.style.height = `${ta.clientHeight}px`;
    inn.style.transform = `translateY(${-ta.scrollTop}px)`;
  };
  useLayoutEffect(() => { if (chips) sync(); });
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return undefined;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (live.current.spans.length) sync(); }) : null;
    ro?.observe(ta);
    const onScroll = () => { if (live.current.spans.length) sync(); };
    ta.addEventListener('scroll', onScroll);
    return () => { ro?.disconnect(); ta.removeEventListener('scroll', onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Change part of the text so the browser keeps its undo history (Ctrl+Z brings a removed mention back); if it cannot, change it directly.
  const edit = (a, b, text, caret) => {
    const ta = ref.current;
    if (!ta) return;
    busy.current = true;
    let done = false;
    try {
      ta.setSelectionRange(a, b);
      done = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    } catch { /* below */ } finally { busy.current = false; }
    if (!done) {
      const v = ta.value;
      live.current.onEdit?.(v.slice(0, a) + text + v.slice(b), caret);
      return;
    }
    ta.setSelectionRange(caret, caret);
  };

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return undefined;
    // Deleting: next to a mention it goes whole. (beforeinput also covers phone keyboards, which send no Backspace key.)
    const before = (e) => {
      const { spans: sp, value: val } = live.current;
      if (!sp.length || busy.current || e.isComposing || composing.current || ta.value !== val) return;
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (a !== b) return;   // (a selection always covers whole mentions: see below)
      const back = e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward' || e.inputType === 'deleteSoftLineBackward';
      const fwd = e.inputType === 'deleteContentForward' || e.inputType === 'deleteWordForward' || e.inputType === 'deleteSoftLineForward';
      if (back || fwd) {
        const hit = sp.find((x) => (back ? x.start < a && a <= x.end : x.start <= a && a < x.end));
        if (hit) { e.preventDefault(); edit(hit.start, hit.end, '', hit.start); }
        return;
      }
      // Typing a letter right against a mention would glue it on and undo it ("@bob" + "x" is no longer bob): keep a space between.
      if (e.inputType === 'insertText' && e.data && WORD.test(e.data[0])) {
        const atEnd = sp.find((x) => x.end === a);
        const atStart = sp.find((x) => x.start === a);
        if (atEnd) { e.preventDefault(); edit(a, a, ` ${e.data}`, a + 1 + e.data.length); }
        else if (atStart) { e.preventDefault(); edit(a, a, `${e.data} `, a + e.data.length); }
      }
    };
    // The cursor and selection never end inside a mention: a click goes to the nearer edge, a selection grows to take in the whole of it.
    const settle = () => {
      const { spans: sp, value: val } = live.current;
      if (!sp.length || document.activeElement !== ta || composing.current || ta.value !== val) return;
      const a = ta.selectionStart, b = ta.selectionEnd;
      let na = a, nb = b;
      if (a === b) {
        const x = sp.find((s) => s.start < a && a < s.end);
        if (x) na = nb = (a - x.start <= x.end - a) ? x.start : x.end;
      } else {
        const xa = sp.find((s) => s.start < a && a < s.end);
        const xb = sp.find((s) => s.start < b && b < s.end);
        if (xa) na = xa.start;
        if (xb) nb = xb.end;
      }
      if (na !== a || nb !== b) ta.setSelectionRange(na, nb, ta.selectionDirection);
    };
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; };
    ta.addEventListener('beforeinput', before);
    ta.addEventListener('compositionstart', start);
    ta.addEventListener('compositionend', end);
    document.addEventListener('selectionchange', settle);
    return () => {
      ta.removeEventListener('beforeinput', before); ta.removeEventListener('compositionstart', start); ta.removeEventListener('compositionend', end);
      document.removeEventListener('selectionchange', settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arrow keys step over a whole mention.
  const keydown = (e) => {
    const sp = live.current.spans;
    if (sp.length && !e.shiftKey && !e.nativeEvent.isComposing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const ta = e.currentTarget;
      const a = ta.selectionStart;
      if (a === ta.selectionEnd) {
        const hit = e.key === 'ArrowLeft' ? sp.find((x) => x.start < a && a <= x.end) : sp.find((x) => x.start <= a && a < x.end);
        if (hit) { e.preventDefault(); const to = e.key === 'ArrowLeft' ? hit.start : hit.end; ta.setSelectionRange(to, to); return; }
      }
    }
    onKeyDown?.(e);
  };

  const parts = [];
  if (chips) {
    let at = 0;
    spans.forEach((sp, i) => {
      if (sp.start > at) parts.push(value.slice(at, sp.start));
      parts.push(<span key={i} className={`mention-chip mc-${sp.kind}`} style={sp.color ? { '--chip': sp.color } : undefined}>{value.slice(sp.start, sp.end)}</span>);
      at = sp.end;
    });
    parts.push(value.slice(at));
  }
  return (
    <div className={cx('mention-field', wrapClassName)}>
      <textarea ref={ref} className={cx(className, chips && 'has-chips')} value={value} onKeyDown={keydown} {...rest} />
      {chips && <div ref={overlay} className="mention-overlay" aria-hidden="true"><div ref={inner} className="mention-overlay-inner">{parts}</div></div>}
    </div>
  );
}
