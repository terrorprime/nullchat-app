// "Can calls work from here?" Gathers network candidates the way a call does and says, in plain words, what they show.
//   host  = an address on this device's own network      (always there when there is a network)
//   srflx = this device's public address, found through a STUN server (what a direct call between two people uses)
//   relay = an address on the relay (TURN) server          (what a call falls back on when a direct connection cannot be made)

/** Ask the browser to gather candidates with the given servers and count them by kind. Resolves when it is done or after `timeoutMs`. */
export function gatherCandidates(iceServers, { timeoutMs = 6000, RTC = globalThis.RTCPeerConnection } = {}) {
  return new Promise((resolve) => {
    const found = { host: 0, srflx: 0, relay: 0, errors: [], ms: 0, unsupported: false };
    const t0 = Date.now();
    let pc = null;
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { pc?.close(); } catch { /* already closed */ }
      found.ms = Date.now() - t0;
      resolve(found);
    };
    if (!RTC) { found.unsupported = true; resolve(found); return; }
    try { pc = new RTC({ iceServers }); } catch { found.unsupported = true; resolve(found); return; }
    timer = setTimeout(finish, timeoutMs);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) { finish(); return; }
      const type = ev.candidate.type || /\btyp (\w+)/.exec(ev.candidate.candidate || '')?.[1];
      if (type === 'host' || type === 'srflx' || type === 'relay') found[type]++;
    };
    pc.onicecandidateerror = (ev) => { if (ev.url) found.errors.push({ url: ev.url, code: ev.errorCode, text: ev.errorText || '' }); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(); };
    try {
      pc.createDataChannel('check');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
    } catch { finish(); }
  });
}

const urlsOf = (servers) => servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter(Boolean);

/**
 * What the counts mean. `level`: 'good' (calls should work), 'limited' (should work for most people, could fail on a strict network),
 * 'bad' (will not work from here). `checks`: one line each: ok = true / false / null (not applicable), with a title and what to do about it.
 */
export function explain(found, iceServers = []) {
  const urls = urlsOf(iceServers);
  const hasStun = urls.some((u) => /^stuns?:/i.test(u));
  const hasTurn = urls.some((u) => /^turns?:/i.test(u));
  const checks = [];
  if (found.unsupported) {
    return { level: 'bad', headline: 'This browser can’t make voice or video calls.', checks: [{ key: 'network', ok: false, title: 'Calls are not supported here', detail: 'Try an up-to-date Chrome, Edge, Firefox or Safari, or the NullChat app.' }] };
  }
  const network = found.host + found.srflx + found.relay > 0;
  checks.push(network
    ? { key: 'network', ok: true, title: 'This device is online for calls', detail: '' }
    : { key: 'network', ok: false, title: 'No network address found', detail: 'The browser gave no addresses to call with. A VPN, or a privacy setting that blocks WebRTC, can cause this.' });
  const direct = found.srflx > 0;
  if (!hasStun) checks.push({ key: 'direct', ok: null, title: 'No address server (STUN) is set up', detail: 'Calls only work between people on the same network until the administrator sets STUN_URLS.' });
  else checks.push(direct
    ? { key: 'direct', ok: true, title: 'Your public address was found', detail: 'Direct calls to other people should work.' }
    : { key: 'direct', ok: false, title: 'Couldn’t find your public address', detail: 'The address server didn’t answer. A firewall or network may be blocking this kind of traffic, so direct calls can fail.' });
  const relay = found.relay > 0;
  if (!hasTurn) checks.push({ key: 'relay', ok: null, title: 'No relay server is set up', detail: 'If a direct call can’t be made (some mobile, school and work networks), it can’t connect at all. The server’s owner can turn one on with “Voice Relay Setup” (see Voice relay in the README).' });
  else checks.push(relay
    ? { key: 'relay', ok: true, title: 'The relay server works', detail: 'Calls can still connect when a direct connection is blocked.' }
    : { key: 'relay', ok: false, title: 'The relay server didn’t answer', detail: 'Check that TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL are right and that its ports are open.' });
  let level; let headline;
  if (!network) { level = 'bad'; headline = 'Calls won’t work from here.'; }
  else if (relay) { level = 'good'; headline = direct ? 'Calls should work from here.' : 'Calls should work from here, through the relay.'; }
  else if (direct) { level = 'limited'; headline = 'Calls should work for most people.'; }
  else { level = 'bad'; headline = 'Calls are likely to fail from this network.'; }
  return { level, headline, checks };
}

/** The text to paste to whoever is helping: what was found, never any password. */
export function reportText(found, iceServers = [], extra = '') {
  const lines = [
    `NullChat connection check`,
    `addresses found: ${found.host} on this device, ${found.srflx} public (STUN), ${found.relay} relay (TURN) — in ${found.ms} ms`,
    `servers: ${urlsOf(iceServers).join(', ') || 'none'}`,
  ];
  if (found.errors.length) lines.push(`errors: ${found.errors.map((e) => `${e.url} → ${e.code}${e.text ? ` ${e.text}` : ''}`).join('; ')}`);
  if (extra) lines.push(extra);
  return lines.join('\n');
}

export async function runConnectionTest(iceServers, opts) {
  const found = await gatherCandidates(iceServers, opts);
  return { found, ...explain(found, iceServers), report: reportText(found, iceServers, typeof navigator !== 'undefined' ? `browser: ${navigator.userAgent}` : '') };
}
