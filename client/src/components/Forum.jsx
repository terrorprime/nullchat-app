// Forum channels: the list of posts (search, tag filters, sort, closed posts), and the box for starting a post.
// Opening a post shows it in the side panel next to the list, like any thread (see ThreadPanel in Chat.jsx).
import { useEffect, useRef, useState } from 'react';
import { useStore, store, channelPermissions, displayName } from '../lib/state.js';
import { api, uploadFile } from '../lib/api.js';
import { on } from '../lib/gateway.js';
import { ackChannel, channelPath } from '../lib/actions.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, relativeTime, idTime, formatBytes } from '../lib/utils.js';
import { Markdown } from '../lib/markdown.jsx';
import { P, has } from '../../../shared/permissions.js';
import { Avatar, Button, Field, Modal, openModal, openContextMenu, pickFile, Select, Spinner } from './ui.jsx';
import { channelMenuItems } from './menus.jsx';
import { Icon } from './icons.jsx';
import { TagChip, PostTags, TagPicker, FieldGroup, MAX_APPLIED, TITLE_MAX } from './ForumTools.jsx';

let maxUploadMb = 150;
api.get('/config').then((c) => { maxUploadMb = c.maxUploadMb || 150; }).catch(() => {});

/** A message preview as plain words: mentions shown by name, not as their raw codes. */
function plain(text) {
  const s = store.get();
  return String(text || '')
    .replace(/<@!?(\d+)>/g, (m, id) => `@${s.users[id]?.displayName || s.users[id]?.username || 'someone'}`)
    .replace(/<@&(\d+)>/g, 'a role')
    .replace(/<#(\d+)>/g, (m, id) => `#${s.channels[id]?.name || 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\*\*|__|~~|\|\||(?<![\w])[*_](?=\S)|(?<=\S)[*_](?![\w])|`/g, '')   // bold, italic, strike, spoiler and code marks
    .replace(/^\s*(#{1,3}|>)\s+/gm, '');
}

/** Posts with something you have not read: the server says so when the list loads, and what arrives after that is worked out here. */
function usePostState(post) {
  return useStore((s) => {
    const ch = s.channels[post.id];
    const rs = s.readStates[post.id];
    const last = ch?.lastMessageId || post.lastMessageId || '';
    let unread = post.unread;
    if (rs?.lastReadId && rs.lastReadId >= last) unread = false;
    else if (last > (post.lastMessageId || '')) unread = true;
    return `${unread ? 1 : 0}:${rs ? rs.mentionCount || 0 : post.mentionCount || 0}`;
  });
}

/** A post nobody has opened yet is not in the store, and its menu is built from the store: put what the list knows about it there first. */
function knowPost(post) {
  const s = store.get();
  if (s.channels[post.id]) return;
  const { author, preview, unread, mentionCount, ...channel } = post;   // (only the channel's own fields)
  void author; void preview; void unread; void mentionCount;
  store.set({ channels: { ...s.channels, [post.id]: channel } });
}

function PostCard({ post, forum, active }) {
  const state = usePostState(post);
  const [unread, mentions] = [state.startsWith('1'), Number(state.split(':')[1])];
  const live = useStore((s) => s.channels[post.id]);
  const merged = live ? { ...post, ...live } : post;
  const replies = Math.max(0, (merged.messageCount || 1) - 1);
  const last = merged.lastMessageId ? idTime(merged.lastMessageId) : merged.createdAt;
  const author = post.author;
  const authorName = useStore((s) => (author ? displayName(s, author.id, forum.guildId) : ''));
  const text = plain(post.preview?.text);
  return (
    <a href={channelPath(post)} className={cx('post-card', active && 'active', unread && 'unread', merged.pinned && 'pinned')}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); navigate(channelPath(post)); }}
      onContextMenu={(e) => { knowPost(post); openContextMenu(e, channelMenuItems(post.id)); }}>
      <div className="post-main">
        <div className="post-title-row">
          {unread && <span className="post-dot" aria-label="Unread" />}
          <h3 className="post-title truncate">{merged.name}</h3>
          {mentions > 0 && <span className="mention-badge">{mentions}</span>}
          {merged.pinned && <Icon name="pin" size={14} className="post-flag post-pin" title="Pinned" />}
          {merged.locked && <Icon name="lock" size={14} className="post-flag" />}
          {merged.archived && <span className="pill">Closed</span>}
        </div>
        <PostTags forum={forum} ids={merged.appliedTags} small />
        {text && <p className="post-preview">{text}</p>}
        <div className="post-meta">
          {author && <><Avatar userId={author.id} guildId={forum.guildId} size={18} /><span className="post-author truncate">{authorName}</span><span className="post-sep" aria-hidden="true">·</span></>}
          <span><Icon name="thread" size={13} /> {replies === 1 ? '1 reply' : `${replies} replies`}</span>
          <span className="post-sep" aria-hidden="true">·</span>
          <span title={new Date(last).toLocaleString()}>{replies ? 'Active ' : 'Posted '}{relativeTime(last)}</span>
        </div>
      </div>
      {post.preview?.image && <img className="post-thumb" src={post.preview.image.url} alt={post.preview.image.description || ''} loading="lazy" />}
    </a>
  );
}

