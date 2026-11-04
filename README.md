# Sosáč pro Home Assistant

Integrace + Lovelace karta pro procházení a přehrávání katalogu sosac.tv
(filmy, seriály, hledání) přímo v Home Assistant dashboardu.

Přehrávání běží v prohlížeči, kde je dashboard otevřený (vestavěný
`<video>` přehrávač v overlayi). Katalog je veřejný; přihlašovací údaje
(StreamujTV/sosac.tv účet) jsou potřeba jen pro premium streamy.

## Instalace přes HACS

1. **HACS → ⋮ → Custom repositories** → přidej URL tohoto repozitáře,
   typ **Integration**
2. Otevři „Sosáč" → **Download** → restart HA
3. **Nastavení → Zařízení a služby → Přidat integraci → Sosáč**
   (credentials volitelné)
4. Přidej kartu jako dashboard resource:
   **Nastavení → Dashboardy → ⋮ → Prostředky → Přidat prostředek**
   - URL: `/sosac/sosac-card.js`, typ: JavaScript modul
5. Na dashboard přidej kartu:

```yaml
type: custom:sosac-card
title: Sosáč   # volitelné
```

### Ručně (bez HACS)

Zkopíruj `custom_components/sosac` do `config/custom_components/`,
restartuj HA a pokračuj od bodu 3.

## Jak to funguje

- Integrace volá sosac.tv JSON API (`tv.sosac.to`) a resolvuje streamy
  přes `streamuj.tv` (logika portovaná z Kodi pluginu).
- Karta komunikuje přes HA websocket API (`sosac/browse`,
  `sosac/search`, `sosac/resolve`), takže se přihlašovací údaje
  nedostanou do prohlížeče a není potřeba řešit CORS.
- U seriálů se prochází složky A–Z → seriál → epizody; u videí se po
  kliknutí resolvuje stream a hraje se v overlayi (720p preferováno).

## Poznámky

- Pokud premium stream nehraje, ověř credentials v konfiguraci integrace
  — `&pass=` parametr se přidává automaticky, když jsou vyplněné.
- Prohlížeče blokují autoplay se zvukem: první spuštění vyžaduje klik.
- Některé CDN servery mohou vyžadovat konkrétní hlavičky při přehrávání;
  kdyby `<video>` odmítlo stream, jde přehrát i přes
  `media_player.play_media` na zařízení v síti (stream URL vrací
  `sosac/resolve`).
