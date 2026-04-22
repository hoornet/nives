# Changelog

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