const SORTS = [{ value: 'activity', label: 'Recent activity' }, { value: 'new', label: 'Newest posts' }];

export function ForumView({ channel, threadId }) {
  const canPost = useStore((s) => has(channelPermissions(s, channel.id), P.CREATE_THREADS));
  const canManage = useStore((s) => has(channelPermissions(s, channel.id), P.MANAGE_CHANNELS));
  const tags = channel.availableTags || [];
  const defaultSort = channel.forumSort ? 'new' : 'activity';
  const [sort, setSort] = useState(defaultSort);
  const [tag, setTag] = useState(null);
  const [closed, setClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState({ posts: null, more: false, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const [guidelinesOpen, setGuidelinesOpen] = useState(false);

  useEffect(() => { setSort(channel.forumSort ? 'new' : 'activity'); }, [channel.id, channel.forumSort]);
  useEffect(() => { setTag(null); setClosed(false); setQuery(''); setSearch(''); setData({ posts: null, more: false, error: null }); }, [channel.id]);
  useEffect(() => { const t = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(t); }, [query]);
  // (a tag that was deleted from the forum while it is chosen as the filter)
  useEffect(() => { if (tag && !tags.some((t) => t.id === tag)) setTag(null); }, [tags, tag]);

  const params = (offset) => {
    const q = new URLSearchParams({ sort, closed: closed ? '1' : '0' });
    if (tag) q.set('tag', tag);
    if (search) q.set('search', search);
    if (offset) q.set('offset', String(offset));
    return q.toString();
  };
  const load = (keep) => {
    const mine = ++seq.current;
    api.get(`/channels/${channel.id}/posts?${params(0)}`).then((res) => {
      if (mine !== seq.current) return;
      const users = {};
      for (const p of res.posts) if (p.author && !store.get().users[p.author.id]) users[p.author.id] = p.author;
      if (Object.keys(users).length) store.set({ users: { ...store.get().users, ...users } });
      setData({ posts: res.posts, more: res.more, error: null });
    }).catch((e) => { if (mine === seq.current) setData((d) => ({ posts: keep ? d.posts : d.posts || [], more: false, error: e.message })); });
  };
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [channel.id, sort, tag, closed, search]);

  // Something changed in this forum (a post started, retitled, closed or deleted; a reply that moves a post up): fetch the list again, calmly.
  useEffect(() => {
    let timer = null;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => load(true), 700); };
    const offs = ['THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE'].map((ev) => on(ev, (d) => { if (d.parentId === channel.id) soon(); }));
    offs.push(on('MESSAGE_CREATE', (d) => { if (store.get().channels[d.channelId]?.parentId === channel.id) soon(); }));
    return () => { clearTimeout(timer); offs.forEach((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, sort, tag, closed, search]);

  // Looking at the forum is what marks it as read (each post has its own mark).
  useEffect(() => { ackChannel(channel.id); }, [channel.id, channel.lastMessageId]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const res = await api.get(`/channels/${channel.id}/posts?${params(data.posts.length)}`);
      setData((d) => ({ ...d, posts: [...d.posts, ...res.posts.filter((p) => !d.posts.some((x) => x.id === p.id))], more: res.more }));
    } catch (e) { toastError(e); } finally { setLoadingMore(false); }
  };

  const filtered = !!(tag || search || closed);
  const posts = data.posts;
  const guidelines = channel.topic?.trim();
  return (
    <div className="forum">
      <div className="forum-top">
        {guidelines && (
          <div className={cx('forum-guidelines', guidelinesOpen && 'open')}>
            <div className="forum-guidelines-text"><Markdown text={guidelines} ctx={{ guildId: channel.guildId }} /></div>
            <button type="button" className="link-btn tiny" onClick={() => setGuidelinesOpen(!guidelinesOpen)}>{guidelinesOpen ? 'Show less' : 'Show more'}</button>
          </div>
        )}
        <div className="forum-toolbar">
          <div className="forum-search"><Icon name="search" size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search post titles" aria-label="Search post titles" maxLength={100}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="x" size={14} /></button>}
          </div>
          <Select className="forum-sort" value={sort} onChange={setSort} options={SORTS} />
          <button type="button" className={cx('forum-toggle', closed && 'active')} aria-pressed={closed} onClick={() => setClosed(!closed)}>Closed posts</button>
          <span className="grow" />
          {canPost
            ? <Button onClick={() => openNewPost(channel.id)}><Icon name="plus" size={16} /> New post</Button>
            : <span className="tiny muted">You can read this forum. Only some roles can start posts.</span>}
        </div>
        {tags.length > 0 && (
          <div className="forum-tags" role="group" aria-label="Filter by tag">
            <TagChip tag={{ name: 'All posts' }} active={!tag} onClick={() => setTag(null)} />
            {tags.map((t) => <TagChip key={t.id} tag={t} active={tag === t.id} onClick={() => setTag(tag === t.id ? null : t.id)} />)}
          </div>
        )}
      </div>
      <div className="forum-list" role="list" aria-label="Posts">
        {!posts && !data.error && <div className="forum-state"><Spinner /></div>}
        {data.error && <div className="forum-state"><p className="muted">Couldn’t load the posts. {data.error}</p><Button variant="secondary" size="sm" onClick={() => load(false)}>Try again</Button></div>}
        {posts && posts.length === 0 && !data.error && (
          <div className="forum-state">
            <Icon name="forum" size={44} />
            {filtered ? (
              <>
                <h3>{closed && !tag && !search ? 'No closed posts' : 'No posts match'}</h3>
                <p className="muted">{closed && !tag && !search ? 'Posts that are closed show up here.' : 'Try another tag or different words.'}</p>
                <Button variant="secondary" size="sm" onClick={() => { setTag(null); setQuery(''); setClosed(false); }}>Clear filters</Button>
              </>
            ) : (
              <>
                <h3>No posts yet</h3>
                <p className="muted">{canPost ? 'Start the first one. Each post gets its own conversation.' : 'Nothing has been posted here yet.'}</p>
                {canPost && <Button onClick={() => openNewPost(channel.id)}>Start a post</Button>}
                {!canPost && canManage && <p className="tiny muted">You can allow members to post in Channel Settings → Permissions → Create Threads.</p>}
              </>
            )}
          </div>
        )}
        {posts?.map((p) => <PostCard key={p.id} post={p} forum={channel} active={p.id === threadId} />)}
        {posts && data.more && <div className="forum-more"><Button variant="secondary" loading={loadingMore} onClick={more}>Show more posts</Button></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- starting a post
function NewPost({ forumId, close }) {
  const forum = useStore((s) => s.channels[forumId]);
  const perms = useStore((s) => channelPermissions(s, forumId));
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState([]);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [errors, setErrors] = useState({});
  const canAttach = has(perms, P.ATTACH_FILES);
  const offered = forum?.availableTags || [];
  const needTag = !!forum?.requireTag && offered.length > 0;
  const textRef = useRef(null);
  if (!forum) return null;

  const addFiles = (list) => {
    if (!canAttach) { toast('You do not have permission to upload files here.', 'error'); return; }
    const arr = [...list];
    const big = arr.filter((f) => f.size > maxUploadMb * 1024 * 1024);
    if (big.length) toast(`${big.map((f) => f.name).join(', ')} ${big.length > 1 ? 'are' : 'is'} too large. The limit is ${maxUploadMb} MB.`, 'error');
    const good = arr.filter((f) => f.size <= maxUploadMb * 1024 * 1024).map((f) => ({ file: f, name: f.name || 'pasted-image.png', size: f.size, type: f.type, description: '', editingAlt: false, preview: /^image\//.test(f.type) ? URL.createObjectURL(f) : null }));
    setFiles((cur) => { if (cur.length + good.length > 10) toast('You can attach at most 10 files.', 'warning'); return [...cur, ...good].slice(0, 10); });
  };
  const patchFile = (i, patch) => setFiles((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const ready = title.trim() && (content.trim() || files.length) && (!needTag || tags.length);

  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const attachmentIds = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setProgress({ i, of: files.length, p: 0 });
        const res = await uploadFile(`/attachments?filename=${encodeURIComponent(f.name)}&spoiler=false${f.description.trim() ? `&description=${encodeURIComponent(f.description.trim().slice(0, 1000))}` : ''}`, f.file, (p) => setProgress({ i, of: files.length, p }));
        attachmentIds.push(res.id);
      }
      setProgress(null);
      const post = await api.post(`/channels/${forumId}/posts`, { title: title.trim(), content, tagIds: tags, attachmentIds });
      store.set({ channels: { ...store.get().channels, [post.id]: (({ firstMessage, ...rest }) => rest)(post) } });
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      close();
      navigate(channelPath(post));
    } catch (e) {
      setProgress(null);
      setErrors({ title: e.errors?.title, content: e.errors?.content, form: e.errors ? null : e.message });
      if (e.errors) toast(Object.values(e.errors)[0], 'error'); else if (!e.errors) toastError(e);
    } finally { setBusy(false); }
  };
  return (
    <Modal title="New post" subtitle={`in #${forum.name}`} onClose={close} size="md" bodyClass="new-post"
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} disabled={!ready} onClick={submit}>Post</Button></>}>
      <Field label="Title" error={errors.title} required>
        <input className="input" autoFocus maxLength={TITLE_MAX} value={title} placeholder="What is this about?" onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); textRef.current?.focus(); } }} />
      </Field>
      {offered.length > 0 && <FieldGroup label="Tags" required={needTag}><TagPicker tags={offered} value={tags} onChange={setTags} required={needTag} /></FieldGroup>}
      <Field label="Message" error={errors.content} required>
        <textarea ref={textRef} className="input new-post-text" rows={7} maxLength={4000} value={content} placeholder="Say more. Markdown works."
          onChange={(e) => setContent(e.target.value)}
          onPaste={(e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.length) { e.preventDefault(); addFiles(fl); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready && !busy) { e.preventDefault(); submit(); } }} />
        <div className="tiny muted right">{content.length}/4000 · Ctrl+Enter to post</div>
      </Field>
      {canAttach && (
        <div className="new-post-files">
          {files.map((f, i) => (
            <div key={i} className="np-file">
              <div className="np-thumb">{f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={28} />}</div>
              <div className="grow np-info">
                <div className="small truncate">{f.name} <span className="tiny muted">{formatBytes(f.size)}</span></div>
                {/^(image|video)\//.test(f.type || '') && (
                  <input className="input np-alt" maxLength={1000} value={f.description} placeholder="Describe this for people who can’t see it (optional)" aria-label={`Description of ${f.name}`}
                    onChange={(e) => patchFile(i, { description: e.target.value })} />
                )}
                {progress?.i === i && <div className="np-progress"><div style={{ width: `${Math.round(progress.p * 100)}%` }} /></div>}
              </div>
              <button type="button" className="icon-btn danger" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></button>
            </div>
          ))}
          <Button variant="secondary" size="sm" disabled={busy || files.length >= 10} onClick={async () => { const l = await pickFile('', true); if (l?.length) addFiles(l); }}><Icon name="upload" size={14} /> Add files</Button>
        </div>
      )}
      {errors.form && <div className="form-error" role="alert">{errors.form}</div>}
    </Modal>
  );
}
export function openNewPost(forumId) { openModal(({ close }) => <NewPost forumId={forumId} close={close} />); }

// (kept for the sidebar/menus to refer to forum posts without importing the whole view)
export const isForumPost = (s, ch) => ch?.type === 11 && s.channels[ch.parentId]?.type === 15;
