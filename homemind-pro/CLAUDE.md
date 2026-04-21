# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

**HomeMind PRO** is a Home Assistant add-on that bundles the complete Home Mind AI assistant into a one-click install. It packages:
- **home-mind-server** (Node.js/Express) — AI conversation engine with HA tool integration
- **Shodh Memory** (Rust) — Cognitive memory with semantic search, Hebbian learning, and natural decay

This is the turnkey product version of Home Mind. Users install one add-on and get a working AI assistant for their smart home.

## License & Source Boundaries

This repo is **AGPL-3.0**. The server code in `server/` is a **hard fork** of `home-mind` — see below.

| Repo | License | Visibility | Relationship |
|------|---------|------------|-------------|
| `homemind-pro-addon` | AGPL-3.0 | **Public** | **This repo** — HA add-on + forked server (the paid product) |
| `home-mind` | AGPL-3.0 | **Public** | Historic origin of `server/` code. **Now fully independent** — no sync in either direction |
| `home-mind-hacs` | AGPL-3.0 | **Public** | LEGACY — integration now lives in rootfs/ |
| `home-mind-proxy` | Proprietary | **Private** | Cloud LLM metering proxy (VPS service) |
| `home-mind-cloud` | Proprietary | **Private** | Cloud signup/billing |
| `home-mind-app` | Proprietary | **Private** | PWA frontend |

**Critical rules:**
- Never add proprietary code from closed-source repos
- `server/` is a **hard fork**, not a vendored mirror. Apply fixes here directly. Do NOT cherry-pick from `home-mind` on autopilot — the two products will diverge intentionally, and cross-syncing guarantees mysterious drift bugs (it already caused one: the reasoning-model fact extractor fix landed in OSS but took days to reach the paid product)
- A fix relevant to both products must be applied in each, with a clear reason each time
- The proxy URL in options-to-env.sh is the only reference to the cloud service
- To update server code: edit `server/src/home-mind-server/` directly in this repo

## Architecture

```
HA Supervisor
  └── HomeMind PRO Add-on (single Docker container)
        ├── s6-overlay (process supervisor)
        │   ├── init-options (oneshot) — reads /data/options.json → env vars
        │   ├── shodh (longrun) — Shodh Memory on port 3030
        │   ├── homemind-server (longrun) — Node.js server on port 3100
        │   └── shodh-watchdog (longrun) — memory leak monitor
        └── /data (persistent volume)
              ├── .shodh_key — auto-generated API key
              ├── shodh/ — Shodh data directory
              └── conversations.db — SQLite conversation history

HA Core
  └── home-mind-hacs integration (companion)
        └── Registers conversation agent → forwards to add-on API
```

### How Config Flows

1. User fills in options in HA UI (LLM mode, API key, etc.)
2. HA Supervisor writes `/data/options.json`
3. `init-options` oneshot runs `options-to-env.sh`
4. Script maps options to env vars in `/var/run/s6/container_environment/`
5. `shodh` and `homemind-server` services start with those env vars
6. Server's existing `loadConfig()` reads env vars — **zero server code changes**

### Two LLM Modes

- **Cloud** (`llm_mode: "cloud"`): Routes LLM calls through HomeMind proxy. User only needs a proxy API key. Sets `LLM_PROVIDER=openai` + `OPENAI_BASE_URL=proxy` + `OPENAI_API_KEY=proxy_key`.
- **BYOK** (`llm_mode: "byok"`): User provides their own Anthropic/OpenAI/Ollama credentials. Direct API calls, no proxy involved.

### HA Integration (Automatic)

- `homeassistant_api: true` in config.yaml → container gets `SUPERVISOR_TOKEN`
- Server uses `HA_URL=http://homeassistant:8123` + `HA_TOKEN=$SUPERVISOR_TOKEN`
- No user configuration needed for HA access
- `discovery: [home_mind]` auto-configures the companion HACS integration

## Project Structure

```
repository.yaml                    # HA add-on repository metadata
homemind-pro/
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
      homemind-server/             # Longrun: Node.js server (depends on shodh)
      shodh-watchdog/              # Longrun: RSS monitor, restarts shodh if >512MB
      user/contents.d/             # Bundle definition (which services to start)
    usr/local/bin/
      options-to-env.sh            # Config bridge script
server/                            # Vendored server source (was git submodule, now independent)
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
1. Docker memory limit: 768MB in config.yaml
2. Watchdog service: checks RSS every 4h, SIGTERMs if >512MB
3. s6 auto-restarts the process

### Binary Distribution

The official Docker image (`varunshodh/shodh-memory:latest`) is amd64 only. This add-on downloads binaries directly from GitHub release assets which include both `linux-x64` and `linux-arm64`.

## Development

### Prerequisites

- Docker with BuildKit
- Git (with submodule support)

### Local Build

```bash
# Run from repo root (context must be root so server/ is accessible)
docker build -t homemind-pro:local -f homemind-pro/Dockerfile .
```

### Local Test (standalone, without HA Supervisor)

```bash
docker run --rm \
  -e SUPERVISOR_TOKEN=dev-token \
  -p 3100:3100 \
  -v homemind-data:/data \
  homemind-pro:local
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

GitHub Actions builds multi-arch images and pushes to `ghcr.io/hoornet/homemind-pro-{arch}`. The `image:` field in config.yaml references these. Users download pre-built images (fast install).

### Add-on Repository

Users add `https://github.com/hoornet/homemind-pro-addon` as a custom repository in HA Supervisor. The `repository.yaml` at root lists the add-on.

### Versioning

The add-on has its own semver (1.0.0+), independent of the server version. CHANGELOG notes which server version (submodule tag) is bundled.

**IMPORTANT:** Every push to master that changes any file must bump the version in `homemind-pro/config.yaml`. HA compares this version number to detect updates — if the version doesn't change, users never see an update available, regardless of what was changed. Always bump version + add CHANGELOG entry before pushing.

**IMPORTANT:** The `version` field in `rootfs/opt/home_mind_integration/manifest.json` must always match the add-on version in `config.yaml`. The `install-integration` s6 script compares these two versions to decide whether to overwrite the integration files on disk — if they match, the update is skipped and users keep running stale integration code.

## Related Projects (on this machine)

- `/home/hoornet/projects/homemind-projects/home-mind` — Server source (AGPL, submodule origin)
- `/home/hoornet/projects/homemind-projects/home-mind-hacs` — Companion HACS integration
- `/home/hoornet/projects/homemind-projects/home-mind-proxy` — Cloud LLM proxy (proprietary)
- `/home/hoornet/projects/homemind-projects/home-mind-cloud` — Cloud provisioner (proprietary)
- `/home/hoornet/projects/homemind-projects/home-mind-app` — PWA app (proprietary)
