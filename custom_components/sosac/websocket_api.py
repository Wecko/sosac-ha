"""Websocket API pro Lovelace kartu.

Příkazy:
  sosac/browse   {id?}   – procházení katalogu (id = sosac URL, prázdné = root)
  sosac/search   {query} – hledání
  sosac/resolve  {id}    – streamuj video ID → seznam stream URL
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api as ws
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN


@callback
def async_register(hass: HomeAssistant) -> None:
    for cmd, handler, schema in (
        ("sosac/browse", ws_browse, {vol.Optional("id", default=""): str}),
        ("sosac/search", ws_search, {vol.Required("query"): str}),
        ("sosac/resolve", ws_resolve, {vol.Required("id"): str}),
    ):
        if not hass.data.get(DOMAIN, {}).get(f"_ws_{cmd}"):
            ws.async_register_command(
                hass, cmd, handler,
                vol.All(ws.BASE_COMMAND_MESSAGE_SCHEMA.extend(schema)),
            )
            hass.data.setdefault(DOMAIN, {})[f"_ws_{cmd}"] = True


def _api(hass):
    from . import get_api
    return get_api(hass)


async def ws_browse(hass: HomeAssistant, connection, msg) -> None:
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    try:
        items = await api.browse(msg.get("id") or "")
    except Exception as err:
        connection.send_error(msg["id"], "browse_failed", str(err))
        return
    connection.send_result(msg["id"], {"items": items})


async def ws_search(hass: HomeAssistant, connection, msg) -> None:
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    try:
        items = await api.search(msg["query"].strip())
    except Exception as err:
        connection.send_error(msg["id"], "search_failed", str(err))
        return
    connection.send_result(msg["id"], {"items": items})


async def ws_resolve(hass: HomeAssistant, connection, msg) -> None:
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    try:
        streams = await api.resolve(msg["id"])
    except Exception as err:
        connection.send_error(msg["id"], "resolve_failed", str(err))
        return
    connection.send_result(msg["id"], {
        "streams": [{"url": s.url, "quality": s.quality, "lang": s.lang}
                    for s in streams]
    })
