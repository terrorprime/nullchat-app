// The servers a call uses to find a path between two people (WebRTC "ICE servers"), as handed to the apps.
//
// Calls go directly between people. That fails when either person's network will not let the other in (phones on mobile data,
// school and work Wi-Fi, some home routers), and the only cure is a relay both can reach (a TURN server). Running one is a job
// of its own, so NullChat can borrow Cloudflare's: with CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN set (the
// "Voice Relay Setup" script does it), this asks Cloudflare for short-lived relay logins and hands them out with the rest.
// The key itself never leaves the server.
import { config } from '../config.js';

const REFRESH_MS = 6 * 60 * 60 * 1000;   // new logins every six hours...
const TTL_SECONDS = 48 * 60 * 60;        // ...each good for two days (Cloudflare's longest), so none in use is near its end
let cache = null;                        // { servers, at }
let lastError = '';

/** What to hand out right now: the configured servers, plus the relay when one is set up and answering. */
export function iceServersNow() { return cache ? cache.servers : config.iceServers; }
export function relayStatus() {
  const cf = config.cloudflareTurn;
  const fixed = config.iceServers.some((s) => [].concat(s.urls || []).some((u) => /^turns?:/i.test(u)));
  return { relay: fixed || !!cache, source: cache ? 'cloudflare' : fixed ? 'turn' : null, configured: !!cf || fixed, error: cf && !cache ? lastError || 'not asked yet' : '' };
}

function tidy(list) {
  const out = [];
  for (const s of [].concat(list || [])) {
    // (port 53 is offered for odd networks but browsers refuse it and wait a long time doing so)
    const urls = [].concat(s?.urls || []).filter((u) => typeof u === 'string' && /^(stun|turns?):/i.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const turn = urls.some((u) => /^turns?:/i.test(u));
    if (turn && !(s.username && s.credential)) continue;
    out.push(turn ? { urls, username: String(s.username), credential: String(s.credential) } : { urls });
  }
  return out;
}

export async function refreshIce() {
  const cf = config.cloudflareTurn;
  if (!cf) return iceServersNow();
  try {
    const r = await fetch(`${cf.api}/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: TTL_SECONDS }), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 || r.status === 404 ? `Cloudflare did not accept the key (HTTP ${r.status}). Run Voice Relay Setup again.` : `Cloudflare answered HTTP ${r.status}`);
    const theirs = tidy((await r.json()).iceServers).filter((s) => s.username);
    if (!theirs.length) throw new Error('Cloudflare sent no relay');
    cache = { servers: [...config.iceServers, ...theirs], at: Date.now() };
    if (lastError) console.log('[voice] the voice relay is answering again');
    lastError = '';
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? 'Cloudflare did not answer in time' : (e?.message || String(e));
    if (msg !== lastError) console.warn(`[voice] could not get the voice relay: ${msg}. Calls carry on without it${cache ? ' (the last logins stay in use)' : ''}.`);
    lastError = msg;
    // (logins older than their lifetime are worse than none: the apps would wait on a relay that turns them away)
    if (cache && Date.now() - cache.at > (TTL_SECONDS - 3600) * 1000) cache = null;
  }
  return iceServersNow();
}

export function startIce() {
  if (!config.cloudflareTurn) return;
  refreshIce().then(() => { if (cache) console.log('  ✓ Voice relay is on (Cloudflare): calls work across networks that block direct connections'); });
  setInterval(refreshIce, REFRESH_MS).unref();
}
