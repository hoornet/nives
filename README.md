# Nives

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Add-on version](https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2Fhoornet%2Fnives%2Fmaster%2Fnives%2Fconfig.yaml&query=%24.version&label=Add--on&color=brightgreen)](nives/CHANGELOG.md)

> _Previously known as **HomeMind PRO**. See the [v2.0.0 changelog](nives/CHANGELOG.md) for migration notes._

**An AI assistant for Home Assistant that remembers.** Talk to your home in plain language — by voice or text through HA Assist — and Nives recalls your preferences, routines, device nicknames, and sensor baselines across every conversation. No re-teaching, no re-explaining.

> Tell it once — *"100 ppm is normal for my NOx sensor"*, *"bedroom lights should go to 30% in the evening"*, *"call the WLED strip 'main kitchen light'"* — and it remembers next time.

## What you get

- **Persistent memory** — preferences, routines, sensor baselines, device nicknames. Survives restarts.
- **Natural voice & text control** through Home Assistant Assist.
- **Knows your home** — reads your floors, areas, and device capabilities, so it always knows which room a light is in and how to control it.
- **Creates & manages automations** — just ask ("turn the porch light on at sunset", "make the evening scene 30 minutes earlier") and Nives builds, edits, lists, or removes Home Assistant automations for you — always confirming before it changes anything, and using what it remembers about your home (your "evening", your preferred brightness).
- **Works inside your automations** — Nives is also a Home Assistant **AI Task** provider: call `ai_task.generate_data` from any automation to get an answer or structured data, reasoned with your home's context. It can even look at a **camera snapshot** and tell you what matters (with a vision-capable model) — great for smarter, low-false-alarm camera and doorbell alerts.
- **Private by default** — your memories live on your Home Assistant machine and never leave your network.
- **Two ways to power it** — managed **Nives Cloud** (recommended) or **bring your own key**. Both run the exact same on-device server and memory; only the AI endpoint differs.

## Choosing how to power Nives

Nives needs a language model to do the thinking. You have two options — pick one in the add-on's **Configuration** tab.

### Nives Cloud — the easy, recommended path

The no-fuss option, and the best choice for most people — especially if you're new to this, or you'd simply rather not spend your evenings benchmarking models and tweaking settings.

With Nives Cloud you **never choose, test, or babysit a model.** Behind the scenes we run a **curated, always-current selection of top models** and keep it updated for you — when a better or faster one comes along, or one gets retired, we swap it on our side. Your assistant just keeps getting better, with nothing for you to install or change.

**How it works:**

1. Sign up at **[nives.house](https://nives.house)** and pick a plan.
2. Copy the key it gives you.
3. Paste it into the add-on's **Cloud** section and save.

That's it — no AI provider accounts to manage, no model names to research, no surprise bills (each plan includes a monthly usage allowance). Plans differ by **speed, monthly usage, and how capable the models are**, all described in plain terms so you can choose by *experience* rather than by model spec sheets. See **[nives.house](https://nives.house)** for current plans.

### Bring Your Own Key (BYOK) — for tinkerers

Prefer full control? Run Nives with **your own** provider key — Anthropic, OpenAI, OpenRouter, or a local Ollama endpoint — and pick your own model. No subscription.

A few honest notes so it goes smoothly:

- Your model **must support function / tool calling** — that's how Nives actually controls your home.
- Memory quality scales with the model: stronger models extract and recall facts more reliably.
- For a fully self-hosted, local-first setup, the open-source **[home-mind](https://github.com/hoornet/home-mind)** project (which Nives grew from) is purpose-built for exactly that.

## Install

1. In Home Assistant, open **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top-right) → **Repositories**.
3. Add this URL: `https://github.com/hoornet/nives`
4. Find **Nives** in the store and click **Install**.
5. Open the **Configuration** tab, choose **Cloud** or **BYOK** (see above), enter your key, and **Save**.
6. **Start** the add-on.

Then point Home Assistant at it: **Settings → Voice assistants → (your assistant) → Conversation agent → Nives**. Now just talk to your home — type in Assist, or speak if you've set up a voice pipeline.

## Under the hood

Nives bundles two services into one add-on:

- **Nives server** — the conversation engine. Connects to Home Assistant automatically (no URL or token to configure) and controls your devices through HA's own tools.
- **Shodh memory** — an on-device cognitive memory with semantic search, so Nives surfaces the right context at the right moment. Your memories stay on your HA machine.

## Related projects

- **[home-mind](https://github.com/hoornet/home-mind)** — the open-source server Nives grew from (AGPL-3.0). An independent project; run it yourself if you prefer the fully-OSS path.
- **[nives.house](https://nives.house)** — the optional Nives Cloud service.

## Support & feedback

Nives is in early access and we'd genuinely love to hear from you.

- **Bugs / feature ideas:** open an [issue](https://github.com/hoornet/nives/issues).
- **Cloud or subscription questions:** [nives.house](https://nives.house) or hello@nives.house.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
