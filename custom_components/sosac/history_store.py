"""Sdílená historie sledování a pozice přehrávání.

Ukládá se do .storage/sosac — karta v jakémkoli prohlížeči/zařízení
čte a zapisuje přes websocket příkazy.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

STORAGE_KEY = "sosac"
STORAGE_VERSION = 1
HISTORY_MAX = 50

MIN_POS_S = 30      # pozice se ukládá až od 30 s
TAIL_S = 60         # poslední minuta = dokoukané → pozice smažeme


class SosacHistory:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict | None = None

    async def async_load(self) -> None:
        self._data = await self._store.async_load() or {
            "history": [], "positions": {}}

    def _ensure(self) -> dict:
        if self._data is None:
            self._data = {"history": [], "positions": {}}
        return self._data

    def history(self) -> list[dict]:
        return self._ensure()["history"]

    async def async_push(self, item: dict) -> None:
        data = self._ensure()
        data["history"] = [
            e for e in data["history"] if e.get("id") != item.get("id")]
        data["history"].insert(0, {
            "id": item.get("id"),
            "title": item.get("title"),
            "img": item.get("img"),
            "ts": item.get("ts"),
        })
        del data["history"][HISTORY_MAX:]
        await self._store.async_save(data)

    async def async_clear(self) -> None:
        self._ensure()["history"] = []
        await self._store.async_save(self._data)

    def position(self, video_id: str) -> int:
        return int(self._ensure()["positions"].get(video_id) or 0)

    async def async_set_position(self, video_id: str, pos: int,
                                 duration: float = 0) -> None:
        data = self._ensure()
        # dokoukané (poslední minuta) → pozici smažeme
        if pos <= MIN_POS_S or (duration and duration - pos <= TAIL_S):
            data["positions"].pop(video_id, None)
        else:
            data["positions"][video_id] = int(pos)
        await self._store.async_save(data)
