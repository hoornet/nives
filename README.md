# HomeMind PRO

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Add-on version](https://img.shields.io/badge/Add--on-1.0.18-brightgreen.svg)](homemind-pro/CHANGELOG.md)

An AI assistant for Home Assistant that **remembers**. One-click install, works with your voice, learns your home.

> Tell it once — "100 ppm is normal for my NOx sensor", "bedroom lights should go to 30% in the evening", "call the WLED strip 'main kitchen light'" — and it remembers next time. No re-teaching every conversation.

## What it does

- **Persistent memory** — preferences, routines, sensor baselines, device nicknames. Stays across restarts.
- **Voice control** through HA Assist — ask in plain language, control anything.
- **Learns your home** — reads your floor plan, areas, and device capabilities so it always knows which room a light is in.
- **Your choice of brain** — use our hosted Cloud (easiest, no setup) or bring your own API key (Anthropic, OpenAI, Ollama).
- **Privacy-respecting** — memories live on your HA machine, never leave your network.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add this URL: `https://github.com/hoornet/homemind-pro-addon`
3. Install **HomeMind PRO** from the store
4. Start it, open the **Configuration** tab, pick a mode (see below), save, restart

The add-on will auto-register as a conversation agent — pick it in **Settings → Voice assistants** as your conversation agent and you're done.

## Cloud vs BYOK — which mode?

HomeMind PRO ships with two modes. Pick one in the add-on's **Configuration** tab.

| Mode | Who it's for | Setup |
|---|---|---|
| **Cloud** | You just want it to work | Sign up at [homemindpro.com](https://homemindpro.com), paste the key we send you |
| **BYOK** | You already have Anthropic / OpenAI / Ollama credentials | Paste your own API key |

Both modes use the exact same on-device server and memory — the only difference is where LLM requests go. No lock-in. Switch any time.

## Docs

Full setup guides, configuration reference, and troubleshooting live in the add-on's **Documentation** tab (or [`homemind-pro/DOCS.md`](homemind-pro/DOCS.md) on GitHub).

## Related projects

- **[home-mind](https://github.com/hoornet/home-mind)** — the open-source server under the hood (AGPL-3.0). Run it yourself without this add-on if you prefer.
- **[homemindpro.com](https://homemindpro.com)** — the paid Cloud service (optional).

## Support

- **Bug reports / feature requests:** open an [issue](https://github.com/hoornet/homemind-pro-addon/issues)
- **Cloud subscription questions:** [homemindpro.com](https://homemindpro.com)

## License

AGPL-3.0 — see [LICENSE](LICENSE).
