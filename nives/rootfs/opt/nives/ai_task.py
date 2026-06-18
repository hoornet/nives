"""AI Task platform for Nives.

Exposes Nives as a Home Assistant AI Task provider so automations/scripts can
call `ai_task.generate_data` for text or structured (JSON) output, reasoned with
the user's Nives memory. Text-only for now (no image/vision attachments).
"""

from __future__ import annotations

import logging

import aiohttp
import voluptuous as vol
from voluptuous_openapi import convert

from homeassistant.components import ai_task, conversation
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util.json import json_loads

from . import NivesConfigEntry
from .const import AI_TASK_CUSTOM_PROMPT, API_CHAT_ENDPOINT, DEFAULT_TIMEOUT

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: NivesConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Nives AI Task entity from a config entry."""
    async_add_entities([NivesAITaskEntity(hass, config_entry)])


class NivesAITaskEntity(ai_task.AITaskEntity):
    """Nives AI Task provider (text + structured data generation)."""

    _attr_has_entity_name = True
    _attr_name = "AI Task"
    _attr_supported_features = ai_task.AITaskEntityFeature.GENERATE_DATA

    def __init__(self, hass: HomeAssistant, entry: NivesConfigEntry) -> None:
        """Initialize the AI Task entity."""
        self.hass = hass
        self.entry = entry
        self._session = async_get_clientsession(hass)

        self._attr_unique_id = f"{entry.entry_id}_ai_task"
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(entry.domain, entry.entry_id)},
            name="Nives",
            manufacturer="Nives",
            model="AI Assistant",
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    async def _async_generate_data(
        self,
        task: ai_task.GenDataTask,
        chat_log: conversation.ChatLog,
    ) -> ai_task.GenDataTaskResult:
        """Generate data (text or structured) for an AI Task."""
        message = task.instructions

        # When a structured output is requested, describe the JSON schema in the
        # prompt and parse/validate the reply ourselves (the server has no native
        # JSON mode).
        if task.structure is not None:
            schema = convert(task.structure, custom_serializer=llm.selector_serializer)
            message = (
                f"{task.instructions}\n\n"
                "Respond with ONLY a JSON object that matches this JSON schema. "
                "Do not wrap it in markdown code fences or add any text outside "
                f"the JSON object.\nSchema:\n{schema}"
            )

        response_text = await self._call_nives(message)

        if task.structure is None:
            return ai_task.GenDataTaskResult(
                conversation_id=chat_log.conversation_id,
                data=response_text,
            )

        # Structured: parse JSON, then coerce/validate against the requested schema.
        try:
            parsed = json_loads(_strip_code_fences(response_text))
        except ValueError as err:
            _LOGGER.error("Nives returned non-JSON for a structured task: %s", response_text)
            raise HomeAssistantError(
                "Nives did not return valid JSON for the requested structure."
            ) from err

        try:
            validated = task.structure(parsed)
        except vol.Invalid as err:
            raise HomeAssistantError(
                f"Nives JSON did not match the requested structure: {err}"
            ) from err

        return ai_task.GenDataTaskResult(
            conversation_id=chat_log.conversation_id,
            data=validated,
        )

    async def _call_nives(self, message: str) -> str:
        """POST a one-shot, memory-aware request to the Nives server.

        Stateless (no conversationId, so it never touches conversation history)
        and task-framed via a dedicated customPrompt. Mirrors the request shape
        in conversation.py.
        """
        data = self.entry.runtime_data
        url = f"{data.api_url}{API_CHAT_ENDPOINT}"

        payload: dict = {
            "message": message,
            "userId": data.user_id,
            "customPrompt": AI_TASK_CUSTOM_PROMPT,
        }
        headers: dict = {}
        if data.api_token:
            headers["Authorization"] = f"Bearer {data.api_token}"

        try:
            async with self._session.post(
                url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as response:
                if response.status == 402:
                    raise HomeAssistantError(
                        "Nives usage limit reached. Visit nives.house to renew or upgrade."
                    )
                if response.status != 200:
                    raise HomeAssistantError(
                        f"Nives server returned HTTP {response.status}."
                    )
                body = await response.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError(
                f"Couldn't reach the Nives server: {err}"
            ) from err

        response_text = body.get("response")
        if response_text:
            return response_text

        error = body.get("error")
        if isinstance(error, dict) and error.get("hint"):
            raise HomeAssistantError(f"Nives could not complete the task: {error['hint']}")
        raise HomeAssistantError("Nives returned an empty response.")


def _strip_code_fences(text: str) -> str:
    """Remove a leading ```/```json fence and trailing ``` if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence line (``` or ```json).
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[:-3]
    return stripped.strip()
