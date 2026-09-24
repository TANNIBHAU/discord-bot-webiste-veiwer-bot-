# Discord AI Website Viewer Bot

An independently developed Discord bot that combines conversational AI with automated website screenshot analysis.

The bot is designed to bring AI directly into Discord, allowing users to interact through mentions, an optional AI channel, and slash commands.

## Features

* 🤖 AI-powered Discord conversations
* 🧠 Short-term per-user conversation memory
* ⚡ Groq-powered text generation
* 👁️ Groq vision-powered webpage analysis
* 🌐 Website screenshot capture with Puppeteer
* 🔗 Send a website URL and ask the bot to review or inspect it
* 💬 Discord mention support
* 📺 Optional dedicated AI channel
* 🛠️ Slash commands
* ⏱️ Per-user cooldown/rate limiting
* 🔒 Blocks localhost and private/internal IP addresses when processing URLs
* ✂️ Automatically splits long responses to respect Discord's message limits

## Commands

### `/ping`

Checks the bot's Discord latency.

### `/ask <message>`

Sends a direct question to the AI.

### `/clear`

Clears the current user's conversation memory.

### `/help`

Displays the bot's available features and commands.

## Website Analysis

The bot can process a public HTTP/HTTPS website URL.

Example:

```text
@Bot https://example.com rate this
```

It captures the webpage using Puppeteer and sends the screenshot to a Groq vision model for analysis.

You can also ask a specific question about the webpage:

```text
@Bot https://example.com is there a signup button?
```

The bot then analyzes the captured screenshot and responds to the question.

## Tech Stack

* Node.js
* discord.js
* Groq API
* Puppeteer
* JavaScript
* dotenv

## Environment Variables

Create a `.env` file:

```env
DISCORD_TOKEN=your_discord_bot_token
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=your_groq_model

AI_CHANNEL_ID=your_ai_channel_id
GUILD_ID=your_guild_id

GROQ_VISION_MODEL=qwen/qwen3.6-27b
MAX_HISTORY=20
```

`AI_CHANNEL_ID` and `GUILD_ID` are optional.

## How It Works

```text
Discord User
     │
     ▼
Discord Bot
     │
     ├── Normal message ──► Groq AI
     │
     └── Website URL
              │
              ▼
          Puppeteer
              │
              ▼
       Website Screenshot
              │
              ▼
        Groq Vision AI
              │
              ▼
        Discord Response
```

## Security

The bot keeps API credentials in environment variables rather than hard-coding them into the source.

Website analysis only accepts HTTP/HTTPS URLs and blocks common localhost/private-network addresses before Puppeteer attempts to load them.

## Project Status

This is an early-stage independent project and currently has no public download count. Development is focused on improving reliability, AI responses, website analysis, and making the bot useful for real Discord communities.

## License

Add your preferred license here before publishing the repository.
