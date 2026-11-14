// The GIF tab of the picker: your favorites (the star on any GIF), the GIFs people on this server have uploaded (anyone can upload,
// everyone can search and send), your own uploads, and GIPHY as another source when an administrator has set it up.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { cx, debounce } from '../lib/utils.js';
import { store, useStore } from '../lib/state.js';
import { loadGifFavorites, setFavorite, dropFavorite, syncFavorite, gifKey } from '../lib/gifFavorites.js';
import { Spinner } from './ui.jsx';
import { Icon } from './icons.jsx';

const MAX_MB = 5;
const OK_TYPES = ['image/gif', 'image/webp'];

/** "my_cat-dancing.final.gif" -> "my cat dancing final" */
const nameFromFile = (f) => f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

const keyOf = gifKey;
const labelOf = (g) => g.name || g.title || 'GIF';

/** Does a favorite match what was typed? Every word has to appear in its name, title or tags. */
function matches(g, q) {
  const terms = q.toLowerCase().split(/[\s,#]+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [g.name, g.title, ...(g.tags || [])].filter(Boolean).join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function GifPicker({ onPick }) {
  const [tab, setTab] = useState(null);            // 'favorites' | 'all' | 'mine' | 'giphy'; null until we know whether you have favorites to start on
  const [q, setQ] = useState('');
  const [giphy, setGiphy] = useState(() => !!store.get().features?.giphy);   // does this server also have GIPHY?
  const [state, setState] = useState({ loading: true, results: [], hasMore: false, error: null, configured: true });
  const favs = useStore((s) => s.gifFavorites);    // the GIFs you starred, newest first (null while they load); shared with the stars in chat
  const favsFailed = useStore((s) => s.gifFavoritesFailed);
  const [form, setForm] = useState(null);          // null | { file?, gif?, name, tags }   (an upload, or editing one of yours)
  const [removing, setRemoving] = useState(null);  // id of the GIF waiting for a second click to be removed
  const seq = useRef(0);
  const busyFav = useRef(new Set());               // GIFs whose star is being saved right now

  // Your favorites come first, and they are where the picker opens when you have any. (They are normally loaded already, when the app started.)
  useEffect(() => { loadGifFavorites(); }, []);
  useEffect(() => { if (favs || favsFailed) setTab((t) => t ?? (favs?.length ? 'favorites' : 'all')); }, [favs, favsFailed]);
  const favKeys = useMemo(() => new Set((favs || []).map(keyOf)), [favs]);
  const shownFavs = useMemo(() => (favs || []).filter((g) => matches(g, q)), [favs, q]);

  const fetchPage = useCallback(async (query, which, offset) => {
    if (which === 'giphy') {
      const r = await api.get(`/gifs/search?q=${encodeURIComponent(query)}`);
      return { results: r.results.map((g) => ({ ...g, source: 'giphy' })), hasMore: false, configured: r.configured, error: r.error || null };
    }
    const r = await api.get(`/gifs?q=${encodeURIComponent(query)}&scope=${which === 'mine' ? 'mine' : 'all'}&offset=${offset}`);
    setGiphy(!!r.giphy);
    return { results: r.results.map((g) => ({ ...g, source: 'library' })), hasMore: r.hasMore, configured: true, error: null };
  }, []);

  const load = useMemo(() => debounce(async (query, which) => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetchPage(query, which, 0);
      if (mine === seq.current) setState({ loading: false, ...r });
    } catch (e) {
      if (mine === seq.current) setState({ loading: false, results: [], hasMore: false, configured: true, error: e.message });
    }
  }, 250), [fetchPage]);
  // Favorites are already here (and searched on this device), so only the other tabs ask the server.
  useEffect(() => { if (tab && tab !== 'favorites') load(q, tab); }, [q, tab, load]);
  const reload = () => load(q, tab);

  const more = async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await fetchPage(q, tab, state.results.length);
      if (mine === seq.current) setState((s) => ({ ...s, loading: false, hasMore: r.hasMore, results: [...s.results, ...r.results.filter((g) => !s.results.some((x) => x.id === g.id))] }));
    } catch (e) { if (mine === seq.current) setState((s) => ({ ...s, loading: false, error: e.message })); }
  };

  const chooseFile = (file) => {
    if (!file) return;
    if (!OK_TYPES.includes(file.type)) return toast('Please choose a GIF (an animated WebP works too).', 'error');
    if (file.size > MAX_MB * 1024 * 1024) return toast(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB.`, 'error');
    setForm({ file, name: nameFromFile(file) || 'GIF', tags: '' });
  };

  const remove = async (g) => {
    if (removing !== g.id) { setRemoving(g.id); setTimeout(() => setRemoving((x) => (x === g.id ? null : x)), 3000); return; }
    setRemoving(null);
    try {
      await api.del(`/gifs/${g.id}`);
      setState((s) => ({ ...s, results: s.results.filter((x) => x.id !== g.id) }));
      dropFavorite('library', g.id);   // the server already took it out of everyone's favorites
    } catch (e) { toastError(e); }
  };

  /** Star or un-star. The star changes at once; if the server says no it changes back and says why. */
  const toggleFavorite = async (g) => {
    const key = keyOf(g);
    if (busyFav.current.has(key)) return;
    busyFav.current.add(key);
    const was = favKeys.has(key);
    const done = await setFavorite(g, !was);
    busyFav.current.delete(key);
    // On the Favorites tab the GIF disappears from view, so an accidental tap can be taken back.
    if (done && was && tab === 'favorites') toast('Removed from favorites', 'info', 5000, { actionLabel: 'Undo', onClick: () => { setFavorite(g, true); } });
  };

  if (form) {
    return <GifForm form={form} setForm={setForm} onCancel={() => setForm(null)} onDone={(g, edited) => {
      setForm(null);
      if (edited) {
        setState((s) => ({ ...s, results: s.results.map((x) => (x.id === g.id ? { ...g, source: 'library' } : x)) }));
        syncFavorite({ ...g, source: 'library' });
        return;
      }
      toast('GIF added. Everyone on this server can find it now.', 'success');
      setQ(''); setTab('mine'); reload();
    }} />;
  }

  const onFavorites = tab === 'favorites';
  const empty = !onFavorites && !state.loading && !state.error && !state.results.length;
  const cell = (g) => (
    <GifCell key={keyOf(g)} g={g} starred={favKeys.has(keyOf(g))} onPick={onPick} onStar={toggleFavorite}
      removing={removing === g.id} onEdit={() => setForm({ gif: g, name: g.name, tags: g.tags.join(', ') })} onRemove={() => remove(g)} />
  );

  return (
    <div className="gif-picker" onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); chooseFile(f); } }}>
      <div className="gif-top">
        <div className="picker-search">
          <input className="input" autoFocus placeholder={tab === 'giphy' ? 'Search GIPHY' : onFavorites ? 'Search your favorites' : 'Search GIFs by name or tag'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search GIFs" />
        </div>
        <UploadButton onFile={chooseFile} />
      </div>
      <div className="gif-sources" role="tablist">
        {[['favorites', 'Favorites'], ['all', 'All'], ['mine', 'Mine'], ...(giphy || tab === 'giphy' ? [['giphy', 'GIPHY']] : [])].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={cx('gif-source', tab === id && 'active')} onClick={() => setTab(id)}>
            {id === 'favorites' && <Icon name="star" size={13} style={{ fill: 'currentColor' }} />}{label}
          </button>
        ))}
      </div>
      <div className="gif-scroll">
        {tab === null || (onFavorites && favs === null && !favsFailed) ? <div className="picker-empty"><Spinner /></div>
          : onFavorites && favs === null ? (
            <div className="picker-empty"><Icon name="star" size={36} /><p><b>Couldn’t load your favorites.</b></p><button className="btn btn-secondary btn-sm" onClick={() => loadGifFavorites(true)}>Try again</button></div>
          ) : onFavorites ? (
            shownFavs.length
              ? <div className="gif-grid">{shownFavs.map(cell)}</div>
              : <FavoritesEmpty q={q} any={!!favs.length} onBrowse={() => setTab('all')} />
          ) : tab === 'giphy' && !state.configured ? (
            <div className="picker-empty"><Icon name="gif" size={36} /><p><b>GIPHY isn’t set up on this server.</b></p></div>
          ) : state.loading && !state.results.length ? <div className="picker-empty"><Spinner /></div>
            : state.error ? <div className="picker-empty muted">{state.error}</div>
              : empty ? <GifEmpty tab={tab} q={q} onFile={chooseFile} />
                : (
                  <>
                    <div className="gif-grid">{state.results.map(cell)}</div>
                    {state.hasMore && <button className="btn btn-secondary btn-sm gif-more" disabled={state.loading} onClick={more}>{state.loading ? 'Loading…' : 'Show more'}</button>}
                  </>
                )}
      </div>
      {tab === 'giphy' && <div className="gif-attrib muted tiny">Powered by GIPHY</div>}
    </div>
  );
}

function GifCell({ g, starred, onPick, onStar, removing, onEdit, onRemove }) {
  const label = labelOf(g);
  return (
    <div className="gif-item">
      <button className="gif-cell" onClick={() => onPick(g)} title={g.name || g.title}
        style={g.width && g.height ? { aspectRatio: `${g.width} / ${g.height}` } : undefined}>
        <img src={g.preview} alt={label} loading="lazy" />
        {g.name && <span className="gif-name">{g.name}</span>}
      </button>
      <button type="button" className={cx('gif-star', starred && 'on')} aria-pressed={starred} aria-label={starred ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
        data-tooltip={starred ? 'Remove from favorites' : 'Add to favorites'} onClick={() => onStar(g)}>
        <Icon name="star" size={15} style={starred ? { fill: 'currentColor' } : undefined} />
      </button>
      {g.source === 'library' && g.canDelete && (
        <div className="gif-tools">
          {!removing && <button className="gif-tool" aria-label={`Edit ${g.name}`} data-tooltip="Edit name and tags" onClick={onEdit}><Icon name="edit" size={14} /></button>}
          <button className={cx('gif-tool', removing && 'danger')} aria-label={removing ? `Confirm removing ${g.name}` : `Remove ${g.name}`} data-tooltip={removing ? undefined : 'Remove'} onClick={onRemove}>
            {removing ? <span>Remove?</span> : <Icon name="trash" size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

function UploadButton({ onFile }) {
  const input = useRef(null);
  return (
    <>
      <button className="gif-upload" onClick={() => input.current?.click()} data-tooltip={`Add your own GIF (up to ${MAX_MB} MB)`}><Icon name="upload" size={16} /> Upload</button>
      <input ref={input} type="file" accept="image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }} />
    </>
  );
}

function FavoritesEmpty({ q, any, onBrowse }) {
  const searching = !!q.trim();
  return (
    <div className="picker-empty">
      <Icon name="star" size={36} />
      {searching && any
        ? <><p><b>No favorites match “{q.trim()}”.</b></p><button className="btn btn-secondary btn-sm" onClick={onBrowse}>Search all GIFs for “{q.trim()}”</button></>
        : <><p><b>No favorites yet.</b></p><p className="muted small">Star a GIF to keep it here, on every device you use.</p><button className="btn btn-primary btn-sm" onClick={onBrowse}>Browse GIFs</button></>}
    </div>
  );
}

function GifEmpty({ tab, q, onFile }) {
  const input = useRef(null);
  const searching = !!q.trim();
  return (
    <div className="picker-empty">
      <Icon name="gif" size={36} />
      {searching
        ? <><p><b>No GIFs match “{q.trim()}”.</b></p><p className="muted small">Try another word, or upload one with that tag.</p></>
        : tab === 'mine'
          ? <><p><b>You haven’t uploaded any GIFs yet.</b></p><p className="muted small">Anything you upload can be found and sent by everyone on this server.</p></>
          : <><p><b>No GIFs here yet.</b></p><p className="muted small">Upload the first one. You can also drop a GIF file here.</p></>}
      <button className="btn btn-primary btn-sm" onClick={() => input.current?.click()}><Icon name="upload" size={16} /> Upload a GIF</button>
      <input ref={input} type="file" accept="image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }} />
    </div>
  );
}

function GifForm({ form, setForm, onCancel, onDone }) {
  const editing = !!form.gif;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const preview = useMemo(() => (form.file ? URL.createObjectURL(form.file) : form.gif.url), [form.file, form.gif]);
  useEffect(() => () => { if (form.file) URL.revokeObjectURL(preview); }, [preview, form.file]);
  const save = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const qs = `name=${encodeURIComponent(form.name.trim() || 'GIF')}&tags=${encodeURIComponent(form.tags)}`;
      if (editing) onDone(await api.patch(`/gifs/${form.gif.id}`, { name: form.name, tags: form.tags }), true);
      else onDone(await uploadFile(`/gifs?${qs}`, form.file, setProgress), false);
    } catch (err) { toastError(err); setBusy(false); }
  };
  return (
    <form className="gif-form" onSubmit={save}>
      <div className="gif-form-preview"><img src={preview} alt="" /></div>
      <label className="field"><span className="field-label">Name</span>
        <input className="input" autoFocus maxLength={40} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="What is it?" />
      </label>
      <label className="field"><span className="field-label">Tags</span>
        <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="funny, cat, reaction" />
        <small className="muted">Separate with commas. People find GIFs by name and tags.</small>
      </label>
      {!editing && <p className="muted small">Everyone on this server can see, search and send this GIF.</p>}
      <div className="gif-form-actions">
        <button type="button" className="btn btn-link" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim()}>
          {busy ? (editing ? 'Saving…' : `Uploading ${Math.round(progress * 100)}%`) : editing ? 'Save' : 'Upload GIF'}
        </button>
      </div>
    </form>
  );
}
