# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

```
HA Assist (Voice/Text) → HA Custom Component (Python) → Home Mind Server (Express/TS) → LLM API (Anthropic/OpenAI/Ollama) + Shodh Memory + HA REST API
```

**Single path, no fallbacks.** All interactions flow through home-mind-server. Shodh Memory is the only memory backend (required, no SQLite fallback). LLM provider is selected via `LLM_PROVIDER` env var (default: `anthropic`).

### Home Layout Index

`TopologyScanner` (`ha/topology-scanner.ts`) runs at startup and every 30 minutes. It uses the HA template API (`POST /api/template`) with a single Jinja2 query that calls `floors()`, `floor_name()`, `floor_areas()`, `area_name()`, `area_entities()`, and `areas()` (available since HA 2024.4). Unassigned areas are derived by exclusion — areas not returned by any `floor_areas()` call.

Builds a compact `floor → room → [entity_id (friendly name)]` text section (entities without a name stay bare ids; an area too big to render with names falls back to bare ids) and injects it into every system prompt alongside the device cheat sheet. This gives the LLM spatial awareness without tool calls — it knows which floor and room every device belongs to before reasoning begins.

If the template API fails (older HA, network error), the scanner logs a warning and injects nothing — the rest of the system works normally.

### The Assist exposure list bounds the room map and the tools

Settings → Voice assistants → Expose is the user's own list of what an assistant may see, and Home Assistant's own agent builds both its prompt and its live-context tool from it, so an unexposed entity does not exist for that agent. The list is websocket-only (`ha/exposed-entities.ts`). `AssistExposure` (`ha/exposure.ts`) is one cached reading of it, TTL 1 minute, retried after 60 s when a read fails, with concurrent reads collapsed into one websocket call. `allows` re-reads the list before refusing, paced to once per 10 s (`missRefreshMs`), so a newly exposed entity works on the very next request; a read is one small websocket call, 6 to 25 ms on a 588-entity house. The room map keeps its own 30-minute scan. `index.ts` creates one instance and hands it to the `TopologyScanner` as its exposure provider (`LAYOUT_FROM_EXPOSED`, default on) and to `HomeAssistantClient` (`TOOLS_FROM_EXPOSED`, default on).

With the client bounded, `get_state` and `get_history` refuse an unexposed entity before any request, `get_entities` and `search_entities` return exposed entities only, and `call_service` refuses before the request leaves: a named `entity_id` (string, list or comma-separated), ids in `data.entity_id` or a nested `target.entity_id`, the entity maps and lists of `scene.apply` / `scene.create` / `group.set` (`entities`, `snapshot_entities`, `add_entities`, `remove_entities`), the speaker of `tts.speak` (`media_player_entity_id`) and the speakers of `media_player.join` (`group_members`), `entity_id: "all"`, and any `area_id` / `device_id` / `floor_id` / `label_id` target, which cannot be vetted without resolving it. Running `script.<name>` needs that script exposed. **Voice engines (`tts.*`) are always allowed** (`isVoiceEngine`, applied in `allows` and `filter`, so `search_entities` finds them too; the room map reads `list()` and is unaffected): HA exposes no tts entity by default, an engine can only be heard through a speaker, and the speaker is checked, so requiring the engine exposed protected nothing while blocking every announcement, Nives's own voice included (2.8.3). The refusal text (`notExposedMessage`) tells the model the entity is out of scope and not to retry other spellings. An exposed group still acts on all of its members; Home Assistant's own agent behaves the same.

