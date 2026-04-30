# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

**Nives** is a Home Assistant add-on that bundles a complete AI assistant into a one-click install. It packages:
- A conversation server (Node.js/Express, hard fork of `home-mind`) — AI conversation engine with HA tool integration
- **Shodh Memory** (Rust) — Cognitive memory with semantic search, Hebbian learning, and natural decay

Nives is the paid product, distributed as a single HA add-on. Users install it from the add-on store, configure either Nives Cloud (managed) or BYOK (their own API key), and get a working AI assistant for their smart home.

> Previously released as **HomeMind PRO** (v1.x). Renamed to **Nives** at v2.0.0 — see the addon's `CHANGELOG.md` for the migration story.

## License & Source Boundaries

This repo is **AGPL-3.0**. The server code in `server/` is a **hard fork** of `home-mind` — see below.

| Repo | License | Visibility | Relationship |
|------|---------|------------|-------------|
| `nives` (was `homemind-pro-addon`) | AGPL-3.0 | **Public** | **This repo** — the Nives HA add-on, including the forked conversation server |
| `home-mind` | AGPL-3.0 | **Public** | Historic origin of `server/` code. **Now fully independent** — no sync in either direction |
| `home-mind-hacs` | AGPL-3.0 | **Public** | LEGACY — integration now lives in this repo's `rootfs/` |
| `home-mind-cloud` | Proprietary | **Private** | Cloud signup/billing for Nives Cloud subscribers |
| `home-mind-app` | Proprietary | **Private** | Mobile/PWA frontend (rename pending — will eventually share Nives identity) |
| `home-mind-proxy` | Proprietary | **Private** | LEGACY — replaced by direct OpenRouter integration |

**Critical rules:**
- Never add proprietary code from closed-source repos
- `server/` is a **hard fork**, not a vendored mirror. Apply fixes here directly. Do NOT cherry-pick from `home-mind` on autopilot — the two products will diverge intentionally, and cross-syncing guarantees mysterious drift bugs (one already happened: the reasoning-model fact extractor fix landed in OSS but took days to reach the paid product)
- A fix relevant to both products must be applied in each, with a clear reason each time
- Do NOT rename references to `home-mind`, `home-mind-server`, `home-mind-cloud`, `home-mind-app`, `home-mind-hacs`, or `home-mind-proxy` — those are sister-project repository identities that stay distinct from the Nives addon brand
- To update server code: edit `server/src/home-mind-server/` directly in this repo

## Architecture

```
HA Supervisor
  └── Nives Add-on (single Docker container)
        ├── s6-overlay (process supervisor)
        │   ├── init-options (oneshot) — reads /data/options.json → env vars
        │   ├── shodh (longrun) — Shodh Memory on port 3030
        │   ├── nives-server (longrun) — Node.js conversation server on port 3100
        │   └── shodh-watchdog (longrun) — memory leak monitor
        └── /data (persistent volume)
              ├── .shodh_key — auto-generated API key
              ├── shodh/ — Shodh data directory
              └── conversations.db — SQLite conversation history

HA Core
  └── Nives integration (companion, auto-installed by add-on)
        └── Registers conversation agent → forwards to add-on API
```

### How Config Flows

1. User fills in options in HA UI (LLM mode, API key, etc.)
2. HA Supervisor writes `/data/options.json`
3. `init-options` oneshot runs `options-to-env.sh`
4. Script maps options to env vars in `/var/run/s6/container_environment/`
5. `shodh` and `nives-server` services start with those env vars
6. Server's existing `loadConfig()` reads env vars — **zero server code changes**

### Two LLM Modes

- **Cloud** (`llm_mode: "cloud"`): Routes LLM calls through the managed Nives Cloud service. User only needs a Nives Cloud API key. Sets `LLM_PROVIDER=openai` + `OPENAI_BASE_URL=<cloud_endpoint>` + `OPENAI_API_KEY=<cloud_key>`.
- **BYOK** (`llm_mode: "byok"`): User provides their own Anthropic/OpenAI/Ollama credentials. Direct API calls, no proxy involved.

### HA Integration (Automatic)

- `homeassistant_api: true` in `config.yaml` → container gets `SUPERVISOR_TOKEN`
- Server uses `HA_URL=http://homeassistant:8123` + `HA_TOKEN=$SUPERVISOR_TOKEN`
- No user configuration needed for HA access
- `discovery: [nives]` in `config.yaml` auto-configures the companion HA integration

## Project Structure

