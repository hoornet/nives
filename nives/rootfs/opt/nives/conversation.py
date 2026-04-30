"""Conversation agent for Home Mind."""

from __future__ import annotations

import logging
from typing import Literal

import aiohttp

from homeassistant.components.conversation import (
    ConversationEntity,
    ConversationEntityFeature,
    ConversationInput,
    ConversationResult,
)
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import HomeMindConfigEntry
from .const import (
    API_CHAT_ENDPOINT,
    CONF_CUSTOM_PROMPT,
    DEFAULT_TIMEOUT,
)

_LOGGER = logging.getLogger(__name__)


class UsageLimitError(Exception):
    """Raised when the HomeMind server returns HTTP 402 (usage limit reached)."""


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: HomeMindConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up conversation agent from a config entry."""
    async_add_entities([HomeMindConversationAgent(hass, config_entry)])


class HomeMindConversationAgent(ConversationEntity):
    """Home Mind conversation agent."""

    _attr_has_entity_name = True
    _attr_name = None  # entity name = device name
    _attr_supported_features = ConversationEntityFeature.CONTROL
    _attr_translation_key = "home_mind"

    def __init__(self, hass: HomeAssistant, entry: HomeMindConfigEntry) -> None:
        """Initialize the agent."""
        self.hass = hass
        self.entry = entry
        self._session = async_get_clientsession(hass)

        self._attr_unique_id = entry.entry_id
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(entry.domain, entry.entry_id)},
            name="HomeMind PRO",
            manufacturer="HomeMind PRO",
            model="AI Assistant",
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return supported languages."""
        return MATCH_ALL

    async def async_process(self, user_input: ConversationInput) -> ConversationResult:
        """Process a conversation input and return a response."""
        _LOGGER.debug("Processing conversation input: %s", user_input.text)

        data = self.entry.runtime_data
        user_id = data.user_id
        if user_input.context and user_input.context.user_id:
            user_id = str(user_input.context.user_id)

        conversation_id = user_input.conversation_id

        try:
            response_text = await self._call_api(
                api_url=data.api_url,
                api_token=data.api_token,
                message=user_input.text,
                user_id=user_id,
                conversation_id=conversation_id,
            )
        except UsageLimitError:
            _LOGGER.warning("HomeMind PRO usage limit reached")
            await self.hass.services.async_call(
                "persistent_notification",
                "create",
                {
                    "title": "HomeMind PRO — Usage Limit Reached",
                    "message": (
                        "Your monthly usage allowance is depleted. "
                        "Visit homemind.veganostr.com to renew or upgrade."
                    ),
                    "notification_id": "homemind_usage_limit",
                },
            )
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech(
                "Your monthly token allowance is depleted. "
                "Please visit homemind.veganostr.com to renew or upgrade."
            )
            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.error("Error calling Home Mind API: %s", err)
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "Sorry, I couldn't reach the HomeMind server right now.",
            )
            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
            )

        intent_response = intent.IntentResponse(language=user_input.language)
        intent_response.async_set_speech(response_text)
        return ConversationResult(
            response=intent_response,
            conversation_id=conversation_id,
        )

    async def _call_api(
        self,
        api_url: str,
        api_token: str | None,
        message: str,
        user_id: str,
        conversation_id: str | None,
    ) -> str:
        """Call the Home Mind API."""
        url = f"{api_url}{API_CHAT_ENDPOINT}"

        payload: dict = {
            "message": message,
            "userId": user_id,
            "conversationId": conversation_id,
        }

        custom_prompt = self.entry.options.get(CONF_CUSTOM_PROMPT)
        if custom_prompt:
            payload["customPrompt"] = custom_prompt

        headers: dict = {}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"

        async with self._session.post(
            url,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
        ) as response:
            if response.status == 402:
                raise UsageLimitError()
            if response.status != 200:
                raise aiohttp.ClientResponseError(
                    response.request_info,
                    response.history,
                    status=response.status,
                    message=f"API error {response.status}",
                )
            data = await response.json()
            return data.get("response") or "I received your request but got no response."
