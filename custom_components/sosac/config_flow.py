"""Config flow pro Sosáč."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import SosacApi
from .const import CONF_LOCATION, CONF_PASSWORD, CONF_USERNAME, DOMAIN


class SosacConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(
        self, user_input: dict | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            api = SosacApi(async_get_clientsession(self.hass))
            if await api.ping():
                return self.async_create_entry(
                    title="Sosáč", data=user_input
                )
            errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Optional(CONF_USERNAME, default=""): str,
                vol.Optional(CONF_PASSWORD, default=""): str,
                vol.Optional(CONF_LOCATION, default=""): vol.In(["", "1", "2"]),
            }),
            errors=errors,
            description_placeholders={},
        )