```
repository.yaml                    # HA add-on repository metadata
nives/
  config.yaml                      # Add-on manifest (options schema, capabilities)
  build.json                       # Architecture + build args
  Dockerfile                       # Multi-stage: Shodh binary + Node.js build + runtime
  DOCS.md                          # Shown in HA UI
  CHANGELOG.md
  CLAUDE.md                        # This file
  translations/
    en.yaml                        # Option labels/descriptions for HA UI
  rootfs/
    etc/s6-overlay/s6-rc.d/        # s6 service definitions
      init-options/                # Oneshot: options.json → env vars
      shodh/                       # Longrun: Shodh Memory server
      nives-server/                # Longrun: Node.js conversation server (depends on shodh)
      shodh-watchdog/              # Longrun: RSS monitor, restarts shodh if >512MB
      install-integration/         # Oneshot: copies HA integration into /config
      discovery/                   # Oneshot: announces add-on to Supervisor
      user/contents.d/             # Bundle definition (which services to start)
    opt/nives/                     # HA integration source (Python files copied to /config/custom_components/nives/ at runtime)
    usr/local/bin/
      options-to-env.sh            # Config bridge script
server/                            # Vendored conversation server source (hard fork of home-mind)
archive/                           # Cold storage for retired snapshots (e.g. legacy integration tarball)
```

## Shodh Memory

### What It Does

Shodh is a Rust-based semantic memory server. It stores facts about the user (preferences, routines, device info) and retrieves them via vector similarity search. Features:
- Built-in ONNX embeddings (MiniLM-L6-v2) — no external embedding service needed
- Hebbian learning — frequently accessed memories get stronger
- Natural decay — unused memories fade over time
- SHA-256 content dedup (v0.1.90+) — identical memories never stored twice
- REST API on port 3030

### API Used by Server

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/remember` | POST | Store single fact |
| `/api/remember/batch` | POST | Batch store |
| `/api/recall` | POST | Semantic search |
| `/api/recall/tags` | POST | Tag-based recall |
| `/api/proactive_context` | POST | Graph-based context |
| `/api/reinforce` | POST | Hebbian learning |
| `/api/forget/{id}` | DELETE | Delete fact |

### Known Issue: Memory Leak

Shodh has a memory leak (github.com/varun29ankuS/shodh-memory/issues/90) — grows to 2GB+ over 24 hours. Mitigated by:
1. Docker memory limit: 768MB in `config.yaml`
2. Watchdog service: checks RSS every 4h, SIGTERMs if >512MB
3. s6 auto-restarts the process

### Binary Distribution

The official Docker image (`varunshodh/shodh-memory:latest`) is amd64 only. This add-on downloads binaries directly from GitHub release assets which include both `linux-x64` and `linux-arm64`.

## Development

### Prerequisites

- Docker with BuildKit
- Git

### Local Build

```bash
# Run from repo root (context must be root so server/ is accessible)
docker build -t nives:local -f nives/Dockerfile .
```

### Local Test (standalone, without HA Supervisor)

```bash
docker run --rm \
  -e SUPERVISOR_TOKEN=dev-token \
  -p 3100:3100 \
  -v nives-data:/data \
  nives:local
```

Note: Without a real Supervisor, HA API calls will fail. The server still starts and responds to chat (LLM calls work independently).

### Updating Server Code

Edit `server/src/home-mind-server/` directly. This is the authoritative source for the addon — no submodule, no sync, no mirror. The `home-mind` OSS project is an independent codebase that happens to share history. Treat it like any third-party library you'd consult for reference but not blindly copy.

### Testing on Real HA

1. Copy the repo to a path accessible by HA
2. In HA: Settings > Add-ons > Add-on Store > Repositories > add local path
3. Install and configure
4. Check logs in the add-on Log tab

## Deployment / Distribution

### Pre-built Images (Production)

GitHub Actions builds multi-arch images and pushes to `ghcr.io/hoornet/nives-{arch}`. The `image:` field in `config.yaml` references these. Users download pre-built images (fast install).

### Add-on Repository

Users add `https://github.com/hoornet/nives` as a custom repository in HA Supervisor. The `repository.yaml` at root lists the add-on.

### Versioning

The add-on has its own semver, independent of the server version. CHANGELOG notes which server version is bundled.

**IMPORTANT:** Every push to master that changes any file must bump the version in `nives/config.yaml`. HA compares this version number to detect updates — if the version doesn't change, users never see an update available, regardless of what was changed. Always bump version + add CHANGELOG entry before pushing.

**IMPORTANT:** The `version` field in `rootfs/opt/nives/manifest.json` must always match the add-on version in `config.yaml`. The `install-integration` s6 script compares these two versions to decide whether to overwrite the integration files on disk — if they match, the update is skipped and users keep running stale integration code.

## Related Projects (on this machine)

- `/home/hoornet/projects/homemind-projects/home-mind` — OSS server source (AGPL, historic origin of the fork)
- `/home/hoornet/projects/homemind-projects/home-mind-hacs` — Legacy companion HACS integration
- `/home/hoornet/projects/homemind-projects/home-mind-cloud` — Nives Cloud signup/billing (proprietary)
- `/home/hoornet/projects/homemind-projects/home-mind-app` — Mobile/PWA frontend (proprietary)
