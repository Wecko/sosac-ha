"""HTTP proxy pro streamuj CDN.

Streamuj servery jedou jen na HTTP — z HTTPS dashboardu by prohlížeč
video zablokoval (mixed content). Proxy zprostředkuje mp4 přes HA.

Autorizace: podepsaná cesta (auth/sign_path), stejný mechanismus jako
HA používá pro media proxy. Karta podepíše přes ws `auth/sign_path`.
"""
from __future__ import annotations

import logging
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

PROXY_PATH = "/api/sosac/stream"

# povolené CDN hosty — proxy nesmí být otevřená na libovolné URL
_ALLOWED_SUFFIXES = ("streamuj.tv", "streamuj.cz")

_HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding",
               "content-encoding", "te", "trailer", "upgrade"}


class SosacStreamView(HomeAssistantView):
    url = PROXY_PATH
    name = "api:sosac:stream"
    requires_auth = True  # auth middleware ověří authSig (podepsaná cesta)

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request) -> web.StreamResponse:

        target = request.query.get("u", "")
        host = urlparse(target).hostname or ""
        if not target.startswith("http") or not host.endswith(_ALLOWED_SUFFIXES):
            raise web.HTTPBadRequest(text="Nepovolené URL")

        headers = {
            # streamuj CDN očekává stejné hlavičky jako probe v api.py,
            # jinak může požadavek odmítnout (403) a EQ/proxy přehrávání umře
            "User-Agent": "Mozilla/5.0",
            "Referer": "http://www.streamuj.tv/mediaplayer/player.swf",
        }
        if "Range" in request.headers:
            headers["Range"] = request.headers["Range"]
        session = async_get_clientsession(self._hass)

        try:
            upstream = await session.get(
                target, headers=headers,
                timeout=aiohttp.ClientTimeout(total=60, sock_read=60),
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Streamuj proxy nedostupná: %s", err)
            raise web.HTTPBadGateway() from err

        resp = web.StreamResponse(status=upstream.status)
        for key, value in upstream.headers.items():
            if key.lower() not in _HOP_BY_HOP:
                resp.headers[key] = value
        # NE chunked — Content-Length se předává z upstreamu a body má
        # známou délku. Chunked stream se přes reverzní proxy (Cloudflare
        # Tunnel) throttleoval na ~74 KB/s; fixed-length jede plnou rychlostí.
        await resp.prepare(request)
        try:
            # velké chunky — každý write() čeká na drain a přes reverzní
            # proxy (Cloudflare Tunnel) trvá cyklus ~0.8 s; 64KB chunky
            # dávaly ~74 KB/s, 4MB chunky jedou ~MB/s
            while True:
                chunk = await upstream.content.read(4 * 1024 * 1024)
                if not chunk:
                    break
                await resp.write(chunk)
        except (ConnectionError, aiohttp.ClientError):
            pass
        finally:
            upstream.release()
        try:
            await resp.write_eof()
        except (ConnectionError, RuntimeError):
            pass  # klient (video) odpojil — běžné u seek/stop
        return resp


@callback
def async_register(hass: HomeAssistant) -> None:
    hass.http.register_view(SosacStreamView(hass))
