// How long to wait before trying to reconnect, after the `attempts`-th failed try (0 for the first).
//
// When the server restarts (every deploy does) everybody loses the connection at the same instant, so everybody's retries are in step. With a
// fixed wait plus a little extra, the whole community would come back within half a second; the server has to build a full picture of the
// community for each person, and doing that for everybody at once keeps it busy for many seconds. So each wait is picked somewhere between half
// of the usual time and all of it: the first retry is still quick (half a second to a second), and the crowd spreads out over the later ones.
export function reconnectDelay(attempts, random = Math.random) {
  const base = Math.min(1000 * 2 ** attempts, 15000);
  return base * (0.5 + random() * 0.5);
}
