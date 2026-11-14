// Server folders: the folder button in the server bar, the window to name and colour one, and its menu. The layout rules are in lib/folders.js.
import { useStore, store, guildHasUnread, guildMentionCount } from '../lib/state.js';
import { cx, plural } from '../lib/utils.js';
import { toast } from '../lib/toast.js';
import { FOLDER_COLORS, FOLDER_NAME_MAX, FOLDERS_MAX } from '../../../shared/community.js';
import { changeLayout, editFolder, makeFolder, ungroup, addToFolder, removeFromFolder, canMakeFolder, currentItems, sortGuildIds } from '../lib/folders.js';
import { Button, Field, GuildIcon, Modal, openModal } from './ui.jsx';
import { Icon } from './icons.jsx';
import { useState } from 'react';

/** Name, colour and choose the servers of a folder. With `guildIds` it makes a new folder (starting with those servers); with `folderId` it changes one. */
export function openFolderModal({ folderId = null, guildIds = [] }) {
  if (!folderId && !canMakeFolder(currentItems())) { toast(`You can have up to ${FOLDERS_MAX} folders.`, 'error', 3000); return; }
  openModal(({ close }) => <FolderModal folderId={folderId} guildIds={guildIds} close={close} />);
}

function FolderModal({ folderId, guildIds, close }) {
  const existing = useStore((s) => (folderId ? currentItems(s).find((i) => i.kind === 'folder' && i.id === folderId) : null));
  const all = useStore((s) => sortGuildIds(s.guilds, s.settings?.guildOrder || []).map((id) => s.guilds[id]));
  const [name, setName] = useState(existing?.name || '');
  const [color, setColor] = useState(existing?.color || FOLDER_COLORS[0]);
  const [picked, setPicked] = useState(() => new Set(existing ? existing.guildIds : guildIds));
  if (folderId && !existing) return null;
  const toggle = (id) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const enough = picked.size >= 2;
  const save = () => {
    if (!enough) return;
    const patch = { name: name.trim().slice(0, FOLDER_NAME_MAX), color };
    changeLayout((items) => {
      if (!folderId) return makeFolder(items, [...picked], patch);
      let next = items;
      for (const id of existing.guildIds) if (!picked.has(id)) next = removeFromFolder(next, id);
      for (const id of picked) if (!existing.guildIds.includes(id)) next = addToFolder(next, folderId, id);
      return editFolder(next, folderId, patch);
    });
    close();
  };
  return (
    <Modal title={folderId ? 'Folder settings' : 'New folder'} subtitle="Pick the servers that go in it. You can also drag one server onto another in the server bar." onClose={close} size="sm"
      footer={(
        <>
          {folderId && <Button variant="link" onClick={() => { changeLayout((items) => ungroup(items, folderId)); close(); }}>Ungroup</Button>}
          <span className="grow" />
          <Button variant="link" onClick={close}>Cancel</Button>
          <Button disabled={!enough} onClick={save}>{folderId ? 'Save' : 'Create folder'}</Button>
        </>
      )}>
      <Field label="Folder name (optional)"><input className="input" autoFocus maxLength={FOLDER_NAME_MAX} placeholder="Friends, Work, Games…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
      <div className="field">
        <span className="field-label">Colour</span>
        <div className="tag-colors" role="radiogroup" aria-label="Folder colour">
          {FOLDER_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} className={cx('tag-color', color === c && 'on')} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Servers {picked.size ? `(${picked.size})` : ''}</span>
        <div className="select-list folder-pick">
          {all.map((g) => (
            <label key={g.id} className={cx('select-item', picked.has(g.id) && 'selected')}>
              <GuildIcon guild={g} size={28} /><span className="grow truncate">{g.name}</span>
              <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g.id)} />
            </label>
          ))}
        </div>
        {!enough && <span className="field-hint">A folder needs at least two servers.</span>}
      </div>
    </Modal>
  );
}

/** The "Add to Folder" part of a server's menu: its folder (to leave it), the other folders, and a new one. */
export function serverFolderItems(guildId) {
  const items = currentItems();
  const folders = items.filter((i) => i.kind === 'folder');
  const mine = folders.find((f) => f.guildIds.includes(guildId));
  const guilds = store.get().guilds;
  const label = (f) => f.name || f.guildIds.map((id) => guilds[id]?.name).filter(Boolean).slice(0, 2).join(', ') + (f.guildIds.length > 2 ? '…' : '');
  return [
    { label: 'Add to Folder', icon: 'folder', items: [
      ...folders.filter((f) => f !== mine).map((f) => ({ label: label(f), onClick: () => changeLayout((cur) => addToFolder(cur, f.id, guildId)) })),
      { label: 'New Folder…', onClick: () => openFolderModal({ guildIds: [guildId] }) },
    ] },
    mine && { label: 'Remove from Folder', icon: 'userMinus', onClick: () => changeLayout((cur) => removeFromFolder(cur, guildId)) },
  ].filter(Boolean);
}

export function folderMenuItems(folderId) {
  return [
    { label: 'Folder Settings', icon: 'settings', onClick: () => openFolderModal({ folderId }) },
    { label: 'Ungroup Servers', icon: 'userMinus', danger: true, onClick: () => changeLayout((items) => ungroup(items, folderId)) },
  ];
}

/** What a closed folder shows: up to four of its servers' icons, or an open-folder symbol while it is open. */
export function FolderIcon({ folder, guilds, open }) {
  return (
    <div className={cx('guild-icon folder-icon', open && 'open')} style={{ '--fc': folder.color }}>
      {open ? <Icon name="folderOpen" size={24} /> : <div className="folder-mini">{guilds.slice(0, 4).map((g) => <GuildIcon key={g.id} guild={g} size={18} />)}</div>}
    </div>
  );
}

/** Unread / mention totals for a folder's servers, for the badge on its button. */
export function useFolderCounts(guildIds) {
  return useStore((s) => ({
    unread: guildIds.some((id) => guildHasUnread(s, id)),
    mentions: guildIds.reduce((n, id) => n + (s.guildSettings[id]?.muted ? 0 : guildMentionCount(s, id)), 0),
  }));
}
