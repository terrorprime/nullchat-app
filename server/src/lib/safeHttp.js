// Fetching a web page for somebody else (link previews) without letting anyone aim the server at its own network.
//
// Checking an address and then fetching is not enough: the name can answer "93.184.x.x" for the check and "10.0.0.1" a moment later
// (DNS rebinding). So the check lives in the lookup the connection itself uses: whatever the connection is opened to is exactly what was
// checked, and every redirect goes through the same door.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- which addresses are off limits
const v4 = (s) => { const p = s.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null; };

/** 8 groups of 16 bits, or null. Understands "::" and a dotted IPv4 tail ("::ffff:127.0.0.1"). */
function parseV6(ip) {
  let s = ip.split('%')[0].toLowerCase();
  if (!net.isIPv6(s)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const p = v4(tail[1]); if (!p) return null; s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const [head, rest] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0 || (rest === undefined && a.length !== 8)) return null;
  const groups = [...a, ...Array(fill).fill('0'), ...b].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

function blockedV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||                  // this network, private, loopback, multicast/reserved/broadcast
    (a === 100 && b >= 64 && b <= 127) ||                               // carrier-grade NAT
    (a === 169 && b === 254) ||                                         // link-local (cloud metadata lives at 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||    // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);   // benchmarking, documentation
}

/** True for anything that is not an ordinary address on the public internet. Anything that cannot be understood counts as blocked. */
export function isBlockedIp(ip) {
  if (typeof ip !== 'string') return true;
  if (net.isIPv4(ip)) return blockedV4(v4(ip));
  const g = parseV6(ip);
  if (!g) return true;
  const embedded = (hi, lo) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.every((n, i) => (i < 7 ? n === 0 : n <= 1))) return true;                          // :: and ::1
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]);   // ::ffff:a.b.c.d and the old ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0 || embedded(g[6], g[7]); // NAT64 (64:ff9b::/96 and the local-use block)
  if (g[0] === 0x2002) return embedded(g[1], g[2]);                                        // 6to4 carries an IPv4 address inside
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;                    // Teredo, documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;             // discard-only
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;   // private (Fly's own network is here), link-local, site-local, multicast
}

// ---------------------------------------------------------------- the lookup the connection uses
const blockedError = (what) => Object.assign(new Error(`${what} is not allowed`), { code: 'EBLOCKED' });

/** A drop-in for dns.lookup that refuses to hand out private addresses. If a name has even one private answer, the whole name is refused. */
export function makeLookup({ resolve = dns.lookup, blocked = isBlockedIp } = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolve(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs?.length || addrs.some((a) => blocked(a.address))) return cb(blockedError('That address'));
      if (options?.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

// ---------------------------------------------------------------- one page
const DECODERS = { gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };

function once(u, { lookup, blocked, headers, signal }) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
    // (an address written out in the link never goes through the lookup, so it is checked here)
    if (net.isIP(host) && blocked(host)) return reject(blockedError('That address'));
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)\.?$/i.test(host)) return reject(blockedError('That host'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET', headers, lookup, agent: false, signal }, resolve);
    req.on('socket', (s) => s.on('connect', () => { if (s.remoteAddress && blocked(s.remoteAddress)) req.destroy(blockedError('That address')); }));  // (belt and braces: never talk to a blocked address, whatever resolved it)
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a page, following up to `maxRedirects` redirects, each one checked like the first.
 * Resolves to { status, headers, url, stream } where `stream` is the (decompressed) body; the caller reads what it needs, then calls `done()`.
 */
export async function safeGet(url, { maxRedirects = 3, timeoutMs = 6000, headers = {}, lookup = makeLookup(), blocked = isBlockedIp } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timed out')), timeoutMs);
  const done = () => { clearTimeout(timer); ctrl.abort(); };
  try {
    let u = new URL(url);
    for (let hop = 0; ; hop++) {
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
      if (u.username || u.password) throw new Error('links with a login are not fetched');
      const res = await once(u, { lookup, blocked, signal: ctrl.signal, headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers } });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        if (hop >= maxRedirects) throw new Error('too many redirects');
        u = new URL(res.headers.location, u);
        continue;
      }
      res.on('error', () => {});   // (closing the connection early is normal here; it must never become an uncaught error)
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      if (enc && enc !== 'identity') {
        const make = DECODERS[enc];
        if (!make) { res.destroy(); throw new Error('unknown content encoding'); }
        stream = res.pipe(make());
        stream.on('error', () => res.destroy());   // (also covers a body that is not really compressed)
      }
      return { status: res.statusCode, headers: res.headers, url: u.toString(), stream, done };
    }
  } catch (e) {
    done();
    throw e;
  }
}

/** Read up to `limit` characters (and stop early when `stopAt` shows up), then close the connection. */
export async function readText(stream, { limit = 512 * 1024, stopAt = null } = {}) {
  let text = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= limit || (stopAt && stopAt.test(text))) break;
    }
  } catch { /* a connection that dies half way still leaves whatever came before */ }
  stream.destroy?.();
  return text;
}
