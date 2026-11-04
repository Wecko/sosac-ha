"""Websocket API pro Lovelace kartu.

Příkazy:
  sosac/browse   {path?}    – procházení katalogu (path = sosac URL, prázdné = root)
  sosac/search   {query}    – hledání
  sosac/resolve  {video_id} – streamuj video ID → seznam stream URL
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api as ws
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN


_REGISTERED: set[str] = set()


def _msg_schema(cmd: str, extra: dict) -> vol.Schema:
    """Schéma pro celou ws zprávu včetně literálu `type` — stejný vzor
    jako interní příkazy HA (robustní vůči vol/probatio rozdílům verzí)."""
    return vol.Schema(
        {vol.Required("type"): cmd, **extra},
        extra=vol.ALLOW_EXTRA,
    )


@callback
def async_register(hass: HomeAssistant) -> None:
    for cmd, handler, extra in (
        ("sosac/browse", ws_browse, {vol.Optional("path", default=""): str}),
        ("sosac/search", ws_search, {vol.Required("query"): str}),
        ("sosac/resolve", ws_resolve, {vol.Required("video_id"): str}),
    ):
        if cmd not in _REGISTERED:
            ws.async_register_command(hass, cmd, handler, _msg_schema(cmd, extra))
            _REGISTERED.add(cmd)


def _api(hass):
    from . import get_api
    return get_api(hass)


async def ws_browse(hass: HomeAssistant, connection, msg) -> None:
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    try:
        items = await api.browse(msg.get("path") or "")
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
        streams = await api.resolve(msg["video_id"])
    except Exception as err:
        connection.send_error(msg["id"], "resolve_failed", str(err))
        return
    connection.send_result(msg["id"], {
        "streams": [{"url": s.url, "quality": s.quality, "lang": s.lang}
                    for s in streams]
    })
