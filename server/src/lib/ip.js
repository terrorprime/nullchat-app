// Works out the visitor's real IP address, which the rate limits and session list depend on.
//
// On Fly.io the platform sets `Fly-Client-IP` itself and overwrites any value a visitor sends,
// so it is the one header that can be trusted there. The first entry of X-Forwarded-For can be
// forged by the visitor, so it is only used as a fallback for other proxies (Caddy, nginx...).
import { config } from '../config.js';

const ON_FLY = !!process.env.FLY_APP_NAME;

export function clientIp(req) {
  if (config.trustProxy) {
    if (ON_FLY) {
      const fly = String(req.headers['fly-client-ip'] || '').trim();
      if (fly) return fly;
    }
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}
