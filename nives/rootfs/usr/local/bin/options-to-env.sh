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
LLM_MODE=$(jq -r '.llm_mode // "cloud"' "$OPTIONS")
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
# The server needs to know the mode itself (not just its consequences): the
# balance watch runs only in cloud mode, where "top up at nives.house" is true.
write_env "LLM_MODE" "$LLM_MODE"
if [ "$LLM_MODE" = "cloud" ]; then
    # Cloud mode: user's managed OpenRouter key (created via Nives Cloud)
    write_env "LLM_PROVIDER" "openai"
    write_env "OPENAI_API_KEY" "$PROXY_KEY"
    write_env "OPENAI_BASE_URL" "https://openrouter.ai/api/v1"

    # Ask Nives Cloud which model preset this key's plan maps to. The cloud
    # returns @preset/nives-<tier>, so the model lineup is managed server-side
    # with no add-on update. Bounded + failure-safe: falls back to a working
    # default if the cloud is briefly unreachable (chat still goes direct to OR).
    CLOUD_MODEL="@preset/nives-standard"
    CLOUD_STT_MODEL=""
    if [ -n "$PROXY_KEY" ]; then
        CLOUD_CFG=$(curl -fsS --max-time 8 -H "Authorization: Bearer $PROXY_KEY" \
            "https://nives.house/api/addon/config" 2>/dev/null || true)
        RESOLVED=$(printf '%s' "$CLOUD_CFG" | jq -r '.model // ""' 2>/dev/null || true)
        case "$RESOLVED" in
            @preset/nives-*) CLOUD_MODEL="$RESOLVED" ;;
        esac
        # Optional and forward-looking: lets the transcription model be swapped
        # server-side later without an add-on release, the same way the chat
        # lineup already is. Absent today, which is why there is a default.
        CLOUD_STT_MODEL=$(printf '%s' "$CLOUD_CFG" | jq -r '.stt_model // ""' 2>/dev/null || true)
        CLOUD_TTS_MODEL=$(printf '%s' "$CLOUD_CFG" | jq -r '.tts_model // ""' 2>/dev/null || true)
        echo "[init] cloud model: ${CLOUD_MODEL}"
    fi
    write_env "LLM_MODEL" "$CLOUD_MODEL"

    # --- Optional cloud transcription (opt-in, default off) ---
    # Listening is billed to the same balance as chat, so it stays off until
    # the user asks for it. When off we write nothing: the server's default
    # STT_PROVIDER is "none" and /api/stt answers 501, which is what tells the
    # integration not to offer a speech-to-text entity at all.
    if [ "$CLOUD_TRANSCRIPTION" = "true" ] && [ -n "$PROXY_KEY" ]; then
        write_env "STT_PROVIDER" "openai"
        write_env "STT_API_KEY" "$PROXY_KEY"
        write_env "STT_BASE_URL" "https://openrouter.ai/api/v1"
        write_env "STT_MODEL" "${CLOUD_STT_MODEL:-openai/whisper-large-v3}"
        echo "[init] cloud transcription: on (${CLOUD_STT_MODEL:-openai/whisper-large-v3})"
    fi

    # --- Optional cloud voice (opt-in, default off) ---
    # Speaking is billed to the same balance as chat, so it stays off until the
    # user picks a voice. When off we write nothing: the server's default
    # TTS_PROVIDER is "none" and /api/tts answers 501, which is what tells the
    # integration not to offer a text-to-speech entity at all.
    #
    # A voice is language-specific, so each choice carries its language with it.
    # The integration advertises exactly that language rather than offering
    # itself for every pipeline, and the language also has to reach the model:
    # Slovene inflects the first person for the speaker's gender, so a female
    # voice saying "Ugasnil sem" is wrong in a way no listener will forgive.
    if [ "$CLOUD_VOICE" != "off" ] && [ -n "$PROXY_KEY" ]; then
        # Gender travels with the voice on purpose. Slovene — like most Slavic
        # languages, Hebrew and Arabic — inflects the first person for the
        # speaker's own gender, so a man's voice saying "Ugasnila sem" is wrong
        # in a way every native listener catches instantly. The voice decides,
        # not the persona: the user hears the voice.
        # The model travels with the voice too: a voice name only means something to the
        # model it belongs to. The "premium" pair (2.8.0) is ElevenLabs v4, picked by ear in
        # the 2026-10 Slovene bake-off (jessica 4/4 and daniel 9/9 on word stress with the
        # language pinned; the server pins it); it costs about twice the standard pair per
        # reply, still a fraction of a cent. The server decides per model whether numbers and
        # initialisms are spelled out for the voice (the standard pair needs it, ElevenLabs
        # reads them right as written).
        case "$CLOUD_VOICE" in
            slovene_female)         TTS_MODEL_ID="microsoft/mai-voice-2"; TTS_VOICE_ID="sl-SI-PetraNeural"; TTS_LANG="sl"; TTS_GENDER="female" ;;
            slovene_male)           TTS_MODEL_ID="microsoft/mai-voice-2"; TTS_VOICE_ID="sl-SI-RokNeural";   TTS_LANG="sl"; TTS_GENDER="male" ;;
            slovene_female_premium) TTS_MODEL_ID="elevenlabs/eleven-v4";  TTS_VOICE_ID="jessica";           TTS_LANG="sl"; TTS_GENDER="female" ;;
            slovene_male_premium)   TTS_MODEL_ID="elevenlabs/eleven-v4";  TTS_VOICE_ID="daniel";            TTS_LANG="sl"; TTS_GENDER="male" ;;
            *)                      TTS_MODEL_ID=""; TTS_VOICE_ID=""; TTS_LANG=""; TTS_GENDER="" ;;
        esac
        # The cloud-side tts_model override predates the second model and names the one the
        # standard voices run on, so it applies to those only; a voice name from one model
        # means nothing to another.
        if [ "$TTS_MODEL_ID" = "microsoft/mai-voice-2" ] && [ -n "$CLOUD_TTS_MODEL" ]; then
            TTS_MODEL_ID="$CLOUD_TTS_MODEL"
        fi
        if [ -n "$TTS_VOICE_ID" ]; then
            write_env "TTS_PROVIDER" "openai"
            write_env "TTS_API_KEY" "$PROXY_KEY"
            write_env "TTS_BASE_URL" "https://openrouter.ai/api/v1"
            write_env "TTS_MODEL" "$TTS_MODEL_ID"
            write_env "TTS_VOICE" "$TTS_VOICE_ID"
            write_env "TTS_LANGUAGE" "$TTS_LANG"
            write_env "TTS_VOICE_GENDER" "$TTS_GENDER"
            echo "[init] cloud voice: on (${CLOUD_VOICE}, ${TTS_GENDER}, ${TTS_MODEL_ID})"
        else
            echo "[init] cloud voice: unknown choice '${CLOUD_VOICE}', staying silent"
        fi
    fi
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
                write_env "LLM_MODEL" "anthropic/claude-haiku-4.5"
                echo "[init] No model set — defaulting to anthropic/claude-haiku-4.5"
                ;;
            openai)
                write_env "LLM_MODEL" "gpt-5-mini"
                echo "[init] No model set — defaulting to gpt-5-mini"
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
