# Changelog

## 2.2.2

- **Cleaner replies in Assist.** Nives now answers in plain text (no stray `*` / `**` markdown characters, which the Assist app showed literally) and refers to your devices by their friendly names instead of technical entity IDs — so responses read naturally on voice and on your phone.

## 2.2.1

- Security and dependency refresh for the bundled server (updated file-upload handling, the network client, and the Anthropic client, among others). No change in behaviour — quiet housekeeping.

## 2.2.0

- **Nives can now power AI Task automations.** Use the `ai_task.generate_data` action to get an answer — or structured data — reasoned with what Nives knows about you. For example, triage a motion or doorbell event into a priority level right inside an automation. (Text for now; image analysis is coming later.)

## 2.1.15

- **Nives now has its icon in the Integrations dashboard.** The integration ships its own brand icon and logo, so the "icon not available" placeholder is replaced with the Nives mark (on Home Assistant 2026.3 and newer).

## 2.1.14

- **Automations now use what Nives knows about you.** Ask for something like "turn on the lights every evening" and Nives uses *your* sense of evening (or your preferred brightness) instead of a generic guess — and if it doesn't know yet, it'll ask once and remember for next time.

## 2.1.13

- **Voice follow-ups now keep listening.** On Home Assistant Voice (and other Assist satellites), when Nives ends a reply with a question it now tells Home Assistant to reopen the microphone — so you can answer straight away without repeating the wake word. Thanks to the detailed community report that pinpointed this.

## 2.1.12

- **More reliable automation actions.** Nives now builds notification and device actions correctly even if the underlying details are phrased loosely — so creating an automation that messages your phone just works.

## 2.1.11

- **Creating an automation now reliably completes on your first "yes."** A follow-up fix to the confirmation flow so it no longer keeps re-asking after you've already confirmed.

## 2.1.10

- **Fixed: creating an automation could get stuck re-asking "shall I create it?" without ever creating it.** Confirming now reliably goes through — describe what you want, say yes, and the automation is created.

## 2.1.9

- **Nives always checks with you before touching your automations.** Creating, editing, or deleting an automation now reliably shows you exactly what it will do and waits for your "yes" first — so nothing in your setup changes without your say-so.

## 2.1.8

- **Edit automations just by asking.** Say *"change that to 22:00"* or *"have it also turn off the hallway light"* and Nives will update an automation it created — always with your confirmation first.
- **More reliable notifications.** When you ask Nives to set up an automation that messages your phone, it now confirms your real notification target before creating it — so those alerts reliably land where they should.

## 2.1.7

- **Nives can now manage the automations it makes.** Ask *"what automations have you set up?"* to see them, or *"delete the living room one"* to remove it — Nives always names the automation and checks with you before deleting anything.

## 2.1.6

- **New: Nives can create automations for you.** Ask for something like *"turn the porch light on at sunset every day"* or *"switch the office lights off at 23:00"* and Nives will set up the Home Assistant automation. It always checks with you before creating anything, and every automation it makes is named with a **"Nives: "** prefix so you can easily find — or tweak — it under Settings → Automations.

## 2.1.5

- Fresh new look: Nives now has its own icon and logo — a green snow-crystal mark you'll see in the add-on store and across nives.house. Same Nives under the hood.

## 2.1.4

- Routine dependency refresh for the bundled server (Anthropic client, esbuild, and supporting libraries). No change in behaviour — quiet housekeeping.

## 2.1.3

- Refreshed the documentation — a clearer guide to powering Nives (Nives Cloud vs bring-your-own-key) and updated setup instructions. No change to the add-on itself.

## 2.1.2

- Routine dependency refresh for the bundled server (Anthropic client + Node type definitions). No change in behaviour — quiet housekeeping.

## 2.1.1

- Routine dependency refresh for the bundled server (including the OpenAI client and test tooling) and the build's CI actions. No change in behaviour — quiet housekeeping.

## 2.1.0

- **Nives Cloud now manages your AI models for you.** Each plan maps to a curated set of models that we keep current behind the scenes — when we add or refresh a model, your add-on picks it up automatically, with nothing for you to install or configure. If a model is ever briefly unavailable, Nives moves on to the next one in your plan so your assistant keeps working. (BYOK mode is unchanged — you stay in full control of your own model choice.)

## 2.0.7

- Updated the bundled server's core libraries — including a major refresh of the underlying web framework and the AI client libraries — to keep Nives current and well-supported. Behaviour is unchanged; this is a quiet housekeeping release.
- Added an automated test suite that now runs on every change, so future updates ship with more confidence.

## 2.0.6

- Refreshed the bundled server's dependencies to pick up upstream security patches (uuid, express, and the transitive `qs` package). Nives behaves exactly the same — this is a quiet housekeeping release that keeps the image current.

