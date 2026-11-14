// Server tags: the little badge next to a name, the card a click on it opens, the editor a server uses to set its tag (with its own badge picture),
// and the picker where each person chooses which of their servers' tags to wear. The rules live in shared/tags.js (and are enforced on the server).
import { useEffect, useRef, useState } from 'react';
import { api, putImage } from '../lib/api.js';
import { useStore, store } from '../lib/state.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { Button, Field, GuildIcon, Spinner, confirmDialog, openPopout, pickFile } from './ui.jsx';
import { isTextLike } from '../../../shared/permissions.js';
import {
  TAG_ICONS, TAG_ICON_NAMES, TAG_COLORS, DEFAULT_TAG_COLOR, DEFAULT_TAG_ICON, TAG_MIN, TAG_MAX, normalizeTagText, validTagText, isReservedTag,
} from '../../../shared/tags.js';

const sameBadge = (a, b) => a?.kind === b?.kind && (a?.kind === 'icon' ? a.name === b.name : a?.url === b?.url);

/** The badge itself: one of the built-in outlines, or the server's own picture. */
export function TagBadge({ badge, size = 12 }) {
  if (badge?.kind === 'image') return <img className="tag-badge-img" src={badge.url} alt="" width={size} height={size} draggable={false} loading="lazy" />;
  const paths = TAG_ICONS[badge?.name] || TAG_ICONS[DEFAULT_TAG_ICON];
  return (
    <svg className="tag-badge-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** The tag as it shows next to a name. Clicking it opens the server's card (unless `plain`, which is for previews). */
export function ServerTag({ tag, plain, className }) {
  if (!tag?.text) return null;
  const style = { '--tag': tag.color || DEFAULT_TAG_COLOR };
  const body = <><TagBadge badge={tag.badge} /><span className="server-tag-text">{tag.text}</span></>;
  if (plain) return <span className={cx('server-tag', className)} style={style}>{body}</span>;
  const open = (e) => {
    e.stopPropagation(); e.preventDefault();
    if (!tag.guildId) return;
    openPopout(e.currentTarget, ({ close }) => <TagCard guildId={tag.guildId} close={close} />, { placement: 'bottom', key: `tag:${tag.guildId}:${e.currentTarget.dataset.pk || ''}` });
  };
  return (
    <button type="button" className={cx('server-tag clickable', className)} style={style} onClick={open} onContextMenu={(e) => e.stopPropagation()} title={`${tag.text} server tag. Click to see the server.`} aria-label={`Server tag ${tag.text}. Open the server’s card.`}>
      {body}
    </button>
  );
}

/** What a click on a tag shows. */
function TagCard({ guildId, close }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get(`/guilds/${guildId}/tag-card`).then((c) => alive && setCard(c)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [guildId]);
  const open = () => {
    const s = store.get();
    const first = (s.guildChannels[guildId] || []).map((id) => s.channels[id]).find((c) => c && isTextLike(c.type));
    close(); navigate(`/channels/${guildId}${first ? `/${first.id}` : ''}`);
  };
  const join = async () => {
    setBusy(true);
    try { const r = await api.post(`/discovery/${guildId}/join`); close(); navigate(`/channels/${r.guildId}${r.channelId ? `/${r.channelId}` : ''}`); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="tag-card" role="dialog" aria-label="Server tag">
      {!card && !error && <div className="tag-card-loading"><Spinner /></div>}
      {error && <p className="muted small">{error}</p>}
      {card && (
        <>
          <div className="tag-card-head">
            <GuildIcon guild={card} size={46} />
            <div className="tag-card-name">
              <b className="truncate">{card.name}</b>
              <ServerTag tag={{ ...card.tag, guildId }} plain />
            </div>
          </div>
          {card.description ? <p className="tag-card-about">{card.description}</p> : null}
          {card.memberCount !== undefined && (
            <p className="tiny muted">{card.memberCount.toLocaleString()} {card.memberCount === 1 ? 'member' : 'members'} · {card.wearing.toLocaleString()} {card.wearing === 1 ? 'wears' : 'wear'} this tag</p>
          )}
          {card.isMember
            ? <Button size="sm" variant="secondary" onClick={open}>Open Server</Button>
            : card.discoverable
              ? <Button size="sm" loading={busy} onClick={join}>Join Server</Button>
              : <p className="tiny muted">This server is private. You need an invite to join.</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the editor (Server Settings → Overview)

/** Shrink a picture to a 128 pixel square (centred) so every badge is small and sharp. A GIF becomes its first frame. */
async function toBadgePng(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('That picture could not be read.');
  return blob;
}

export function ServerTagEditor({ guild }) {
  const me = useStore((s) => s.me);
  const saved = guild.tag || null;
  const initial = saved ? { text: saved.text, badge: saved.badge, color: saved.color } : { text: '', badge: { kind: 'icon', name: DEFAULT_TAG_ICON }, color: DEFAULT_TAG_COLOR };
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const key = JSON.stringify(initial);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setD(initial); setError(null); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const text = normalizeTagText(d.text);
  const problem = !text ? null : !validTagText(text) ? `Use ${TAG_MIN} to ${TAG_MAX} letters or numbers.` : isReservedTag(text) ? 'That tag is reserved. Pick another.' : null;
  const dirty = !saved || text !== saved.text || d.color !== saved.color || !sameBadge(d.badge, saved.badge);
  const ready = validTagText(text) && !problem && dirty;

  const pick = async () => {
    const f = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    setUploading(true); setError(null);
    try {
      const small = await toBadgePng(f);
      const r = await putImage(`/guilds/${guild.id}/tag/badge`, small);
      setD((x) => ({ ...x, badge: { kind: 'image', url: r.url } }));
    } catch (e) { toastError(e); } finally { setUploading(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.put(`/guilds/${guild.id}/tag`, { text, color: d.color, badge: d.badge.kind === 'image' ? { kind: 'image', url: d.badge.url } : { kind: 'icon', name: d.badge.name } }); toast('Server tag saved', 'success', 2000); }
    catch (e) { setError(e.errors?.text || e.message); if (!e.errors?.text) toastError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove the server tag?', body: 'Everyone who wears it stops wearing it right away. You can set a new one any time.', confirmText: 'Remove tag', danger: true }))) return;
    setBusy(true);
    try { await api.del(`/guilds/${guild.id}/tag`); setD({ text: '', badge: { kind: 'icon', name: DEFAULT_TAG_ICON }, color: DEFAULT_TAG_COLOR }); toast('Server tag removed', 'success', 2000); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const previewTag = text && validTagText(text) ? { text, badge: d.badge, color: d.color } : null;
  return (
    <div className="settings-section server-tag-editor">
      <h3>Server Tag</h3>
      <p className="muted small">A short tag that members can choose to wear next to their name, everywhere they show up. Anyone in this server can wear it, and nobody has to.</p>
      <Field label={`Tag (${TAG_MIN} to ${TAG_MAX} letters or numbers)`} error={error || problem} hint="No two servers can share a tag, and a few are kept for the people who run NullChat.">
        <div className="tag-text-row">
          <input className="input tag-text-input" value={d.text} maxLength={TAG_MAX} placeholder="ABCD" aria-label="Tag"
            onChange={(e) => { setError(null); setD({ ...d, text: e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, TAG_MAX) }); }}
            onKeyDown={(e) => e.key === 'Enter' && ready && save()} />
          <span className="tiny muted">Preview</span>
          {previewTag ? <ServerTag tag={previewTag} plain /> : <span className="tiny muted">Type a tag to see it</span>}
        </div>
      </Field>
      <div className="field">
        <span className="field-label">Badge</span>
        <div className="tag-badge-grid" role="radiogroup" aria-label="Badge">
          {TAG_ICON_NAMES.map((n) => {
            const on = d.badge.kind === 'icon' && d.badge.name === n;
            return (
              <button key={n} type="button" role="radio" aria-checked={on} aria-label={n} title={n} className={cx('tag-badge-opt', on && 'on')} onClick={() => setD({ ...d, badge: { kind: 'icon', name: n } })}>
                <TagBadge badge={{ kind: 'icon', name: n }} size={20} />
              </button>
            );
          })}
          <button type="button" role="radio" aria-checked={d.badge.kind === 'image'} aria-label="Your own picture" title="Upload your own picture" className={cx('tag-badge-opt upload', d.badge.kind === 'image' && 'on')} disabled={uploading} onClick={pick}>
            {uploading ? <Spinner /> : d.badge.kind === 'image' ? <TagBadge badge={d.badge} size={26} /> : <span className="tag-upload-plus" aria-hidden="true">+</span>}
          </button>
        </div>
        <span className="field-hint">{d.badge.kind === 'image' ? 'Using your own picture. Click it to upload a different one.' : 'Or press + to use your own picture. It is cropped to a square and shrunk to 128 pixels.'}</span>
      </div>
      <div className="field">
        <span className="field-label">Colour</span>
        <div className="tag-colors" role="radiogroup" aria-label="Colour">
          {TAG_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={`Colour ${c}`} className={cx('tag-color', d.color === c && 'on')} style={{ background: c }} onClick={() => setD({ ...d, color: c })} />
          ))}
        </div>
      </div>
      <div className="tag-sample">
        <span className="tiny muted">How it looks</span>
        <div className="tag-sample-name"><b>{me.displayName || me.username}</b>{previewTag && <ServerTag tag={previewTag} plain />}</div>
      </div>
      <div className="row gap">
        <Button loading={busy} disabled={!ready || uploading} onClick={save}>{saved ? 'Save tag' : 'Create tag'}</Button>
        {saved && <Button variant="link" disabled={busy} onClick={remove}>Remove tag</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the picker (User Settings → Profile)

/** Choose which of your servers' tags to wear. Takes effect at once (it is not part of the profile's Save). */
export function MyServerTag() {
  const me = useStore((s) => s.me);
  const guilds = useStore((s) => s.guilds);
  const [busy, setBusy] = useState(null);
  const list = Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name));
  const wearing = me.serverTag?.guildId || null;
  const choose = async (guildId) => {
    if (guildId === wearing) return;
    setBusy(guildId || 'none');
    try { await api.put('/users/@me/tag', { guildId }); } catch (e) { toastError(e); } finally { setBusy(null); }
  };
  const withTag = list.filter((g) => g.tag);
  return (
    <div className="my-server-tag">
      <p className="tiny muted">Show the tag of one of your servers next to your name. You can change or remove it any time. It comes off by itself if you leave that server.</p>
      {withTag.length === 0 && <p className="small muted">None of your servers has a tag yet. A server’s owner can add one in Server Settings → Overview.</p>}
      <div className="tag-pick-list" role="radiogroup" aria-label="Your server tag">
        {withTag.map((g) => (
          <button key={g.id} type="button" role="radio" aria-checked={wearing === g.id} disabled={busy !== null} className={cx('tag-pick', wearing === g.id && 'on')} onClick={() => choose(g.id)}>
            <GuildIcon guild={g} size={34} />
            <span className="tag-pick-name"><b className="truncate">{g.name}</b><span className="tiny muted">{wearing === g.id ? 'Wearing this tag' : 'Click to wear it'}</span></span>
            <ServerTag tag={{ ...g.tag, guildId: g.id }} plain />
            <span className="tag-pick-radio" aria-hidden="true" />
          </button>
        ))}
        {withTag.length > 0 && (
          <button type="button" role="radio" aria-checked={!wearing} disabled={busy !== null} className={cx('tag-pick none', !wearing && 'on')} onClick={() => choose(null)}>
            <span className="tag-pick-none-icon" aria-hidden="true">–</span>
            <span className="tag-pick-name"><b>Don’t show a tag</b><span className="tiny muted">Your name stays plain</span></span>
            <span className="tag-pick-radio" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

