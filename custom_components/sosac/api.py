"""Async klient pro sosac.tv JSON API + resolve streamů přes streamuj.tv.

Port logiky z Kodi pluginu plugin.video.sosac.ph a streamujtvresolver
(script.module.stream.resolver).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass

import aiohttp

_LOGGER = logging.getLogger(__name__)

URL = "http://tv.sosac.to"
J_MOVIES_A_TO_Z = "/vystupy5981/souboryaz.json"
J_MOVIES_GENRE = "/vystupy5981/souboryzanry.json"
J_MOVIES_MOST_POPULAR = "/vystupy5981/moviesmostpopular.json"
J_MOVIES_RECENTLY_ADDED = "/vystupy5981/moviesrecentlyadded.json"
J_TV_SHOWS = "/vystupy5981/tvpismena/"
J_TV_SHOWS_A_TO_Z = "/vystupy5981/tvpismenaaz/"
J_SERIES = "/vystupy5981/serialy/"
J_TV_SHOWS_MOST_POPULAR = "/vystupy5981/tvshowsmostpopular.json"
J_TV_SHOWS_RECENTLY_ADDED = "/vystupy5981/tvshowsrecentlyadded.json"
J_SEARCH = "/jsonsearchapi.php?q="

STREAMUJ_URL = "http://www.streamuj.tv/video/"
IMAGE_URL = "http://movies.sosac.tv/images/"
IMAGE_MOVIE = IMAGE_URL + "75x109/movie-"
IMAGE_SERIES = IMAGE_URL + "558x313/serial-"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
STREAMUJ_PLAYER_URL = "http://www.streamuj.tv/new-flash-player/mplugin4.swf"

LETTERS = ["0-9"] + [chr(c) for c in range(ord("a"), ord("z") + 1)]


def _name(names: dict, lang: str = "cs") -> str:
    return names.get(lang) or names.get("cs") or next(iter(names.values()), "")


def _movie_item(v: dict, lang: str) -> dict:
    return {
        "type": "video",
        "id": v.get("l") or "",
        "title": _name(v.get("n", {}), lang),
        "year": v.get("y") or "",
        "img": IMAGE_MOVIE + v["i"] if v.get("i") else None,
        "rating": (v.get("r") or 0) * 2,
        "quality": v.get("q"),
        "lang": v.get("d"),
        "plot": " ".join(v.get("g") or []),
    }


def _series_item(s: dict, lang: str) -> dict:
    return {
        "type": "series",
        "id": s.get("l") or "",
        "title": _name(s.get("n", {}), lang),
        "year": s.get("y") or "",
        "img": IMAGE_SERIES + s["i"] if s.get("i") else None,
        "rating": (s.get("r") or 0) * 2,
        "plot": s.get("p") or "",
    }


def _episode_item(season: str, ep: str, v: dict) -> dict:
    img = v.get("i") or ""
    if img and not img.startswith("http"):
        img = URL + img
    return {
        "type": "video",
        "id": v.get("l") or "",
        "title": f"{season.zfill(2)}x{ep.zfill(2)} - {v.get('n', '')}",
        "season": int(season),
        "episode": int(ep),
        "img": img or None,
    }


@dataclass
class Stream:
    url: str
    quality: str
    lang: str


class SosacApi:
    """Klient nad sosac.tv JSON API."""

    def __init__(self, session: aiohttp.ClientSession, username: str = "",
                 password: str = "", location: str = "", lang: str = "cs"):
        self._session = session
        self._username = username
        self._password = password
        self._location = location
        self._lang = "cs" if lang in ("cs", "sk") else "en"

    async def _get(self, url: str) -> str:
        async with self._session.get(
            url, headers={"User-Agent": UA}, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            resp.raise_for_status()
            return await resp.text()

    async def _get_json(self, url: str):
        return json.loads(await self._get(url))

    async def ping(self) -> bool:
        """Ověř dostupnost API (pro config flow)."""
        try:
            await self._get(URL + J_MOVIES_MOST_POPULAR)
            return True
        except Exception:
            return False

    async def root(self) -> list[dict]:
        return [
            {"type": "dir", "title": "Filmy – nejnovější", "id": URL + J_MOVIES_RECENTLY_ADDED},
            {"type": "dir", "title": "Filmy – nejoblíbenější", "id": URL + J_MOVIES_MOST_POPULAR},
            {"type": "dir", "title": "Filmy – A–Z", "id": URL + J_MOVIES_A_TO_Z},
            {"type": "dir", "title": "Filmy – žánry", "id": URL + J_MOVIES_GENRE},
            {"type": "dir", "title": "Seriály – nejnovější", "id": URL + J_TV_SHOWS_RECENTLY_ADDED},
            {"type": "dir", "title": "Seriály – nejoblíbenější", "id": URL + J_TV_SHOWS_MOST_POPULAR},
            {"type": "dir", "title": "Seriály – A–Z", "id": URL + J_TV_SHOWS_A_TO_Z},
        ]

    async def browse(self, url: str) -> list[dict]:
        """Procházení podle sosac URL (stejné větvení jako Kodi plugin)."""
        if not url:
            return await self.root()
        if J_SERIES in url:
            return await self._list_episodes(url)
        if J_TV_SHOWS_A_TO_Z in url:
            return [
                {"type": "dir", "title": letter.upper(),
                 "id": f"{URL}{J_TV_SHOWS}{letter}.json"}
                for letter in LETTERS
            ]
        if J_TV_SHOWS in url or J_TV_SHOWS_MOST_POPULAR in url:
            return await self._list_series(url)
        if J_TV_SHOWS_RECENTLY_ADDED in url:
            return await self._list_recent_episodes(url)
        if J_MOVIES_A_TO_Z in url or J_MOVIES_GENRE in url:
            return await self._list_dirs(url)
        return await self._list_videos(url)

    async def _list_dirs(self, url: str) -> list[dict]:
        data = await self._get_json(url)
        items = [{"type": "dir", "title": k.title(), "id": v} for k, v in data.items()]
        items.sort(key=lambda i: i["title"])
        return items

    async def _list_videos(self, url: str) -> list[dict]:
        data = await self._get_json(url)
        return [self._search_or_movie_item(v) for v in data]

    async def _list_series(self, url: str) -> list[dict]:
        data = await self._get_json(url)
        return [_series_item(s, self._lang) for s in data]

    async def _list_episodes(self, url: str) -> list[dict]:
        data = await self._get_json(url)
        result = []
        for series in data:
            for season, episodes in series.items():
                for ep, video in episodes.items():
                    result.append(_episode_item(season, ep, video))
        result.sort(key=lambda i: (i["season"], i["episode"]))
        return result

    async def _list_recent_episodes(self, url: str) -> list[dict]:
        data = await self._get_json(url)
        result = []
        for e in data:
            img = e.get("i") or ""
            if img and not img.startswith("http"):
                img = URL + img
            result.append({
                "type": "video",
                "id": e.get("l") or "",
                "title": f"{_name(e.get('t', {}), self._lang)}: "
                         f"{str(e.get('s', '')).zfill(2)}x{str(e.get('e', '')).zfill(2)}"
                         f" - {_name(e.get('n', {}), self._lang)}",
                "img": img or None,
            })
        return result

    def _search_or_movie_item(self, v: dict) -> dict:
        link = v.get("l") or ""
        # seriál: 'l' není stream ID, ale URL na seznam epizod (serialy/...)
        if "serialy" in link or link.startswith("http"):
            return _series_item(v, self._lang)
        item = _movie_item(v, self._lang)
        # epizoda ve výsledcích hledání/novinek: má klíče t/s/e
        if "t" in v and "s" in v:
            item["title"] = (f"{_name(v['t'], self._lang)}: "
                             f"{str(v['s']).zfill(2)}x{str(v.get('e', '')).zfill(2)}"
                             f" - {_name(v.get('n', {}), self._lang)}")
            img = v.get("i") or ""
            if img and not img.startswith("http") and not img.endswith(".jpg"):
                item["img"] = URL + img
        return item

    async def search(self, query: str) -> list[dict]:
        from urllib.parse import quote_plus
        if not 3 <= len(query) <= 100:
            raise ValueError("Dotaz musí mít 3–100 znaků")
        return await self._list_videos(URL + J_SEARCH + quote_plus(query))

    # --- resolve -----------------------------------------------------------

    async def resolve(self, video_id: str) -> list[Stream]:
        """streamuj.tv/video/<id> → seznam přehratelných streamů."""
        if not video_id:
            raise ValueError("Video nemá stream ID")
        page_url = STREAMUJ_URL + video_id
        data = await self._get(page_url)
        if "Toto video neexistuje" in data:
            raise ValueError("Video bylo smazáno ze serveru")

        qualities = re.search(r'rn:[^"]*"([^"]*)', data, re.I | re.S)
        langs = re.search(r'langs:[^"]*"([^"]+)', data, re.I | re.S)
        languages = langs.group(1).split(",") if langs else [""]
        rn = qualities.group(1).split(",") if qualities else []

        streams: list[Stream] = []
        for index, language in enumerate(languages):
            m = re.search(rf'res{index}:[^"]*"([^"]+)', data, re.I | re.S)
            if not m:
                continue
            for qindex, raw in enumerate(m.group(1).split(",")):
                q = rn[qindex] if qindex < len(rn) else ""
                url = self._premium_url(raw.strip())
                streams.append(Stream(url=url,
                                      quality="720p" if q == "HD" else "SD",
                                      lang=language))
        resolved: list[Stream] = []
        for s in streams:
            resolved.append(await self._probe(s))
        return resolved

    def _premium_url(self, url: str) -> str:
        if self._username and self._password:
            h = hashlib.md5(self._password.encode()).hexdigest()
            h = hashlib.md5(h.encode()).hexdigest()
            url += f"&pass={self._username}:::{h}"
        if self._location in ("1", "2"):
            url += f"&location={self._location}"
        return url

    async def _probe(self, stream: Stream) -> Stream:
        """302 redirect → finální mp4 URL (jako probe_html5 v pluginu)."""
        headers = {
            "User-Agent": UA,
            "Referer": "http://www.streamuj.tv/mediaplayer/player.swf",
        }
        try:
            async with self._session.get(
                stream.url, headers=headers, allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status in (301, 302, 303, 307):
                    stream.url = resp.headers.get("Location", stream.url)
                elif resp.status == 200:
                    body = await resp.text()
                    if body.strip():
                        stream.url = body.strip()
        except Exception as err:
            _LOGGER.debug("Probe selhal pro %s: %s", stream.url, err)
        return stream