**The list fails closed (2.10.1).** The websocket read honours `HA_SKIP_TLS_VERIFY` like the REST calls (`fetchExposedEntities(..., { skipTlsVerify })`); without it a self-signed Home Assistant could never be read and would allow nothing. An empty list allows nothing: the tools refuse every entity, `get_entities` returns only voice engines, and the room map is `NOTHING_EXPOSED_LAYOUT`, which tells the model why it sees no devices. `jobs/nothing-exposed-notice.ts` posts a Home Assistant notification (`nives_nothing_exposed`) a minute after startup when the list is empty and clears it when it is not; when the list still can't be read on the second try it posts `nives_exposure_unreadable` instead and keeps checking every 5 minutes until it can, then clears it. A list that has never been read (`list()` returns `null`: HA still starting, no websocket) also allows nothing, with `exposureUnavailableMessage` instead of the not-exposed text, is retried after 60 s, and leaves the room map empty with a rescan a minute later. A refresh that fails mid-session keeps the last good list. Before 2.10.1 both cases meant "no opinion" and reached the whole house. The eval rigs' mock HA has no websocket, so the rigs set `TOOLS_FROM_EXPOSED=false` and `LAYOUT_FROM_EXPOSED=false`; without them the model sees nothing.

**What the assistant may call: an allowlist (`ha/service-policy.ts`, 2.10.1).** The tool handler calls `callServiceAsAssistant`, never `callService`; the add-on's own calls (automation reload, its notifications) use `callService` and are not limited by this. `serviceRefusal` allows only `ALLOWED_SERVICES`, everyday device control by `(domain, service)`, plus `script.<name>` (vetted by name), any `notify.*` (see `notifyRefusal`) and the older `tts.*_say`. It is an allowlist, not a list of blocked services, because Home Assistant has too many services, integrations add their own, and some act on more than the entity they name: add to it deliberately and never go back to blocking. A call must also name what it acts on (an entity other than a voice engine, or an area/device/floor/label for the exposure check to refuse) unless its domain is in `UNTARGETED_DOMAINS` (`notify`, `shopping_list`). With the tools bounded, an untargeted call is refused when the list is empty or unread, and entity-shaped words inside the fields (`collectReach(payload).mentioned`, percent-decoded too) are checked like automation mentions. `notifyRefusal` refuses a `target` on the per-service notify calls (not on `notify.send_message`, whose target entity is checked as named) and the companion app's phone commands, also when a template assembles them; `mediaRefusal` checks every media id at any depth (`*media_id`, `*media_content_id`): a `media-source://` provider must be in `MEDIA_SOURCES` (voices, radio, Jellyfin, DLNA; the local folder `media_source` for audio files only, since camera add-ons record there, browsing allowed), and templates, Home Assistant paths (`/...`) and fetched addresses (http(s), rtsp, file, smb, ...) are refused; ids an integration resolves itself (`plex://`, `library://`, `spotify:`) pass. Calls carrying a `code` to an alarm or lock take an attempt per entity before anything is awaited (`takeCodeAttempt`, so parallel calls count) and stop after `CODE_ATTEMPTS` within `CODE_WINDOW_MS`, successful or not; a code to an area or device is refused. All of this applies with `TOOLS_FROM_EXPOSED=false` too: that option opens up entities, not the system.

**Automations the assistant writes (2.10.1).** `checkActionStep` (`reach.ts`) runs on every object in every section and puts the reason in `Reach.refused`: a service outside the allowlist or naming nothing, the older `service_template` / `data_template` keys, a call's `target` / `data` / `service_data` that is not a plain object, an `event:` action (a step that is not a trigger; zone, sun and calendar triggers use `event` too), a trigger outside `ALLOWED_TRIGGERS`, a device trigger, condition or action (`device_id` with `type`), a `code` for an alarm or lock, and media `mediaRefusal` refuses. Templates are an allowlist too: `isSafeTemplate` (`ha/template-check.ts`) parses every `{{ ... }}` against a small grammar (entity functions with a literal id or `trigger.entity_id`, `states.<domain>.<object>.<field>`, `trigger` / `repeat` / `this` / `wait` attributes, `now()` / `utcnow()` / `today_at()` date parts, `as_timestamp`, literals, arithmetic, comparisons, `and` / `or` / `not`, `a if b else c`, the filters in `FILTERS` with literal arguments) and refuses everything else, `{% %}` statements included. A device can only be read by naming it, and the name is then a mention held to the exposure list. Pattern matching was tried first and could not keep up with what Jinja can express; extend the grammar deliberately rather than adding patterns. Values under `DATA_KEYS` (`data`, `target`, `variables`, ...) are collected as data, not checked as steps. `sun.*` and `zone.*` are not held to the list as mentions. `checkAutomationCreate` / `checkAutomationUpdate` check the sections exactly as written (after `toArray` and `normalizeActions`) and run `validateActionServices`, and the tool handler calls the same methods before the preview. With the tools bounded, no automation can be written while the list is empty or unread. **An automation with any hidden section is left to the user**: the assistant can't change it, rename it or delete it. Without a conversation (`conversationId` / `turnId`, absent on the AI Task path) the gate refuses automation changes, and the catch in `handleToolCall` hands a confirmation back only when the failure happened while writing (`committing`).

