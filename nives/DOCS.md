# Nives

AI assistant with cognitive memory for Home Assistant. Talk to your smart home naturally — it remembers your preferences, understands your devices, and gets smarter over time.

> _Previously known as **HomeMind PRO**. See the [v2.0.0 changelog](CHANGELOG.md) for migration notes._

Nives is in early access. It's a convenience assistant for everyday things — asking about your home, and changing it when you ask. Treat it as that rather than as something to depend on.

## Quick Start

1. Install this add-on
2. Choose your LLM mode: **Cloud** or **BYOK** (see sections below)
3. Start the add-on
4. Restart Home Assistant once when Nives asks (a notification on first install; after updates, a one-click repair under **Settings > Repairs**) — this loads the companion integration
5. Go to **Settings > Voice assistants** and select **Nives** as your conversation agent
6. Talk to your home via Assist!

## How It Works

Nives bundles two services in one add-on:

- **Nives Server** — AI conversation engine that understands your smart home. Connects to Home Assistant automatically — no URL or token needed.
- **Shodh Memory** — Cognitive memory system with semantic search. Remembers your preferences, routines, and device configurations across conversations.

## What Nives Can Do

- **Answer & control** — ask about any sensor or device, and control them by voice or text ("dim the lounge", "is the bedroom warm?").
- **Remember** — tell it your preferences, baselines, and nicknames once; it uses them across every conversation.
- **Create & manage automations** — ask it to set up, change, list, or delete automations ("turn the porch light on at sunset every day"). It always shows what it will do and waits for your confirmation, and names its automations with a `Nives:` prefix so you can find them under Settings → Automations.
- **Be someone else entirely** — the **Custom Prompt** option replaces her personality outright, so the assistant answering you is whoever you describe. Leave it empty and you get Nives: helpful, plain-spoken, and aware of her own name. Write *"You are HAL 9000, the calm and precise computer from 2001"* and that is who answers — including, inevitably, when you ask her to open the pod bay doors. It applies after the add-on restarts, and everything else — memory, automations, your devices — carries on unchanged underneath.
- **Power your automations (AI Task)** — Nives registers an `ai_task` entity, so any automation can call `ai_task.generate_data` to get an answer or structured data reasoned with your home's context. With a vision-capable model it can also analyze an **image attachment** (e.g. a camera snapshot) — useful for smarter, low-false-alarm camera/doorbell notifications.

---

## Cloud Mode

Use Nives Cloud, a managed AI service on a prepaid balance. Buy a ticket, use it until it runs out, top up when you like. No subscription, no API key management, no surprise bills.

### Setup

