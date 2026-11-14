const api = window.nullchatDesktop;
api.onSplash(({ text, progress, version }) => {
  if (text) document.getElementById('status').textContent = text;
  if (version) document.getElementById('version').textContent = `v${version}`;
  const bar = document.getElementById('bar');
  if (typeof progress === 'number') {
    bar.style.visibility = 'visible';
    document.getElementById('fill').style.width = `${Math.max(0, Math.min(100, progress))}%`;
  } else bar.style.visibility = 'hidden';
});
