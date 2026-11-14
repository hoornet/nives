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

# Generate the add-on's own API token on first run.
#
# Without this the server's auth middleware stays dormant and port 3100 is wide
# open to anything that can reach the container: /api/chat can drive Home
# Assistant, and DELETE /api/memory/:userId wipes everything the user has taught
# it. The token is persisted in /data so it survives restarts and updates — the
# companion integration receives it via the Supervisor discovery message, so
# there is nothing for the user to copy or configure.
if [ ! -f /data/.api_token ]; then
    openssl rand -hex 32 > /data/.api_token
    echo "[init] Generated a new API token for the Nives server"
fi
chmod 600 /data/.api_token /data/.shodh_key 2>/dev/null || true

API_TOKEN=$(cat /data/.api_token)

# Read options (nested cloud/byok structure)
LLM_MODE=$(jq -r '.llm_mode // "byok"' "$OPTIONS")
PROXY_KEY=$(jq -r '.cloud.api_key // ""' "$OPTIONS")
CLOUD_TRANSCRIPTION=$(jq -r '.cloud.transcription // false' "$OPTIONS")
CLOUD_VOICE=$(jq -r '.cloud.voice // "off"' "$OPTIONS")
LLM_PROVIDER=$(jq -r '.byok.provider // "anthropic"' "$OPTIONS")
LLM_API_KEY=$(jq -r '.byok.api_key // ""' "$OPTIONS")
LLM_MODEL=$(jq -r '.byok.model // ""' "$OPTIONS")
LLM_BASE_URL=$(jq -r '.byok.base_url // ""' "$OPTIONS")
CUSTOM_PROMPT=$(jq -r '.custom_prompt // ""' "$OPTIONS")
MAX_OUTPUT_TOKENS=$(jq -r '.max_output_tokens // ""' "$OPTIONS")
REASONING_EFFORT=$(jq -r '.reasoning_effort // ""' "$OPTIONS")
# `// ""` would turn an explicit false into "", so test for null instead.
LAYOUT_FROM_EXPOSED=$(jq -r 'if .layout_from_exposed == null then "" else (.layout_from_exposed|tostring) end' "$OPTIONS")
TOOLS_FROM_EXPOSED=$(jq -r 'if .tools_from_exposed == null then "" else (.tools_from_exposed|tostring) end' "$OPTIONS")
LAYOUT_DOMAINS=$(jq -r '.layout_domains // ""' "$OPTIONS")
LOG_LEVEL=$(jq -r '.log_level // "info"' "$OPTIONS")

# --- LLM configuration ---
# The server needs to know the mode itself (not just its consequences): in
# cloud mode it posts the Nives Cloud closing notice.
write_env "LLM_MODE" "$LLM_MODE"
if [ "$LLM_MODE" = "cloud" ]; then
    # Cloud mode: a Nives Cloud key. Nives Cloud closes on 2026-12-01 and its keys
    # stop working that day; until then they run on the standard preset. Since
    # 2.10.0 nothing is fetched from the Nives Cloud site: that call sent the key
    # there on every start, and the domain outlives the service.
    write_env "LLM_PROVIDER" "openai"
    write_env "OPENAI_API_KEY" "$PROXY_KEY"
    write_env "OPENAI_BASE_URL" "https://openrouter.ai/api/v1"
    write_env "LLM_MODEL" "@preset/nives-standard"
    echo "[init] Nives Cloud closes on 1 December 2026. Switch LLM Mode to byok with your own key;"
    echo "[init]   the notification in Home Assistant explains how."
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
        mistral)
            # Mistral's API is OpenAI-compatible — rewrite provider to openai, like
            # OpenRouter. The base URL may be overridden for another Mistral
            # endpoint. Name it in the log when it is: one left over from a previous
            # provider (Ollama needs one) would otherwise take the requests unnoticed.
            write_env "LLM_PROVIDER" "openai"
            write_env "OPENAI_API_KEY" "$LLM_API_KEY"
            write_env "OPENAI_BASE_URL" "${LLM_BASE_URL:-https://api.mistral.ai/v1}"
            if [ -n "$LLM_BASE_URL" ]; then
                # A user:password@ part or a query string can carry a credential,
                # and this log gets pasted into bug reports.
                shown=$(printf '%s' "${LLM_BASE_URL%%\?*}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#')
                echo "[init] Mistral: using the API Base URL from the configuration (${shown})"
            fi
            ;;
        ollama)
            write_env "OLLAMA_BASE_URL" "${LLM_BASE_URL:-http://homeassistant:11434/v1}"
            ;;
    esac

    # Model, with a per-provider default when the user leaves it blank.
    # Only OpenRouter used to get a default; every other provider fell through to
    # the server's own built-in default, which is an Anthropic model id. Pointing
    # that at OpenAI or Ollama gets a "model not found" error that reads like the
    # add-on is broken rather than like a missing setting.
    if [ -n "$LLM_MODEL" ]; then
        write_env "LLM_MODEL" "$LLM_MODEL"
    else
        case "$LLM_PROVIDER" in
            openrouter)
                write_env "LLM_MODEL" "anthropic/claude-haiku-5.5"
                echo "[init] No model set — defaulting to anthropic/claude-haiku-5.5"
                ;;
            openai)
                write_env "LLM_MODEL" "gpt-5-mini"
                echo "[init] No model set — defaulting to gpt-5-mini"
                ;;
            mistral)
                write_env "LLM_MODEL" "mistral-small-latest"
                echo "[init] No model set — defaulting to mistral-small-latest"
                ;;
            ollama)
                echo "[init] WARNING: Ollama has no default model. Set 'Model' in the add-on"
                echo "[init]          configuration to the name you pulled (e.g. qwen3:8b),"
                echo "[init]          otherwise chat will fail with a model-not-found error."
                ;;
            anthropic)
                # The server's built-in default is already an Anthropic model.
                :
                ;;
        esac
    fi
