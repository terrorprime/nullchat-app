// A small NullChat bot you can copy. It needs nothing installed: Node.js 22 already has `fetch` and `WebSocket`.
//
//   1. In NullChat: Server Settings → Integrations → Bots → Add Bot. Copy the token (it is shown only once).
//   2. Run it:
//        NULLCHAT_URL=https://nullchat.fly.dev NULLCHAT_BOT_TOKEN=nb_xxxxxxxx node bot.mjs
//      (on Windows PowerShell:  $env:NULLCHAT_URL="https://nullchat.fly.dev"; $env:NULLCHAT_BOT_TOKEN="nb_xxxxxxxx"; node bot.mjs)
//   3. In any channel the bot can see, type  /  and pick one of its commands. The bot has to be running to answer.
//
// What it shows:
//   • registering slash commands (with options, choices, and a required option)
//   • answering a command: a plain message, a rich card, a private ("only you can see this") reply, and a slow one ("thinking…")
//   • reading ordinary messages over the live connection ("!ping")
//   • staying connected: heartbeat and automatic reconnect

const BASE = (process.env.NULLCHAT_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = (process.env.NULLCHAT_BOT_TOKEN || '').replace(/^Bot\s+/i, '');
if (!TOKEN) {
  console.error('Set NULLCHAT_BOT_TOKEN to the token you got when you added the bot (Server Settings → Integrations).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ REST helper
// Bots call the normal API with  Authorization: Bot <token>.
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.message || data?.error || ''}`);
  return data;
}

// Answering a slash command uses the interaction's own id and token in the URL (no Authorization header needed).
async function interactionCall(it, method, tail, body) {
  const res = await fetch(`${BASE}/api/interactions/${it.id}/${it.token}/${tail}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) console.warn(`interaction ${tail} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ------------------------------------------------------------------ the commands
const COMMANDS = [
  { name: 'ping', description: 'Check that the bot is alive' },
  { name: 'echo', description: 'Repeat what you type', options: [{ name: 'text', description: 'What to repeat', required: true }] },
  { name: 'roll', description: 'Roll a die', options: [{ name: 'sides', description: 'How many sides (default 6)', type: 'integer' }] },
  {
    name: 'mood', description: 'Pick a mood',
    options: [{ name: 'mood', description: 'How are you?', required: true, choices: [{ name: 'Happy', value: 'happy' }, { name: 'Sleepy', value: 'sleepy' }, { name: 'Hungry', value: 'hungry' }] }],
  },
  { name: 'about', description: 'Show a card about this bot' },
  { name: 'secret', description: 'A reply only you can see' },
  { name: 'slow', description: 'Takes a few seconds (shows “thinking…”)' },
  { name: 'counter', description: 'A counter with buttons (and a feedback form)' },
  { name: 'pick', description: 'Choose from a menu' },
];

// ------------------------------------------------------------------ buttons, menus and forms
// A message can carry rows of components. A row holds up to 5 buttons, or one menu. Each button or menu has a custom_id that comes back
// to the bot when someone uses it. (Link buttons, style 5, just open a page and send nothing.)
const row = (...components) => ({ type: 1, components });
const counterMessage = (n) => ({
  content: `Count: **${n}**`,
  components: [row(
    { type: 2, style: 1, label: '+1', custom_id: 'inc' },
    { type: 2, style: 2, label: 'Reset', custom_id: 'reset', disabled: n === 0 },
    { type: 2, style: 3, label: 'Send feedback', custom_id: 'feedback' },
    { type: 2, style: 5, label: 'About this example', url: 'https://example.com' },
  )],
});
const pickMessage = (chosen) => ({
  content: chosen ? `You picked **${chosen}**.` : 'Which colour?',
  components: [row({
    type: 3, custom_id: 'colour', placeholder: 'Choose a colour', min_values: 1, max_values: 1,
    options: [{ label: 'Red', value: 'red', emoji: { name: '🔴' } }, { label: 'Green', value: 'green', emoji: { name: '🟢' } }, { label: 'Blue', value: 'blue', description: 'The calm one', emoji: { name: '🔵' } }],
  })],
});
const feedbackForm = {
  custom_id: 'feedback_form', title: 'Send feedback',
  components: [
    row({ type: 4, custom_id: 'subject', label: 'Subject', style: 1, max_length: 60, placeholder: 'A few words' }),
    row({ type: 4, custom_id: 'details', label: 'Details', style: 2, required: false }),
  ],
};

const handlers = {
  async ping(it) {
    await interactionCall(it, 'POST', 'callback', { content: 'Pong! 🏓' });
  },
  async echo(it) {
    // Message text can use the usual formatting. Don't echo @everyone back: the server would (rightly) refuse to ping for a bot without permission.
    await interactionCall(it, 'POST', 'callback', { content: String(it.options.text).slice(0, 1900) });
  },
  async roll(it) {
    const sides = Math.max(2, Math.min(1000, Number(it.options.sides) || 6));
    const n = 1 + Math.floor(Math.random() * sides);
    await interactionCall(it, 'POST', 'callback', {
      embeds: [{
        title: `🎲 d${sides}`, description: `**${it.user.displayName || it.user.username}** rolled a **${n}**`, color: '#c2ff3d',
        fields: [{ name: 'Result', value: String(n), inline: true }, { name: 'Out of', value: String(sides), inline: true }],
      }],
    });
  },
  async mood(it) {
    const lines = { happy: 'Glad to hear it!', sleepy: 'Go get some rest.', hungry: 'Snack time.' };
    await interactionCall(it, 'POST', 'callback', { content: `${lines[it.options.mood] || 'Okay.'}` });
  },
  async about(it) {
    await interactionCall(it, 'POST', 'callback', {
      embeds: [{
        author: { name: 'Example bot' },
        title: 'Hello from a NullChat bot',
        description: 'This card was posted with the **embeds** field. It can have a title, text, a colored bar, fields, a thumbnail, an image and a footer.',
        color: '#5865f2',
        fields: [
          { name: 'Runs on', value: `Node ${process.version}`, inline: true },
          { name: 'Server', value: BASE.replace(/^https?:\/\//, ''), inline: true },
          { name: 'Commands', value: COMMANDS.map((c) => `\`/${c.name}\``).join(' ') },
        ],
        footer: { text: 'bots/example-bot' },
        timestamp: Date.now(),
      }],
    });
  },
  async secret(it) {
    await interactionCall(it, 'POST', 'callback', { content: `Only **${it.user.displayName || it.user.username}** can see this.`, ephemeral: true });
  },
  async slow(it) {
    // 1) acknowledge within 5 seconds so people see “thinking…”, 2) take your time (up to 15 minutes), 3) fill in the answer.
    await interactionCall(it, 'POST', 'callback', { type: 'defer' });
    await sleep(3000);
    await interactionCall(it, 'PATCH', 'original', { content: 'Done thinking. (That took three seconds.)' });
  },
};