## 2.0.5

- **More accurate "when did X start today?" answers.** Previously, asking when solar production or any rate/power/flow sensor started today could return a pre-dawn time (e.g. "4 AM") that was really just the inverter's idle current or sensor noise. Nives now ignores those near-zero readings and either cites when the value first crossed a meaningful fraction of today's peak or describes the ramp ("ramped up through the morning") — whichever fits the data better. Works the same way regardless of season, latitude, or sensor type.
- **Correct "today" range on history queries.** When the AI asked Home Assistant for "today's" data, it was using midnight UTC instead of your local midnight — so the first hours of your actual local day were missing from the query window. Nives now hands the AI your local midnight (in UTC form) directly, so "how much did the solar make today?" or "any motion since midnight?" line up with the day you're actually living in, regardless of your timezone.

## 2.0.4

- **Better answers for "how's solar production?", "when did X start?", and "any motion at the gate?" style questions.** Nives's system prompt now pushes the AI to search Home Assistant for entities before saying "I can't help" — so questions about systems that weren't in the initial cheat sheet (solar, energy meters, security devices, anything in HA) get answered after a quick search instead of being declined.
- **Smarter handling of "today's X" questions.** Nives now knows that the current state of a `*_current_power` sensor is the live reading, not the day's total — so asking "how much did the solar make today?" pulls daily history, not whatever the panels are doing right now.
- **No more "solar started at 4 AM" mistakes** on noisy sensors. Pre-dawn sensor noise on solar inverters or other cumulative sensors is now treated as noise — Nives picks a meaningful threshold or describes the ramp rather than naming the first non-zero reading.

## 2.0.3

- **Helpful error messages instead of "I received your request but got no response."** When the AI fails to produce an answer, Nives now tells you *why* — whether the response was cut off at the token limit, blocked by the provider's content filter, or the model just returned nothing usable. Previously every failure showed the same generic message regardless of cause, which made diagnosing problems frustrating. The new messages also point you at the specific setting to try next when one applies.
- **Two new advanced settings for BYOK users running picky local models** (Ollama / LM Studio etc.). If your fact extractor was silently returning nothing, you can now nudge it with `OPENAI_RESPONSE_FORMAT=json_object` (asks the provider for strict JSON output) and `OPENAI_MAX_TOKENS=2048` (raises the output budget). These are passed via the addon's "Server-level environment" config and only affect fact extraction — chat is unaffected. Defaults are unchanged, so existing setups behave the same.

## 2.0.2

- Fixed a history-lookup bug that prevented Nives from answering "today's solar production" style questions. When the AI included its local timezone (e.g. `+02:00`) in a history query, the request was silently rejected with a 400 from Home Assistant. Conversations that depended on history would then loop, give up, or fall back to less-accurate live readings. Queries about energy production, past events, and "when did X happen?" now resolve cleanly on the first try.

## 2.0.1

- Refreshed the bundled server's dependencies to pick up upstream security patches (multer, undici, and a few transitive packages). Nives behaves exactly the same — this is a quiet housekeeping release that keeps the image current.

## 2.0.0 — renamed to Nives

The add-on previously known as **HomeMind PRO** is now called **Nives**. Same product, same memory layer, same modes — new identity that's easier to address by voice and gives the add-on its own name (separate from the open-source `home-mind` project it grew out of).

**What changes for you:**

