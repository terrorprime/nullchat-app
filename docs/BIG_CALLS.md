# Big calls (a LiveKit server for voice channels)

By default NullChat calls go **straight from each person's computer to each other person's** (peer-to-peer). That is free, private and needs nothing from you, and it works well for a handful of people. The catch is that everyone sends their own camera and screen to everyone else, so it gets heavy past about **8 people**, and one person sharing a screen to 20 viewers asks their home internet to upload 20 copies.

A **LiveKit server** fixes that. Everyone sends one copy to the server, and the server hands each viewer what they need. You don't have to write any code. You give NullChat three settings and every voice channel in your servers uses it.

You only need this if people in your servers actually have big calls. If you don't, leave it off: nothing changes.

---

## What changes when it is on

| | |
|---|---|
| **Server voice channels** | Use the LiveKit server. Big calls, and many people watching one screen share, work. |
| **Direct messages and group DMs** | Stay peer-to-peer (they are small, and this keeps them private). |
| **Stage channels** | Stay peer-to-peer, exactly as before. |
| **Everything the app does in a call** | Mute, deafen, push-to-talk, the voice gate, per-person volume, camera and screen quality, moderator mute/move/disconnect, the call-quality tooltip: all work the same. Camera and screen quality are not divided between viewers any more: you send one picture at the quality you picked. |
| **Permissions** | The server decides what each person may send, from their role and channel permissions: no *Speak* permission means no microphone, no *Stream* permission means no camera or screen. Someone who may not send still joins and listens. |
| **If it is switched off again** | Everything goes back to peer-to-peer on its own. |

The Admin Panel (Overview) says which mode you are in: *"Voice channels use your LiveKit server…"* or *"Voice channels connect people directly…"*.

---

## Turn it on (about ten minutes)

You need a LiveKit server. The easy way is **LiveKit Cloud**, which is hosted for you.

1. Go to [livekit.io](https://livekit.io) and make an account, then create a **project**.
2. In the project's settings, find its **WebSocket URL**. It starts with `wss://` and ends with `.livekit.cloud`.
3. Still in the project's settings, create an **API key**. You get a **key** and a **secret**. Copy both straight away, because the dashboard may not show the secret again. Treat the secret like a password.
4. Put the three values into NullChat. On Fly.io, run this in a terminal in your project folder (use your own values):

   ```
   fly secrets set LIVEKIT_URL=wss://your-project.livekit.cloud LIVEKIT_API_KEY=APIxxxxxxxx LIVEKIT_API_SECRET=your-long-secret
   ```

   Fly restarts the app by itself. If you run NullChat some other way, put the same three lines in `.env` and restart.
5. Open the Admin Panel (Settings → Admin Panel → Overview). It should now say your voice channels use LiveKit.
6. Join a voice channel with a friend and try a camera and a screen share.

Everyone who already had NullChat open needs to **reload the page (Ctrl+R)** once. If they try to join a big call with an old page, NullChat tells them to reload instead of failing in a confusing way.

### The three settings

| Setting | What it is |
|---|---|
| `LIVEKIT_URL` | Your LiveKit server's address. Starts with `wss://` (or `ws://` for a test server on your own computer). |
| `LIVEKIT_API_KEY` | The API key's name. |
| `LIVEKIT_API_SECRET` | The API key's secret. Never share it and never put it in a screenshot. |

If only some of the three are set, or the address is not `ws://`/`wss://`, NullChat prints a clear warning when it starts and carries on with normal peer-to-peer calls. It does not stop working.

---

## What LiveKit Cloud costs

LiveKit Cloud has a free plan. When this was written (check [LiveKit's limits page](https://docs.livekit.io/cloud/quotas-and-limits) and [pricing](https://livekit.io/pricing) for today's numbers, they change) the free plan included **100 people connected at once, 5,000 call-minutes a month (one person in a call for one minute is one minute) and 50 GB of video and audio sent out**, and it simply stops accepting new calls when the month's allowance is used instead of charging you. 5,000 minutes is, for example, six friends in a call for about 14 hours a month. Heavy use (a big server with calls all day) needs a paid plan or your own server.

Because the free plan stops rather than bills, you can try this with no card on file. If it does run out, joining a voice channel shows "Could not connect to this server’s voice system" until the month resets; removing the three settings puts you back on peer-to-peer straight away (`fly secrets unset LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET`).

## Running your own LiveKit server

LiveKit is open source, so you can run it yourself instead of paying LiveKit: see [LiveKit's self-hosting guide](https://docs.livekit.io/home/self-hosting/). It needs its own machine (a small VPS is fine) with a public address, a TLS certificate and a range of UDP ports open. **NullChat does not ship a ready-made setup for this**, because it can't be tested from here and a half-working media server is worse than none. Once yours is running, the three settings above are the same.

---

## What was tested, and what was not

Tested (automatically, every time the project is checked):
- NullChat's side of the connection against a stand-in for LiveKit's server: the join token is a valid signed LiveKit token with the right room, a two-minute life, and permissions that match the person's role (including no microphone without *Speak* and no camera or screen without *Stream*); a person who left, was moved, was disconnected by a moderator, lost access, was kicked, or lost their connection is removed from the room; a LiveKit server that is down or slow never stops anyone leaving or moving between calls and never fills the log; DMs and stages do not use it; a server without the three settings behaves exactly as before.
- NullChat's page in a real browser with a stand-in for LiveKit's browser library: joining, hearing other people, their camera and screen (and the screen's sound), your own microphone/camera/screen being handed over with the right quality and without being stopped, deafen, the connection tooltip, and every way a call can end or fail (lost connection, replaced by another tab, removed by the server, voice server unreachable, NullChat's own connection dropping and coming back).

**Not tested: real sound and pictures through a real LiveKit server.** The machine this was built on can neither download LiveKit's browser library nor reach a LiveKit server. The way NullChat uses the library was checked against the library's own published source, but it has not been run. Your Fly.io build downloads `livekit-client` (one new dependency) the first time you deploy this version. **Try it with one other person before a call night**, and tell me what breaks.

## Honest limits

- Viewer-side adaptation is simple: LiveKit still lowers quality for a viewer on a slow connection, but NullChat does not yet shrink the picture it asks for based on how large a tile is drawn.
- A moderator's *server mute* is still enforced by the page, as it always was. *Disconnect*, *move* and losing access are enforced by the server (the person is removed from the room).
- A person who is removed from a channel is dropped from the LiveKit room straight away, but the join token they were given stays valid for up to two minutes, so someone determined could slip back into the room in that window. After that they can't.
- Stage and DM calls are still peer-to-peer, so a very large stage still depends on each speaker's connection.