Object.assign(handlers, {
  async counter(it) { await interactionCall(it, 'POST', 'callback', counterMessage(0)); },
  async pick(it) { await interactionCall(it, 'POST', 'callback', pickMessage(null)); },
});

// A press, a menu choice or a sent form. The answer is one of:
//   { type: 'update', … }   change the message the button is on       { type: 'defer_update' }   do nothing visible
//   { type: 'message', … }  a new message                             { type: 'modal', modal }   open a form for the person
async function onComponent(it) {
  const count = Number(/Count: \*\*(\d+)\*\*/.exec(it.message?.content || '')?.[1] || 0);   // (keep state in the message itself, so the bot can restart)
  if (it.type === 'component') {
    if (it.customId === 'inc') return interactionCall(it, 'POST', 'callback', { type: 'update', ...counterMessage(count + 1) });
    if (it.customId === 'reset') return interactionCall(it, 'POST', 'callback', { type: 'update', ...counterMessage(0) });
    if (it.customId === 'feedback') return interactionCall(it, 'POST', 'callback', { type: 'modal', modal: feedbackForm });
    if (it.customId === 'colour') return interactionCall(it, 'POST', 'callback', { type: 'update', ...pickMessage(it.values[0]) });
  }
  if (it.type === 'modal' && it.customId === 'feedback_form') {
    const who = it.user.displayName || it.user.username;
    return interactionCall(it, 'POST', 'callback', { content: `Thanks, **${who}**. Noted: “${it.values.subject}”` });
  }
}

async function onInteraction(it) {
  if (it.type !== 'command') { try { await onComponent(it); } catch (e) { console.error(e); } return; }
  const run = handlers[it.commandName];
  console.log(`/${it.commandName} from ${it.user.username} in ${it.channelId}`, it.options);
  if (!run) return;
  try { await run(it); } catch (e) { console.error(e); }
}

// Plain messages arrive over the same connection. Bots can use any prefix they like.
async function onMessage(m) {
  if (m.author?.bot) return;                    // never answer bots (including yourself)
  if (m.content?.trim().toLowerCase() === '!ping') {
    await api('POST', `/api/channels/${m.channelId}/messages`, { content: 'pong', replyTo: m.id }).catch((e) => console.warn(e.message));
  }
}

// ------------------------------------------------------------------ the live connection
let attempt = 0;
function connect() {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/gateway');
  let heartbeat = null;
  ws.onopen = () => ws.send(JSON.stringify({ op: 'identify', d: { token: TOKEN } }));
  ws.onmessage = (ev) => {
    const { t, d } = JSON.parse(ev.data);
    if (t === 'READY') {
      attempt = 0;
      console.log(`Connected as ${d.user.displayName || d.user.username} to ${d.guilds.map((g) => g.name).join(', ') || 'no servers'}`);
      heartbeat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: 'heartbeat' })), 25_000);
      // (Re)register the commands each time we start. Same name = same command, so nothing is lost.
      api('PUT', '/api/bot/commands', COMMANDS).then((list) => console.log(`${list.length} slash commands registered`)).catch((e) => console.error(e.message));
    } else if (t === 'INTERACTION_CREATE') onInteraction(d);
    else if (t === 'MESSAGE_CREATE') onMessage(d);
    else if (t === 'INVALID_SESSION') { console.error('The token was rejected. Was it reset or the bot removed?'); process.exit(1); }
  };
  ws.onclose = async () => {
    clearInterval(heartbeat);
    const wait = Math.min(30_000, 1000 * 2 ** attempt++);
    console.log(`Disconnected. Reconnecting in ${Math.round(wait / 1000)}s…`);
    await sleep(wait);
    connect();
  };
  ws.onerror = () => { /* onclose follows */ };
}
connect();
