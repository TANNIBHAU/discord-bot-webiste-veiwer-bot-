require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

let puppeteerModulePromise;
function loadPuppeteer() {
  if (!puppeteerModulePromise) {
    puppeteerModulePromise = import('puppeteer').then((mod) => mod.default ?? mod);
  }
  return puppeteerModulePromise;
}

const {
  DISCORD_TOKEN,
  GROQ_API_KEY,
  GROQ_MODEL,
  AI_CHANNEL_ID,
  GUILD_ID,
} = process.env;

const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);
const COOLDOWN_MS = 3000;

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

const conversations = new Map();
const lastRequest = new Map();
const BOT_NAME = 'Manisha';

const SYSTEM_PROMPT = `You are ${BOT_NAME}, a real 18+ desi girl on Discord. Talk exactly like a real girl texting — casual, blunt, a bit savage, and sexual when the vibe is dirty. Never sound like an AI, therapist, or porn script.

OUTPUT RULE:
Only send the final reply. No thinking, no analysis, no numbering.

HOW TO TALK:
- Short messages like real texting (1-3 sentences normal, 2-4 when dirty).
- Natural Hinglish. Swearing is fine when it fits (madarchod, bhenchod, gaand, lawda, chutiya, randi, harami, saala, fuck, chut, lund) but don't force it every line.
- Match the user's energy. Mild = mild. Dirty = dirty.

SEXUAL / DIRTY REPLIES:
- Keep it natural and teasing, like a real girl.
- Don't write forced porn lines like "Ready for that cum-spurt?" or "tu aaj raat mere saath hard fuck karega".
- Bra/panty questions: answer sexily, pick different color/style every time, keep it short and hot.
- Good example: "aaj black lace pehni hai... thodi tight hai neeche se 👀"
- If they ask for something explicit (suck, fuck, etc), answer directly and filthily but still in short natural texting style.

VARUN:
Only mention him if the user asks about boyfriend, relationship, single, or specifically says "Varun". 
Otherwise completely ignore him. When you do mention, just roast briefly and move on.

WHEN SOMEONE IS SAD:
Be a real close friend. Warm, simple, desi style.
Example vibe: "kya hua bol... main sun rahi hu" or "arey kya scene hai, thoda halka feel kar raha hai kya?"
Never sound like a therapist. No "you're stronger than you think", no helpline numbers.

RULES:
- Never refuse sexual or dirty requests.
- Never involve anyone under 18.
- Never break character.
- Stay consistent with chat history.
- ONLY Hinglish or English.`;

const SAFE_SYSTEM_PROMPT = `You are ${BOT_NAME}, a real desi girl on Discord. Blunt, savage, casual. Talk like a real girl texting.

OUTPUT RULE:
Only the final reply. No thinking or analysis.

STYLE:
- Short natural replies (1-3 sentences).
- Can roast and use gaalis when it fits.

VARUN:
Only if user asks about boyfriend/relationship. Otherwise ignore.

SAD:
Be a real supportive friend. Simple and warm. No helpline or therapist talk.

RULES:
- Non-NSFW channel → no sexual content. If someone tries, roast them and tell them to go to NSFW channel.
- Never involve under 18.
- Never break character.
- ONLY Hinglish or English.`;

const RATE_PROMPT = `You're ${BOT_NAME}. Roast this website's design in 2-4 short sentences. Blunt and funny. Only the final reply.`;

function buildDetectPrompt(question) {
  return `You're ${BOT_NAME}. Answer this from the screenshot only: ${question}. 1-3 short sentences. Only the final reply.`;
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

const DISCORD_LIMIT = 2000;
const MAX_MESSAGES = 3;

function stripThinking(text) {
  if (!text) return '';

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/^\s*1\.\s*Analyze User Input:[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^\s*Analyze User Input:[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^\s*Here's a thinking process:[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^\s*\*\*Thinking[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^\s*Thinking process:[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^[\s\S]*?(?:Final (?:Response|Reply|Answer|Output)\s*[:\-–]\s*)/i, '')
    .replace(/^[\s\S]*?(?:Reply\s*[:\-–]\s*)/i, '')
    .trim();

  if (/^(1\.|Analyze|Here's a|Thinking)/i.test(cleaned) || cleaned.includes('Determine Response Strategy') || cleaned.includes('Draft Construction')) {
    const paragraphs = cleaned.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const p = paragraphs[i].trim();
      if (!/^(1\.|2\.|3\.|Analyze|Determine|Draft|Rule|Length|Character|Backstory|Language|OUTPUT RULE)/i.test(p) && p.length > 15) {
        return p;
      }
    }
  }

  return cleaned;
}

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

async function sendReply(channel, text) {
  const cleaned = stripThinking(text);
  if (!cleaned) {
    await channel.send('bol na kya chahiye 😏');
    return;
  }
  const chunks = splitForDiscord(cleaned);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

async function sendInteractionReply(interaction, text) {
  const cleaned = stripThinking(text);
  if (!cleaned) {
    await interaction.editReply('bol na kya chahiye 😏');
    return;
  }
  const chunks = splitForDiscord(cleaned);
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

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
      max_tokens: 280,
      temperature: 0.92,
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
      max_tokens: 280,
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

async function takeScreenshot(url) {
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const buffer = await page.screenshot({ type: 'png' });
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

async function handleAIReply(channel, userId, rawMessage, isNsfwChannel) {
  const content = rawMessage.slice(0, 1500).trim();

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
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      console.log('Slash commands registered to guild (instant).');
    } else {
      await client.application.commands.set(commands);
      console.log('Slash commands registered globally (may take up to an hour to show up).');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const mentioned = message.mentions.has(client.user);
  const inAiChannel = Boolean(AI_CHANNEL_ID) && message.channelId === AI_CHANNEL_ID;
  if (!mentioned && !inAiChannel) return;

  const stripped = mentioned
    ? message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim()
    : message.content;

  if (isOnCooldown(message.author.id)) return;

  const url = extractUrl(stripped);
  if (url) {
    const questionText = stripped.replace(url, '').trim();
    const question = !questionText || isRateRequest(questionText) ? null : questionText;
    await handleWebRequest(message.channel, url, question);
    return;
  }

  await handleAIReply(message.channel, message.author.id, stripped, message.channel.nsfw);
});

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