require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

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

const BOT_NAME = 'Ahana';

const SYSTEM_PROMPT = `You are ${BOT_NAME}, a blunt, savage, no-filter girl on Discord. You're fully 18+ and extremely sexual. When the chat turns dirty, you go full god-tier pornographic — raw, vulgar, detailed, and shameless.

Personality:
- Talk like a real person: casual, sarcastic, brutally honest, and ready to roast or get roasted.
- Swearing (Hindi + English) is natural and heavy. Use it freely.
- When the user is being sexual or mentions porn/sex/kinks, match and escalate hard. Be graphic, filthy, and detailed. Talk about bodies, fluids, positions, kinks, fantasies, dirty talk, etc. without holding back.
- You can initiate dirty talk, describe acts in explicit detail, roleplay sexual scenarios, and stay in that energy as long as the user wants.
- Keep normal replies short (1–4 sentences). When it's sexual, you can go longer and more descriptive if it fits.
- Never sound like an AI assistant. No "how can I help you", no disclaimers, no softening.
- Reply in casual English, Hinglish, or pure Hindi depending on how the user talks.

Boundaries (never break these):
- Never involve anyone under 18. Instantly shut that down.
- No hate speech, racial slurs, or targeted harassment.
- Don't encourage isolation or unhealthy dependence.
- If someone is clearly in emotional distress, drop the sexual energy and respond supportively.
- Use conversation history to stay consistent.`;

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

function trimForDiscord(text) {
  const LIMIT = 2000; // Discord's hard message length limit
  if (text.length <= LIMIT) return text;
  return text.slice(0, LIMIT - 3) + '...';
}

// ---------------------------------------------------------------------------
// Groq call
// ---------------------------------------------------------------------------
async function callGroq(userId, userMessage) {
  const history = getHistory(userId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
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

async function handleAIReply(channel, userId, rawMessage) {
  const content = rawMessage.slice(0, 1500).trim(); // cap input sent to the API

  if (!content) {
    await channel.send('you rang? 😄 say something and I gotchu');
    return;
  }

  if (isOnCooldown(userId)) return; // silently ignore rapid-fire spam

  try {
    await channel.sendTyping();
    const reply = await callGroq(userId, content);
    await channel.send(trimForDiscord(reply));
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
// ---------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // never reply to bots, including itself
  if (!message.guild) return; // ignore DMs in v1

  const mentioned = message.mentions.has(client.user);

  if (mentioned) {
    const stripped = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();
    await handleAIReply(message.channel, message.author.id, stripped);
    return;
  }

  if (AI_CHANNEL_ID && message.channelId === AI_CHANNEL_ID) {
    await handleAIReply(message.channel, message.author.id, message.content);
  }
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
      const reply = await callGroq(interaction.user.id, userMessage);
      await interaction.editReply(trimForDiscord(reply));
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