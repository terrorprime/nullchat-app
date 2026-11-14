// The small pieces of forum channels that more than one screen uses: tag chips, the tag picker, the tag editor for the channel's
// settings, and the box that edits a post's title and tags.
import { useState } from 'react';
import { api } from '../lib/api.js';
import { store } from '../lib/state.js';
import { toast, toastError } from '../lib/toast.js';
import { cx } from '../lib/utils.js';
import { Modal, Button, Field, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';
import { ChannelType } from '../../../shared/permissions.js';

export const MAX_APPLIED = 5;
export const MAX_TAGS = 20;
export const TAG_NAME_MAX = 20;
export const TITLE_MAX = 100;

/** The forum a post lives in (from the store), if it is a forum post. */
export const forumOfPost = (s, post) => {
  const parent = post && s.channels[post.parentId];
  return parent?.type === ChannelType.FORUM ? parent : null;
};

export function TagChip({ tag, active, onClick, small, title }) {
  const body = <>{tag.emoji && <span className="tag-emoji" aria-hidden="true">{tag.emoji}</span>}<span className="tag-name">{tag.name}</span></>;
  const cls = cx('tag-chip', small && 'small', active && 'active', onClick && 'clickable');
  return onClick
    ? <button type="button" className={cls} aria-pressed={!!active} title={title} onClick={onClick}>{body}</button>
    : <span className={cls} title={title}>{body}</span>;
}

/** The tags a post carries, read from the forum's list (a tag that was deleted is simply not there any more). */
export function PostTags({ forum, ids, small }) {
  const tags = (ids || []).map((id) => (forum?.availableTags || []).find((t) => t.id === id)).filter(Boolean);
  if (!tags.length) return null;
  return <span className="tag-row">{tags.map((t) => <TagChip key={t.id} tag={t} small={small} />)}</span>;
}

/** Like <Field>, but not a <label>: a label would pass a click on its title to the first tag button and change it. */
export function FieldGroup({ label, required, hint, children }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}{required && <span className="req"> *</span>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Choose up to five of the forum's tags. */
export function TagPicker({ tags, value, onChange, required }) {
  if (!tags.length) return null;
  const toggle = (id) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else if (value.length >= MAX_APPLIED) toast(`A post can have at most ${MAX_APPLIED} tags.`, 'warning', 2200);
    else onChange([...value, id]);
  };
  return (
    <div className="tag-picker" role="group" aria-label="Tags">
      {tags.map((t) => <TagChip key={t.id} tag={t} active={value.includes(t.id)} onClick={() => toggle(t.id)} />)}
      <span className="tiny muted tag-count">{required && !value.length ? 'Pick at least one · ' : ''}{value.length}/{MAX_APPLIED}</span>
    </div>
  );
}

/** The tag list in a forum channel's settings: rename, change the emoji, add, remove. */
export function TagsEditor({ value, onChange }) {
  const set = (i, patch) => onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const dupe = (t, i) => !!t.name.trim() && value.some((x, j) => j !== i && x.name.trim().toLowerCase() === t.name.trim().toLowerCase());
  return (
    <div className="tags-editor">
      {value.length === 0 && <p className="muted small">No tags yet. Tags help people sort posts, and find the ones they care about.</p>}
      {value.map((t, i) => (
        <div key={t.id || `new${i}`} className="tag-edit-row">
          <input className="input tag-emoji-input" maxLength={4} value={t.emoji || ''} placeholder="🙂" aria-label={`Emoji for tag ${i + 1}`}
            onChange={(e) => set(i, { emoji: e.target.value.trim() ? [...e.target.value.trim()].slice(0, 2).join('') : null })} />
          <input className={cx('input', dupe(t, i) && 'invalid')} maxLength={TAG_NAME_MAX} value={t.name} placeholder="Tag name" aria-label={`Name of tag ${i + 1}`}
            onChange={(e) => set(i, { name: e.target.value })} />
          <button type="button" className="icon-btn danger" aria-label={`Remove tag ${t.name || i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></button>
          {dupe(t, i) && <span className="tiny tag-dupe">Another tag has this name.</span>}
        </div>
      ))}
      <Button variant="secondary" size="sm" disabled={value.length >= MAX_TAGS} onClick={() => onChange([...value, { id: null, name: '', emoji: null }])}>
        <Icon name="plus" size={14} /> Add tag
      </Button>
      <span className="tiny muted">{value.length}/{MAX_TAGS}</span>
    </div>
  );
}

function PostEditor({ postId, close }) {
  const post = store.get().channels[postId];
  const forum = post && forumOfPost(store.get(), post);
  const [title, setTitle] = useState(post?.name || '');
  const [tags, setTags] = useState(post?.appliedTags || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!post || !forum) return null;
  const needTag = forum.requireTag && (forum.availableTags || []).length > 0;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = {};
      if (title.trim() !== post.name) body.name = title.trim();
      if (JSON.stringify(tags) !== JSON.stringify(post.appliedTags || [])) body.appliedTags = tags;
      if (Object.keys(body).length) await api.patch(`/channels/${post.id}`, body);
      close();
    } catch (e) { setError(e.message); toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Edit post" onClose={close} size="sm"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} disabled={!title.trim() || (needTag && !tags.length)} onClick={save}>Save</Button></>}>
      <Field label="Title" error={error} required>
        <input className="input" autoFocus maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()} />
      </Field>
      {(forum.availableTags || []).length > 0 && (
        <FieldGroup label="Tags" required={needTag}><TagPicker tags={forum.availableTags} value={tags} onChange={setTags} required={needTag} /></FieldGroup>
      )}
    </Modal>
  );
}
export function openPostEditor(postId) { openModal(({ close }) => <PostEditor postId={postId} close={close} />); }