fi

# --- Optional voice and transcription (opt-in, default off) ---
# Both run on OpenRouter's speech endpoints, so they need an OpenRouter key: a
# Nives Cloud key until it stops, or your own when Provider is openrouter. The
# settings keep their old place in the "cloud" group so nobody's choice is lost.
VOICE_KEY=""
if [ "$LLM_MODE" = "cloud" ]; then
    VOICE_KEY="$PROXY_KEY"
elif [ "$LLM_PROVIDER" = "openrouter" ]; then
    VOICE_KEY="$LLM_API_KEY"
fi
if [ -z "$VOICE_KEY" ] && { [ "$CLOUD_TRANSCRIPTION" = "true" ] || [ "$CLOUD_VOICE" != "off" ]; }; then
    echo "[init] Voice and transcription need an OpenRouter key (Provider: openrouter); leaving them off"
fi

# Listening is billed to the key like chat, so it stays off until the user asks
# for it. When off we write nothing: the server's default STT_PROVIDER is "none"
# and /api/stt answers 501, which is what tells the integration not to offer a
# speech-to-text entity at all. MAI-Transcribe 2 is the model Nives Cloud served
# to every install; for Slovene it heard far better than Whisper (2026-09).
if [ "$CLOUD_TRANSCRIPTION" = "true" ] && [ -n "$VOICE_KEY" ]; then
    write_env "STT_PROVIDER" "openai"
    write_env "STT_API_KEY" "$VOICE_KEY"
    write_env "STT_BASE_URL" "https://openrouter.ai/api/v1"
    write_env "STT_MODEL" "microsoft/mai-transcribe-2"
    echo "[init] transcription: on (microsoft/mai-transcribe-2)"
fi

# Speaking is billed to the key too, so it stays off until the user picks a
# voice. When off we write nothing: the server's default TTS_PROVIDER is "none"
# and /api/tts answers 501, which is what tells the integration not to offer a
# text-to-speech entity at all.
#
# A voice is language-specific, so each choice carries its language with it.
# The integration advertises exactly that language rather than offering itself
# for every pipeline, and the language also has to reach the model: Slovene
# inflects the first person for the speaker's gender, so a female voice saying
# "Ugasnil sem" is wrong in a way no listener will forgive.
if [ "$CLOUD_VOICE" != "off" ] && [ -n "$VOICE_KEY" ]; then
    # Gender travels with the voice on purpose: the voice decides, not the
    # persona, because the user hears the voice. The model travels with it too,
    # since a voice name only means something to its own model. Petra and Rok
    # moved from microsoft/mai-voice-2 (expires 2026-12-31) to mai-voice-2.1 in
    # 2.10.0: same Azure voices, Rok's test clip came back byte for byte the
    # same. The "premium" voice (2.8.0) is ElevenLabs v4 jessica, the one voice
    # that put the word stress right in every render of the 2026-10 Slovene
    # bake-off once the language is pinned (the server pins it); there is no
    # male premium voice yet. It costs about twice the standard voices per
    # reply, still a fraction of a cent. The server decides per model whether
    # numbers and initialisms are spelled out for the voice.
    case "$CLOUD_VOICE" in
        slovene_female)         TTS_MODEL_ID="microsoft/mai-voice-2.1"; TTS_VOICE_ID="sl-SI-PetraNeural"; TTS_LANG="sl"; TTS_GENDER="female" ;;
        slovene_male)           TTS_MODEL_ID="microsoft/mai-voice-2.1"; TTS_VOICE_ID="sl-SI-RokNeural";   TTS_LANG="sl"; TTS_GENDER="male" ;;
        slovene_female_premium) TTS_MODEL_ID="elevenlabs/eleven-v4";    TTS_VOICE_ID="jessica";           TTS_LANG="sl"; TTS_GENDER="female" ;;
        *)                      TTS_MODEL_ID=""; TTS_VOICE_ID=""; TTS_LANG=""; TTS_GENDER="" ;;
    esac
    if [ -n "$TTS_VOICE_ID" ]; then
        write_env "TTS_PROVIDER" "openai"
        write_env "TTS_API_KEY" "$VOICE_KEY"
        write_env "TTS_BASE_URL" "https://openrouter.ai/api/v1"
        write_env "TTS_MODEL" "$TTS_MODEL_ID"
        write_env "TTS_VOICE" "$TTS_VOICE_ID"
        write_env "TTS_LANGUAGE" "$TTS_LANG"
        write_env "TTS_VOICE_GENDER" "$TTS_GENDER"
        echo "[init] voice: on (${CLOUD_VOICE}, ${TTS_GENDER}, ${TTS_MODEL_ID})"
    else
        echo "[init] voice: unknown choice '${CLOUD_VOICE}', staying silent"
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

