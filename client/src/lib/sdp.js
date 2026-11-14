// Session descriptions (SDP) are plain text. This is the one change NullChat makes to them, kept here as a pure function so it can be tested on its own.

/**
 * Put a start-bitrate hint (`x-google-start-bitrate`, in kbps) on every video codec of a description and return the new text.
 * Left alone, Chrome starts a video stream at about 300 kbps and takes 20 to 30 seconds to climb to a sharp picture; with the hint it starts there.
 * Chrome and Safari follow the hint, Firefox ignores it. Only the video codecs themselves (VP8, VP9, AV1, H264) are touched: not their
 * retransmission entries (rtx), not audio, and a codec that already has the hint keeps its own value.
 */
export function withVideoStart(sdp, kbps) {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);
  const codec = new Set();
  let video = false;
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const m = video && /^a=rtpmap:(\d+) (?:VP8|VP9|AV1|H264)\//i.exec(l);
    if (m) codec.add(m[1]);
  }
  if (!codec.size) return sdp;
  const hint = `x-google-start-bitrate=${kbps}`;
  const have = new Set();
  for (const l of lines) { const m = /^a=fmtp:(\d+) /.exec(l); if (m && codec.has(m[1])) have.add(m[1]); }
  const out = [];
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && codec.has(f[1])) { out.push(/x-google-start-bitrate=/.test(f[2]) ? l : `a=fmtp:${f[1]} ${f[2]};${hint}`); continue; }
    out.push(l);
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && codec.has(r[1]) && !have.has(r[1])) out.push(`a=fmtp:${r[1]} ${hint}`);
  }
  return out.join('\r\n');
}
