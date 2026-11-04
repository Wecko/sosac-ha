/**
 * Sosáč — Lovelace karta pro Home Assistant.
 *
 * Prochází katalog sosac.tv (filmy, seriály, hledání) a přehrává
 * resolvované streamy přímo v prohlížeči, kde je dashboard otevřený.
 * Data a resolve zajišťuje integrace `sosac` přes websocket API —
 * žádné credentials ani CORS problém v prohlížeči.
 *
 * Konfigurace karty:
 *   type: custom:sosac-card
 *   title: Sosáč        (volitelné)
 */
const VIEWS = ['player', 'movies', 'series', 'history', 'search'];
const VIEW_TITLES = { player: 'Přehrávač', movies: 'Filmy', series: 'Seriály',
  history: 'Historie', search: 'Hledat' };

const CARD_VERSION = '0.2.1';
(function versionGuard() {
  try {
    const key = 'sosac-card-version';
    const prev = localStorage.getItem(key);
    if (prev === CARD_VERSION) return;
    localStorage.setItem(key, CARD_VERSION);
    if (prev !== null) location.reload();
  } catch { /* localStorage nedostupný */ }
})();

const ICONS = {
  play: 'M8,5.14V19.14L19,12.14L8,5.14Z',
  pause: 'M14,19H18V5H14M6,19H10V5H6V19Z',
  back: 'M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,6.41Z',
  search: 'M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z',
  movie: 'M18,4L20,8H17L15,4H13L15,8H12L10,4H8L10,8H7L5,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V4H18Z',
  series: 'M21,17H3V5H1V19A2,2 0 0,0 3,21H21M23,5H7A2,2 0 0,0 5,7V15A2,2 0 0,0 7,17H23A2,2 0 0,0 25,15V7A2,2 0 0,0 23,5Z',
  folder: 'M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z',
  fullscreen: 'M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z',
  eq: 'M10,20H14V4H10M16,20H20V8H16M4,20H8V12H4V20Z',
};
function icon(name, size = 22) {
  const wh = size ? ` width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 24 24"${wh} fill="currentColor" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

/**
 * Sdílený stav na window — <video> overlay přežije zničení a
 * znovuvytvoření karty (HA kartu při přepnutí pohledu odebere z DOMu).
 */
const STORE_KEY = '__sosacStore';
function store() {
  if (!window[STORE_KEY]) {
    window[STORE_KEY] = {
      overlay: null,   // overlay div v document.body
      video: null,     // <video>
      nowPlaying: null,// {title}
      streams: null,   // varianty streamu (kvalita/stopa)
      streamIndex: 0,
      ws: null,        // callWS funkce z karty
      eqCtx: null, eqFilters: null, eqOn: false,
      listeners: new Set(),
    };
  }
  return window[STORE_KEY];
}

// --- ekvalizér (Web Audio API) -------------------------------------------
// MediaElementSource vyžaduje CORS/same-origin — CDN hlavičky neposílá,
// proto EQ přepne zdroj videa na HA proxy (jinak by zvuk ztichl).
const EQ_BANDS = [60, 250, 1000, 4000, 12000];

function eqGains() {
  try {
    const g = JSON.parse(localStorage.getItem('sosac-eq') || 'null');
    if (Array.isArray(g) && g.length === EQ_BANDS.length) return g;
  } catch { /* ok */ }
  return EQ_BANDS.map(() => 0);
}

function buildEqPanel(st) {
  const gains = eqGains();
  st.eqPanel.innerHTML = EQ_BANDS.map((f, i) => `
    <label style="display:flex;flex-direction:column;align-items:center;gap:6px;
      font:400 11px Roboto,sans-serif;color:#aaa;">
      <input type="range" min="-12" max="12" step="1" value="${gains[i]}"
        data-band="${i}" orient="vertical"
        style="writing-mode:vertical-lr;direction:rtl;height:90px;accent-color:var(--primary-color,#03a9f4);">
      <span>${f >= 1000 ? f / 1000 + 'k' : f}</span>
      <span data-bandval="${i}" style="color:#666">${gains[i] > 0 ? '+' : ''}${gains[i]}</span>
    </label>`).join('');
  st.eqPanel.addEventListener('input', (ev) => {
    const band = ev.target.dataset && ev.target.dataset.band;
    if (band === undefined) return;
    const v = +ev.target.value;
    if (st.eqFilters) st.eqFilters[+band].gain.value = v;
    const g = eqGains(); g[+band] = v;
    try { localStorage.setItem('sosac-eq', JSON.stringify(g)); } catch { /* ok */ }
    const val = st.eqPanel.querySelector(`[data-bandval="${band}"]`);
    if (val) val.textContent = (v > 0 ? '+' : '') + v;
  });
}

function ensureEqGraph(st) {
  if (st.eqCtx) return true;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(st.video);
    const filters = EQ_BANDS.map((f, i) => {
      const bq = ctx.createBiquadFilter();
      bq.type = i === 0 ? 'lowshelf' : (i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking');
      bq.frequency.value = f;
      bq.gain.value = eqGains()[i];
      return bq;
    });
    let node = src;
    filters.forEach((f) => { node.connect(f); node = f; });
    node.connect(ctx.destination);
    st.eqCtx = ctx;
    st.eqFilters = filters;
    return true;
  } catch (e) {
    console.error('[sosac-card] eq graph:', e);
    return false;
  }
}

async function proxySrc(st, url) {
  if (!st.ws) throw new Error('hass není k dispozici');
  const path = `/api/sosac/stream?u=${encodeURIComponent(url)}`;
  const signed = await st.ws({ type: 'auth/sign_path', path, expires: 3600 });
  return signed.path;
}

// --- historie sledování + pozice -------------------------------------------
const HISTORY_MAX = 50;

function getHistory() {
  try {
    const h = JSON.parse(localStorage.getItem('sosac-history') || '[]');
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

function pushHistory(item) {
  try {
    const h = getHistory().filter((e) => e.id !== item.id);
    h.unshift({ id: item.id, title: item.title, img: item.img || null,
                ts: Date.now() });
    localStorage.setItem('sosac-history', JSON.stringify(h.slice(0, HISTORY_MAX)));
  } catch { /* ok */ }
}

function posKey(id) { return 'sosac-pos-' + id; }
function getPos(id) {
  try { return +localStorage.getItem(posKey(id)) || 0; } catch { return 0; }
}
function setPos(id, t) {
  try { localStorage.setItem(posKey(id), String(Math.floor(t))); } catch { /* ok */ }
}
function clearPos(id) {
  try { localStorage.removeItem(posKey(id)); } catch { /* ok */ }
}

// navázání pozice + periodické ukládání
function trackPosition(st, id) {
  clearInterval(st.posTimer);
  st.posTimer = setInterval(() => {
    if (st.video && !st.video.paused && st.video.duration > 60) {
      const t = st.video.currentTime;
      // neukládat prvních 30 s a posledních 60 s (dokoukané)
      if (t > 30 && st.video.duration - t > 60) setPos(id, t);
      if (st.video.duration - t <= 60) clearPos(id);
    }
  }, 5000);
}

async function enableEq(st) {
  // EQ potřebuje same-origin zdroj → proxy URL aktuálního streamu
  try {
    const s = st.streams && st.streams[st.streamIndex];
    if (s && !s.proxyUrl) s.proxyUrl = await proxySrc(st, s.url);
    if (s) {
      const pos = st.video.currentTime || 0;
      st.video.src = s.proxyUrl;
      const resume = () => { st.video.currentTime = pos; st.video.removeEventListener('loadedmetadata', resume); };
      st.video.addEventListener('loadedmetadata', resume);
      st.video.play().catch(() => {});
    }
    if (!ensureEqGraph(st)) { st.eqBtn.title = 'EQ se nepodařilo inicializovat'; return; }
    st.eqCtx.resume().catch(() => {});
    st.eqOn = true;
    st.eqBtn.style.color = '#4fc3f7';
    st.eqPanel.style.display = 'flex';
  } catch (e) {
    console.error('[sosac-card] eq enable:', e);
    st.eqBtn.title = 'EQ vyžaduje funkční HA proxy';
  }
}
function emit() {
  store().listeners.forEach((fn) => { try { fn(); } catch {} });
}

function ensurePlayer() {
  const st = store();
  if (st.overlay) return st;
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);' +
    'display:none;align-items:center;justify-content:center;flex-direction:column;';
  const bar = document.createElement('div');
  bar.style.cssText =
    'width:100%;max-width:1100px;display:flex;align-items:center;gap:12px;' +
    'padding:10px 14px;color:#eee;box-sizing:border-box;';
  const title = document.createElement('div');
  title.style.cssText = 'flex:1;font:500 15px/1.3 Roboto,sans-serif;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;';
  const quality = document.createElement('select');
  quality.title = 'Kvalita / stopa';
  quality.style.cssText = 'display:none;background:#222;color:#eee;border:1px solid #444;' +
    'border-radius:6px;padding:4px 6px;font:400 13px Roboto,sans-serif;';
  quality.onchange = () => switchStream(+quality.value);
  const eqBtn = document.createElement('button');
  eqBtn.innerHTML = icon('eq', 24);
  eqBtn.title = 'Ekvalizér';
  eqBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;padding:4px;';
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = icon('close', 26);
  closeBtn.title = 'Zavřít';
  closeBtn.style.cssText = 'background:none;border:none;color:#eee;cursor:pointer;padding:4px;';
  closeBtn.onclick = () => stopPlayback();
  const fsBtn = document.createElement('button');
  fsBtn.innerHTML = icon('fullscreen', 24);
  fsBtn.title = 'Celá obrazovka';
  fsBtn.style.cssText = 'background:none;border:none;color:#eee;cursor:pointer;padding:4px;';
  fsBtn.onclick = () => { if (st.video) st.video.requestFullscreen?.(); };
  bar.append(title, quality, eqBtn, fsBtn, closeBtn);
  const eqPanel = document.createElement('div');
  eqPanel.style.cssText = 'width:100%;max-width:1100px;display:none;gap:14px;' +
    'justify-content:center;padding:8px 14px 14px;box-sizing:border-box;color:#eee;';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.style.cssText = 'width:100%;max-width:1100px;max-height:calc(100% - 60px);background:#000;';
  overlay.append(bar, eqPanel, video);
  document.body.appendChild(overlay);
  st.overlay = overlay;
  st.video = video;
  st.titleEl = title;
  st.qualityEl = quality;
  st.eqPanel = eqPanel;
  st.eqBtn = eqBtn;
  st.eqOn = false;
  buildEqPanel(st);
  eqBtn.onclick = () => {
    if (!st.eqOn) { enableEq(st); return; }
    eqPanel.style.display = eqPanel.style.display === 'none' ? 'flex' : 'none';
  };
  video.addEventListener('play', emit);
  video.addEventListener('pause', emit);
  video.addEventListener('ended', emit);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && st.overlay.style.display !== 'none') stopPlayback();
  });
  return st;
}

function streamLabel(s) {
  const parts = [];
  if (s.quality) parts.push(s.quality);
  if (s.lang) parts.push(s.lang);
  return parts.join(' · ') || 'stream';
}

function playStream(item, streams, index) {
  const st = ensurePlayer();
  st.titleEl.textContent = item.title;
  st.nowPlaying = item.title;
  st.currentItem = item;
  pushHistory(item);
  trackPosition(st, item.id);
  const resumePos = getPos(item.id);
  if (resumePos > 0) {
    const v = st.video;
    const resume = () => { v.currentTime = resumePos; v.removeEventListener('loadedmetadata', resume); };
    v.addEventListener('loadedmetadata', resume);
  }
  st.streams = streams;
  st.streamIndex = index;
  if (streams.length > 1) {
    st.qualityEl.innerHTML = streams.map((s, i) =>
      `<option value="${i}"${i === index ? ' selected' : ''}>${esc(streamLabel(s))}</option>`).join('');
    st.qualityEl.style.display = '';
  } else {
    st.qualityEl.style.display = 'none';
  }
  st.video.src = (st.eqOn && streams[index].proxyUrl) ? streams[index].proxyUrl
    : streams[index].url;
  st.overlay.style.display = 'flex';
  st.video.play().catch(() => {});
  emit();
}

function switchStream(index) {
  const st = store();
  if (!st.streams || index === st.streamIndex) return;
  st.streamIndex = index;
  try {
    localStorage.setItem('sosac-quality', st.streams[index].quality || '');
  } catch { /* ok */ }
  const pos = st.video.currentTime || 0;
  const v = st.video;
  const s = st.streams[index];
  const applySrc = () => {
    v.src = (st.eqOn && s.proxyUrl) ? s.proxyUrl : s.url;
  };
  if (st.eqOn && !s.proxyUrl && st.ws) {
    proxySrc(st, s.url).then((p) => { s.proxyUrl = p; applySrc(); })
      .catch(() => { applySrc(); });
  } else {
    applySrc();
  }
  const resume = () => {
    v.currentTime = pos;
    v.removeEventListener('loadedmetadata', resume);
  };
  v.addEventListener('loadedmetadata', resume);
  v.play().catch(() => {});
}

function stopPlayback() {
  const st = store();
  if (st.video) {
    // poslední uložení pozice před zavřením
    if (st.currentItem && st.video.duration > 60) {
      const t = st.video.currentTime;
      if (t > 30 && st.video.duration - t > 60) setPos(st.currentItem.id, t);
      else if (st.video.duration - t <= 60) clearPos(st.currentItem.id);
    }
    st.video.pause(); st.video.removeAttribute('src'); st.video.load();
  }
  clearInterval(st.posTimer);
  if (st.overlay) st.overlay.style.display = 'none';
  st.nowPlaying = null;
  st.currentItem = null;
  emit();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class SosacCard extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (this._root && !this._roots) this._browseRoot();
  }

  setConfig(config) {
    this._config = config || {};
    if (!this._root) {
      this._root = this.attachShadow({ mode: 'open' });
      this._root.innerHTML = this._tpl();
      this._bind();
      store().listeners.add(() => this._syncMini());
    }
    this._view = 'movies';
    this._stack = [];         // [{title,id}]
    this._items = [];
    this._search = '';
    this._render();
    if (this._hass && !this._roots) this._browseRoot();
  }

  connectedCallback() { this._syncMini(); }
  disconnectedCallback() { /* overlay je na window, video hraje dál */ }

  static getStubConfig() { return {}; }

  _ws(payload) {
    if (!this._hass) return Promise.reject(new Error('hass není k dispozici'));
    return this._hass.callWS(payload);
  }

  async _browse(id, title) {
    try {
      const res = await this._ws({ type: 'sosac/browse', path: id || '' });
      this._items = res.items || [];
      this._renderList();
    } catch (e) {
      console.error('[sosac-card] browse:', e);
      this._toast(e.message || 'Načtení selhalo');
    }
  }

  async _browseRoot() {
    // root rozdělíme podle prefixu na Filmy/Seriály záložky
    try {
      const res = await this._ws({ type: 'sosac/browse', path: '' });
      const all = res.items || [];
      this._roots = {
        movies: all.filter((i) => i.title.startsWith('Filmy')),
        series: all.filter((i) => i.title.startsWith('Seriály')),
      };
      if (this._view === 'movies' || this._view === 'series') {
        if (this._stack.length === 0) this._items = this._roots[this._view] || [];
        this._renderList();
      }
    } catch (e) {
      console.error('[sosac-card] browseRoot:', e);
      this._toast(e.message || 'Integrace Sosáč není dostupná');
    }
  }

  async _searchNow(q) {
    try {
      const res = await this._ws({ type: 'sosac/search', query: q });
      this._items = res.items || [];
      this._renderList();
    } catch (e) {
      console.error('[sosac-card] search:', e);
      this._toast(e.message || 'Hledání selhalo');
    }
  }

  async _play(item) {
    this._toast('Resolvuji stream…');
    try {
      const res = await this._ws({ type: 'sosac/resolve', video_id: item.id });
      const streams = res.streams || [];
      if (!streams.length) { this._toast('Žádný stream nenalezen'); return; }
      // Proxy přes HA jen pro HTTP streamy na HTTPS dashboardu
      // (mixed content). Backend vrací HTTPS URL → normálně přímé URL.
      if (location.protocol === 'https:') {
        for (const s of streams) {
          if (/^http:\/\//i.test(s.url)) {
            const path = `/api/sosac/stream?u=${encodeURIComponent(s.url)}`;
            const signed = await this._ws({ type: 'auth/sign_path', path, expires: 3600 });
            s.url = signed.path;
          }
        }
      }
      // preference: uložená kvalita > 720p cs > 720p > první
      let pref = '';
      try { pref = localStorage.getItem('sosac-quality') || ''; } catch { /* ok */ }
      let idx = streams.findIndex((s) => s.quality === pref);
      if (idx < 0) idx = streams.findIndex((s) => s.quality === '720p' && /cs|cz/i.test(s.lang || ''));
      if (idx < 0) idx = streams.findIndex((s) => s.quality === '720p');
      if (idx < 0) idx = 0;
      store().ws = (p) => this._ws(p);
      playStream(item, streams, idx);
      this._view = 'player';
      this._render();
    } catch (e) {
      console.error('[sosac-card] resolve:', e);
      this._toast(e.message || 'Resolve selhal');
    }
  }

  _open(item) {
    if (item.type === 'video') { this._play(item); return; }
    this._stack.push({ title: item.title, id: item.id });
    this._browse(item.id);
    this._renderNav();
  }

  _back() {
    this._stack.pop();
    if (this._stack.length === 0) {
      this._items = this._roots?.[this._view] || [];
      this._renderList();
    } else {
      this._browse(this._stack[this._stack.length - 1].id);
    }
    this._renderNav();
  }

  _toast(text) {
    const el = this._root.querySelector('.toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), 3000);
  }

  _bind() {
    this._root.addEventListener('click', (ev) => {
      const tab = ev.target.closest('[data-view]');
      if (tab) {
        this._view = tab.dataset.view;
        this._stack = [];
        this._items = this._roots?.[this._view] || [];
        this._render();
        if (this._view === 'search') {
          this._root.querySelector('.search-input')?.focus();
        }
        return;
      }
      const back = ev.target.closest('.nav-back');
      if (back) { this._back(); return; }
      const el = ev.target.closest('[data-idx]');
      if (el) {
        const item = this._items[+el.dataset.idx];
        if (item) this._open(item);
        return;
      }
      const stop = ev.target.closest('.mini-stop');
      if (stop) { stopPlayback(); return; }
      const show = ev.target.closest('.mini-show');
      if (show) {
        const st = store();
        if (st.overlay) st.overlay.style.display = 'flex';
        this._view = 'player';
        this._render();
      }
    });
    this._root.addEventListener('input', (ev) => {
      if (ev.target.classList.contains('search-input')) {
        this._search = ev.target.value;
        clearTimeout(this._searchT);
        const q = this._search.trim();
        if (q.length >= 3) {
          this._searchT = setTimeout(() => this._searchNow(q), 500);
        }
      }
    });
  }

  _tpl() {
    return `
    <style>
      :host { display:block; }
      ha-card { overflow:hidden; }
      .header { display:flex; align-items:center; padding:8px 12px 0; }
      .title { font:500 18px/1.2 var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--primary-text-color); flex:1; }
      .tabs { display:flex; gap:2px; padding:8px 8px 0; }
      .tab { flex:1; text-align:center; padding:8px 4px; cursor:pointer;
        font:500 13px/1 var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--secondary-text-color); border-bottom:2px solid transparent;
        user-select:none; }
      .tab.active { color:var(--primary-color); border-bottom-color:var(--primary-color); }
      .nav { display:flex; align-items:center; gap:8px; padding:6px 12px 0; min-height:28px; }
      .nav-back { display:inline-flex; align-items:center; gap:4px; cursor:pointer;
        color:var(--primary-color); font:500 13px var(--ha-font-family-body,Roboto,sans-serif);
        background:none;border:none;padding:4px 0; }
      .crumbs { color:var(--secondary-text-color); font-size:13px; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .search-wrap { padding:10px 12px 0; }
      .search-input { width:100%; box-sizing:border-box; padding:8px 12px;
        border-radius:8px; border:1px solid var(--divider-color,#444);
        background:var(--secondary-background-color,#222); color:var(--primary-text-color);
        font:400 14px var(--ha-font-family-body,Roboto,sans-serif); outline:none; }
      .list { padding:10px 12px 12px; max-height:520px; overflow-y:auto;
        overscroll-behavior:contain; }
      .grid { display:grid; gap:10px;
        grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); }
      .item { cursor:pointer; border-radius:8px; overflow:hidden;
        background:var(--secondary-background-color,#222); transition:transform .1s; }
      .item:hover { transform:scale(1.03); }
      .item img { width:100%; aspect-ratio:2/3; object-fit:cover; display:block;
        background:var(--divider-color,#333); }
      .item .cap { padding:6px 8px; }
      .item .t { font:500 12px/1.3 var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--primary-text-color); display:-webkit-box;
        -webkit-line-clamp:2;-webkit-box-orient:vertical; overflow:hidden; }
      .item .m { font:400 11px/1.3 var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--secondary-text-color); margin-top:2px; display:flex; gap:6px; }
      .row { display:flex; align-items:center; gap:10px; padding:8px;
        border-radius:8px; cursor:pointer; }
      .row:hover { background:var(--secondary-background-color,#222); }
      .row .ic { color:var(--secondary-text-color); display:flex; }
      .row .t { flex:1; font:500 14px var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--primary-text-color); }
      .row .m { font:400 12px var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--secondary-text-color); }
      .empty { padding:30px 12px; text-align:center;
        color:var(--secondary-text-color); font-size:14px; }
      .mini { display:flex; align-items:center; gap:10px; padding:10px 14px;
        border-top:1px solid var(--divider-color,#333); cursor:pointer; }
      .mini .ic { color:var(--primary-color); display:flex; }
      .mini .t { flex:1; font:500 13px var(--ha-font-family-body,Roboto,sans-serif);
        color:var(--primary-text-color); overflow:hidden; text-overflow:ellipsis;
        white-space:nowrap; }
      .mini button { background:none;border:none;cursor:pointer;
        color:var(--secondary-text-color); padding:4px; display:flex; }
      .toast { position:absolute; left:50%; bottom:14px; transform:translateX(-50%);
        background:#323232; color:#fff; padding:8px 16px; border-radius:16px;
        font:400 13px var(--ha-font-family-body,Roboto,sans-serif); opacity:0;
        transition:opacity .2s; pointer-events:none; white-space:nowrap; }
      .toast.show { opacity:.95; }
      .player-empty { padding:60px 12px; text-align:center;
        color:var(--secondary-text-color); }
    </style>
    <ha-card>
      <div class="header"><div class="title">${esc(this._config?.title || 'Sosáč')}</div></div>
      <div class="tabs">
        ${VIEWS.map((v) => `
          <div class="tab${v === this._view ? ' active' : ''}" data-view="${v}">
            ${VIEW_TITLES[v]}
          </div>`).join('')}
      </div>
      <div class="nav"></div>
      <div class="list"></div>
      <div class="toast"></div>
    </ha-card>`;
  }

  _render() {
    this._root.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.view === this._view));
    this._renderNav();
    const list = this._root.querySelector('.list');
    if (this._view === 'player') {
      const st = store();
      list.innerHTML = `<div class="player-empty">
        ${st.nowPlaying
          ? `<p>Právě hraje: <b>${esc(st.nowPlaying)}</b></p>
             <p><button class="mini-show" style="color:var(--primary-color);background:none;border:none;font:inherit;cursor:pointer">Zobrazit přehrávač</button></p>`
          : '<p>Nic se nepřehrává. Vyber film nebo epizodu.</p>'}
      </div>`;
    } else if (this._view === 'search') {
      list.innerHTML = '';
      this._renderSearch();
    } else if (this._view === 'history') {
      this._items = getHistory().map((e) => ({
        ...e, type: 'video',
        year: new Date(e.ts).toLocaleString('cs-CZ',
          { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }),
        quality: getPos(e.id) ? '▶ ' + Math.floor(getPos(e.id) / 60) + ' min' : null,
      }));
      list.innerHTML = '';
      this._renderItems(list);
    } else {
      this._renderList();
    }
    this._syncMini();
  }

  _renderNav() {
    const nav = this._root.querySelector('.nav');
    if (this._view === 'history') {
      nav.innerHTML = getHistory().length
        ? `<button class="nav-back" id="clear-history">Vymazat historii</button>` : '';
      nav.querySelector('#clear-history')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try { localStorage.removeItem('sosac-history'); } catch { /* ok */ }
        this._render();
      });
      return;
    }
    if (this._view !== 'movies' && this._view !== 'series') { nav.innerHTML = ''; return; }
    const crumbs = this._stack.map((s) => esc(s.title)).join(' › ');
    nav.innerHTML = this._stack.length
      ? `<button class="nav-back">${icon('back', 16)} Zpět</button>
         <span class="crumbs">${crumbs}</span>`
      : '';
  }

  _renderSearch() {
    const list = this._root.querySelector('.list');
    list.innerHTML = `
      <div class="search-wrap" style="padding:0 0 10px">
        <input class="search-input" placeholder="Hledat film nebo seriál… (min. 3 znaky)"
               value="${esc(this._search)}">
      </div>
      <div class="results"></div>`;
    this._renderItems(list.querySelector('.results'));
  }

  _renderList() {
    const list = this._root.querySelector('.list');
    if (this._view === 'search') { this._renderSearch(); return; }
    list.innerHTML = '';
    this._renderItems(list);
  }

  _renderItems(container) {
    const items = this._items || [];
    if (!items.length) {
      container.innerHTML = '<div class="empty">Nic tu není.</div>';
      return;
    }
    const dirs = items.filter((i) => i.type === 'dir');
    const media = items.filter((i) => i.type !== 'dir');
    let html = '';
    if (dirs.length) {
      html += dirs.map((i, n) => `
        <div class="row" data-idx="${items.indexOf(i)}">
          <span class="ic">${icon('folder', 20)}</span>
          <span class="t">${esc(i.title)}</span>
        </div>`).join('');
    }
    if (media.length) {
      html += `<div class="grid">` + media.map((i) => `
        <div class="item" data-idx="${items.indexOf(i)}">
          ${i.img
            ? `<img src="${esc(i.img)}" loading="lazy" alt="">`
            : `<img alt="" src="data:image/svg+xml,${encodeURIComponent(
                `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 150'>
                  <rect width='100' height='150' fill='#333'/>
                  <text x='50' y='80' fill='#777' font-size='12' text-anchor='middle'
                    font-family='sans-serif'>${esc(i.title).slice(0, 20)}</text>
                </svg>`)}">`}
          <div class="cap">
            <div class="t">${esc(i.title)}</div>
            <div class="m">
              ${i.year ? `<span>${esc(i.year)}</span>` : ''}
              ${i.quality ? `<span>${esc(String(i.quality).toUpperCase())}</span>` : ''}
              ${i.rating ? `<span>★ ${i.rating}</span>` : ''}
            </div>
          </div>
        </div>`).join('') + '</div>';
    }
    container.innerHTML = html;
  }

  _syncMini() {
    // spodní lišta "právě hraje" — jen mimo pohled player
    const card = this._root.querySelector('ha-card');
    let mini = this._root.querySelector('.mini');
    const st = store();
    if (st.nowPlaying && this._view !== 'player') {
      if (!mini) {
        mini = document.createElement('div');
        mini.className = 'mini';
        card.appendChild(mini);
      }
      mini.innerHTML = `
        <span class="ic">${icon(st.video && !st.video.paused ? 'pause' : 'play', 20)}</span>
        <span class="t mini-show" style="cursor:pointer">${esc(st.nowPlaying)}</span>
        <button class="mini-stop" title="Zastavit">${icon('close', 18)}</button>`;
    } else if (mini) {
      mini.remove();
    }
  }

  getCardSize() { return 8; }
}

customElements.define('sosac-card', SosacCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'sosac-card',
  name: 'Sosáč',
  description: 'Procházení a přehrávání filmů a seriálů ze sosac.tv',
});
