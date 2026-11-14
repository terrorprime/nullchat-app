import { createRoot } from 'react-dom/client';
import './styles.css';
import './null-ui.css';
import App from './App.jsx';
import { store } from './lib/state.js';
import { applySettings } from './lib/settings.js';
import { unlockAudio } from './lib/sounds.js';
import './lib/notify.js';
import './lib/saved.js';
import './lib/gifFavorites.js';
import './lib/scheduled.js';
import './lib/announcement.js';
import './lib/reports.js';
import './lib/keybinds.js';
import { installComposerFocus } from './lib/composerFocus.js';
import { registerServiceWorker } from './lib/install.js';

registerServiceWorker();

// Apply appearance settings now and whenever they change.
let lastSettings = null;
applySettings({});
store.subscribe(() => {
  const s = store.get().settings;
  if (s !== lastSettings) { lastSettings = s; applySettings(s || {}); }
});

// Browsers only allow audio after a user gesture.
window.addEventListener('pointerdown', unlockAudio, { once: true });

installComposerFocus();
createRoot(document.getElementById('root')).render(<App />);
