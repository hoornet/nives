# Nives — HA Add-on
# Bundles the Node.js conversation server + Shodh Memory (Rust) in one container
# Ubuntu 24.04 base required: Shodh needs glibc 2.38+

# -------------------------------------------------------------------
# Stage 1: Download Shodh binary for target architecture
# -------------------------------------------------------------------
FROM ubuntu:24.04 AS shodh

# Every file this image downloads is checked against a pinned SHA-256 before it
# is used: the digest GitHub records for a release asset, the publisher's own
# .sha256 file, or Hugging Face's LFS hash. A swapped or tampered download fails
# the build instead of shipping. Changing a version means changing its hash;
# a build arg that bumps the version alone fails on purpose.
ARG SHODH_VERSION=v0.2.0
ARG SHODH_SHA256_X64=abf2e255355c46ef9333342cc4b58234e032bfe8c4cbbdef81c814cdf58182ed
ARG SHODH_SHA256_ARM64=8db8765efdb5fb5ac4b9ef4fc014eac329dcfc343bd426fd6c0f7553893e7665

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Detect architecture at build time (works with both legacy builder and BuildKit)
RUN ARCH=$(uname -m) \
    && SHODH_ARCH=$(if [ "$ARCH" = "aarch64" ]; then echo "arm64"; else echo "x64"; fi) \
    && SHODH_SHA256=$(if [ "$ARCH" = "aarch64" ]; then echo "${SHODH_SHA256_ARM64}"; else echo "${SHODH_SHA256_X64}"; fi) \
    && curl -fsSL "https://github.com/varun29ankuS/shodh-memory/releases/download/${SHODH_VERSION}/shodh-memory-linux-${SHODH_ARCH}.tar.gz" \
       -o /tmp/shodh.tar.gz \
    && echo "${SHODH_SHA256}  /tmp/shodh.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/shodh \
    && tar -xzf /tmp/shodh.tar.gz -C /tmp/shodh \
    && cp /tmp/shodh/shodh /usr/local/bin/shodh \
    && chmod +x /usr/local/bin/shodh \
    && rm -rf /tmp/shodh /tmp/shodh.tar.gz
# Pre-seed Shodh's ONNX Runtime cache with a correct libonnxruntime.so symlink.
# Shodh v0.2.0's first-boot download has a bug: it saves libonnxruntime_providers_shared.so
# (~14KB stub) over the main libonnxruntime.so slot, so dlopen panics with
# `expected OrtGetApiBase to be present in libonnxruntime`. Seeding the cache at build time
# with the correct v1.23.2 library + symlink (matching what ort 2.0-rc.11 expects) avoids
# the runtime download + panic cycle and makes first boot clean.
#
# The libraries come from Microsoft's NuGet package (Microsoft.ML.OnnxRuntime),
# which carries the same Linux builds as the GitHub release tarballs; the
# microsoft/onnxruntime GitHub repository and its release downloads went
# offline in November 2026. The package must match the SHA-512 nuget.org
# publishes for it, and each library the SHA-256 of the exact file the GitHub
# tarball held (the two were compared byte for byte on 2026-11-20).
ARG ORT_VERSION=1.23.2
ARG ORT_NUPKG_SHA512=b15027986e717e2e095bb614ef48d8eb3e24496682b77f6d9f24479eacbb4252c81c0e1167e981067cca50a0238496324f23c33f2f765ae8bb318fe4160b3698
ARG ORT_LIB_SHA256_X64=13ab8084954fa4a47c777880180b90810d6020f021441395712b48a75b74c68b
ARG ORT_SHARED_SHA256_X64=086ec1d5388f64153d9c63470d126693db9a182c8ce236d3a1119068471b8a0d
ARG ORT_LIB_SHA256_AARCH64=648ffa64fbe027ae27139109410900cf776a030dec2dbbac51053318cc44c286
ARG ORT_SHARED_SHA256_AARCH64=3b6be288fbfb7dff8770d08a23defdde18e8f7e0f5a2b344a0e5e238c999ea88
RUN ARCH=$(uname -m) \
    && ORT_RID=$(if [ "$ARCH" = "aarch64" ]; then echo "linux-arm64"; else echo "linux-x64"; fi) \
    && LIB_SHA256=$(if [ "$ARCH" = "aarch64" ]; then echo "${ORT_LIB_SHA256_AARCH64}"; else echo "${ORT_LIB_SHA256_X64}"; fi) \
    && SHARED_SHA256=$(if [ "$ARCH" = "aarch64" ]; then echo "${ORT_SHARED_SHA256_AARCH64}"; else echo "${ORT_SHARED_SHA256_X64}"; fi) \
    && curl -fsSL "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ORT_VERSION}/microsoft.ml.onnxruntime.${ORT_VERSION}.nupkg" \
       -o /tmp/ort.nupkg \
    && echo "${ORT_NUPKG_SHA512}  /tmp/ort.nupkg" | sha512sum -c - \
    && mkdir -p /tmp/ort /root/.cache/shodh-memory/onnxruntime \
    && unzip -q -j /tmp/ort.nupkg \
       "runtimes/${ORT_RID}/native/libonnxruntime.so" \
       "runtimes/${ORT_RID}/native/libonnxruntime_providers_shared.so" -d /tmp/ort \
    && printf '%s  %s\n%s  %s\n' "${LIB_SHA256}" /tmp/ort/libonnxruntime.so \
       "${SHARED_SHA256}" /tmp/ort/libonnxruntime_providers_shared.so | sha256sum -c - \
    && cp /tmp/ort/libonnxruntime.so /root/.cache/shodh-memory/onnxruntime/libonnxruntime.so.${ORT_VERSION} \
    && cp /tmp/ort/libonnxruntime_providers_shared.so /root/.cache/shodh-memory/onnxruntime/ \
    && ln -s libonnxruntime.so.${ORT_VERSION} /root/.cache/shodh-memory/onnxruntime/libonnxruntime.so \
    && rm -rf /tmp/ort /tmp/ort.nupkg

