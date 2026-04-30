#!/usr/bin/env bash
# Maps /data/options.json (HA add-on config) to environment variables
# that home-mind-server's loadConfig() expects.
# Writes to /var/run/s6/container_environment/ so all s6 services inherit them.

set -eo pipefail

S6_ENV_DIR="/var/run/s6/container_environment"
OPTIONS="/data/options.json"

write_env() {
    local name="$1"
    local value="$2"
    if [ -n "$value" ]; then
        printf '%s' "$value" > "${S6_ENV_DIR}/${name}"
    fi
}

# Generate Shodh API key on first run
if [ ! -f /data/.shodh_key ]; then
    openssl rand -hex 32 > /data/.shodh_key
fi

SHODH_KEY=$(cat /data/.shodh_key)

# Read options (nested cloud/byok structure)
LLM_MODE=$(jq -r '.llm_mode // "cloud"' "$OPTIONS")
PROXY_KEY=$(jq -r '.cloud.api_key // ""' "$OPTIONS")
LLM_PROVIDER=$(jq -r '.byok.provider // "anthropic"' "$OPTIONS")
LLM_API_KEY=$(jq -r '.byok.api_key // ""' "$OPTIONS")
LLM_MODEL=$(jq -r '.byok.model // ""' "$OPTIONS")
LLM_BASE_URL=$(jq -r '.byok.base_url // ""' "$OPTIONS")
CUSTOM_PROMPT=$(jq -r '.custom_prompt // ""' "$OPTIONS")
LOG_LEVEL=$(jq -r '.log_level // "info"' "$OPTIONS")

# --- LLM configuration ---
if [ "$LLM_MODE" = "cloud" ]; then
    # Cloud mode: user's managed OpenRouter key (created via HomeMind Cloud)
    write_env "LLM_PROVIDER" "openai"
    write_env "OPENAI_API_KEY" "$PROXY_KEY"
    write_env "OPENAI_BASE_URL" "https://openrouter.ai/api/v1"
    write_env "LLM_MODEL" "anthropic/claude-haiku-4.5"
else
    # BYOK mode: user provides their own API key
    write_env "LLM_PROVIDER" "$LLM_PROVIDER"

    case "$LLM_PROVIDER" in
        anthropic)
            write_env "ANTHROPIC_API_KEY" "$LLM_API_KEY"
            ;;
        openai)
            write_env "OPENAI_API_KEY" "$LLM_API_KEY"
            [ -n "$LLM_BASE_URL" ] && write_env "OPENAI_BASE_URL" "$LLM_BASE_URL"
            ;;
        openrouter)
            # OpenRouter is OpenAI-compatible — rewrite provider to openai
            write_env "LLM_PROVIDER" "openai"
            write_env "OPENAI_API_KEY" "$LLM_API_KEY"
            write_env "OPENAI_BASE_URL" "https://openrouter.ai/api/v1"
            ;;
        ollama)
            write_env "OLLAMA_BASE_URL" "${LLM_BASE_URL:-http://homeassistant:11434/v1}"
            ;;
    esac

    # Default model for OpenRouter if not specified
    if [ "$LLM_PROVIDER" = "openrouter" ] && [ -z "$LLM_MODEL" ]; then
        write_env "LLM_MODEL" "anthropic/claude-haiku-4.5"
    elif [ -n "$LLM_MODEL" ]; then
        write_env "LLM_MODEL" "$LLM_MODEL"
    fi
fi

# --- Home Assistant (automatic via Supervisor) ---
# SUPERVISOR_TOKEN may be in the s6 container environment or shell env
SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-}"
if [ -z "$SUPERVISOR_TOKEN" ] && [ -f "${S6_ENV_DIR}/SUPERVISOR_TOKEN" ]; then
    SUPERVISOR_TOKEN=$(cat "${S6_ENV_DIR}/SUPERVISOR_TOKEN")
fi
if [ -z "$SUPERVISOR_TOKEN" ]; then
    echo "[init] WARNING: SUPERVISOR_TOKEN is empty — HA API calls will fail (401)"
    echo "[init] DEBUG: s6 env dir contents: $(ls ${S6_ENV_DIR}/ 2>/dev/null | tr '\n' ' ')"
    echo "[init] DEBUG: env vars with SUPER: $(env | grep -i SUPER 2>/dev/null || echo 'none')"
else
    echo "[init] SUPERVISOR_TOKEN found (${#SUPERVISOR_TOKEN} chars)"
fi
write_env "HA_URL" "http://supervisor/core"
write_env "HA_TOKEN" "$SUPERVISOR_TOKEN"

# --- Shodh Memory (internal, always localhost) ---
write_env "SHODH_URL" "http://127.0.0.1:3030"
write_env "SHODH_API_KEY" "$SHODH_KEY"

# --- Server configuration (always the same in add-on mode) ---
write_env "PORT" "3100"
write_env "CONVERSATION_STORAGE" "sqlite"
write_env "CONVERSATION_DB_PATH" "/data/conversations.db"
write_env "MEMORY_CLEANUP_INTERVAL_HOURS" "6"
write_env "LOG_LEVEL" "$LOG_LEVEL"

# --- Optional ---
[ -n "$CUSTOM_PROMPT" ] && write_env "CUSTOM_PROMPT" "$CUSTOM_PROMPT"

echo "[init] Environment configured (mode=${LLM_MODE}, provider=${LLM_PROVIDER:-cloud})"
