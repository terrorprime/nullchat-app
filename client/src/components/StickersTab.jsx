// Server Settings → Stickers: add, rename and remove the stickers members can send as messages.
import { useState } from 'react';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { Icon } from './icons.jsx';
import { Button, Field, Modal, openModal, pickFile, confirmDialog, EmptyState } from './ui.jsx';

const MAX = 50;
const OK_TYPES = ['image/png', 'image/gif', 'image/webp'];
const MAX_KB = 512;

/** "my_cat-dancing.final.png" -> "my cat dancing final" */
const nameFromFile = (f) => f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);

function UploadModal({ guild, file, close }) {
  const [name, setName] = useState(nameFromFile(file));
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview] = useState(() => URL.createObjectURL(file));
  const valid = name.trim().length >= 2;
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/guilds/${guild.id}/stickers?name=${encodeURIComponent(name.trim())}&tag=${encodeURIComponent(tag.trim())}`, file);
      close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title="Upload a sticker" onClose={close} size="sm"
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={save}>Upload</Button></>}>
      <div className="sticker-upload">
        <img className="sticker-upload-preview" src={preview} alt="Preview of the sticker" />
        <Field label="Name" hint="2-30 characters. This is what people search for.">
          <input className="input" autoFocus value={name} maxLength={30} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && save()} />
        </Field>
        <Field label="Related word (optional)" hint="Another word that finds it, like “happy”.">
          <input className="input" value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && save()} />
        </Field>
      </div>
    </Modal>
  );
}

export function StickersTab({ guild }) {
  const stickers = guild.stickers || [];
  const full = stickers.length >= MAX;
  const upload = async () => {
    const f = await pickFile('image/png,image/gif,image/webp');
    if (!f) return;
    if (!OK_TYPES.includes(f.type)) { toastError(new Error('Stickers need a see-through background, so please use a PNG, GIF or WebP picture.')); return; }
    if (f.size > MAX_KB * 1024) { toastError(new Error(`That picture is too big. A sticker can be up to ${MAX_KB} KB.`)); return; }
    openModal(({ close }) => <UploadModal guild={guild} file={f} close={close} />);
  };
  const patch = async (st, body) => {
    try { await api.patch(`/guilds/${guild.id}/stickers/${st.id}`, body); } catch (e) { toastError(e); }
  };
  return (
    <>
      <h2>Stickers</h2>
      <p className="muted">Add up to {MAX} stickers. Members send one by picking it from the Stickers tab next to the emoji button. It goes out as a message of its own, and people in your server can use it in their other servers and direct messages too. Pictures can be PNG, GIF or WebP and up to {MAX_KB} KB.</p>
      <Button disabled={full} onClick={upload}>Upload Sticker</Button>
      <div className="settings-section">
        <h3>Stickers — {stickers.length} / {MAX}</h3>
        {!stickers.length ? <EmptyState icon="sticker">No stickers yet.</EmptyState> : (
          <div className="emoji-table sticker-table">
            {stickers.map((st) => (
              <div key={st.id} className="emoji-row sticker-row">
                <img src={st.url} alt={st.name} />
                <input className="input" defaultValue={st.name} maxLength={30} aria-label={`Name of ${st.name}`}
                  onBlur={(ev) => { const v = ev.target.value.trim(); if (v === st.name) return; if (v.length < 2) { ev.target.value = st.name; return; } patch(st, { name: v }); }}
                  onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()} />
                <input className="input" defaultValue={st.tag || ''} maxLength={40} placeholder="Related word" aria-label={`Related word for ${st.name}`}
                  onBlur={(ev) => { const v = ev.target.value.trim(); if (v !== (st.tag || '')) patch(st, { tag: v }); }}
                  onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()} />
                <button className="icon-btn danger" aria-label={`Delete the sticker ${st.name}`}
                  onClick={async () => {
                    if (await confirmDialog({ title: `Delete “${st.name}”?`, body: 'This sticker will be removed from the server. Messages that already used it will say it was removed.', confirmText: 'Delete', danger: true })) {
                      try { await api.del(`/guilds/${guild.id}/stickers/${st.id}`); } catch (e) { toastError(e); }
                    }
                  }}><Icon name="trash" size={18} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