**Every name is shape-checked before it reaches a URL.** `assertServiceName` (domain and service `^[a-z0-9_]+$`) runs in `callService` itself, and `normalizeEntityId` (trimmed, lower-cased, `^[a-z0-9_]+\.[a-z0-9_]+$`) in `getState` and `getHistory`, whose `filter_entity_id` would otherwise take a comma-separated list; path segments are also `encodeURIComponent`-ed. A `..` or `/` in any of them would otherwise reach a different endpoint than the one that was checked. `isVoiceEngine` (used as `alwaysAllowed` in `exposure.ts`) tests the whole id, not a `tts.` prefix, for the same reason.

**Automations are bounded too (2.8.2).** `requireExposedAutomation` holds what an automation's triggers, conditions and actions name to the same list, using `collectReach` (`ha/reach.ts`): ids in `entity_id` and in the scene/group keys must be exposed; area/device/floor/label selectors and templated entity ids are refused, because they cannot be vetted; and an entity-shaped word anywhere else (a template, `at: sensor.x`, `action: script.x`) is checked when an entity with that id exists, so `trigger.to_state` and `light.turn_on` pass. `zone.*` is skipped (a zone trigger's person is in its `entity_id`). Named ids, scene/group ids and mentions are lower-cased first (2.8.3), because Home Assistant lower-cases an entity id wherever it reads one, so `Lock.Front_Door` must be checked as `lock.front_door`. Every written section is checked in full, and a hidden automation is left to the user (above). The tool handler runs the check **before** the confirm gate and returns the refusal: a payload must not be refused after the user said yes to its preview. `createAutomation` / `updateAutomation` run it again as the enforcement point. `listAutomations()` still deliberately reads past the list: automations are rarely exposed, and filtering them would stop `update_automation` / `delete_automation` from finding the automation the assistant just made.

### Device Capability Index

`DeviceScanner` (`ha/device-scanner.ts`) runs at startup and every 30 minutes. It fetches all `light.*` entities, reads `supported_color_modes` attributes, and builds `DeviceCapabilityProfile` objects with pre-computed `whiteMethod` and `colorMethod`. These are formatted as a markdown cheat sheet and injected into every system prompt via `buildSystemPrompt()` / `buildSystemPromptText()`.

**White method precedence**: `rgbw`/`rgbww` → `rgbw_color: [0,0,0,255]`; `color_temp` → `color_temp_kelvin`; `rgb`/`xy`/`hs` → `rgb_color: [255,255,255]`; else → none.

