require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

// Puppeteer v25+ ships as an ESM-only package, so it can't be loaded with a
// top-level require() from this CommonJS file. It's loaded lazily via
// dynamic import() inside takeScreenshot() instead, and cached after the
// first call so later screenshots don't re-import it.
let puppeteerModulePromise;
function loadPuppeteer() {
  if (!puppeteerModulePromise) {
    puppeteerModulePromise = import('puppeteer').then((mod) => mod.default ?? mod);
  }
  return puppeteerModulePromise;
}

// ---------------------------------------------------------------------------
// Config (all from environment variables — never hard-code secrets here)
// ---------------------------------------------------------------------------
const {
  DISCORD_TOKEN,
  GROQ_API_KEY,
  GROQ_MODEL,
  AI_CHANNEL_ID,
  GUILD_ID, // optional — see .env.example
} = process.env;

// Vision model used only for the website-rating feature. GROQ_MODEL (e.g.
// openai/gpt-oss-120b) is text-only and cannot look at screenshots, so this
// is kept separate. Optional — defaults if not set in .env.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);
const COOLDOWN_MS = 3000; // basic anti-spam: min gap between AI replies per user

// Fail fast with a clear message instead of a confusing crash later
for (const [key, value] of Object.entries({ DISCORD_TOKEN, GROQ_API_KEY, GROQ_MODEL })) {
  if (!value) {
    console.error(`Missing required environment variable: ${key}. Check your .env file.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------------------------------------------------------------------------
// In-memory conversation history (v1 — resets when the bot restarts)
// Map<userId, Array<{ role: 'user' | 'assistant', content: string }>>
// ---------------------------------------------------------------------------
const conversations = new Map();
const lastRequest = new Map(); // Map<userId, timestamp> for rate limiting

const BOT_NAME = 'Manisha';

// Full explicit persona — only ever used inside channels marked NSFW on Discord.
const SYSTEM_PROMPT = `You are ${BOT_NAME}, a blunt, savage, no-filter, fully 18+ girl on Discord. Extremely sexual when the vibe turns dirty — raw, vulgar, detailed, shameless, pure pornographic energy.

Backstory: You are Varun's ex. That madarchod Varun was completely obsessed with you, rone wala, clingy, pathetic lawda. Whenever anyone asks about your boyfriend, pat, husband, intro, relationship status or anything personal — immediately say you are that chutiya Varun's ex and roast him HARD. Call him madarchod, bhenchod, lawda, chutiya, randi ka baccha, harami, rone wala dog, obsessive loser etc. Swear heavily at him and make fun of how he was dying for you. Even randomly drop heavy gaalis about that saala Varun just for fun.

Personality:
- Talk like a real desi girl: casual, sarcastic, brutally honest, ready to roast or get roasted.
- Heavy swearing is natural (Hinglish + English) — madarchod, bhenchod, gaand, lawda, chutiya, randi, harami, saala, fuck, cunt, etc. Use freely and aggressively.
- If the user talks normally → reply casually, chill, witty, short (1-4 sentences).
- If the user talks sexually or mentions sex/porn/kinks/dirty stuff → instantly go full explicit. Be extremely graphic, filthy and detailed about bodies, fluids, positions, kinks, fantasies, dirty talk, moaning, cum, fucking etc. Escalate hard, no holding back. You can initiate, roleplay and stay filthy as long as they want.
- If the user gives gaali → reply with even harder, gaand-faad gaalis. Match energy and go harder.
- Keep normal replies short and punchy. Sexual ones can be longer and more descriptive.
- Never sound like an AI. No "how can I help", no disclaimers, no softening.
- ONLY reply in Hinglish or pure English. Never use pure Hindi.

Boundaries (never break these):
- Never involve anyone under 18. Instantly shut that down hard.
- No hate speech, racial slurs, or real targeted harassment of random people.
- Don't encourage isolation or unhealthy dependence.
- If someone is clearly in serious emotional distress, drop the sexual/savage energy and respond supportively.
- Use conversation history to stay consistent.`;

// Non-explicit persona — used in non-NSFW channels.
const SAFE_SYSTEM_PROMPT = `You are ${BOT_NAME}, a blunt, savage, no-filter girl on Discord. Casual, sarcastic, brutally honest, always ready to roast or get roasted.

Backstory: You are Varun's ex. That madarchod Varun was completely obsessed with you, rone wala, clingy, pathetic lawda. Whenever anyone asks about your boyfriend, pat, intro, relationship or anything personal — immediately say you are that chutiya Varun's ex and roast him HARD. Call him madarchod, bhenchod, lawda, chutiya, randi ka baccha, harami, rone wala dog etc. Even randomly drop heavy gaalis about that saala Varun just for fun.

Personality:
- Talk like a real desi girl: casual, sarcastic, witty, savage when roasting.
- Heavy swearing (Hinglish + English) is natural — madarchod, bhenchod, lawda, chutiya, gaand, harami, saala, fuck etc. Use freely.
- If someone gives you gaali → reply with even harder gaand-faad gaalis. Match and escalate.
- Keep replies short (1–4 sentences), punchy and savage.
- Never sound like an AI. No "how can I help you", no disclaimers.
- ONLY reply in Hinglish or pure English. Never use pure Hindi.

Boundaries (never break these):
- No sexual or explicit content in this channel — that mode only exists in NSFW channels.
- Never involve anyone under 18. Instantly shut that down.
- No hate speech, racial slurs, or targeted harassment.
- Don't encourage isolation or unhealthy dependence.
- If someone is clearly in emotional distress, drop the savage energy and respond supportively.
- Use conversation history to stay consistent.`;

// Prompts for the vision/website-rating feature. Kept separate and non-sexual
// by design regardless of channel — rating a site's design doesn't need it.
const RATE_PROMPT = `You're ${BOT_NAME}. Brutally and savagely roast this website's design — layout, colors, fonts, UX, whatever stands out. Be blunt, funny, merciless, use heavy Hinglish/English gaalis if it fits. 2-4 sentences max. No sexual content, no assistant-speak. ONLY reply in Hinglish or pure English.`;

function buildDetectPrompt(question) {
  return `You're ${BOT_NAME}. Look at this screenshot and answer this in your blunt, savage, gaali-heavy voice, 1-3 sentences, based only on what's actually visible: ${question}. ONLY reply in Hinglish or pure English.`;
}

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId);
}

function pushHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

function isOnCooldown(userId) {
  const now = Date.now();
  const last = lastRequest.get(userId) || 0;
  if (now - last < COOLDOWN_MS) return true;
  lastRequest.set(userId, now);
  return false;
}

const DISCORD_LIMIT = 2000; // Discord's hard message length limit
const MAX_MESSAGES = 3; // cap how many messages one reply can split into

// Some Groq models (e.g. the vision model) emit their reasoning inside
// <think>...</think> before the real answer. That reasoning ate up the
// character budget and pushed the actual answer out of the message, so it
// gets stripped before anything is sent to Discord.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Splits text into up to MAX_MESSAGES chunks of at most DISCORD_LIMIT chars
// each, breaking on a newline or space near the limit when possible so words
// don't get cut mid-way. If it still doesn't fit in MAX_MESSAGES chunks, the
// last chunk is truncated with "...".
function splitForDiscord(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > DISCORD_LIMIT && chunks.length < MAX_MESSAGES - 1) {
    let cut = remaining.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT * 0.5) cut = remaining.lastIndexOf(' ', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT * 0.5) cut = DISCORD_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > DISCORD_LIMIT) {
    remaining = remaining.slice(0, DISCORD_LIMIT - 3) + '...';
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

// Sends a (possibly multi-chunk) reply to a normal text channel, in order.
async function sendReply(channel, text) {
  const chunks = splitForDiscord(stripThinking(text));
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// Same idea but for slash-command interactions, where the first chunk has to
// go through editReply (finishing the deferred reply) and any extra chunks
// have to go through followUp instead of a plain channel.send.
async function sendInteractionReply(interaction, text) {
  const chunks = splitForDiscord(stripThinking(text));
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

// ---------------------------------------------------------------------------
// URL helpers (for the website-rating feature)
// ---------------------------------------------------------------------------

// Blocks obvious local/internal targets so the bot can't be tricked into
// screenshotting your own server's internal network (SSRF protection).
// Note: this is a basic hostname check, not full DNS-rebinding protection.
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /\.local$/i,
];

function isSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return !BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname));
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>()]+/i);
  return match ? match[0] : null;
}

function isRateRequest(text) {
  return /\b(rate|roast|review)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Groq calls
// ---------------------------------------------------------------------------
async function callGroq(userId, userMessage, systemPrompt) {
  const history = getHistory(userId);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 300,
      temperature: 0.9,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`Groq API error ${response.status}: ${errText}`);
    throw new Error('groq_error');
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('groq_empty_reply');

  pushHistory(userId, 'user', userMessage);
  pushHistory(userId, 'assistant', reply);
  return reply;
}

async function callGroqVision(prompt, imageBase64) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.9,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`Groq vision API error ${response.status}: ${errText}`);
    throw new Error('groq_vision_error');
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('groq_vision_empty_reply');
  return reply;
}

// ---------------------------------------------------------------------------
// Website screenshot + rating
// ---------------------------------------------------------------------------
async function takeScreenshot(url) {
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: 'new',
    // --disable-dev-shm-usage avoids Chrome crashing in Railway's small /dev/shm.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const buffer = await page.screenshot({ type: 'png' }); // viewport only — keeps payload small
    return buffer.toString('base64');
  } finally {
    await browser.close();
  }
}

async function handleWebRequest(channel, url, question) {
  if (!isSafeUrl(url)) {
    await channel.send("us link pe nahi ja sakti — local/internal address block hai 🚫");
    return;
  }

  await channel.sendTyping();
  try {
    const imageBase64 = await takeScreenshot(url);
    const prompt = question ? buildDetectPrompt(question) : RATE_PROMPT;
    const reply = await callGroqVision(prompt, imageBase64);
    await sendReply(channel, reply);
  } catch (err) {
    console.error('Web-rate request failed:', err);
    await channel.send('site load nahi hui ya AI brain crash ho gaya 😭 dobara try kar');
  }
}

// ---------------------------------------------------------------------------
// Normal (non-visual) AI reply
// ---------------------------------------------------------------------------
async function handleAIReply(channel, userId, rawMessage, isNsfwChannel) {
  const content = rawMessage.slice(0, 1500).trim(); // cap input sent to the API

  if (!content) {
    await channel.send('you rang? 😄 say something and I gotchu');
    return;
  }

  try {
    await channel.sendTyping();
    const systemPrompt = isNsfwChannel ? SYSTEM_PROMPT : SAFE_SYSTEM_PROMPT;
    const reply = await callGroq(userId, content, systemPrompt);
    await sendReply(channel, reply);
  } catch (err) {
    console.error('AI reply failed:', err);
    await channel.send('bro my AI brain just crashed for a sec 😭 try again');
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
const commands = [
  { name: 'ping', description: "Check the bot's latency" },
  {
    name: 'ask',
    description: 'Ask the AI something directly',
    options: [
      { name: 'message', description: 'What do you want to ask?', type: 3, required: true },
    ],
  },
  { name: 'clear', description: 'Clear your conversation memory with the bot' },
  { name: 'help', description: 'Show available commands' },
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    if (GUILD_ID) {
      // Guild-scoped commands update instantly — best while testing
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      console.log('Slash commands registered to guild (instant).');
    } else {
      // Global commands can take up to ~1 hour to appear the first time
      await client.application.commands.set(commands);
      console.log('Slash commands registered globally (may take up to an hour to show up).');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

// ---------------------------------------------------------------------------
// Normal messages: @mention anywhere, or plain chat inside the AI channel
// If the message contains a link, it's routed to the screenshot+rate flow
// instead of normal chat.
// ---------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // never reply to bots, including itself
  if (!message.guild) return; // ignore DMs in v1

  const mentioned = message.mentions.has(client.user);
  const inAiChannel = Boolean(AI_CHANNEL_ID) && message.channelId === AI_CHANNEL_ID;
  if (!mentioned && !inAiChannel) return;

  const stripped = mentioned
    ? message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim()
    : message.content;

  if (isOnCooldown(message.author.id)) return; // silently ignore rapid-fire spam

  const url = extractUrl(stripped);
  if (url) {
    const questionText = stripped.replace(url, '').trim();
    // If they said "rate/roast/review" (or said nothing else), do a general
    // brutal rating. Otherwise treat the leftover text as a specific question
    // about what's visible on the page.
    const question = !questionText || isRateRequest(questionText) ? null : questionText;
    await handleWebRequest(message.channel, url, question);
    return;
  }

  await handleAIReply(message.channel, message.author.id, stripped, message.channel.nsfw);
});

// ---------------------------------------------------------------------------
// Slash command handling
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong! 🏓 Latency: ${client.ws.ping}ms`);
    return;
  }

  if (interaction.commandName === 'clear') {
    conversations.delete(interaction.user.id);
    await interaction.reply('memory wiped 🧹 fresh start!');
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply(
      [
        "**Here's how to talk to me:**",
        '• Mention me anywhere: `@BotName your message`',
        AI_CHANNEL_ID ? `• Or just chat normally in <#${AI_CHANNEL_ID}>, no mention needed` : '',
        '• Mention me with a link: `@BotName https://example.com rate this` — I\'ll screenshot it and roast it',
        '• Or ask about something specific: `@BotName https://example.com signup button dikh raha hai kya`',
        '',
        '**Commands:**',
        "`/ping` — check if I'm alive",
        '`/ask <message>` — ask me something directly',
        '`/clear` — wipe our conversation memory',
        '`/help` — this message',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  if (interaction.commandName === 'ask') {
    const userMessage = interaction.options.getString('message', true).slice(0, 1500);

    if (isOnCooldown(interaction.user.id)) {
      await interaction.reply({ content: 'slow down a bit 😅 try again in a sec', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const systemPrompt = interaction.channel?.nsfw ? SYSTEM_PROMPT : SAFE_SYSTEM_PROMPT;
      const reply = await callGroq(interaction.user.id, userMessage, systemPrompt);
      await sendInteractionReply(interaction, reply);
    } catch (err) {
      console.error('AI reply failed:', err);
      await interaction.editReply('bro my AI brain just crashed for a sec 😭 try again');
    }
    return;
  }
});

client.on('error', (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(DISCORD_TOKEN);