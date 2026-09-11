# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

```
HA Assist (Voice/Text) → HA Custom Component (Python) → Home Mind Server (Express/TS) → LLM API (Anthropic/OpenAI/Ollama) + Shodh Memory + HA REST API
```

**Single path, no fallbacks.** All interactions flow through home-mind-server. Shodh Memory is the only memory backend (required, no SQLite fallback). LLM provider is selected via `LLM_PROVIDER` env var (default: `anthropic`).

### Home Layout Index

`TopologyScanner` (`ha/topology-scanner.ts`) runs at startup and every 30 minutes. It uses the HA template API (`POST /api/template`) with a single Jinja2 query that calls `floors()`, `floor_name()`, `floor_areas()`, `area_name()`, `area_entities()`, and `areas()` (available since HA 2024.4). Unassigned areas are derived by exclusion — areas not returned by any `floor_areas()` call.

Builds a compact `floor → room → [entity_ids]` text section and injects it into every system prompt alongside the device cheat sheet. This gives the LLM spatial awareness without tool calls — it knows which floor and room every device belongs to before reasoning begins.

If the template API fails (older HA, network error), the scanner logs a warning and injects nothing — the rest of the system works normally.

### Device Capability Index

`DeviceScanner` (`ha/device-scanner.ts`) runs at startup and every 30 minutes. It fetches all `light.*` entities, reads `supported_color_modes` attributes, and builds `DeviceCapabilityProfile` objects with pre-computed `whiteMethod` and `colorMethod`. These are formatted as a markdown cheat sheet and injected into every system prompt via `buildSystemPrompt()` / `buildSystemPromptText()`.

**White method precedence**: `rgbw`/`rgbww` → `rgbw_color: [0,0,0,255]`; `color_temp` → `color_temp_kelvin`; `rgb`/`xy`/`hs` → `rgb_color: [255,255,255]`; else → none.

**`DEVICE_OVERRIDES`** env var (JSON) allows per-entity overrides for devices with incorrect HA-reported modes (e.g. Gledopto GL-C-008P always reports `color_temp+xy` regardless of wiring). Overrides are applied after auto-detection. Fields: `whiteMethod` and/or `colorMethod`.

### Request Flow (IChatEngine.chat)

1. Load user's facts from Shodh via semantic search (query = current message)
2. Refresh DeviceScanner + TopologyScanner if stale (both run in parallel via `Promise.all`)
3. Build system prompt: static part (cached via `cache_control: ephemeral` for Anthropic, plain string for OpenAI) + dynamic part (facts + datetime + home layout + device cheat sheet)
3. Load conversation history from `IConversationStore` (keyed by conversationId)
4. Stream response with tool loop (parallel tool execution)
5. Fire-and-forget fact extraction (extracts facts, replaces conflicting old ones)
6. Return response to caller

### Two LLM Calls Per Request

- **Chat**: `IChatEngine` — handles conversation + HA tool calls. Implementations: `LLMClient` (Anthropic), `OpenAIChatEngine` (OpenAI/Ollama)
- **Extraction**: `IFactExtractor` — extracts facts from conversation (async, non-blocking). Implementations: `FactExtractor` (Anthropic), `OpenAIFactExtractor` (OpenAI/Ollama)

Provider is selected at startup by `llm/factory.ts` based on `LLM_PROVIDER` config.

### Memory Architecture

- **Long-term facts**: Shodh Memory (external service, semantic search, Hebbian learning, natural decay)
- **Conversation history**: `IConversationStore` with two backends: `InMemoryConversationStore` (default, lost on restart) and `SqliteConversationStore` (persistent via `better-sqlite3`). Controlled by `CONVERSATION_STORAGE` env var (`memory` | `sqlite`). Max 20 messages/conversation. **The add-on always sets `sqlite`.**
- **Known users** live in their own `users` table (sqlite) / `knownUsers` set (memory) — deliberately *not* derived from conversation rows, which `cleanupOldConversations()` prunes after 24h. Deriving them from messages is what silently disabled `MemoryCleanupJob` in every release before 2.3.3 (live logs showed "[cleanup] No known users" on every run for a week while Shodh held 67 facts).
- **Entity cache**: 10-second TTL in HomeAssistantClient (invalidated after service calls)
- **Fact categories**: baseline, preference, identity, device, pattern, correction
- **Smart replacement**: Extractor identifies existing facts that new facts supersede (via `replaces` field)

## Development Commands

All commands run from `src/home-mind-server/`:

```bash
npm run dev          # tsx watch (hot reload), starts at localhost:3100
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # vitest run
npm run test:watch   # vitest (watch mode)
npm run test:coverage # vitest with v8 coverage

# Single test file
npm test -- src/memory/shodh-client.test.ts

# Single test by name
npm test -- -t "can check health"
```

