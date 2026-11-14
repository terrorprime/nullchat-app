// Image descriptions (alt text): the editor for a message you already sent. (Before sending, it is in the composer's upload tray.)
import { useState } from 'react';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { Modal, Button, openModal } from './ui.jsx';

export const DESCRIPTION_MAX = 1000;
export const isDescribable = (a) => /^(image|video)\//.test(a.contentType || '') && !!a.url;

function Editor({ message, close }) {
  const files = (message.attachments || []).filter(isDescribable);
  const [text, setText] = useState(() => Object.fromEntries(files.map((a) => [a.id, a.description || ''])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      for (const a of files) {
        const next = text[a.id].trim();
        if (next !== (a.description || '')) await api.patch(`/attachments/${a.id}`, { description: next || null });
      }
      toast('Description saved', 'success', 1800);
      close();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Image descriptions" subtitle="Say what is in the picture, for people who can’t see it. Screen readers read this out." onClose={close}
      footer={<><Button variant="link" onClick={close}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="alt-editor">
        {files.map((a) => (
          <div key={a.id} className="alt-editor-item">
            {/^image\//.test(a.contentType) ? <img src={a.url} alt="" /> : <video src={a.url} preload="metadata" muted />}
            <div className="grow">
              <div className="small truncate">{a.filename}</div>
              <textarea className="input" rows={3} maxLength={DESCRIPTION_MAX} value={text[a.id]} placeholder="Describe this for people who can’t see it"
                aria-label={`Description of ${a.filename}`} onChange={(e) => setText({ ...text, [a.id]: e.target.value })} />
              <div className="tiny muted right">{text[a.id].length}/{DESCRIPTION_MAX}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function openAltTextEditor(message) { openModal(({ close }) => <Editor message={message} close={close} />); }
