"""Websocket API pro Lovelace kartu.

Příkazy:
  sosac/browse   {path?}    – procházení katalogu (path = sosac URL, prázdné = root)
  sosac/search   {query}    – hledání
  sosac/resolve  {video_id} – streamuj video ID → seznam stream URL
"""
from __future__ import annotations

import time

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
        ("sosac/history", ws_history, {}),
        ("sosac/history_push", ws_history_push,
         {vol.Required("item"): dict}),
        ("sosac/history_clear", ws_history_clear, {}),
        ("sosac/position", ws_position, {vol.Required("video_id"): str}),
        ("sosac/position_set", ws_position_set,
         {vol.Required("video_id"): str, vol.Required("pos"): int,
          vol.Optional("duration", default=0): vol.Coerce(float)}),
    ):
        if cmd not in _REGISTERED:
            ws.async_register_command(hass, cmd, handler, _msg_schema(cmd, extra))
            _REGISTERED.add(cmd)


def _api(hass):
    from . import get_api
    return get_api(hass)


@ws.async_response
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


@ws.async_response
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


@ws.async_response
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


def _history(hass):
    from . import get_history
    return get_history(hass)


@ws.async_response
async def ws_history(hass: HomeAssistant, connection, msg) -> None:
    h = _history(hass)
    if h is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    connection.send_result(msg["id"], {"items": h.history()})


@ws.async_response
async def ws_history_push(hass: HomeAssistant, connection, msg) -> None:
    h = _history(hass)
    if h is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    item = msg["item"]
    item.setdefault("ts", int(time.time() * 1000))
    await h.async_push(item)
    connection.send_result(msg["id"], {"ok": True})


@ws.async_response
async def ws_history_clear(hass: HomeAssistant, connection, msg) -> None:
    h = _history(hass)
    if h is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    await h.async_clear()
    connection.send_result(msg["id"], {"ok": True})


@ws.async_response
async def ws_position(hass: HomeAssistant, connection, msg) -> None:
    h = _history(hass)
    if h is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    connection.send_result(msg["id"], {"pos": h.position(msg["video_id"])})


@ws.async_response
async def ws_position_set(hass: HomeAssistant, connection, msg) -> None:
    h = _history(hass)
    if h is None:
        connection.send_error(msg["id"], "not_loaded", "Integrace Sosáč není načtená")
        return
    await h.async_set_position(msg["video_id"], msg["pos"], msg.get("duration") or 0)
    connection.send_result(msg["id"], {"ok": True})