Requires Shodh Memory running at SHODH_URL. For local dev: `cp .env.example .env` and fill in credentials.

## Testing Patterns

Vitest with `globals: true`. Tests mock constructors using `class` syntax in `vi.mock()` factories (not `vi.fn().mockImplementation()`) because the code uses `new`. Config tests use `vi.resetModules()` + dynamic `import()` to test different env var configurations.

Integration tests (e.g., `shodh-client.test.ts`) only run when `SHODH_TEST_URL` and `SHODH_TEST_API_KEY` are set — otherwise `describe.skip`.

## Code Patterns

**ES Modules with `.js` extensions** in TypeScript imports (required by `moduleResolution: "NodeNext"` in tsconfig):
```typescript
import { loadConfig } from "./config.js";
```

**Zod validation** for all config and request schemas. Config loads from env vars via `loadConfig()` in `config.ts` — exits process on validation failure. Uses `emptyToUndefined()` helper because Docker Compose sets empty strings (not `undefined`) for unset env vars.

**HA tool definitions** are provider-neutral `ToolDefinition[]` in `llm/tool-definitions.ts`, converted to provider format via `toAnthropicTools()` / `toOpenAITools()`. Eleven tools: `get_state`, `get_entities`, `search_entities`, `call_service`, `get_history`, `create_automation`, `list_automations`, `delete_automation`, `update_automation`, `list_services`, `forget_memory`. Shared execution logic in `llm/tool-handler.ts`. The automation create/update/delete tools run through a server-enforced confirmation gate (`llm/automation-confirmations.ts`) — first call previews, a later-turn re-call commits, **scoped by a stable identity** (entity_id for update/delete, normalized alias for create). The payload is never compared: the model reformats it wildly between turns, which is what made the v2.1.10 fingerprint approach loop forever. Create had no identity key at all until 2.3.3, so any create in a later turn confirmed any earlier create preview.

