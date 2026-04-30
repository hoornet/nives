"""Home Mind integration for Home Assistant."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CONF_API_TOKEN, CONF_API_URL, CONF_USER_ID, DEFAULT_USER_ID

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.CONVERSATION]


@dataclass
class HomeMindData:
    """Runtime data for a HomeMind config entry."""

    api_url: str
    api_token: str | None
    user_id: str


type HomeMindConfigEntry = ConfigEntry[HomeMindData]


async def async_setup_entry(hass: HomeAssistant, entry: HomeMindConfigEntry) -> bool:
    """Set up Home Mind from a config entry."""
    entry.runtime_data = HomeMindData(
        api_url=entry.data.get(CONF_API_URL, "").rstrip("/"),
        api_token=entry.data.get(CONF_API_TOKEN, "").strip() or None,
        user_id=entry.data.get(CONF_USER_ID, DEFAULT_USER_ID),
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: HomeMindConfigEntry) -> None:
    """Reload the config entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: HomeMindConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
