"""Sosáč — integrace pro Home Assistant."""
from __future__ import annotations

import logging
import os

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import SosacApi
from .const import CONF_LOCATION, CONF_PASSWORD, CONF_USERNAME, DOMAIN
from . import websocket_api

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = []

CARD_URL = "/sosac/sosac-card.js"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Websocket příkazy registrujeme hned, nezávisle na config entry."""
    websocket_api.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    session = async_get_clientsession(hass)
    api = SosacApi(
        session,
        username=entry.data.get(CONF_USERNAME, ""),
        password=entry.data.get(CONF_PASSWORD, ""),
        location=entry.data.get(CONF_LOCATION, ""),
        lang=hass.config.language,
    )
    hass.data.setdefault(DOMAIN, {}).setdefault("api", {})[entry.entry_id] = api

    await _register_card_static_path(hass)
    return True


async def _register_card_static_path(hass: HomeAssistant) -> None:
    card_path = os.path.join(os.path.dirname(__file__), "www", "sosac-card.js")
    try:
        try:
            from homeassistant.components.http import StaticPathConfig
            await hass.http.async_register_static_paths(
                [StaticPathConfig(CARD_URL, card_path, cache_headers=False)]
            )
        except (ImportError, AttributeError, TypeError):
            # starší HA očekává dict
            await hass.http.async_register_static_paths(
                [{"url_path": CARD_URL, "path": card_path,
                  "cache_headers": False}]
            )
    except RuntimeError as err:  # cesta už registrovaná (reload integrace)
        _LOGGER.debug("Static path už existuje: %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.get(DOMAIN, {}).get("api", {}).pop(entry.entry_id, None)
    return True


def get_api(hass: HomeAssistant) -> SosacApi | None:
    apis = (hass.data.get(DOMAIN) or {}).get("api") or {}
    return next(iter(apis.values()), None)