`DeviceScanner` reads lights through the same `HomeAssistantClient`, so with `TOOLS_FROM_EXPOSED` on the cheat sheet covers exposed lights only.

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
- **Conversation history**: `IConversationStore` with two backends: `InMemoryConversationStore` (default, lost on restart) and `SqliteConversationStore` (persistent via `better-sqlite3`). Controlled by `CONVERSATION_STORAGE` env var (`memory` | `sqlite`). Max 20 messages/conversation. **The add-on always sets `sqlite`.** History is reply text only, with no tool calls, so the follow-up rule in `llm/prompts.ts` tells the model that; without it Haiku 5.5 reads its own correct answers as unchecked and takes them back.
- **Known users** live in their own `users` table (sqlite) / `knownUsers` set (memory) — deliberately *not* derived from conversation rows, which `cleanupOldConversations()` prunes after 24h. Deriving them from messages is what silently disabled `MemoryCleanupJob` in every release before 2.3.3 (live logs showed "[cleanup] No known users" on every run for a week while Shodh held 67 facts).
- **Whose memory (nives#65)**: facts are keyed by `userId`. Since 2.7.0 the integration sends its configured `user_id` on every request by default (the "Shared memory" option in its options flow); per-user buckets (HA `context.user_id`, falling back to the configured id for satellites and automations, which carry no user) are the opt-in. That fallback used to be the only behaviour and silently split households into memories that could not see each other. `memory/shared-memory.ts` holds the server half: a once-per-user-id-per-process info log (`[memory] Memory bucket ... is empty`) when a chat request's bucket is empty while another known user has facts, fire and forget; and `POST /api/memory/:userId/merge`, a one-time, non-destructive copy of every other known user's facts into `:userId` (normalised-content dedupe, sources only read, marker `memory-merges.json` next to `CONVERSATION_DB_PATH` when sqlite, in-flight calls for the same target share one run). The integration calls it from a background task on every setup while shared memory is on, retrying while the add-on boots after Core; the marker makes repeats free. Users come from `getKnownUsers()` because Shodh has no "list buckets" call, and `getFacts()` returns at most 100 facts per bucket, so that is also the most one merge copies from each.
- **Entity cache**: 10-second TTL in HomeAssistantClient (invalidated after service calls)
- **Fact categories**: baseline, preference, identity, device, pattern, correction
- **Smart replacement**: Extractor identifies existing facts that new facts supersede (via `replaces` field)

## Development Commands

All commands run from `src/home-mind-server/`:

```bash
npm run dev          # tsx watch (hot reload), starts at localhost:3100
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
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

**HA tool definitions** are provider-neutral `ToolDefinition[]` in `llm/tool-definitions.ts`, converted to provider format via `toAnthropicTools()` / `toOpenAITools()`. Twelve tools: `get_state`, `get_entities`, `search_entities`, `call_service`, `get_history`, `create_automation`, `list_automations`, `get_automation`, `delete_automation`, `update_automation`, `list_services`, `forget_memory`. Shared execution logic in `llm/tool-handler.ts`. `get_automation` leaves out any section that names something unexposed, and `requireExposedAutomation` refuses a replacement that would drop what such a section names. The automation create/update/delete tools run through a server-enforced confirmation gate (`llm/automation-confirmations.ts`) — first call previews, a later-turn re-call commits, **scoped by a stable identity** (entity_id for update/delete, normalized alias for create). The payload is never compared: the model reformats it wildly between turns, which is what made the v2.1.10 fingerprint approach loop forever. Create had no identity key at all until 2.3.3, so any create in a later turn confirmed any earlier create preview.

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

**Voice detection**: `satellite_id` is set (read with `getattr`, since it does not exist on older Cores), which sets `isVoice=true` on the server request. Don't key on `agent_id`: Home Assistant sets it on every routed request, typed or spoken.

**Conversation IDs**: Uses `ulid.ulid_now()` (not UUID).

**120-second timeout**: `DEFAULT_TIMEOUT = 120` for API calls because tool-using LLM responses can take 60+ seconds.

## Environment Variables

Server requires: `HA_URL`, `HA_TOKEN`, `SHODH_URL`, `SHODH_API_KEY`, plus the API key for the selected provider (not needed for Ollama).

LLM config:
- `LLM_PROVIDER` — `anthropic` (default), `openai`, or `ollama`
- `LLM_MODEL` — model ID (default: `claude-haiku-5-5`; must be set explicitly for Ollama)
- `ANTHROPIC_API_KEY` — required when `LLM_PROVIDER=anthropic`
- `OPENAI_API_KEY` — required when `LLM_PROVIDER=openai`
- `OPENAI_BASE_URL` — optional, for OpenAI-compatible APIs (Azure, local proxies)
- `OLLAMA_BASE_URL` — optional, Ollama API endpoint (default: `http://localhost:11434/v1`)
- Mistral has no provider value of its own. In the add-on, BYOK provider `mistral` becomes `LLM_PROVIDER=openai` + `OPENAI_BASE_URL=https://api.mistral.ai/v1` (set by `options-to-env.sh`, the same rewrite OpenRouter gets). For that host `OpenAIChatEngine` omits `stream_options` (not in Mistral's schema; the live service accepted it in a 2026-10 test, usage arrives on the last chunk regardless), and `withReasoningEffort` sends no effort but `none`: Mistral documents only `high` and `none`, and answers `high` with content as a list of thinking and text chunks, which neither the chat loop nor the fact extractor reads yet (the reply came out as `[object Object]`). Reading that shape is the follow-up that lets the guard go; models that always answer in chunks are unsupported until then
- `REASONING_EFFORT` — optional `none|minimal|low|medium|high`, sent as `reasoning_effort` on OpenAI-compatible calls (chat and fact extraction); unset sends nothing. A model that rejects the parameter with a 400 or 422 naming it is remembered per endpoint and model (`llm/reasoning-effort.ts`) and gets it no more, so one setting is safe across models. Add-on option `reasoning_effort`

Optional: `PORT` (default 3100), `API_TOKEN` (bearer token for auth — when set, all endpoints except health require it), `HA_SKIP_TLS_VERIFY`, `MEMORY_TOKEN_LIMIT` (default 3000), `LOG_LEVEL`, `CONVERSATION_STORAGE` (`memory` | `sqlite`, default `memory`), `CONVERSATION_DB_PATH` (default `/data/conversations.db`, only used when `CONVERSATION_STORAGE=sqlite`), `CUSTOM_PROMPT` (server-level default custom system prompt), `LAYOUT_FROM_EXPOSED` (default `true`; build the room map from the entities exposed to Assist), `TOOLS_FROM_EXPOSED` (default `true`; bound `get_state` / `get_entities` / `search_entities` / `get_history` / `call_service` to the entities exposed to Assist; `false` lets them reach the whole house), `TZ` (timezone for the Docker container, default `Europe/Prague` in docker-compose; Node.js uses this for `toLocaleString()` so the LLM sees correct local time)

### Nives Cloud Mode (until 2026-12-01)

Nives Cloud closes on 2026-12-01 and its keys stop working that day. `options-to-env.sh` uses cloud mode only while `llm_mode` is `cloud`, a Cloud key is set and the UTC day is before 1 December; it then sets `LLM_PROVIDER=openai` plus a base URL, the user's Cloud key and a fixed model preset. Otherwise a saved `cloud` falls through to the BYOK settings by itself; an add-on still running in Cloud mode on the day restarts itself to make the switch (the add-on's `cloud-switch` service). `LLM_MODE=cloud` is still written in that case, so the server keeps posting one Home Assistant notification explaining the switch to the user's own key (`jobs/cloud-closing-notice.ts`, which replaced the balance watch and dismisses its old notifications); its title says "has closed" from 1 December. Since 2.10.0 nothing is fetched at boot (the old config call sent the key to the Cloud site on every start). The add-on's `llm_mode` and `cloud.api_key` options are removed in a later release; `LLM_MODE` and `llmMode` can go with them.

With no API key for the provider in use, the add-on does not start the server at all: its s6 run script posts the `nives_needs_key` notification and waits. The same startup job dismisses `nives_needs_key`, since a running server means a key is set.

Voice and transcription also run on the user's own key when Provider is `openrouter` (`options-to-env.sh`).

The forced final answer at the tool-loop cap sends `tool_choice: "none"`; a model that refuses it (Muse Ember, 2026-11) is remembered per endpoint and model and gets a plain "answer now" instruction instead (`llm/forced-answer.ts`).

STT (optional): `STT_PROVIDER` (`openai` | `none`, default `none`), `STT_API_KEY` (overrides `OPENAI_API_KEY`), `STT_BASE_URL` (custom Whisper-compatible endpoint), `STT_MODEL` (default `whisper-1`)

TTS (optional): `TTS_PROVIDER` (`openai` | `none`, default `none`), `TTS_API_KEY` (overrides `OPENAI_API_KEY`), `TTS_BASE_URL` (custom OpenAI-compatible endpoint), `TTS_MODEL` (default `tts-1`), `TTS_VOICE` (default `alloy`)

Integration tests: `SHODH_TEST_URL`, `SHODH_TEST_API_KEY`

## Authentication

Optional bearer token auth via `API_TOKEN` env var. When set, all endpoints except `/api/health` require `Authorization: Bearer <token>`. When unset, all requests pass through (backward compat with existing HA integrations).

- **Health endpoint** (`/api/health`) is always public, even when auth is enabled
- **Timing-safe comparison** prevents timing attacks on the token
- **The integration's config flow** validates tokens against `/api/memory/{userId}` (not `/api/health`, since health bypasses auth)
- **Compressed request bodies are refused with 415** (`api/json-body.ts`, `inflate: false`). `express.json()` runs before the token check, so whatever it does to a body, an unauthenticated caller can make it do; at body-parser's default that included decompressing gzip, deflate and Brotli (CVE-2026-111497 was in Node's Brotli decoder). Don't drop the option as redundant once Node is patched; `json-body.test.ts` proves the default would decode.

