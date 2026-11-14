// A picture in chat that is a GIF you could keep: one uploaded to this server, or one from GIPHY. It gets the same star as in the GIF picker.
import { useStore } from '../lib/state.js';
import { openImageViewer } from './ui.jsx';
import { findFavoriteByLink, gifIdentity, toggleChatGif } from '../lib/gifFavorites.js';
import { cx } from '../lib/utils.js';
import { Icon } from './icons.jsx';

export function ChatGif({ embed, canStar }) {
  const src = embed.image?.url || embed.url;
  const items = useStore((s) => s.gifFavorites);
  const starrable = canStar && !!gifIdentity(src);
  const starred = starrable && !!findFavoriteByLink(items, src);
  return (
    <div className="media-wrap" onClick={() => openImageViewer(src)}>
      <img className="attachment-img" src={src} alt={embed.alt || ''} loading="lazy" referrerPolicy="no-referrer" />
      {starrable && (
        <button type="button" className={cx('chat-gif-star', starred && 'on')} aria-pressed={starred} aria-label={starred ? 'Remove this GIF from your favorites' : 'Add this GIF to your favorites'}
          data-tooltip={starred ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => { e.stopPropagation(); toggleChatGif({ link: src, width: embed.image?.width, height: embed.image?.height }); }}>
          <Icon name="star" size={16} style={starred ? { fill: 'currentColor' } : undefined} />
        </button>
      )}
    </div>
  );
}
