# Nives — HA Add-on
# Bundles the Node.js conversation server + Shodh Memory (Rust) in one container
# Ubuntu 24.04 base required: Shodh needs glibc 2.38+

# -------------------------------------------------------------------
# Stage 1: Download Shodh binary for target architecture
# -------------------------------------------------------------------
FROM ubuntu:24.04 AS shodh

ARG SHODH_VERSION=v0.2.0

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Detect architecture at build time (works with both legacy builder and BuildKit)
RUN ARCH=$(uname -m) \
    && SHODH_ARCH=$(if [ "$ARCH" = "aarch64" ]; then echo "arm64"; else echo "x64"; fi) \
    && curl -fsSL "https://github.com/varun29ankuS/shodh-memory/releases/download/${SHODH_VERSION}/shodh-memory-linux-${SHODH_ARCH}.tar.gz" \
       -o /tmp/shodh.tar.gz \
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
ARG ORT_VERSION=1.23.2
RUN ARCH=$(uname -m) \
    && ORT_ARCH=$(if [ "$ARCH" = "aarch64" ]; then echo "aarch64"; else echo "x64"; fi) \
    && curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-${ORT_ARCH}-${ORT_VERSION}.tgz" \
       -o /tmp/ort.tgz \
    && mkdir -p /tmp/ort /root/.cache/shodh-memory/onnxruntime \
    && tar -xzf /tmp/ort.tgz -C /tmp/ort --strip-components=1 \
    && cp /tmp/ort/lib/libonnxruntime.so.${ORT_VERSION} /root/.cache/shodh-memory/onnxruntime/ \
    && cp /tmp/ort/lib/libonnxruntime_providers_shared.so /root/.cache/shodh-memory/onnxruntime/ \
    && ln -s libonnxruntime.so.${ORT_VERSION} /root/.cache/shodh-memory/onnxruntime/libonnxruntime.so \
    && rm -rf /tmp/ort /tmp/ort.tgz

# Pre-download MiniLM-L6-v2 ONNX model (pinned commit, same URLs Shodh uses)
# Saves as model_quantized.onnx matching Shodh's expected filename
RUN mkdir -p /root/.cache/shodh-memory/models/minilm-l6 \
    && curl -fsSL "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/c9745ed1d9f207416be6d2e6f8de32d1f16199bf/onnx/model_quint8_avx2.onnx" \
       -o /root/.cache/shodh-memory/models/minilm-l6/model_quantized.onnx \
    && curl -fsSL "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/c9745ed1d9f207416be6d2e6f8de32d1f16199bf/tokenizer.json" \
       -o /root/.cache/shodh-memory/models/minilm-l6/tokenizer.json

# -------------------------------------------------------------------
# Stage 2: Build the conversation server from vendored source
# -------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

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
ARG NODE_MAJOR=22
# Lowest Node release this image may ship. NodeSource serves the newest
# ${NODE_MAJOR}.x, but CI reuses the cached install layer until its
# instruction changes, so a rebuild alone keeps the old Node (2.8.5 shipped
# 22.23.3, built hours before 22.23.4 fixed CVE-2026-111497). Raising this
# after a Node security release rebuilds the layer, and the build fails if
# the mirror has not caught up yet.
ARG NODE_MIN_VERSION=22.23.4

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
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
       | tar -C / -Jxpf - \
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
       | tar -C / -Jxpf -

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && NODE_VERSION=$(node -p process.versions.node) \
    && echo "Node.js ${NODE_VERSION} (minimum ${NODE_MIN_VERSION})" \
    && dpkg --compare-versions "${NODE_VERSION}" ge "${NODE_MIN_VERSION}"

# Install bashio (HA add-on helper library)
RUN curl -fsSL https://github.com/hassio-addons/bashio/archive/refs/tags/v0.16.2.tar.gz \
    | tar -xzf - \
    && mv bashio-0.16.2/lib /usr/lib/bashio \
    && ln -s /usr/lib/bashio/bashio /usr/bin/bashio \
    && rm -rf bashio-0.16.2

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
