# Archive

Snapshots of code and assets that have been retired but might be useful later for investigation or recovery. Nothing in this directory ships in the addon image — it exists purely as cold storage.

## Contents

### `legacy-server-ha-integration-2026-04-30.tar.gz`

A tar+gzip snapshot of `server/src/ha-integration/custom_components/home_mind/` taken on 2026-04-30, immediately before deletion as part of the rename to **Nives** (v2.0.0).

**Why it was deleted:** This was a stale duplicate of the HA custom-component integration. The live source-of-truth had moved to `homemind-pro/rootfs/opt/home_mind_integration/` (and is now `nives/rootfs/opt/nives/` after the rename). Per `nives/CLAUDE.md`, the HACS-style integration tree was already labeled "LEGACY — integration now lives in rootfs/" — keeping a parallel copy was a maintenance trap that risked drift.

The two copies had already drifted by the time of the rename (`diff` showed `manifest.json` differed) — one more reason to consolidate.

**What's inside:** the six Python/JSON files that made up the original `home_mind` integration domain (config_flow, conversation, const, __init__, manifest, strings). Pre-rename, so domain is still `home_mind` and class names are still `HomeMind*`.

To inspect: `tar -tzf legacy-server-ha-integration-2026-04-30.tar.gz` (list) or `tar -xzf` (extract).
