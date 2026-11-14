// The Zoom setting (Settings → Appearance) is CSS `zoom` on <html>. Inside it, CSS lengths (left, top, translate(), …) are multiplied by the
// zoom when drawn, while pointer positions (clientX/Y), getBoundingClientRect() and window.innerWidth/innerHeight stay in real screen pixels.
// (offsetWidth, scrollTop and the like are in the element's own CSS pixels.) Code that turns a screen position into a left/top/translate
// divides by this; styles.css does the same for vw/vh/dvh through --zoom.
export function pageZoom() {
  const z = parseFloat(document.documentElement.style.zoom);   // '80%' → 80; '' (100%) → NaN
  return z > 0 ? z / 100 : 1;
}

// How far the Zoom setting can go in this window. Zoom is CSS `zoom`, so media queries still see the real window width: a zoomed-in
// desktop window never switches to the phone layout, and the chat column would be squeezed to a few letters wide. So the desktop layout
// is kept at least MIN_LAYOUT CSS pixels wide (a 1360px window tops out at 150%, a 1920px one reaches 200%). A phone-width window uses
// the phone layout, which copes with any zoom.
const MIN_LAYOUT = 900;
export function zoomLimit(width = window.innerWidth) {
  if (width <= 768) return 200;
  return Math.max(100, Math.min(200, Math.floor((width / MIN_LAYOUT) * 10) * 10));
}
/** The zoom (in percent) actually applied for a Zoom setting. */
export const effectiveZoom = (percent, width) => Math.min(percent, zoomLimit(width));
