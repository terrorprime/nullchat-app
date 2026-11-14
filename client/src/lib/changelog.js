// What's new: the list behind the small "update" window that opens once after NullChat is updated.
//
// TO ANNOUNCE AN UPDATE: add one entry at the TOP of RELEASES, then deploy. That's all.
//   - id    A date like '2026-11-20' (add '-2' for a second release on the same day). Ids sort oldest to newest,
//           and the window only ever opens for an id that is newer than the last one the person has seen.
//   - ts    When the release was written (ms). Accounts created AFTER this never get the window: they joined on this
//           version, so nothing is "new" to them. Use Date.parse('2026-11-20T18:00:00Z').
//   - title Short name for the update, shown under the date.
//   - items 1 to 6 features. Each: { icon, title, text, to? }. `icon` is a name from components/icons.jsx, `title` is
//           what the feature is called, `text` is ONE plain sentence (what it does for the person, not how it's built).
//           `to` (an in-app path such as '/apps') or `settings` (a Settings page, such as 'profile') is optional; either puts a
//           "Try it" button on the row.
// Only list things that are really in this build. Don't edit or remove old entries: people who missed an update see
// everything since the last one they saw.

export const RELEASES = [
  {
    id: '2026-11-14-1',
    ts: Date.parse('2026-11-14T12:00:00Z'),
    title: 'Close friends, warnings and saving on phones',
    items: [
      {
        icon: 'star', title: 'Close friends',
        text: 'Star a friend on the Friends page to keep them at the top, and let only them notify you on Do Not Disturb.',
        settings: 'notifications',
      },
      {
        icon: 'shield', title: 'Warnings',
        text: 'Moderators can right-click a member and warn them with a reason, and a server can time people out after a set number.',
      },
      {
        icon: 'clock', title: 'Timeouts of any length',
        text: 'Choose Custom when timing someone out to type your own length, up to 28 days.',
      },
      {
        icon: 'edit', title: 'Moderator notes',
        text: 'Moderators can keep shared notes on a member that the member never sees.',
      },
      {
        icon: 'download', title: 'Saving on phones',
        text: 'Download now saves pictures, GIFs and files on iPhone and Android.',
      },
    ],
  },
  {
    id: '2026-11-13-4',
    ts: Date.parse('2026-11-13T22:45:00Z'),
    title: 'Clearer, steadier voice',
    items: [
      {
        icon: 'mic', title: 'Fuller voice',
        text: 'High quality now gives your voice a full 64 kbps, and Studio goes up to 128 kbps.',
        settings: 'voice',
      },
      {
        icon: 'shield', title: 'Fewer gaps on a bad connection',
        text: 'Your voice is sent with a spare copy of each moment, so a dropped packet no longer sounds like a gap or a robot.',
      },
      {
        icon: 'volume', title: 'Turn people up to 200%',
        text: 'Right-click someone in a call and User Volume now goes up to 200% for people who are too quiet.',
      },
      {
        icon: 'sliders', title: 'Voice Enhancement',
        text: 'Quiet and loud speech are evened out, low rumble is removed and shouting no longer distorts.',
      },
    ],
  },
  {
    id: '2026-11-13-3',
    ts: Date.parse('2026-11-13T22:00:00Z'),
    title: 'Any microphone, any headphones',
    items: [
      {
        icon: 'mic', title: 'Your devices are found again',
        text: 'A chosen microphone or speaker is remembered by name, so it is still chosen after a restart, on Safari, and when a Bluetooth headset reconnects.',
        settings: 'voice',
      },
      {
        icon: 'headphones', title: 'Plug in and carry on',
        text: 'Headphones or a microphone connected or removed during a call are picked up without rejoining, and a device that is not connected falls back to your default one.',
      },
      {
        icon: 'sliders', title: 'Microphones that would not start',
        text: 'Audio interfaces and other microphones that refused to open now start, because NullChat asks them more simply when the first try fails.',
      },
    ],
  },
  {
    id: '2026-11-13-2',
    ts: Date.parse('2026-11-13T15:30:00Z'),
    title: 'The whole call, in its own window',
    items: [
      {
        icon: 'chat', title: 'Chat inside the call window',
        text: 'The chat button in a popped-out call opens the call’s text chat right there, where you can read, type and attach files.',
      },
      {
        icon: 'screen', title: 'Share your screen from the call window',
        text: 'In the desktop app, Share your screen in the call window now shows the screens and windows to pick from right there.',
      },
      {
        icon: 'pip', title: 'Popping out moves the call',
        text: 'While a call is in its own window, the app shows a note in its place instead of a second copy of the call.',
      },
      {
        icon: 'speaker', title: 'A cleaner voice channel',
        text: 'Voice channels in the app now use the same tiles and button bar as the call window, with the chat closed until you open it.',
      },
    ],
  },
  {
    id: '2026-11-13-1',
    ts: Date.parse('2026-11-13T00:00:00Z'),
    title: 'The call window, rebuilt',
    items: [
      {
        icon: 'pip', title: 'Click a tile to make it big',
        text: 'In a popped-out call, cameras and shared screens are tiles like everyone else, and clicking a tile makes it the big one.',
      },
      {
        icon: 'sliders', title: 'Pick your microphone, speakers and camera from the call',
        text: 'The small arrows next to the microphone and camera buttons in the call window list your devices.',
        settings: 'voice',
      },
      {
        icon: 'user', title: 'Invite from an empty call',
        text: 'Alone in a voice channel, the call window offers an Invite to Voice button that makes an invite link and copies it.',
      },
    ],
  },
  {
    id: '2026-11-12-6',
    ts: Date.parse('2026-11-12T22:30:00Z'),
    title: 'Full screen calls',
    items: [
      {
        icon: 'fullscreen', title: 'Make a call full screen',
        text: 'The new button at the right end of a call’s buttons fills the screen with the call, and Esc brings you back.',
      },
      {
        icon: 'pip', title: 'A proper window for popped-out calls',
        text: 'A popped-out call is laid out as tiles with camera and share-screen buttons, and its corner button opens it as a full window.',
      },
    ],
  },
  {
    id: '2026-11-12-5',
    ts: Date.parse('2026-11-12T15:30:00Z'),
    title: 'Profile songs and bigger files',
    items: [
      {
        icon: 'music', title: 'A song on your profile',
        text: 'Pick up to 15 seconds of any audio file and it plays quietly for people who open your profile, unless they switched profile songs off with the speaker button.',
        settings: 'profile',
      },
      {
        icon: 'link', title: 'Files up to 150 MB',
        text: 'The limit for a single file went from 100 MB to 150 MB.',
      },
    ],
  },
  {
    id: '2026-11-12-4',
    ts: Date.parse('2026-11-12T12:30:00Z'),
    title: 'A cleaner message layout',
    items: [
      {
        icon: 'eye', title: 'Easier to read',
        text: 'Messages are a touch larger with tighter lines, and the time after a name is short: today just shows the time, like 5:27 AM.',
        settings: 'appearance',
      },
    ],
  },
  {
    id: '2026-11-12-3',
    ts: Date.parse('2026-11-12T11:00:00Z'),
    title: 'Picture-in-picture for calls',
    items: [
      {
        icon: 'pip', title: 'Pop out the call',
        text: 'A button next to mute puts your call in a small window that stays on top while you use other tabs and apps, with mute, deafen and hang up in it.',
      },
      {
        icon: 'screen', title: 'Keep watching a screen share',
        text: 'The small window shows whoever is sharing their screen or camera, and lights up people as they speak.',
        settings: 'voice',
      },
    ],
  },
  {
    id: '2026-11-12-2',
    ts: Date.parse('2026-11-12T09:20:00Z'),
    title: 'Your own join and leave sounds',
    items: [
      {
        icon: 'volume', title: 'Join and leave sounds',
        text: 'Pick your own short sound that plays for everyone when you come into a voice channel, and another for when you leave.',
        settings: 'voice',
      },
      {
        icon: 'eye', title: 'Not a fan? Switch them off',
        text: 'One switch gives everyone the standard sound on your device, and a server can do the same for its voice channels.',
        settings: 'voice',
      },
    ],
  },
  {
    id: '2026-11-12',
    ts: Date.parse('2026-11-12T07:16:00Z'),
    title: 'Music together, streaks and birthdays',
    items: [
      {
        icon: 'music', title: 'Music in voice channels',
        text: 'Paste a YouTube or audio link with the new music button next to the microphone, and everyone in the voice channel hears the same track at the same moment.',
      },
      {
        icon: 'flame', title: 'Streaks',
        text: 'A flame with a number shows how many days in a row you and a friend have written to each other, or a server has been active.',
        settings: 'chat',
      },
      {
        icon: 'cake', title: 'Birthdays',
        text: 'Save the day and month of your birthday, and servers that picked a birthday channel post a message for you on the day.',
        settings: 'account',
      },
    ],
  },
  {
    id: '2026-11-11',
    ts: Date.parse('2026-11-12T03:30:00Z'),
    title: 'Quiet replies, catching up and room sounds',
    items: [
      {
        icon: 'eyeOff', title: 'Quiet replies',
        text: 'Reply in a channel so that only the people you pick can see it: right-click a message and choose Reply Quietly, or turn on Quiet while replying.',
      },
      {
        icon: 'inbox', title: 'While you were gone',
        text: 'Come back to a busy server and a small card shows the busiest conversations, where you were mentioned and what was pinned.',
        settings: 'chat',
      },
      {
        icon: 'volume', title: 'Room sounds',
        text: 'A voice channel can have a quiet shared background such as rain or a fireplace. Use the new button next to the microphone while you are in one.',
      },
    ],
  },
  {
    id: '2026-11-09-5',
    ts: Date.parse('2026-11-10T06:00:00Z'),
    title: 'Stickers and switching accounts',
    items: [
      {
        icon: 'sticker', title: 'Stickers',
        text: 'Servers can add their own stickers. Send one from the new Stickers tab next to the emoji button.',
      },
      {
        icon: 'user', title: 'Switch accounts',
        text: 'Click your name at the bottom left, then Switch Account, to jump between accounts on this device without typing a password.',
      },
      {
        icon: 'eye', title: 'Mark Unread keeps its place',
        text: 'Right-click a message and choose Mark Unread: the channel stays unread, with a new-messages line at that message, until you read it.',
      },
    ],
  },
  {
    id: '2026-11-09-4',
    ts: Date.parse('2026-11-10T03:10:00Z'),
    title: 'Escape takes you to the present',
    items: [
      {
        icon: 'chevronDown', title: 'Back to the newest message with Esc',
        text: 'Scrolled up in a chat? Press Esc to jump straight to the newest messages. It still marks the channel as read.',
      },
    ],
  },
  {
    id: '2026-11-09-3',
    ts: Date.parse('2026-11-10T00:30:00Z'),
    title: 'Profile effects',
    items: [
      {
        icon: 'star', title: 'Animated profile effects',
        text: 'Twelve effects for your profile card: falling petals, snow, sparkles, hearts, fireflies, embers, a storm and more.',
        settings: 'profile',
      },
      {
        icon: 'eye', title: 'Not a fan? Switch them off',
        text: 'Accessibility → Profile effects hides them just for you. Reduced motion and High contrast turn them off too.',
      },
    ],
  },
  {
    id: '2026-11-09-2',
    ts: Date.parse('2026-11-09T23:30:00Z'),
    title: 'Fonts and effects for your name',
    items: [
      {
        icon: 'edit', title: 'Eleven new name fonts',
        text: 'Tempo, Sakura, Jellybean, Modern, Medieval, 8Bit, Vampyre, Monkey Bars, Mainframe, Headbang and Journal.',
        settings: 'profile',
      },
      {
        icon: 'star', title: 'New name effects',
        text: 'Toon, Pop, Gummy and Prism join Neon and gradients. Prism blends five colours that move along your name.',
      },
      {
        icon: 'eye', title: 'Not a fan? Switch them off',
        text: 'Accessibility → Display name styles shows everyone’s name plainly, just for you.',
      },
    ],
  },
  {
    id: '2026-11-09',
    ts: Date.parse('2026-11-09T21:00:00Z'),
    title: 'Apps for every server',
    items: [
      {
        icon: 'bot', title: 'Add an app to any server',
        text: 'One app can now live in many servers. Browse them in Discover → Apps and add one to a server you manage.',
        to: '/apps',
      },
      {
        icon: 'at', title: 'Pick people, roles and channels in app menus',
        text: 'Apps can now ask you to choose a member, a role or a channel from a list, instead of typing a name.',
      },
      {
        icon: 'sliders', title: 'More control in the Developer Portal',
        text: 'Choose who can add your app, and remove it from a single server without deleting it everywhere.',
      },
      {
        icon: 'link', title: 'Invite cards and link previews',
        text: 'A NullChat invite link now shows the server, how many people are online and a Join button right in the chat.',
      },
      {
        icon: 'pin', title: 'Pin posts in forums',
        text: 'Moderators can right-click a forum post and choose Pin Post to keep it at the top.',
      },
    ],
  },
];