# Pre-download MiniLM-L6-v2 ONNX model (pinned commit, same URLs Shodh uses)
# Saves as model_quantized.onnx matching Shodh's expected filename
ARG MINILM_MODEL_SHA256=b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21
ARG MINILM_TOKENIZER_SHA256=be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037
RUN mkdir -p /root/.cache/shodh-memory/models/minilm-l6 \
    && curl -fsSL "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/c9745ed1d9f207416be6d2e6f8de32d1f16199bf/onnx/model_quint8_avx2.onnx" \
       -o /root/.cache/shodh-memory/models/minilm-l6/model_quantized.onnx \
    && curl -fsSL "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/c9745ed1d9f207416be6d2e6f8de32d1f16199bf/tokenizer.json" \
       -o /root/.cache/shodh-memory/models/minilm-l6/tokenizer.json \
    && printf '%s  %s\n%s  %s\n' \
       "${MINILM_MODEL_SHA256}" /root/.cache/shodh-memory/models/minilm-l6/model_quantized.onnx \
       "${MINILM_TOKENIZER_SHA256}" /root/.cache/shodh-memory/models/minilm-l6/tokenizer.json \
       | sha256sum -c -

# -------------------------------------------------------------------
# Stage 2: Build the conversation server from vendored source
# -------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

WORKDIR /build

# Copy vendored server source (no external git clone needed)
# --ignore-scripts: better-sqlite3 13+ ships N-API prebuilds inside the package
# and needs no install script, but npm ci still invokes node-gyp for it
# (WiseLibs/better-sqlite3#1516) and this image carries no Python/toolchain.
# Nothing else in the tree needs an install script; the require() below fails
# the build if a future dependency ever does.
COPY server/src/home-mind-server/package*.json ./
RUN npm ci --ignore-scripts
COPY server/src/home-mind-server/src ./src
COPY server/src/home-mind-server/tsconfig.json ./
RUN npx tsc

# Production dependencies only
RUN rm -rf node_modules && npm ci --omit=dev --ignore-scripts \
    && node -e "require('better-sqlite3')(':memory:').prepare('select 1 as ok').get()"

# -------------------------------------------------------------------
# Stage 3: Runtime — Ubuntu 24.04 + s6-overlay + Node.js + Shodh
# -------------------------------------------------------------------
FROM ubuntu:24.04