- **Clean install required.** Because the underlying add-on slug changed, v2.0.0 installs as a brand-new add-on alongside the older HomeMind PRO rather than replacing it. To switch over: install Nives from the same repository, copy your configuration across, then uninstall the old HomeMind PRO. Memories and conversation history don't carry across — you start fresh on Nives.
- **New home on the web: [nives.house](https://nives.house).** Cloud sign-up, your account dashboard, and these docs all live there now. The old `homemindpro.com` redirects to the new site, so any links you've saved keep working.
- **Same behaviour, new labels everywhere.** Cloud and BYOK modes work identically to v1. The integration domain, conversation agent name, s6 service names, and every UI string now read "Nives" instead of "HomeMind PRO".

About the name: *Nives* is a Slovenian female name, from Latin *nives* — "snows". Pronounced **NEE-ves**.

## 1.0.28

- More forgiving memory-layer parsing. The fact extractor now tolerates trailing text after JSON, single-fact responses (some AI models return either of those instead of strict JSON arrays), and a few related variants. If you've ever noticed the assistant not remembering something you clearly told it, this should reduce those misses.

## 1.0.27

- **Memory layer actually upgraded to Shodh-Memory v0.2.0.** v1.0.20's CHANGELOG announced this upgrade, but a build-configuration mismatch caused every CI build since then to keep shipping v0.1.91 in the actual image. This release corrects that — production now gets the v0.2.0 binary the codebase has been pinning all along. v0.2.0 brings entity salience, NER-based filtering, curvature-weighted retrieval, glacial exponential decay, and the MCP orphan-process fix. Existing memory data migrates automatically thanks to dual-decode (postcard + legacy bincode) on read paths — no user action needed.

## 1.0.26

- Behind-the-scenes maintenance update. No change to how the add-on works — Cloud and BYOK behave exactly as before.

## 1.0.25

- **Honest BYOK framing in docs and UI** — the README, DOCS, and HA config UI no longer suggest BYOK is easy or supported the same way Cloud is. "Easiest setup" framing is gone; Cloud is now explicitly the curated/supported path, BYOK is labelled best-effort. The DOCS BYOK section now leads with two upfront requirements: the selected model **must** support function/tool calling (or chat fails with the provider's "No endpoints found that support tool use" 404), and memory extraction quality varies by model. Users wanting deep local/Ollama setups are pointed at the open-source [home-mind](https://github.com/hoornet/home-mind) project, which is purpose-built for that. No code change — documentation and HA UI strings only. Driven by a real user mistaking BYOK as "just working" out of the box.

## 1.0.24

- **Stop executing time-anchored requests immediately** — when a user said "turn on the kitchen lights at 20h", the assistant was reaching for `call_service` right away and ignoring the time anchor, then offering to set up an automation through the HA UI as an afterthought. The system prompt now has a `SCHEDULED / RECURRING ACTIONS` section that tells the LLM not to `call_service` when the request includes a time anchor (`at 20h`, `every evening`, `tomorrow`, `daily`, `when X happens`), and instead acknowledge the scheduled intent and save it as a remembered preference until automation creation is supported. Honest about the limitation rather than papering over it. Added to both text and voice prompt variants.

## 1.0.23

- **Read Shodh's Hebbian `strength` field as confidence** — the recall path now uses `mem.strength ?? mem.importance` instead of just `importance`. `importance` is the value the client stored at write time; `strength` is the field Shodh updates on each recall hit per its LTP/Hebbian model. We were reading the static input back as confidence, which is why facts looked frozen at extraction confidence forever despite repeated use. Falls back to `importance` if Shodh's response shape doesn't include `strength`, so behavior is unchanged where the new field isn't present.
- **One-shot Shodh memory shape log** — the first recall after each process start prints `[shodh-shape] first recall memory keys` + full JSON, so the addon log shows exactly which fields Shodh returns (strength, access_count, last_accessed, …). Fires at most once per process; useful for any future debug session.

## 1.0.22

- **Protect frequently-used facts from cleanup** — the cleanup job now rescues facts with `useCount >= 3` from the low-confidence rule. A fact that has been recalled and used three or more times is load-bearing for the user even if its original extraction confidence was low (Haiku tends to land 0.25–0.35), so deleting it on the next sweep is exactly wrong. Pattern-based rules (transient state, device spec, command echo, too-short content) are not rescued — useCount cannot immortalize actual garbage. Closes the gap that v1.0.21's threshold drop only narrowed.

## 1.0.21

- **Fix silent fact-forgetting** — the cleanup job was deleting every extracted fact within 6 hours because the garbage filter treated any fact with `confidence < 0.5` as low-confidence and purged it. Real-world extracted facts (Haiku) consistently land around 0.25–0.35, so the facts layer would silently wipe itself every cleanup cycle even while the user kept telling the assistant things worth remembering. Threshold lowered from 0.5 to 0.2 in `fact-patterns.ts`. Pattern-based filters (transient state, device specs, command echo, too-short content) still run and catch the actual garbage.

## 1.0.20

- **Shodh upgrade v0.1.91 → v0.2.0** — entity salience, NER-based filtering, curvature-weighted retrieval, causal lineage inference, glacial exponential decay, and MCP orphan process fix. Read paths dual-decode (postcard + legacy bincode), so existing memory data stays readable and gradually converts to the new format on natural writes — no user migration step required.
- **Run Shodh in production mode** — the Shodh server now launches with `--production` + `SHODH_API_KEYS`, removing the "DEVELOPMENT mode" security banner that was printed on every boot.
- **Pre-seed ONNX Runtime in image** — Shodh v0.2.0's first-boot ONNX download writes a broken `libonnxruntime.so` that causes `expected OrtGetApiBase` panics on NER init. The Docker image now pre-installs ONNX Runtime v1.23.2 at Shodh's cache path with the correct symlink, so first boot is clean and NER works without a restart cycle.

## 1.0.19

- **Reasoning-model fact extractor fix** — strips `<think>...</think>` blocks (Qwen3, DeepSeek-R1, etc.) before JSON parsing, and raises the extractor's `max_tokens` budget 500 → 1000 so reasoning models don't run out of budget inside their thinking phase. Empty responses now warn cleanly instead of throwing. Fact extraction no longer silently fails when using reasoning models.
- **Hard fork declaration** — `server/` is no longer treated as a synced copy of `home-mind`. Documentation updated to reflect that HomeMind PRO and the OSS `home-mind` are independent products; a fix that belongs in both must be applied twice, with intention.

## 1.0.18

- **Fix recall** — facts that were saved to memory but not being returned on recall (e.g. "what's my passkey?" answered with "I don't know" even though the fact existed under `/api/memory/{userId}`). Retrieval now always pulls the user's tagged fact set; proactive-context results are merged on top as a query-relevance boost and deduped. Bundles home-mind-server v0.15.0.
- Raise `MEMORY_TOKEN_LIMIT` default 1500 → 3000 so more facts fit in the system prompt by default (prompt caching makes the extra tokens essentially free).
- Add `[recall]` debug log under `LOG_LEVEL=debug` for diagnosing recall issues.

## 1.0.17

- Restructure configuration into clear Cloud and BYOK sections — no more overlapping fields
- Fix all "Home Mind" references to "HomeMind PRO" throughout docs and UI
- Restructure DOCS.md with separate Cloud and BYOK setup guides

## 1.0.16

- Pre-download MiniLM-L6-v2 ONNX model into Docker image — Shodh now uses full semantic search instead of falling back to hash-based embeddings

## 1.0.15

- When monthly usage limit is reached, show a persistent HA notification and return a clear spoken message instead of a generic error

## 1.0.14

- Auto-restart HA Core after integration install/update so discovery works without manual restart

## 1.0.13

- Fix auto-update: keep integration manifest version in sync with add-on version

## 1.0.12

- Modernise integration for HA 2026: use runtime_data, ConfigFlowResult, typed HassioServiceInfo
- Fix device name showing as "Home Mind" instead of "HomeMind PRO"
- Fix error responses leaking internal details to voice/text output
- Remove broken is_voice heuristic

## 1.0.11

- Fix integration auto-discovery: add `hassio` field to manifest.json so HA Core routes Supervisor discovery to our config flow

## 1.0.10

- Fix Supervisor discovery: wrap host/port in `config` key per HA API spec
- Fix config_flow: skip connectivity check during hassio discovery (HA Core → add-on routing not available at config time)

## 1.0.9

- Bump bundled server to v0.14.0 (auto-detect language, OpenRouter attribution, Shodh v0.1.91, security hardening)
- Fix conversation agent entity name to "HomeMind PRO" in Assist

## 1.0.8

- Rename integration display name to "HomeMind PRO" throughout the HA UI

## 1.0.7

- Add GitHub Actions CI/CD — builds and pushes multi-arch images on every push to master
- Pre-built images published to `ghcr.io/hoornet/homemind-pro-{arch}` (amd64 + aarch64)
- config.yaml now references pre-built GHCR images — faster installs, no local Docker build on HA
- GHA build cache per arch reduces incremental build times

## 1.0.6

- Fix config validation error when `llm_base_url` is empty (HA rejects empty string as invalid URL)

## 1.0.5

- Add OpenRouter as a first-class LLM provider option (no more "openai" workaround)
- Cloud mode now routes directly to OpenRouter (replaces old metering proxy)
- Default model for OpenRouter: `anthropic/claude-haiku-4.5`
- Updated config descriptions with OpenRouter model ID examples

## 1.0.4

- Auto-install Home Mind HA integration on startup — no HACS required
- Bundled integration files are copied to `/config/custom_components/home_mind/`
- Auto-updates when a newer version is bundled
- Truly one-click install: add-on handles everything

## 1.0.3

- Fix HA API 401 errors — use Supervisor internal proxy (`http://supervisor/core`) instead of direct HA access
- Add-ons must route HA API calls through the Supervisor, not directly to `homeassistant:8123`

## 1.0.2

- Add diagnostics for Supervisor token injection
- Confirmed SUPERVISOR_TOKEN is present (112 chars) — issue was routing, not auth

## 1.0.1

- Fix Shodh startup failure — call `shodh server` binary directly instead of wrapper script
- Fix Dockerfile for HA Supervisor build context (clone server from GitHub at build time)
- Remove pre-built image reference (local builds only until CI/CD is set up)

## 1.0.0

- Initial release
- Bundles home-mind-server + Shodh Memory in a single HA add-on
- Two LLM modes: Cloud (managed proxy) and BYOK (bring your own key)
- Supports Anthropic, OpenAI, and Ollama providers
- Persistent conversation history (SQLite)
- Cognitive memory with semantic search (Shodh)
- Automatic HA integration via Supervisor API (no manual URL/token config)
- Memory leak watchdog for Shodh (auto-restart at 512MB RSS)
- Architectures: amd64, aarch64 (RPi4/5)
