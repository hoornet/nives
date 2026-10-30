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
| `nives` | AGPL-3.0 | **Public** | **This repo** — the Nives HA add-on, including the forked conversation server |
| `home-mind` | AGPL-3.0 | **Public** | Historic origin of `server/` code. **Now fully independent** — no sync in either direction |
| `nives-cloud` | Proprietary | **Private** | Cloud signup/billing for Nives Cloud (renamed from `home-mind-cloud` end-to-end on 2026-06-06 — repo, dir, and VPS) |
| `nives-app` | Proprietary | **Private** | Closed-source mobile/PWA frontend for Nives users (React + Vite PWA, reverse-DNS `app.nives.assistant`) |
| `home-mind-hacs` | AGPL-3.0 | **Public** | **Maintained.** The HACS integration OSS `home-mind` users install. This add-on ships its own copy from `rootfs/`; the two are independent and must not be synced |

**Critical rules:**
- Never add proprietary code from closed-source repos
- `server/` is a **hard fork**, not a vendored mirror. Apply fixes here directly. Do NOT cherry-pick from `home-mind` on autopilot — the two products will diverge intentionally, and cross-syncing guarantees mysterious drift bugs (one already happened: the reasoning-model fact extractor fix landed in OSS but took days to reach the paid product)
- A fix relevant to both products must be applied in each, with a clear reason each time
- Do NOT rename references to `home-mind` or `home-mind-server` (npm package + source directory) — those are the OSS sister project and its internal naming, which stays distinct from the Nives addon brand by design. (`home-mind-cloud` was renamed to `nives-cloud` on 2026-06-06 — that rename is complete.)
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
- Server uses **`HA_URL=http://supervisor/core`** + `HA_TOKEN=$SUPERVISOR_TOKEN`, set by
  `options-to-env.sh`. `SUPERVISOR_TOKEN` authenticates against the **Supervisor proxy**,
  so a direct Core address such as `http://homeassistant:8123` rejects it with a 401.
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

Shodh has a memory leak (github.com/varun29ankuS/shodh-memory/issues/90) — grows to 2GB+ over 24 hours. Mitigations:

1. **Watchdog service** — checks RSS every 4h, SIGTERMs if >512MB; s6 auto-restarts.
   It matches `/usr/local/bin/shodh server …`, the way the binary is launched, and logs
   when no matching process is found. Keep the pattern in sync with
   `s6-rc.d/shodh/run`, because a pattern that matches nothing fails silently.
2. **`memory: 768` in `config.yaml` — does NOT work.** This is not a key the HA
   Supervisor recognises, so it is silently ignored; a live add-on reports
   `memory_limit` equal to the host's total RAM. HA add-on config has no
   documented container memory-limit option. Do not count this as a guard.

Practically that means the only working mitigation today is the watchdog. If the
leak resurfaces, the container will grow until the host OOM-kills it.

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

**Ship a version when there is something worth updating for, not once per commit.** Every version prompts each user to update and restart Home Assistant, so several in one day is noise. Group related work on a branch and land it as one version. Security fixes are the exception: they ship as soon as they are ready.

HA compares the version in `nives/config.yaml` to detect updates, so nothing reaches existing users until it changes. Every push to master also rebuilds the image and re-tags the current version, so a code change pushed without a bump would silently replace that version's image for new installs. Anything that reaches the image or the user's disk therefore lands on master together with its version bump and CHANGELOG entry; until then it stays on the branch.

**IMPORTANT:** The `version` field in `rootfs/opt/nives/manifest.json` must always match the add-on version in `config.yaml`. The `install-integration` s6 script compares these two versions to decide whether to overwrite the integration files on disk — if they match, the update is skipped and users keep running stale integration code.

### Cutting a release — the step that keeps getting skipped

A version bump is **not** a release. HA updates users from `config.yaml`, so the add-on ships fine without a git tag — which is exactly why tagging gets forgotten, and why on 2026-08-09 this repo had **thirty-odd versions shipped and zero GitHub releases**. Anyone who found the repo saw no release history at all and reasonably concluded it was dead. The tag is not for Home Assistant, it is for the human deciding whether to trust the project.

After the version bump is pushed, in order:

1. Watch CI **by SHA** — `gh run list --json headSha,status,conclusion` filtered to your commit. Never `--limit 1`; that has reported the *previous* run's success more than once.
2. Confirm **both** GHCR images exist before telling anyone to update:
   `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $(curl -s "https://ghcr.io/token?scope=repository:hoornet/nives-amd64:pull&service=ghcr.io" | jq -r .token)" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" https://ghcr.io/v2/hoornet/nives-amd64/manifests/<version>` — and again for `nives-aarch64`. The `Accept` header is not optional: without it GHCR answers 404 for an image that exists (2026-10-10, both 2.7.0 and the live 2.6.10 read as missing), so a release would be held for nothing. `GET /v2/hoornet/nives-amd64/tags/list` is the second opinion. The store reads `config.yaml` from git instantly while images publish minutes later; a user who updates in that gap gets `404 manifest unknown` — this has already caught a real user once.
3. `git tag -a v<version> -m "Nives <version>"` && `git push origin v<version>`
4. `gh release create v<version> --title "…" --notes-file …` — notes written for users, in the CHANGELOG voice, not a diff summary.

Docs-only commits (README, assets) don't need a version bump — no add-on content changed, and bumping would push a pointless update to every user. CI still rebuilds, which is harmless.

**A build that fails on a `sha256sum -c` line is the download check working, not a CI flake (since 2.8.9).** Every file `nives/Dockerfile` fetches is pinned by SHA-256 in an `ARG` next to its version. The expected causes are a version bumped without its hash, NodeSource rotating its repository key (`NODESOURCE_KEY_SHA256`, fingerprint `6F71F525282841EEDAF851B42F59B5F99B1BE0B4`), or GitHub regenerating the bashio tag archive. Before changing a hash, get the new value from the publisher: GitHub's release-asset `digest`, the project's `.sha256` file, or Hugging Face's LFS hash. A key that changed with no announcement is the case the check exists for, so don't paste in whatever the failed build computed.
