"""Constants for Nives integration."""

DOMAIN = "nives"
CONF_API_URL = "api_url"
CONF_API_TOKEN = "api_token"
CONF_USER_ID = "user_id"
CONF_CUSTOM_PROMPT = "custom_prompt"

DEFAULT_API_URL = "http://localhost:3100"
DEFAULT_USER_ID = "default"
DEFAULT_TIMEOUT = 120  # Claude with tool use can take 60+ seconds

API_CHAT_ENDPOINT = "/api/chat"
API_HEALTH_ENDPOINT = "/api/health"

CLOUD_SIGNUP_URL = "https://nives.house"

# System-prompt override for AI Task requests. Keeps task output clean and
# literal, instead of the chatty smart-home assistant persona. Intentionally
# separate from CONF_CUSTOM_PROMPT (the user's conversation persona).
AI_TASK_CUSTOM_PROMPT = (
    "You are a data-generation assistant for Home Assistant. Follow the "
    "instructions exactly and output only what is asked — no greetings, "
    "commentary, or chit-chat."
)