# --- API auth ---
#
# Hand the token to the companion integration through a file in /config. The
# add-on has config:rw, so this lands in the directory Home Assistant reads its
# own configuration from, and the integration re-reads it every time it sets up.
# That is what makes it work for installs that already exist.
#
# 2.4.0 tried to do this through the Supervisor discovery message instead, and
# broke Assist for every existing user: Supervisor DEDUPLICATES discovery, so
# re-announcing returns the same uuid, raises no new event, and the config flow
# never re-runs — the entry never learned the token while the server had already
# started rejecting it. A file has no such one-shot semantics.
#
# Requiring the token is gated on PROOF that the integration can read it, not on
# the assumption that it can. The integration writes back the SHA-256 of the
# token it loaded; we only switch enforcement on once that receipt matches.
#
# So the first start after an update always leaves auth off: we hand the token
# over, Home Assistant restarts into the new integration, and it leaves the
# receipt. The next start of this add-on sees the receipt and starts requiring
# the token. One extra restart in exchange for it being impossible to lock the
# integration out — which is exactly what 2.4.0 did.
#
# Rotating the token invalidates the receipt, so auth falls back to off (not to
# broken) until the integration confirms the new one.
TOKEN_HANDOFF="/config/nives/.api_token"
TOKEN_ACK="${TOKEN_HANDOFF}.ack"

if mkdir -p "$(dirname "$TOKEN_HANDOFF")" 2>/dev/null &&
    printf '%s' "$API_TOKEN" > "$TOKEN_HANDOFF" 2>/dev/null; then
    chmod 600 "$TOKEN_HANDOFF" 2>/dev/null || true

    EXPECTED_ACK=$(printf '%s' "$API_TOKEN" | openssl dgst -sha256 -r 2>/dev/null | cut -d' ' -f1)
    ACTUAL_ACK=$(tr -d '[:space:]' < "$TOKEN_ACK" 2>/dev/null || echo "")

    if [ -n "$EXPECTED_ACK" ] && [ "$ACTUAL_ACK" = "$EXPECTED_ACK" ]; then
        write_env "API_TOKEN" "$API_TOKEN"
        echo "[init] API authentication enabled"
    else
        echo "[init] API authentication not enabled yet — waiting for the Nives"
        echo "[init]          integration to confirm it has the access token."
        echo "[init]          This is normal right after an update; it takes effect"
        echo "[init]          the next time the add-on starts."
    fi
else
    echo "[init] WARNING: could not write ${TOKEN_HANDOFF}."
    echo "[init]          Leaving the Nives API unauthenticated so the integration"
    echo "[init]          keeps working. Port 3100 is reachable by anything on the"
    echo "[init]          same network."
fi

# --- Server configuration (always the same in add-on mode) ---
write_env "PORT" "3100"
write_env "CONVERSATION_STORAGE" "sqlite"
write_env "CONVERSATION_DB_PATH" "/data/conversations.db"
write_env "MEMORY_CLEANUP_INTERVAL_HOURS" "6"
write_env "LOG_LEVEL" "$LOG_LEVEL"

# --- Optional ---
[ -n "$CUSTOM_PROMPT" ] && write_env "CUSTOM_PROMPT" "$CUSTOM_PROMPT"
[ -n "$MAX_OUTPUT_TOKENS" ] && write_env "MAX_OUTPUT_TOKENS" "$MAX_OUTPUT_TOKENS"
[ -n "$REASONING_EFFORT" ] && write_env "REASONING_EFFORT" "$REASONING_EFFORT"
[ -n "$LAYOUT_FROM_EXPOSED" ] && write_env "LAYOUT_FROM_EXPOSED" "$LAYOUT_FROM_EXPOSED"
[ -n "$TOOLS_FROM_EXPOSED" ] && write_env "TOOLS_FROM_EXPOSED" "$TOOLS_FROM_EXPOSED"
[ -n "$LAYOUT_DOMAINS" ] && write_env "LAYOUT_DOMAINS" "$LAYOUT_DOMAINS"

echo "[init] Environment configured (mode=${LLM_MODE}, provider=${LLM_PROVIDER:-cloud}, max_output_tokens=${MAX_OUTPUT_TOKENS:-default}, reasoning_effort=${REASONING_EFFORT:-default})"
