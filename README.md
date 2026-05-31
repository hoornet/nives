# Nives

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Add-on version](https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2Fhoornet%2Fnives%2Fmaster%2Fnives%2Fconfig.yaml&query=%24.version&label=Add--on&color=brightgreen)](nives/CHANGELOG.md)

> _Previously known as **HomeMind PRO**. See the [v2.0.0 changelog](nives/CHANGELOG.md) for migration notes._

An AI assistant for Home Assistant that **remembers**. One-click install, works with your voice, learns your home.

> Tell it once — "100 ppm is normal for my NOx sensor", "bedroom lights should go to 30% in the evening", "call the WLED strip 'main kitchen light'" — and it remembers next time. No re-teaching every conversation.

## What it does

- **Persistent memory** — preferences, routines, sensor baselines, device nicknames. Stays across restarts.
- **Voice control** through HA Assist — ask in plain language, control anything.
- **Learns your home** — reads your floor plan, areas, and device capabilities so it always knows which room a light is in.
- **Your choice of brain** — use Nives Cloud (recommended, fully supported) or BYOK with your own API key (advanced; for full local/custom-model setups, see [home-mind](https://github.com/hoornet/home-mind), the open-source project this add-on grew out of).
- **Privacy-respecting** — memories live on your HA machine, never leave your network.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add this URL: `https://github.com/hoornet/nives`
3. Install **Nives** from the store
4. Start it, open the **Configuration** tab, pick a mode (see below), save, restart

The add-on will auto-register as a conversation agent — pick it in **Settings → Voice assistants** as your conversation agent and you're done.

## Cloud vs BYOK — which mode?

Nives ships with two modes. Pick one in the add-on's **Configuration** tab.

| Mode | Who it's for | Caveats |
|---|---|---|
| **Cloud** | You want a curated, supported setup | Sign up at [nives.house](https://nives.house), paste the key we send you. We pick the model, we test it, we support it. |
| **BYOK** | You're comfortable picking models and debugging | Best-effort. Your model **must** support function-calling. Memory extraction quality varies by model. For deeper local/Ollama setups, use [home-mind OSS](https://github.com/hoornet/home-mind) — it's purpose-built for that. |

Both modes use the same on-device server and memory; only the LLM endpoint differs. Cloud is curated and tested. BYOK quality depends entirely on the model you pick.

## Docs

Full setup guides, configuration reference, and troubleshooting live in the add-on's **Documentation** tab (or [`nives/DOCS.md`](nives/DOCS.md) on GitHub).

## Related projects

- **[home-mind](https://github.com/hoornet/home-mind)** — the open-source server this add-on grew from (AGPL-3.0). Independent project; run it yourself if you prefer the OSS path.
- **[nives.house](https://nives.house)** — the Nives Cloud service (optional).

## Support

- **Bug reports / feature requests:** open an [issue](https://github.com/hoornet/nives/issues)
- **Cloud subscription questions:** [nives.house](https://nives.house)

## License

AGPL-3.0 — see [LICENSE](LICENSE).
