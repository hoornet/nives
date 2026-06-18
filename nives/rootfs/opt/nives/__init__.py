"""Nives integration for Home Assistant."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CONF_API_TOKEN, CONF_API_URL, CONF_USER_ID, DEFAULT_USER_ID

_LOGGER = logging.getLogger(__name__)


def _get_platforms() -> list[Platform]:
    """Platforms to set up. AI Task is added only on HA versions that have it
    (2025.7+), so older cores keep the conversation agent and just skip it."""
    platforms: list[Platform] = [Platform.CONVERSATION]
    ai_task_platform = getattr(Platform, "AI_TASK", None)
    if ai_task_platform is not None:
        try:
            from homeassistant.components import ai_task  # noqa: F401

            platforms.append(ai_task_platform)
        except ImportError:
            _LOGGER.info("ai_task unavailable on this HA version; skipping AI Task entity")
    return platforms


@dataclass
class NivesData:
    """Runtime data for a Nives config entry."""

    api_url: str
    api_token: str | None
    user_id: str


type NivesConfigEntry = ConfigEntry[NivesData]


async def async_setup_entry(hass: HomeAssistant, entry: NivesConfigEntry) -> bool:
    """Set up Nives from a config entry."""
    entry.runtime_data = NivesData(
        api_url=entry.data.get(CONF_API_URL, "").rstrip("/"),
        api_token=entry.data.get(CONF_API_TOKEN, "").strip() or None,
        user_id=entry.data.get(CONF_USER_ID, DEFAULT_USER_ID),
    )
    await hass.config_entries.async_forward_entry_setups(entry, _get_platforms())
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: NivesConfigEntry) -> None:
    """Reload the config entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: NivesConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, _get_platforms())