ARG S6_OVERLAY_VERSION=3.2.0.2
# From the s6-overlay release's own .sha256 files (the release predates GitHub
# asset digests).
ARG S6_SHA256_NOARCH=6dbcde158a3e78b9bb141d7bcb5ccb421e563523babbe2c64470e76f4fd02dae
ARG S6_SHA256_X86_64=59289456ab1761e277bd456a95e737c06b03ede99158beb24f12b165a904f478
ARG S6_SHA256_AARCH64=8b22a2eaca4bf0b27a43d36e65c89d2701738f628d1abd0cea5569619f66f785
ARG NODE_MAJOR=24
# NodeSource's repository signing key (fingerprint
# 6F71F525282841EEDAF851B42F59B5F99B1BE0B4, never expires). apt checks every
# package against it; the hash pins the key file itself.
ARG NODESOURCE_KEY_SHA256=b42e0321dabdc24e892115da705cf061167eac12a317f23d329862d0aa0a271d
ARG BASHIO_VERSION=0.16.2
ARG BASHIO_SHA256=d0f0c780c4badd103c00c572b1bf9645520d15a8a8070d6e3d64e35cb9f583aa
# Lowest Node release this image may ship. NodeSource serves the newest
# ${NODE_MAJOR}.x, but CI reuses the cached install layer until its
# instruction changes, so a rebuild alone keeps the old Node (2.8.5 shipped
# 22.23.3, built hours before 22.23.4 fixed CVE-2026-111497). Raising this
# after a Node security release rebuilds the layer, and the build fails if
# the mirror has not caught up yet.
ARG NODE_MIN_VERSION=24.22.1

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install base packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    xz-utils \
    jq \
    openssl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay (detect architecture at build time)
RUN ARCH=$(uname -m) \
    && S6_ARCH=$(if [ "$ARCH" = "aarch64" ]; then echo "aarch64"; else echo "x86_64"; fi) \
    && S6_SHA256=$(if [ "$ARCH" = "aarch64" ]; then echo "${S6_SHA256_AARCH64}"; else echo "${S6_SHA256_X86_64}"; fi) \
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
       -o /tmp/s6-noarch.tar.xz \
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
       -o /tmp/s6-arch.tar.xz \
    && printf '%s  %s\n%s  %s\n' "${S6_SHA256_NOARCH}" /tmp/s6-noarch.tar.xz "${S6_SHA256}" /tmp/s6-arch.tar.xz \
       | sha256sum -c - \
    && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# Install Node.js from NodeSource's signed apt repository. These are the steps
# NodeSource's setup_<major>.x script performs, done here directly instead of
# piping a downloaded script into bash.
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.key \
    && echo "${NODESOURCE_KEY_SHA256}  /tmp/nodesource.key" | sha256sum -c - \
    && gpg --batch --dearmor -o /usr/share/keyrings/nodesource.gpg /tmp/nodesource.key \
    && rm /tmp/nodesource.key \
    && printf 'Types: deb\nURIs: https://deb.nodesource.com/node_%s.x\nSuites: nodistro\nComponents: main\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' \
       "${NODE_MAJOR}" > /etc/apt/sources.list.d/nodesource.sources \
    && printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && NODE_VERSION=$(node -p process.versions.node) \
    && echo "Node.js ${NODE_VERSION} (minimum ${NODE_MIN_VERSION})" \
    && dpkg --compare-versions "${NODE_VERSION}" ge "${NODE_MIN_VERSION}"

# Install bashio (HA add-on helper library)
RUN curl -fsSL "https://github.com/hassio-addons/bashio/archive/refs/tags/v${BASHIO_VERSION}.tar.gz" -o /tmp/bashio.tar.gz \
    && echo "${BASHIO_SHA256}  /tmp/bashio.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/bashio.tar.gz \
    && mv "bashio-${BASHIO_VERSION}/lib" /usr/lib/bashio \
    && ln -s /usr/lib/bashio/bashio /usr/bin/bashio \
    && rm -rf "bashio-${BASHIO_VERSION}" /tmp/bashio.tar.gz

# Copy Shodh binary and pre-downloaded MiniLM-L6-v2 model from stage 1.
# ONNX Runtime is NOT pre-shipped — see stage 1 note above.
COPY --from=shodh /usr/local/bin/shodh /usr/local/bin/shodh
COPY --from=shodh /root/.cache/shodh-memory /root/.cache/shodh-memory

# Copy built server from stage 2
WORKDIR /opt/nives
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# Copy s6-overlay service definitions and scripts
COPY nives/rootfs /

# Ensure all scripts are executable
RUN find /etc/s6-overlay -name 'run' -exec chmod +x {} \; \
    && find /etc/s6-overlay -name 'finish' -exec chmod +x {} \; \
    && chmod +x /usr/local/bin/*.sh

# Persistent data volume (Shodh data, conversations, keys)
VOLUME ["/data"]

ENTRYPOINT ["/init"]
