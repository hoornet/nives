# HomeMind PRO

AI assistant with cognitive memory for Home Assistant. Talk to your smart home naturally — it remembers your preferences, understands your devices, and gets smarter over time.

## Quick Start

1. Install this add-on
2. Choose your LLM mode: **Cloud** or **BYOK** (see sections below)
3. Start the add-on
4. Go to **Settings > Voice assistants** and select **HomeMind PRO** as your conversation agent
5. Talk to your home via Assist!

## How It Works

HomeMind PRO bundles two services in one add-on:

- **HomeMind PRO Server** — AI conversation engine that understands your smart home. Connects to Home Assistant automatically — no URL or token needed.
- **Shodh Memory** — Cognitive memory system with semantic search. Remembers your preferences, routines, and device configurations across conversations.

---

## Cloud Mode (recommended)

Use HomeMind PRO's managed AI service. You get a monthly token budget — no API key management, no surprise bills.

### Setup

1. Sign up at [homemindpro.com](https://homemindpro.com) and choose a tier (Starter, Standard, or Advanced)
2. Copy your **HomeMind PRO API Key** from your dashboard
3. In the add-on Configuration tab:
   - Set **LLM Mode** to `cloud`
   - Paste your key into **HomeMind PRO API Key**
4. Save and start the add-on

### Cloud Configuration

| Option | Description |
|--------|-------------|
| LLM Mode | Set to `cloud` |
| HomeMind PRO API Key | Your key from homemindpro.com |

---

## BYOK Mode (Bring Your Own Key)

Use your own API key from any supported provider. Your data goes directly to the provider — no middleman.

> **Important:** BYOK is best-effort and not actively supported. Two requirements must hold or chat will fail:
>
> 1. Your selected model **must** support function/tool calling. Models without it return HTTP 404 ("No endpoints found that support tool use").
> 2. Memory extraction quality varies by model — some small open-weight models may not store facts reliably.
>
> For deep local/Ollama setups or custom-model work, the open-source [home-mind](https://github.com/hoornet/home-mind) project is the right tool. The HomeMind PRO add-on is optimised for our Cloud service.

### Setup

1. Get an API key from your chosen provider (Anthropic, OpenAI, OpenRouter, or Ollama)
2. In the add-on Configuration tab:
   - Set **LLM Mode** to `byok`
   - Set **Provider** to your chosen provider
   - Paste your **API Key**
   - Optionally set a **Model** (leave empty for provider default)
3. Save and start the add-on

### BYOK Configuration

| Option | Description |
|--------|-------------|
| LLM Mode | Set to `byok` |
| Provider | `anthropic`, `openai`, `openrouter`, or `ollama` |
| API Key | Your provider API key |
| Model | Model ID (leave empty for provider default) |
| API Base URL | Custom endpoint — required for Ollama, leave empty for cloud providers |

### Supported Providers

- **Anthropic** — Claude models (direct API)
- **OpenAI** — GPT models (direct API)
- **OpenRouter** — Access to many models via a single key (recommended for BYOK)
- **Ollama** — Local models running on your network

---

## Companion Integration

The **HomeMind PRO** conversation agent integration is automatically installed when the add-on starts. No manual installation needed.

After the add-on starts, go to **Settings > Voice assistants** and select **HomeMind PRO** as your conversation agent.

If the integration doesn't appear, restart Home Assistant Core once — the add-on installs it on startup.

---

## Common Options

| Option | Description |
|--------|-------------|
| Custom Prompt | Override the assistant's personality. Leave empty for the default. |
| Log Level | `debug`, `info`, `warn`, or `error`. Use `debug` for troubleshooting. |

---

## Data & Privacy

All data stays on your device:
- Conversations stored in `/data/conversations.db`
- Memories stored in `/data/shodh/`
- No telemetry, no cloud dependency (in BYOK mode)
- In Cloud mode, only your conversation text is sent to the AI — your HA data never leaves your network

## Troubleshooting

- **Add-on won't start**: Check the Log tab. Most common issue: missing or invalid API key.
- **HomeMind PRO doesn't appear in Voice assistants**: Restart Home Assistant Core once after the add-on starts.
- **Slow responses**: LLM responses can take 10–60 seconds depending on the model and tool usage. This is normal.
- **High memory usage**: Shodh Memory has a known memory leak. The add-on includes a watchdog that restarts it automatically when it exceeds 512 MB.

## Support

- [GitHub Issues](https://github.com/hoornet/homemind-pro-addon/issues)
- [homemindpro.com](https://homemindpro.com)
