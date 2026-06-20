# Nives

AI assistant with cognitive memory for Home Assistant. Talk to your smart home naturally — it remembers your preferences, understands your devices, and gets smarter over time.

> _Previously known as **HomeMind PRO**. See the [v2.0.0 changelog](CHANGELOG.md) for migration notes._

## Quick Start

1. Install this add-on
2. Choose your LLM mode: **Cloud** or **BYOK** (see sections below)
3. Start the add-on
4. Go to **Settings > Voice assistants** and select **Nives** as your conversation agent
5. Talk to your home via Assist!

## How It Works

Nives bundles two services in one add-on:

- **Nives Server** — AI conversation engine that understands your smart home. Connects to Home Assistant automatically — no URL or token needed.
- **Shodh Memory** — Cognitive memory system with semantic search. Remembers your preferences, routines, and device configurations across conversations.

## What Nives Can Do

- **Answer & control** — ask about any sensor or device, and control them by voice or text ("dim the lounge", "is the bedroom warm?").
- **Remember** — tell it your preferences, baselines, and nicknames once; it uses them across every conversation.
- **Create & manage automations** — ask it to set up, change, list, or delete automations ("turn the porch light on at sunset every day"). It always shows what it will do and waits for your confirmation, and names its automations with a `Nives:` prefix so you can find them under Settings → Automations.
- **Power your automations (AI Task)** — Nives registers an `ai_task` entity, so any automation can call `ai_task.generate_data` to get an answer or structured data reasoned with your home's context. With a vision-capable model it can also analyze an **image attachment** (e.g. a camera snapshot) — useful for smarter, low-false-alarm camera/doorbell notifications.

---

## Cloud Mode (recommended)

Use Nives Cloud — a managed AI service with a monthly token budget. No API key management, no surprise bills.

### Setup

1. Sign up at [nives.house](https://nives.house) and choose a plan (Standard or Premium)
2. Copy your **Nives API Key** from your dashboard
3. In the add-on Configuration tab:
   - Set **LLM Mode** to `cloud`
   - Paste your key into **Nives API Key**
4. Save and start the add-on

### Cloud Configuration

| Option | Description |
|--------|-------------|
| LLM Mode | Set to `cloud` |
| Nives API Key | Your key from nives.house |

---

## BYOK Mode (Bring Your Own Key)

Use your own API key from any supported provider. Your data goes directly to the provider — no middleman.

> **Important:** BYOK is best-effort and not actively supported. Two requirements must hold or chat will fail:
>
> 1. Your selected model **must** support function/tool calling. Models without it return HTTP 404 ("No endpoints found that support tool use").
> 2. Memory extraction quality varies by model — some small open-weight models may not store facts reliably.
>
> For deep local/Ollama setups or custom-model work, the open-source [home-mind](https://github.com/hoornet/home-mind) project is the right tool. The Nives add-on is optimised for Nives Cloud.

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

The **Nives** conversation agent integration is automatically installed when the add-on starts. No manual installation needed.

After the add-on starts, go to **Settings > Voice assistants** and select **Nives** as your conversation agent.

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
- **Nives doesn't appear in Voice assistants**: Restart Home Assistant Core once after the add-on starts.
- **Slow responses**: LLM responses can take 10–60 seconds depending on the model and tool usage. This is normal.
- **High memory usage**: Shodh Memory has a known memory leak. The add-on includes a watchdog that restarts it automatically when it exceeds 512 MB.

## Support

- [GitHub Issues](https://github.com/hoornet/nives/issues)
- [nives.house](https://nives.house)