`forget_memory` (conversational memory deletion, issue #54) takes a content `query` — never a fact id (ids aren't shown to the model and can't survive turns). The handler resolves it deterministically against ALL of the user's facts (`memory/fact-resolution.ts`: exact normalized match, else Dice over token sets; ambiguity → candidates, no action) and gates through the same confirm module using an `identityOverride` = the resolved fact's **normalized content** — so a reworded confirm-turn query still commits, and extraction re-adding the content under a new Shodh id between preview and confirm can't cause an id mismatch. Commit deletes every duplicate id of the content group. Every forget_memory invocation (preview, commit, ambiguous, near-miss) appends the memories it touched to `ToolContext.forgetTargets`, which both engines hand to `extractAndStoreFacts`; extraction then **runs as usual but drops any extracted fact scoring ≥ `FORGET_FILTER_THRESHOLD` (0.85) against a touched memory**. Filtering rather than suppressing is deliberate: "forget that my name is Jure, my name is now HAL 9000" must forget the old fact AND learn the new one, and a same-frame replacement scores ~0.73 while a reworded re-learn scores ~0.91 — hence the much higher threshold than resolution's 0.6. Engines pass ONE shared `ToolContext` per turn so tool calls can write `forgetTargets` back.

**Tool loop is capped** at `MAX_TOOL_ITERATIONS` (8) in both engines. On the final iteration the request is re-issued with tool calling disabled (`tool_choice: "none"` / `{type: "none"}`) so a stuck model produces a written answer rather than running to the integration's 120s timeout, burning the user's allowance. Tool arguments are parsed defensively — malformed JSON becomes a retryable tool error, never an exception that fails the whole request (cheap models emit these). `/api/chat` also accepts an optional `images` array (data URLs) → forwarded as multimodal content to vision-capable models (used by the integration's `ai_task` entity for camera-snapshot analysis).

**Prompt caching**: System prompt split into static (cached) + dynamic (facts/datetime) blocks in `llm/prompts.ts`. Two variants: regular and voice (shorter). Custom prompt replaces the default identity line (opening sentence) rather than appending — this gives it maximum authority over persona. Dynamic block includes both human-readable datetime with UTC offset (e.g., `10:15 PM CET (UTC+1)`) and a raw ISO timestamp for unambiguous tool use.

**Timestamp normalization**: `normalizeTimestamp()` in `tool-handler.ts` appends `Z` to bare ISO timestamps (no timezone suffix) before passing them to HA. This prevents HA from misinterpreting timezone-naive timestamps from the LLM. All tool calls are debug-logged with `[tool]` prefix showing name, input, and elapsed time.

**HA light service data fields**: `brightness` (0-255), `rgb_color` ([R,G,B] each 0-255), `color_temp_kelvin` (2000-6500; 2700=warm white, 4000=neutral, 6500=daylight), `hs_color` ([hue 0-360, saturation 0-100]), `rgbw_color` ([R,G,B,W] each 0-255). For white light on RGBW strips (WLED etc.), use `rgbw_color: [0,0,0,255]` — the dedicated white LED channel. `color_temp_kelvin` is accepted by HA but WLED doesn't render it correctly on RGBW strips. For non-RGBW lights, `color_temp_kelvin` works fine. Check `supported_color_modes` in entity attributes to determine which mode to use. There is no separate `set_color` service — use `light.turn_on` with data fields. These are documented in `call_service` tool description in `tool-definitions.ts`.

**White light mode selection** (by `supported_color_modes`): `rgbw` → `rgbw_color: [0,0,0,255]`; `color_temp` only → `color_temp_kelvin`; `xy`/`hs`/`rgb` (RGB-only, no white channel) → `rgb_color: [255,255,255]`. RGB-only lights (e.g. Gledopto GL-C-008P) cannot render `color_temp_kelvin` even though HA accepts it — they need explicit RGB values.

**Shodh type mapping**: Our fact categories map to Shodh memory types (e.g., `baseline` → `Observation`, `preference` → `Preference`) in `shodh-client.ts`.

**Self-signed TLS**: HA client uses undici Agent with `rejectUnauthorized: false` when `HA_SKIP_TLS_VERIFY=true`. Note: when the server runs in Docker and connects to HA over LAN, use `http://` in `HA_URL` — HA typically only serves HTTPS via add-ons or reverse proxies (e.g. Tailscale), not on the raw LAN IP. Using `https://` against a plain HTTP endpoint causes SSL handshake failures even with `HA_SKIP_TLS_VERIFY=true`.

**Token estimation**: Uses `content.length / 4` as rough token count (4 chars ≈ 1 token) for fact budget limiting.

**JSON from LLMs**: Both fact extractors strip markdown code fences (`` ```json ... ``` ``) before `JSON.parse()` — LLMs sometimes wrap JSON responses.

**Startup sequence**: Server checks Shodh health (`memory.isHealthy()`) and exits with `process.exit(1)` if unhealthy, before Express starts listening. Graceful shutdown handles SIGTERM/SIGINT and calls `memory.close()`.

**SSE streaming**: `/api/chat/stream` sends `event: chunk` for text, `event: done` with full response, `event: error` on failure. Calls `res.flushHeaders()` immediately. Both `/api/chat` and `/api/chat/stream` use the same `llm.chat()` internally — non-streaming just omits the `onChunk` callback.

### HA Integration Gotchas (Python)

**HA conversation agent** uses `intent.IntentResponse` (not `conversation.IntentResponse`):
```python
intent_response = intent.IntentResponse(language=user_input.language)
intent_response.async_set_speech(response)
return ConversationResult(response=intent_response)
```

**OptionsFlow has no `__init__`** — passing `config_entry` to the superclass constructor breaks in newer HA versions (fixed in v0.9.1).

**Voice detection**: Detected via `user_input.agent_id is not None` (not HA metadata), sets `isVoice=true` on server request.

**Conversation IDs**: Uses `ulid.ulid_now()` (not UUID).

**120-second timeout**: `DEFAULT_TIMEOUT = 120` for API calls because tool-using LLM responses can take 60+ seconds.

## Environment Variables

Server requires: `HA_URL`, `HA_TOKEN`, `SHODH_URL`, `SHODH_API_KEY`, plus the API key for the selected provider (not needed for Ollama).

LLM config:
- `LLM_PROVIDER` — `anthropic` (default), `openai`, or `ollama`
- `LLM_MODEL` — model ID (default: `claude-haiku-4-5-20251001`; must be set explicitly for Ollama)
- `ANTHROPIC_API_KEY` — required when `LLM_PROVIDER=anthropic`
- `OPENAI_API_KEY` — required when `LLM_PROVIDER=openai`
- `OPENAI_BASE_URL` — optional, for OpenAI-compatible APIs (Azure, local proxies)
- `OLLAMA_BASE_URL` — optional, Ollama API endpoint (default: `http://localhost:11434/v1`)

Optional: `PORT` (default 3100), `API_TOKEN` (bearer token for auth — when set, all endpoints except health require it), `HA_SKIP_TLS_VERIFY`, `MEMORY_TOKEN_LIMIT` (default 3000), `LOG_LEVEL`, `CONVERSATION_STORAGE` (`memory` | `sqlite`, default `memory`), `CONVERSATION_DB_PATH` (default `/data/conversations.db`, only used when `CONVERSATION_STORAGE=sqlite`), `CUSTOM_PROMPT` (server-level default custom system prompt), `TZ` (timezone for the Docker container, default `Europe/Prague` in docker-compose; Node.js uses this for `toLocaleString()` so the LLM sees correct local time)

### Nives Cloud Mode

There is **no proxy**. In cloud mode `options-to-env.sh` sets `LLM_PROVIDER=openai` plus a base URL and the user's provisioned key, and the add-on calls that endpoint directly — nothing in the request path goes through us. Read `rootfs/usr/local/bin/options-to-env.sh` for the exact values; they are not restated here, because a doc that repeats them serves no purpose the script does not already serve.

The model is not hardcoded: at boot the add-on asks `GET https://nives.house/api/addon/config` (bearer = the user's key) which returns `@preset/nives-<tier>`, so the model lineup is managed server-side with no add-on release. Bounded and failure-safe — an 8s timeout, falling back to `@preset/nives-standard` if the cloud is briefly unreachable. Chat itself never goes through nives.house.

> Historical note: this section used to describe a "Home Mind Cloud metering proxy" (`OPENAI_BASE_URL=<proxy>/v1`). That proxy was retired and its repo is archived under `Legacy/`. Nothing in the request path goes through us any more.

STT (optional): `STT_PROVIDER` (`openai` | `none`, default `none`), `STT_API_KEY` (overrides `OPENAI_API_KEY`), `STT_BASE_URL` (custom Whisper-compatible endpoint), `STT_MODEL` (default `whisper-1`)

TTS (optional): `TTS_PROVIDER` (`openai` | `none`, default `none`), `TTS_API_KEY` (overrides `OPENAI_API_KEY`), `TTS_BASE_URL` (custom OpenAI-compatible endpoint), `TTS_MODEL` (default `tts-1`), `TTS_VOICE` (default `alloy`)

Integration tests: `SHODH_TEST_URL`, `SHODH_TEST_API_KEY`

## Authentication

Optional bearer token auth via `API_TOKEN` env var. When set, all endpoints except `/api/health` require `Authorization: Bearer <token>`. When unset, all requests pass through (backward compat with existing HA integrations).

- **Health endpoint** (`/api/health`) is always public, even when auth is enabled
- **Timing-safe comparison** prevents timing attacks on the token
- **HACS config flow** validates tokens against `/api/memory/{userId}` (not `/api/health`, since health bypasses auth)

## API Endpoints

- `POST /api/chat` — Full response (uses streaming internally). Body: `{ message, userId?, conversationId?, isVoice?, customPrompt? }`
- `POST /api/chat/stream` — SSE streaming (`event: chunk` then `event: done`). Same body as `/api/chat`
- `POST /api/stt` — Transcribe audio. Multipart `audio` field. Returns `{ text }`. 501 if `STT_PROVIDER=none`.
- `POST /api/tts` — Synthesize speech. Body `{ text, language? }`. Returns `audio/mpeg`. 501 if `TTS_PROVIDER=none`.
- `GET /api/health` — Health check (always public, bypasses auth)
- `GET /api/memory/:userId` — List user's facts
- `POST /api/memory/:userId/facts` — Add fact manually
- `DELETE /api/memory/:userId` — Clear all facts
- `DELETE /api/memory/:userId/facts/:factId` — Delete specific fact
- `GET /api/conversations/:userId` — List conversations
- `GET /api/conversations/:userId/:conversationId` — Get conversation messages
- `DELETE /api/conversations/:userId/:conversationId` — Delete conversation
- `GET /api/admin/conversations` — All users + conversation summaries (auth required)

## Deployment

**How this actually ships:** as part of the Nives add-on, not standalone. The add-on's `nives/Dockerfile` builds this source in a Node stage, and s6-overlay runs it alongside Shodh in one container. Shodh comes from a **GitHub release binary** (both `linux-x64` and `linux-arm64` — the official Docker image is amd64-only), not from Docker Hub. See `nives/CLAUDE.md` for the s6 service layout and the config bridge.

**The HA integration is not installed via HACS.** It ships inside this repo at `nives/rootfs/opt/nives/` and the `install-integration` s6 oneshot copies it into `/config/custom_components/nives/` on startup, version-gated against `manifest.json`. Users never touch HACS. (The old `home-mind-hacs` repo belongs to the OSS sister project and is archived under `Legacy/` — don't reference it here.)

**Standalone dev only:** the `docker-compose.yml` in this directory runs `shodh` (port 3030) and `server` (port 3100) as two services for working on the server outside HA. That path uses the `varunshodh/shodh-memory` image, pinned by tag and digest, via a thin wrapper (`docker/shodh/Dockerfile`) that fixes volume permissions, and `deploy.sh` auto-generates `SHODH_API_KEY`. It is not how the add-on runs.

## Known Limitations

- Single-user only (multi-user via OIDC planned)
- Conversation history lost on server restart by default (set `CONVERSATION_STORAGE=sqlite` for persistence)
- Both chat and extraction use the same model (configured via `LLM_MODEL`)
- Fact extraction sometimes stores transient state or LLM hallucinations (improvement planned)