## API Endpoints

- `POST /api/chat` — Full response (uses streaming internally). Body: `{ message, userId?, conversationId?, isVoice?, customPrompt? }`
- `POST /api/chat/stream` — SSE streaming (`event: chunk` then `event: done`). Same body as `/api/chat`
- `POST /api/stt` — Transcribe audio. Multipart `audio` field. Returns `{ text }`. 501 if `STT_PROVIDER=none`.
- `POST /api/tts` — Synthesize speech. Body `{ text, language? }`. Returns `audio/mpeg`. 501 if `TTS_PROVIDER=none`.
- `GET /api/health` — Health check (always public, bypasses auth)
- `GET /api/memory/:userId` — List user's facts
- `POST /api/memory/:userId/facts` — Add fact manually
- `POST /api/memory/:userId/merge`: one-time copy of other known users' facts into this user (see "Whose memory" above). Returns `{ merged, sources: [{ userId, copied, duplicates }] }`, or `{ merged: 0, skipped: true }` once it has run
- `DELETE /api/memory/:userId` — Clear all facts
- `DELETE /api/memory/:userId/facts/:factId` — Delete specific fact
- `GET /api/conversations/:userId` — List conversations
- `GET /api/conversations/:userId/:conversationId` — Get conversation messages
- `DELETE /api/conversations/:userId/:conversationId` — Delete conversation
- `GET /api/admin/conversations` — All users + conversation summaries (auth required)