1. Buy a ticket at [nives.house](https://nives.house) — €10, everything included
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
| Transcription | Off by default. Turn it on to let Nives do the listening too — see below |
| Voice | Off by default. Pick a voice and Nives reads her replies aloud — see below |

### Let Nives do the speaking (optional)

Home Assistant can already read replies aloud, but the free local voices are
thin outside English, and in some languages the only one available sounds like a
news bulletin read by a machine.

Pick a **Voice** and restart the add-on. Within a couple of minutes Nives
appears as a **Text-to-speech** choice in your Assist pipeline (Settings → Voice
assistants), speaking in a voice native to that language rather than a foreign
one sounding out the words. (In a hurry? Reloading the Nives integration under
Settings → Devices & services makes it appear at once.) Speaking is paid from
the same balance as your conversations, and costs a fraction of a cent per
reply.

Two voices are available today, both Slovene:

| Setting | Voice |
|---|---|
| `slovene_female` | A woman's voice |
| `slovene_male` | A man's voice |

More languages will follow as each is tested. A voice is added only when it is
genuinely good in that language — a bad voice is worse than none, and the local
ones are free.

> **The voice also settles the grammar.** Slovene changes the words a speaker
> uses about themselves depending on whether the speaker is a woman or a man,
> and so do Croatian, Czech, Polish, Russian, Hebrew and Arabic. Whichever voice
> you pick decides that, in the written reply as well as the spoken one — even
> if you have given Nives a personality of your own.

> **A voice speaks one language.** Nives offers herself as a speaking choice
> only for the language of the voice you picked, so a Slovene voice will not be
> offered to an English pipeline. If you run Assist in more than one language,
> keep Home Assistant's own text-to-speech for the others.

### Let Nives do the listening (optional)

Home Assistant needs a speech-to-text engine to turn what you say into words
before Nives can answer. The engines that run on your own box are excellent for
English, but on smaller hardware they tend to struggle with names — "Nives"
especially — and with languages other than English.

Turn **Transcription** on and restart the add-on. Within a couple of minutes
Nives appears as a **Speech-to-text** choice in your Assist pipeline (Settings →
Voice assistants), using high-quality transcription paid from the same balance
as your conversations. (In a hurry? Reloading the Nives integration under
Settings → Devices & services makes it appear at once.) Listening is
inexpensive next to thinking: a typical spoken command costs a small fraction of
the reply it produces. Nives is told which language your pipeline speaks, so
short commands in your own language are understood rather than guessed at.

> **What this changes about your privacy.** With Transcription off, only your
> written request and your home's device list go to the cloud. With it on, the
> audio of what you say is sent to be transcribed as well. That is why it is
> off until you choose it. Everything else is unchanged, and you can turn it
> back off at any time — a couple of minutes after the add-on restarts, Nives
> removes itself from the Speech-to-text list and your pipeline falls back to
> the engine it used before.

Prefer to keep audio on your own hardware? Leave this off and use a local engine
in the pipeline; Nives works exactly the same, it just receives the words rather
than the sound.

### Balance heads-up

Nives keeps an eye on your remaining balance. When about three days of typical use are left, it posts a Home Assistant notification inviting you to top up at [nives.house](https://nives.house); if the balance runs out, a clearer one says so. After a top-up both clear on their own — nothing to configure. This applies to Cloud mode only; keys you bring yourself are never watched.

---

## BYOK Mode (Bring Your Own Key)

Use your own API key from any supported provider. Your data goes directly to the provider, with no middleman.

Two things to get right, and chat will fail if either is wrong:

1. Your model **must** support function / tool calling. That is how Nives controls your home, and a model without it returns HTTP 404 ("No endpoints found that support tool use").
2. Memory extraction quality varies by model. Some small open-weight models don't store facts reliably.

Going deep on local or Ollama setups? The open-source [home-mind](https://github.com/hoornet/home-mind) project is built around exactly that, and it's the same engine.

### Setup

1. Get an API key from your chosen provider (Anthropic, OpenAI, OpenRouter, or Ollama)
2. In the add-on Configuration tab:
   - Set **LLM Mode** to `byok`
   - Set **Provider** to your chosen provider
   - Paste your **API Key**
   - Set a **Model** — optional for Anthropic, OpenAI and OpenRouter (each has a sensible default); **required for Ollama**, where you must enter the model you pulled (e.g. `qwen3:8b`)
3. Save and start the add-on

### BYOK Configuration

| Option | Description |
|--------|-------------|
| LLM Mode | Set to `byok` |
| Provider | `anthropic`, `openai`, `openrouter`, or `ollama` |
| API Key | Your provider API key |
| Model | Model ID. Optional for Anthropic / OpenAI / OpenRouter; **required for Ollama** |
| API Base URL | Custom endpoint. Leave empty for cloud providers; for Ollama, defaults to `http://homeassistant:11434/v1` if you leave it blank |

### Supported Providers

- **Anthropic** — Claude models (direct API)
- **OpenAI** — GPT models (direct API)
- **OpenRouter** — Access to many models via a single key (recommended for BYOK)
- **Ollama** — Local models running on your network

---

## Companion Integration

The **Nives** conversation agent integration is automatically installed when the add-on starts. No manual installation needed.

After installing or updating, Home Assistant needs one restart to load the integration. After an update, Nives files a **Restart required** repair under **Settings > Repairs** — click Submit there to restart at a moment that suits you. On a fresh install it leaves a notification instead, and you restart via Settings > System > Restart. Either way, the add-on never restarts Home Assistant by itself.

Once restarted, go to **Settings > Voice assistants** and select **Nives** as your conversation agent.

### API access (advanced)

The add-on's HTTP API uses an access token. It is generated on first start and
handed to the companion integration automatically — **there is nothing to
configure.** The add-on only begins requiring the token once the integration has
confirmed it has it, so the two can never get out of step; the add-on log says
which state it is in on every start.

It only matters if you call the API yourself (a script, or the add-on's port
mapped to your network). In that case, read it from your Home Assistant
configuration folder — `nives/.api_token`, e.g. with the File Editor, SSH or
Terminal add-on — and send it as a bearer token:

```
curl -H "Authorization: Bearer <token>" http://<addon-host>:3100/api/chat ...
```

`/api/health` stays public so monitoring doesn't need the token.

---

## Common Options

| Option | Description |
|--------|-------------|
| Voice | The voice Nives speaks her replies in, or `off` for no voice. Each choice is a voice native to that language; it applies once the add-on restarts. |
| Custom Prompt | The assistant's personality — what you write replaces the default persona outright (e.g. "You are HAL 9000, the calm and precise computer from 2001"). This is the one place to set it; it applies once the add-on restarts. Leave empty for the default. |
| Maximum Answer Length | How much room one written answer gets, in tokens. Leave it empty and Nives chooses. Raise it if long answers stop before they finish, which is most likely when you ask about several sensors at once or over a long period. Longer answers cost a little more. Spoken answers are not affected. |
| Room map from exposed entities | On by default. Nives keeps a room map of your home, and it lists the entities you have exposed to Assist (Settings, Voice assistants, Expose), the same set Home Assistant's own assistant sees. Turn it off to list entities by type instead. Either way Nives can still find and control any entity by name; this only decides which ones are in the map. |
| Room map entity types | Advanced. Which entity types go in the room map when it is not built from exposed entities: a comma-separated list such as `light,switch,climate,sensor`, or `all` for every entity in the house. Leave empty for a sensible default. |
| Log Level | `debug`, `info`, `warn`, or `error`. Use `debug` for troubleshooting. |

---

## Data & Privacy

**Stored on your device, always:**
- Conversations in `/data/conversations.db`
- Memories in `/data/shodh/`
- No telemetry

Nothing is stored anywhere else — there is no copy of your memories or your home on our side.

**What is sent to the AI model, on every message:**

To answer usefully, Nives has to tell the model about your home. Each request includes:
- your message and recent conversation
- the memories relevant to what you asked
- your home layout — floors, rooms, and the device IDs in them
- the capabilities of your lights
- the results of anything it looks up to answer you (device states, history)

This is true in **both** Cloud and BYOK mode — the difference is only *which* provider receives it. In Cloud mode that's the model provider we route to; in BYOK mode it's whichever provider's key you entered, and we're not in the path at all. If you'd rather none of it left your network, run a local model via Ollama in BYOK mode (see the note above about local setups).

## Troubleshooting

- **Add-on won't start**: Check the Log tab. Most common issue: missing or invalid API key.
- **Nives doesn't appear in Voice assistants**: Restart Home Assistant Core once after the add-on starts — there should be a notification (or, after updates, a repair under Settings > Repairs) reminding you.
- **Slow responses**: LLM responses can take 10–60 seconds depending on the model and tool usage. This is normal.
- **High memory usage**: Shodh Memory has a known memory leak. The add-on includes a watchdog that restarts it automatically when it exceeds 512 MB.

## Support

- [GitHub Issues](https://github.com/hoornet/nives/issues)
- [nives.house](https://nives.house)
