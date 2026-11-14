// Server insights (Server Settings → Insights): how the server is doing, for its owner and anyone who can manage it.
// Numbers from server/src/routes/insights.js. Charts are plain SVG/HTML here (no chart library): thin marks, a legend for two series,
// hover tooltips that never hide a value (every number is also in the table view), and colours that follow the app theme.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { cx, relativeTime } from '../lib/utils.js';
import { Avatar, Button, Spinner, Tabs } from './ui.jsx';
import { Icon } from './icons.jsx';
import { pageZoom } from '../lib/zoom.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n);
const compact = (n) => (n >= 10000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt(n));
const dateLabel = (iso, long) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) });
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;

/** Round tick marks for a 0-based axis: whole numbers, about three steps. */
function ticksFor(max) {
  const raw = Math.max(max, 1) / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out = []; for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

function useWidth() {
  const [el, setEl] = useState(null);
  const [w, setW] = useState(640);
  // The chart's wrapper comes and goes (the table view swaps it out), so measure whichever one is on screen now.
  const holder = useMemo(() => { let cur = null; return { get current() { return cur; }, set current(n) { cur = n; setEl(n); } }; }, []);
  useEffect(() => {
    if (!el) return undefined;
    const measure = () => setW(Math.max(260, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [holder, w];
}

/** Touch screens: the readout stays after the finger lifts, and goes away on the next tap anywhere else. */
function useDismiss(ref, clear) {
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) clear(); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A hover readout positioned inside its chart. Text only (names and numbers are shown as text nodes, never HTML). */
function Tip({ tip, width }) {
  if (!tip) return null;
  const right = tip.x > width / 2;
  return (
    <div className="viz-tip" role="tooltip" style={{ left: tip.x, top: Math.max(0, tip.y), transform: `translate(${right ? 'calc(-100% - 12px)' : '12px'}, -8px)` }}>
      <div className="viz-tip-head">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-row">
          {r.color && <i className={cx('viz-key', r.line && 'line')} style={{ background: r.color }} aria-hidden="true" />}
          <b>{r.value}</b><span>{r.label}</span>
        </div>
      ))}
      {tip.note && <div className="viz-tip-note">{tip.note}</div>}
    </div>
  );
}

function Card({ title, sub, table, onTable, showTable, children, wide }) {
  return (
    <section className={cx('viz-card', wide && 'wide')} aria-label={title}>
      <header className="viz-head">
        <div><h3>{title}</h3>{sub && <p className="muted small">{sub}</p>}</div>
        {table && <button type="button" className="link-btn small" onClick={onTable} aria-pressed={showTable}>{showTable ? 'Show chart' : 'Show as table'}</button>}
      </header>
      {children}
    </section>
  );
}

// ================================================================ numbers
function Delta({ cur, prev, days, upGood = true, partial }) {
  if (partial) return <div className="viz-delta muted">Counted from the day tracking began</div>;
  if (cur === prev) return <div className="viz-delta muted">Same as the {days} days before</div>;
  const up = cur > prev;
  const good = up === upGood;
  // (a percentage of a tiny number says nothing: "1100% up" is really "12, from 1")
  const text = prev < 10 ? `${up ? 'Up' : 'Down'} from ${fmt(prev)} in the ${days} days before` : `${Math.round((Math.abs(cur - prev) / prev) * 100)}% ${up ? 'up' : 'down'} on the ${days} days before`;
  return <div className={cx('viz-delta', good ? 'good' : 'bad')}><Icon name={up ? 'chevronUp' : 'chevronDown'} size={14} /> <span className="sr-only">{up ? 'Up: ' : 'Down: '}</span>{text}</div>;
}
function Tile({ label, value, children }) {
  return <div className="viz-tile"><div className="viz-tile-label">{label}</div><div className="viz-tile-value">{value}</div>{children}</div>;
}

// ================================================================ messages per day (columns)
function MessagesChart({ data, table }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState(null);
  const [hot, setHot] = useState(-1);
  useDismiss(ref, () => { setTip(null); setHot(-1); });
  const s = data.series; const n = s.length;
  const H = 190, m = { l: 40, r: 8, t: 14, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const peak = Math.max(0, ...s.map((d) => d.messages));
  const ticks = ticksFor(peak); const top = ticks[ticks.length - 1];
  const band = iw / n; const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v) => m.t + ih - (v / top) * ih;
  const xTicks = n <= 7 ? s.map((_, i) => i) : [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1];
  const peakIdx = peak > 0 ? s.findIndex((d) => d.messages === peak) : -1;
  if (table) return <DataTable head={['Day', 'Messages', 'People who wrote']} rows={s.map((d) => [dateLabel(d.date, true), fmt(d.messages), fmt(d.active)])} />;
  const show = (e, i) => { const r = ref.current.getBoundingClientRect(); setHot(i); setTip({ x: (e.clientX - r.left) / pageZoom(), y: (e.clientY - r.top) / pageZoom(), title: dateLabel(s[i].date, true), rows: [{ value: fmt(s[i].messages), label: s[i].messages === 1 ? 'message' : 'messages', color: 'var(--viz-1)' }, { value: fmt(s[i].active), label: s[i].active === 1 ? 'person wrote' : 'people wrote' }] }); };
  return (
    <div className="viz-wrap" ref={ref} onPointerLeave={(e) => { if (e.pointerType !== 'touch') { setTip(null); setHot(-1); } }}>
      <svg width={W} height={H} role="img" aria-label={`Messages per day over the last ${n} days. Total ${fmt(data.messages.total)}. Busiest day ${peakIdx >= 0 ? `${dateLabel(s[peakIdx].date)} with ${fmt(peak)}` : 'none'}. The table view has every day.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="viz-tick">{compact(t)}</text>
          </g>
        ))}
        {s.map((d, i) => {
          const h = Math.max(d.messages ? 2 : 0, (d.messages / top) * ih);
          const x = m.l + i * band + (band - bw) / 2;
          // 4px rounded at the top, square on the baseline
          const r = Math.min(4, bw / 2, h);
          return h > 0 ? <path key={d.date} className={cx('viz-bar', hot === i && 'hot')} fill="var(--viz-1)" d={`M${x},${m.t + ih} V${m.t + ih - h + r} Q${x},${m.t + ih - h} ${x + r},${m.t + ih - h} H${x + bw - r} Q${x + bw},${m.t + ih - h} ${x + bw},${m.t + ih - h + r} V${m.t + ih} Z`} /> : null;
        })}
        {peakIdx >= 0 && <text x={Math.min(W - m.r, Math.max(m.l, m.l + peakIdx * band + band / 2))} y={y(peak) - 6} textAnchor="middle" className="viz-label">{fmt(peak)}</text>}
        {xTicks.map((i) => <text key={i} x={m.l + i * band + band / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="viz-tick">{dateLabel(s[i].date)}</text>)}
        {s.map((d, i) => <rect key={`h${d.date}`} x={m.l + i * band} y={m.t} width={band} height={ih} fill="transparent" onPointerMove={(e) => show(e, i)} onPointerDown={(e) => show(e, i)} />)}
      </svg>
      <Tip tip={tip} width={W} />
    </div>
  );
}

// ================================================================ joined and left (lines)
function MembersChart({ data, table }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState(null);
  const [hot, setHot] = useState(-1);
  useDismiss(ref, () => { setTip(null); setHot(-1); });
  const s = data.series; const n = s.length;
  const H = 190, m = { l: 40, r: 54, t: 14, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(0, ...s.map((d) => d.joined), ...s.map((d) => d.left ?? 0));
  const ticks = ticksFor(max); const top = ticks[ticks.length - 1];
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + ih - (v / top) * ih;
  // a line breaks where a value is unknown (leaves before tracking began)
  const path = (key) => { let d = ''; let pen = false; s.forEach((p, i) => { if (p[key] === null || p[key] === undefined) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)},${y(p[key])}`; pen = true; }); return d; };
  const lastJoined = s[n - 1].joined, lastLeft = s[n - 1].left;
  const xTicks = n <= 7 ? s.map((_, i) => i) : [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1];
  const apart = lastLeft !== null && Math.abs(y(lastJoined) - y(lastLeft)) > 16;   // direct labels only when they would not touch
  if (table) return <DataTable head={['Day', 'Joined', 'Left']} rows={s.map((d) => [dateLabel(d.date, true), fmt(d.joined), d.left === null ? 'not tracked yet' : fmt(d.left)])} />;
  const show = (e) => {
    const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / pageZoom();
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    setHot(i);
    setTip({ x: x(i), y: (e.clientY - r.top) / pageZoom(), title: dateLabel(s[i].date, true), rows: [
      { value: fmt(s[i].joined), label: 'joined', color: 'var(--viz-1)', line: true },
      { value: s[i].left === null ? 'not tracked' : fmt(s[i].left), label: 'left', color: 'var(--viz-2)', line: true },
    ] });
  };
  const dot = (i, v, color) => (v === null || v === undefined ? null : <g key={color}><circle cx={x(i)} cy={y(v)} r={6} fill="var(--viz-surface)" /><circle cx={x(i)} cy={y(v)} r={4} fill={color} /></g>);
  return (
    <div className="viz-wrap" ref={ref} onPointerLeave={(e) => { if (e.pointerType !== 'touch') { setTip(null); setHot(-1); } }}>
      <div className="viz-legend" aria-hidden="false">
        <span><i className="viz-key line" style={{ background: 'var(--viz-1)' }} /> Joined</span>
        <span><i className="viz-key line" style={{ background: 'var(--viz-2)' }} /> Left</span>
      </div>
      <svg width={W} height={H} role="img" aria-label={`People who joined and left per day over the last ${n} days. ${fmt(data.members.joined)} joined${data.members.leftKnownDays ? `, ${fmt(data.members.left)} left` : ''}. The table view has every day.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="viz-tick">{compact(t)}</text>
          </g>
        ))}
        {hot >= 0 && <line x1={x(hot)} x2={x(hot)} y1={m.t} y2={m.t + ih} className="viz-cross" />}
        <path d={path('joined')} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={path('left')} fill="none" stroke="var(--viz-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {dot(n - 1, lastJoined, 'var(--viz-1)')}
        {dot(n - 1, lastLeft, 'var(--viz-2)')}
        {hot >= 0 && hot !== n - 1 && <>{dot(hot, s[hot].joined, 'var(--viz-1)')}{dot(hot, s[hot].left, 'var(--viz-2)')}</>}
        {apart && <>
          <text x={x(n - 1) + 12} y={y(lastJoined) + 4} className="viz-label">Joined</text>
          <text x={x(n - 1) + 12} y={y(lastLeft) + 4} className="viz-label">Left</text>
        </>}
        {xTicks.map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="viz-tick">{dateLabel(s[i].date)}</text>)}
        <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent" onPointerMove={show} onPointerDown={show} />
      </svg>
      <Tip tip={tip} width={W} />
    </div>
  );
}

// ================================================================ busiest hours (heatmap)
function HeatChart({ data, table }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState(null);
  const [hot, setHot] = useState(null);
  useDismiss(ref, () => { setTip(null); setHot(null); });
  const heat = data.heat;
  const max = Math.max(0, ...heat.flat());
  const L = 36, T = 18, CH = 24, gap = 2;
  const cw = (W - L) / 24;
  const H = T + 7 * CH + 6;
  const step = (v) => (v === 0 ? 0 : Math.min(6, Math.max(1, Math.ceil(6 * Math.sqrt(v / max)))));
  if (table) return <DataTable scroll head={['', ...Array.from({ length: 24 }, (_, h) => hourLabel(h))]} rows={heat.map((row, d) => [WEEKDAYS[d], ...row.map(fmt)])} />;
  const show = (e, d, h) => { const r = ref.current.getBoundingClientRect(); setHot(`${d}-${h}`); setTip({ x: (e.clientX - r.left) / pageZoom(), y: (e.clientY - r.top) / pageZoom(), title: `${WEEKDAYS[d]}s, ${hourLabel(h)}`, rows: [{ value: fmt(heat[d][h]), label: heat[d][h] === 1 ? 'message' : 'messages' }], note: `in the last ${data.days} days` }); };
  return (
    <div className="viz-wrap" ref={ref} onPointerLeave={(e) => { if (e.pointerType !== 'touch') { setTip(null); setHot(null); } }}>
      <svg width={W} height={H} role="img" aria-label={`Messages by weekday and hour over the last ${data.days} days, in your time zone. ${max ? `The busiest slot has ${fmt(max)} messages.` : 'No messages yet.'} The table view has every slot.`}>
        {[0, 6, 12, 18].map((h) => <text key={h} x={L + h * cw} y={11} className="viz-tick">{hourLabel(h)}</text>)}
        {heat.map((row, d) => (
          <g key={d}>
            <text x={L - 8} y={T + d * CH + CH / 2 + 4} textAnchor="end" className="viz-tick">{WEEKDAYS[d].slice(0, 3)}</text>
            {row.map((v, h) => (
              <rect key={h} x={L + h * cw + gap / 2} y={T + d * CH + gap / 2} width={Math.max(2, cw - gap)} height={CH - gap} rx="3"
                className={cx('viz-cell', `s${step(v)}`, hot === `${d}-${h}` && 'hot')}
                onPointerMove={(e) => show(e, d, h)} onPointerDown={(e) => show(e, d, h)} />
            ))}
          </g>
        ))}
      </svg>
      <div className="viz-scale" aria-hidden="true"><span className="muted tiny">Fewer</span>{[1, 2, 3, 4, 5, 6].map((i) => <i key={i} className={cx('viz-cell-key', `s${i}`)} />)}<span className="muted tiny">More</span></div>
      <Tip tip={tip} width={W} />
    </div>
  );
}

// ================================================================ ranked bars
function Ranked({ rows, empty }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ol className="viz-rank">
      {rows.map((r) => (
        <li key={r.key} title={`${r.name}: ${fmt(r.value)} messages`}>
          <span className="viz-rank-name">{r.avatar}<span className="truncate">{r.name}</span></span>
          <span className="viz-rank-track"><span className="viz-rank-bar" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></span>
          <b className="viz-rank-value">{fmt(r.value)}</b>
        </li>
      ))}
    </ol>
  );
}

function DataTable({ head, rows, scroll }) {
  return (
    <div className={cx('viz-table-wrap', scroll && 'scroll')} tabIndex={0}>
      <table className="viz-table">
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ================================================================ the page
export function InsightsTab({ guild }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tables, setTables] = useState({});
  const tz = useMemo(() => new Date().getTimezoneOffset(), []);
  const flip = (k) => setTables((t) => ({ ...t, [k]: !t[k] }));
  const load = async (fresh) => {
    setLoading(true); setError('');
    try { setData(await api.get(`/guilds/${guild.id}/insights?days=${days}&tz=${tz}${fresh ? '&fresh=1' : ''}`)); }
    catch (e) { if (fresh) toastError(e); else setError(e.message || 'Couldn’t load insights.'); } finally { setLoading(false); }
  };
  useEffect(() => { load(false); }, [guild.id, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  const d = data;
  const partial = d && d.members.leftKnownDays < d.days;
  const trackedOn = d ? new Date(d.trackedSince).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  return (
    <div className="insights">
      <h2>Insights</h2>
      <div className="viz-controls">
        <Tabs className="report-tabs" value={days} onChange={setDays} tabs={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} />
        <span className="grow" />
        {d && <span className="muted tiny">Updated {relativeTime(d.generatedAt)}</span>}
        <Button size="sm" variant="secondary" loading={loading && !!d} onClick={() => load(true)}>Refresh</Button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {!d && !error && <div className="admin-loading"><Spinner /></div>}
      {d && (
        <div className={cx('viz-body', loading && 'refetching')}>
          <div className="viz-tiles">
            <Tile label="Members" value={fmt(d.members.now)}><div className="viz-delta muted">{d.members.now === 1 ? 'person' : 'people'} in the server</div></Tile>
            <Tile label="Joined" value={fmt(d.members.joined)}><Delta cur={d.members.joined} prev={d.members.joinedPrev} days={d.days} /></Tile>
            <Tile label="Left" value={d.members.leftKnownDays ? fmt(d.members.left) : '—'}>
              {partial ? <div className="viz-delta muted">{d.members.leftKnownDays ? 'Counted from' : 'Counting starts'} {trackedOn}</div> : <Delta cur={d.members.left} prev={d.members.leftPrev} days={d.days} upGood={false} partial={d.members.leftKnownDaysPrev < d.days} />}
            </Tile>
            <Tile label="Messages" value={fmt(d.messages.total)}><Delta cur={d.messages.total} prev={d.messages.prev} days={d.days} /></Tile>
            <Tile label="People who wrote" value={fmt(d.active.count)}><Delta cur={d.active.count} prev={d.active.prev} days={d.days} /></Tile>
          </div>

          <Card title="Messages per day" sub={d.messages.total ? 'People only. Bots are left out.' : 'No one has written anything in this time yet.'} table onTable={() => flip('msg')} showTable={!!tables.msg}>
            <MessagesChart data={d} table={!!tables.msg} />
          </Card>

          <Card title="People joining and leaving" sub={partial ? `Leaves are counted from ${trackedOn}, when this server started being tracked. Joins before that count the people who are still here.` : 'Everyone who joined or left each day.'} table onTable={() => flip('mem')} showTable={!!tables.mem}>
            <MembersChart data={d} table={!!tables.mem} />
          </Card>

          <Card title="When people write" sub={`Messages by weekday and hour, over the last ${d.days} days, in your time zone.`} table onTable={() => flip('heat')} showTable={!!tables.heat}>
            <HeatChart data={d} table={!!tables.heat} />
          </Card>

          <div className="viz-pair">
            <Card title="Busiest channels" sub={`Messages in the last ${d.days} days`}>
              <Ranked rows={d.channels.map((c) => ({ key: c.id, name: `#${c.name}`, value: c.messages }))} empty="No messages yet." />
            </Card>
            <Card title="Most active people" sub={`Messages in the last ${d.days} days`}>
              <Ranked rows={d.topMembers.map((t) => ({ key: t.user.id, name: t.user.displayName || t.user.username, value: t.messages, avatar: <Avatar user={t.user} size={20} /> }))} empty="No messages yet." />
            </Card>
          </div>

          <Card title="New people who spoke up" sub={`Of the ${fmt(d.newcomers.joined)} who joined in the last ${d.days} days and are still here.`}>
            {d.newcomers.joined === 0 ? <p className="muted small">No one new joined in this time.</p> : (
              <div className="viz-meter-row">
                <div className="viz-meter" role="img" aria-label={`${d.newcomers.posted} of ${d.newcomers.joined} new people have written a message`}><span style={{ width: `${(d.newcomers.posted / d.newcomers.joined) * 100}%` }} /></div>
                <div><b className="viz-meter-value">{Math.round((d.newcomers.posted / d.newcomers.joined) * 100)}%</b> <span className="muted small">{fmt(d.newcomers.posted)} of {fmt(d.newcomers.joined)} have written at least one message</span></div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