## Deployment

**How this actually ships:** as part of the Nives add-on, not standalone. The add-on's `nives/Dockerfile` builds this source in a Node stage, and s6-overlay runs it alongside Shodh in one container. Shodh comes from a **GitHub release binary** (both `linux-x64` and `linux-arm64` — the official Docker image is amd64-only), not from Docker Hub. See `nives/CLAUDE.md` for the s6 service layout and the config bridge.

**The HA integration is not installed via HACS.** It ships inside this repo at `nives/rootfs/opt/nives/` and the `install-integration` s6 oneshot copies it into `/config/custom_components/nives/` on startup, version-gated against `manifest.json`. Users never touch HACS. (`home-mind-hacs` is the OSS sister project's own integration, independent of this one, so don't reference it here.)

**Standalone dev only:** the `docker-compose.yml` in this directory runs `shodh` (port 3030) and `server` (port 3100) as two services for working on the server outside HA. That path uses the `varunshodh/shodh-memory` image, pinned by tag and digest, via a thin wrapper (`docker/shodh/Dockerfile`) that fixes volume permissions, and `scripts/deploy.sh` auto-generates `SHODH_API_KEY`. It is not how the add-on runs.

## Known Limitations

- No per-user login: one API token for the whole server (multi-user via OIDC planned). Per-user memory buckets are opt-in, see "Whose memory"
- Conversation history lost on server restart by default (set `CONVERSATION_STORAGE=sqlite` for persistence)
- Both chat and extraction use the same model (configured via `LLM_MODEL`)
- Fact extraction sometimes stores transient state or LLM hallucinations (improvement planned)
