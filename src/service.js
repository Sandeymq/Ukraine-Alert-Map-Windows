'use strict';
// Мережевий сервіс віджета: опитування NEPTUN/Ubilling, WebSocket-потік, кеш меж районів.
// Нічого не знає про Electron, тому тестується звичайним Node. Вивід має той самий формат
// («@@ім'я код@@» + тіло), що й у macOS-версії, тож інтерфейс однаковий.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const UA = 'UkraineAlertMap-Windows/1.0 (desktop widget; +https://github.com/Sandeymq)';
const DEFAULT_URLS = {
  nt: 'https://neptun.in.ua/api/v1/threats',
  na: 'https://neptun.in.ua/api/v1/alerts',
  nm: 'https://neptun.in.ua/api/v1/messages',
  ub: 'https://ubilling.net.ua/aerialalerts/',
  rg: 'https://neptun.in.ua/raions.geojson',
  ws: 'wss://neptun.in.ua/api/v1/stream'
};
const ALLOWED_HOSTS = ['neptun.in.ua', 'ubilling.net.ua'];
const section = (name, r) => '@@' + name + ' ' + r.code + '@@\n' + r.body + '\n';

class DataService extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.fetch = opts.fetch || globalThis.fetch;
    this.WebSocket = opts.WebSocket || null;
    this.now = opts.now || Date.now;
    this.dir = opts.cacheDir || path.join(os.tmpdir(), 'ukraine-alert-map');
    this.urls = Object.assign({}, DEFAULT_URLS, opts.urls || {});
    this.allowedHosts = opts.allowedHosts || ALLOWED_HOSTS;
    this.allowHttp = !!opts.allowHttp; // лише для тестів
    this.retryMs = opts.retryMs || 0; // лише для тестів: фіксована пауза перед перепідключенням
    this.cache = {};
    this.sock = null;
    this.state = 'off';
    this.lastFrame = 0;
    this.tries = 0;
    this.wantStream = false;
    this.retryTimer = null;
    this.watchTimer = null;
    this.rgText = null;
    this.rgBusy = false;
    this.loopTimer = null;
    this.busy = false;
  }

  isAllowed(url) {
    try {
      const u = new URL(url);
      if (!(u.protocol === 'https:' || (this.allowHttp && u.protocol === 'http:'))) return false;
      return this.allowedHosts.indexOf(u.hostname) >= 0;
    } catch (e) {
      return false;
    }
  }

  async get(url, timeout) {
    if (!this.isAllowed(url)) return { code: '403', body: '' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const body = await r.text();
      return { code: String(r.status), body };
    } catch (e) {
      return { code: '000', body: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Кеш на ttl мс; після 429 пауза 60 с (як і в macOS-версії)
  async cached(name, ttl, url) {
    const c = this.cache[name];
    const life = !c ? 0 : (c.code === '200' ? ttl : (c.code === '429' ? 60000 : 0));
    if (c && this.now() - c.t < life) return c;
    const r = await this.get(url);
    this.cache[name] = { t: this.now(), code: r.code, body: r.body };
    return this.cache[name];
  }

  isLive() {
    return this.state === 'open' && this.lastFrame > 0 && this.now() - this.lastFrame < 40000;
  }

  async cycle() {
    const live = this.isLive(); // поки живий потік, цілі (threats) не опитуємо
    const res = await Promise.all([
      live ? Promise.resolve({ code: 'skip', body: '' }) : this.get(this.urls.nt),
      this.get(this.urls.na),
      this.cached('nm', 10000, this.urls.nm),
      this.cached('ub', 10000, this.urls.ub)
    ]);
    let out = section('nt', res[0]) + section('na', res[1]) + section('nm', res[2]) + section('ub', res[3]);
    if (this.rgText) {
      out += section('rg', { code: '200', body: this.rgText });
      this.rgText = null;
    }
    return out;
  }

  start(intervalMs) {
    this.stop();
    const run = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        this.emit('output', await this.cycle());
      } catch (e) {
        /* наступний цикл спробує ще раз */
      } finally {
        this.busy = false;
      }
    };
    run();
    this.loopTimer = setInterval(run, intervalMs || 6000);
  }

  stop() {
    clearInterval(this.loopTimer);
    this.loopTimer = null;
  }

  // ---- WebSocket ----
  streamStart() {
    this.wantStream = true;
    this._open();
  }

  streamStop() {
    this.wantStream = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchTimer);
    const s = this.sock;
    this.sock = null;
    if (s) {
      try { s.terminate(); } catch (e) { /* ignore */ }
    }
    this.state = 'off';
    this.lastFrame = 0;
    this.emit('stream', { type: 'state', state: 'off' });
  }

  _open() {
    clearTimeout(this.retryTimer);
    if (!this.WebSocket) return;
    const old = this.sock;
    this.sock = null;
    if (old) {
      try { old.terminate(); } catch (e) { /* ignore */ }
    }
    this.state = 'connecting';
    this.lastFrame = 0;
    this.emit('stream', { type: 'state', state: 'connecting' });
    let sock;
    try {
      sock = new this.WebSocket(this.urls.ws, { handshakeTimeout: 10000, headers: { 'User-Agent': UA } });
    } catch (e) {
      this._retry();
      return;
    }
    this.sock = sock;
    sock.on('open', () => {
      if (this.sock !== sock) return;
      this.tries = 0;
      this.state = 'open';
      this.emit('stream', { type: 'state', state: 'open' });
    });
    sock.on('message', (d) => {
      if (this.sock !== sock) return;
      this.lastFrame = this.now();
      this.emit('stream', { type: 'frame', data: d.toString() });
    });
    const ended = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.state = 'closed';
      this.lastFrame = 0;
      this.emit('stream', { type: 'state', state: 'closed' });
      this._retry();
    };
    sock.on('close', ended);
    sock.on('error', () => {
      try { sock.terminate(); } catch (e) { /* ignore */ }
      ended();
    });
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => { // сторожовий таймер: 90 с тиші, перепідключення
      if (this.sock === sock && this.state === 'open' && this.lastFrame && this.now() - this.lastFrame > 90000) {
        try { sock.terminate(); } catch (e) { /* ignore */ }
      }
    }, 15000);
  }

  _retry() {
    if (!this.wantStream) return;
    const wait = this.retryMs || [1, 2, 5, 10, 30][Math.min(this.tries++, 4)] * 1000;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._open(), wait);
  }

  // ---- межі районів: кеш на диску, оновлення раз на 7 діб ----
  async ensureRaions() {
    const file = path.join(this.dir, 'raions.geojson');
    let st = null;
    try {
      st = fs.statSync(file);
      this.rgText = fs.readFileSync(file, 'utf8');
    } catch (e) {
      st = null;
    }
    if (st && this.now() - st.mtimeMs < 7 * 864e5) return;
    if (this.rgBusy) return;
    this.rgBusy = true;
    try {
      const r = await this.get(this.urls.rg, 60000);
      if (r.code === '200') {
        const geo = JSON.parse(r.body);
        if (geo && Array.isArray(geo.features) && geo.features.length >= 3) {
          const text = r.body.replace(/(\d+\.\d\d)\d+/g, '$1'); // 2 знаки (~1 км) достатньо для карти
          fs.mkdirSync(this.dir, { recursive: true });
          fs.writeFileSync(file, text);
          this.rgText = text;
        }
      }
    } catch (e) {
      /* залишаємо стару копію */
    } finally {
      this.rgBusy = false;
    }
  }
}

module.exports = { DataService, UA, DEFAULT_URLS, ALLOWED_HOSTS, section };
