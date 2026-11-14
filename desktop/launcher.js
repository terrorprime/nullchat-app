const $ = (id) => document.getElementById(id);
const api = window.nullchatDesktop;

function showError(msg) {
  const el = $('error');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}
showError(new URLSearchParams(location.search).get('error'));

api.info().then((info) => {
  // A build locked to its own server (the default when one is baked in) has no choices to offer: just a retry.
  if (info.locked) {
    const host = (info.bakedServer || '').replace(/^https?:\/\//, '');
    $('sub').hidden = true;
    document.querySelector('.cards').hidden = true;
    $('baked').hidden = true;
    $('locked').hidden = false;
    $('locked-msg').textContent = `NullChat couldn’t reach ${host}. Check your internet connection, then try again.`;
    $('retry').addEventListener('click', () => { $('retry').disabled = true; $('retry').textContent = 'Connecting…'; api.retry(); });
    return;
  }
  $('sub').hidden = false;
  document.querySelector('.cards').hidden = false;
  if (info.url) $('url').value = info.url;
  // A server baked into this build: offer it first, since that is where existing accounts live.
  if (info.bakedServer) {
    $('baked-host').textContent = info.bakedServer.replace(/^https?:\/\//, '');
    $('baked').hidden = false;
    $('baked-connect').textContent = `Connect to ${info.bakedServer.replace(/^https?:\/\//, '')}`;
    $('baked-connect').addEventListener('click', async () => {
      $('baked-connect').disabled = true; showError('');
      const res = await api.connect(info.bakedServer);
      if (!res.ok) { showError(res.error); $('baked-connect').disabled = false; }
    });
  }
}).catch(() => { $('sub').hidden = false; document.querySelector('.cards').hidden = false; });

$('host').addEventListener('click', async () => {
  $('host').disabled = true; $('host').textContent = 'Starting…'; showError('');
  const res = await api.host();
  if (!res.ok) { showError(res.error); $('host').disabled = false; $('host').textContent = 'Start my server'; }
});

async function connect() {
  $('connect').disabled = true; $('connect').textContent = 'Connecting…'; showError('');
  const res = await api.connect($('url').value);
  if (!res.ok) { showError(res.error); $('connect').disabled = false; $('connect').textContent = 'Connect'; }
}
$('connect').addEventListener('click', connect);
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