/** The id of the newest release, or null. */
export function latestReleaseId(releases = RELEASES) { return releases[0]?.id ?? null; }

/**
 * Decide what to do on startup. Pure, so it can be tested without a browser.
 *   me         the signed-in user ({ onboarded, createdAt })
 *   seen       the last release id this person has seen (synced setting, else this device's copy), or null
 * Returns { show: [releases to display, newest first], mark: id|null }.
 *   - `show` is empty when there is nothing to announce.
 *   - `mark` is set when the person should be recorded as up to date without being shown anything (a brand-new account).
 */
export function pendingReleases({ releases = RELEASES, me, seen }) {
  const latest = releases[0];
  if (!latest || !me?.onboarded) return { show: [], mark: null }; // first-run onboarding comes first
  if (seen && seen >= latest.id) return { show: [], mark: null };
  // Everything since the last one they saw, newest first and at most three; someone who has never seen one gets the latest three.
  const candidates = (seen ? releases.filter((r) => r.id > seen) : releases).slice(0, 3);
  // A release written before this account existed isn't news to it; if that leaves nothing, just record them as up to date.
  const show = me.createdAt ? candidates.filter((r) => r.ts > me.createdAt) : candidates;
  if (!show.length) return { show: [], mark: latest.id };
  return { show, mark: null };
}

/** The releases to list when someone opens "What's new" by hand: the newest few. */
export function recentReleases(releases = RELEASES, n = 3) { return releases.slice(0, n); }
