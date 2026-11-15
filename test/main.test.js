'use strict';
// Перевіряє логіку main.js на імітації Electron (справжній Electron тут не потрібен).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = require.resolve('../main.js');

class FakeWS extends EventEmitter {
  constructor(url) { super(); this.url = url; FakeWS.all.push(this); }
  terminate() { setImmediate(() => this.emit('close')); }
}

function makeElectron(userData, o) {
  o = o || {};
  const E = { app: null, wins: [], trays: [], notes: [], opened: [], ipc: {}, handlers: {}, fetchCalls: [] };
  const appHandlers = {};
  E.app = {
    isPackaged: o.packaged !== false, quit: () => { E.quitCalled = true; }, getPath: () => userData, getVersion: () => '1.0.0', getLocale: () => 'uk',
    setAppUserModelId: (id) => { E.appId = id; }, requestSingleInstanceLock: () => o.lock !== false,
    on: (ev, fn) => { appHandlers[ev] = fn; }, whenReady: () => Promise.resolve(),
    setLoginItemSettings: (s) => { E.login = Object.assign(E.login || {}, s); (E.loginCalls = E.loginCalls || []).push(s); },
    getLoginItemSettings: () => ({ openAtLogin: !!(E.login && E.login.openAtLogin) })
  };
  E.appHandlers = appHandlers;
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }; this.visible = false; this.events = {}; this.once_ = {};
      this.sent = []; this.setBoundsCalls = [];
      this.webContents = { send: (c, p) => this.sent.push([c, p]), setZoomFactor: (z) => { this.zoomFactor = z; }, setWindowOpenHandler: (fn) => { this.openHandler = fn; }, on: (ev, fn) => { this.wcEvents = this.wcEvents || {}; this.wcEvents[ev] = fn; }, isDestroyed: () => false };
      E.wins.push(this);
    }
    setMenuBarVisibility() {} loadFile(f) { this.file = f; } once(ev, fn) { this.once_[ev] = fn; } on(ev, fn) { this.events[ev] = fn; }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; } isVisible() { return this.visible; } isDestroyed() { return false; }
    getBounds() { return this.bounds; } setBounds(b) { this.bounds = Object.assign({}, b); this.setBoundsCalls.push(b); }
    setAlwaysOnTop(v) { this.aot = v; } setBackgroundMaterial(m) { this.material = m; }
  }
  E.BrowserWindow = BrowserWindow;
  class Tray { constructor(img) { this.img = img; this.tips = []; E.trays.push(this); } setToolTip(t) { this.tip = t; } setContextMenu(m) { this.menu = m; } on(ev, fn) { this.ev = this.ev || {}; this.ev[ev] = fn; } }
  class Notification { constructor(opts) { this.opts = opts; E.notes.push(this); } static isSupported() { return true; } on(ev, fn) { this.clk = fn; } show() { this.shown = true; } }
  const disp = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  E.module = {
    app: E.app, BrowserWindow, Tray, Notification,
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => { E.appMenu = m; } },
    ipcMain: { on: (ch, fn) => { E.ipc[ch] = fn; }, handle: (ch, fn) => { E.handlers[ch] = fn; } },
    net: { fetch: async (u) => { E.fetchCalls.push(u); return { status: 200, text: async () => (/threats/.test(u) ? '{"threats":[]}' : '{}') }; } },
    shell: { openExternal: (u) => E.opened.push(u), showItemInFolder: (f) => { E.shownInFolder = f; } },
    screen: { getPrimaryDisplay: () => disp, getAllDisplays: () => [disp] },
    nativeImage: { createFromPath: (p) => ({ path: p }) },
    systemPreferences: { getAccentColor: () => '0067c0ff' }
  };
  return E;
}

async function loadMain(o) {
  o = o || {};
  const userData = o.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'uam-main-'));
  const E = makeElectron(userData, o);
  FakeWS.all = [];
  const origLoad = Module._load, origRelease = os.release, plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Module._load = function (req) {
    if (req === 'electron') return E.module;
    if (req === 'ws') return FakeWS;
    return origLoad.apply(this, arguments);
  };
  // Тести не залежать від ОС, на якій запущені (на Windows-раннері теж): платформа й збірка Windows підміняються завжди
  os.release = () => (o.win11 ? '10.0.22631' : '10.0.19045');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  delete require.cache[MAIN];
  try { require(MAIN); await sleep(30); }
  finally { Module._load = origLoad; os.release = origRelease; Object.defineProperty(process, 'platform', plat); }
  E.win = E.wins[0]; E.userData = userData;
  E.cleanup = () => { try { E.appHandlers['before-quit'] && E.appHandlers['before-quit'](); } catch (e) { /* ignore */ } fs.rmSync(userData, { recursive: true, force: true }); };
  return E;
}

test('Windows 11: frameless window with Acrylic, transparent background colour, sandboxed renderer', async () => {
  const E = await loadMain({ win11: true });
  const o = E.win.opts;
  assert.equal(o.frame, false);
  assert.equal(o.skipTaskbar, true);
  assert.equal(o.backgroundMaterial, 'acrylic');
  assert.equal(o.backgroundColor, '#00000000');
  assert.ok(!('transparent' in o) || o.transparent !== true, 'must not be transparent:true (breaks Mica/Acrylic)');
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.backgroundThrottling, false);
  assert.equal(path.basename(o.webPreferences.preload), 'preload.js');
  assert.equal(path.basename(E.win.file), 'index.html');
  assert.equal(E.appId, 'com.sandeymq.ukraine-alert-map');
  E.cleanup();
});

test('Windows 10 / older Windows 11 builds: solid dark background instead of a material', async () => {
  const E = await loadMain({ win11: false });
  assert.equal(E.win.opts.backgroundMaterial, 'none');
  assert.equal(E.win.opts.backgroundColor, '#1c1c1e');
  E.cleanup();
});

test('window follows the card size and keeps its top-right corner', async () => {
  const E = await loadMain({ win11: true });
  E.win.once_['ready-to-show']();
  E.ipc['uaw:resize']({}, { w: 440, h: 254 });
  let b = E.win.bounds;
  assert.deepEqual([b.x, b.y, b.width, b.height], [1460, 20, 440, 254]); // 1920 - 20 - 440
  E.ipc['uaw:resize']({}, { w: 440, h: 770 });
  b = E.win.bounds;
  assert.deepEqual([b.x + b.width, b.y], [1900, 20], 'right edge and top stay put when the panel opens');
  E.ipc['uaw:zoom']({}, 1.2);
  b = E.win.bounds;
  assert.equal(E.win.zoomFactor, 1.2);
  assert.deepEqual([b.width, b.height, b.x + b.width], [528, 924, 1900]);
  E.ipc['uaw:resize']({}, { w: -5, h: NaN });
  E.ipc['uaw:resize']({}, null);
  E.ipc['uaw:zoom']({}, 99);
  assert.equal(E.win.zoomFactor, 1.2, 'invalid IPC input is ignored');
  assert.equal(E.win.bounds.width, 528);
  E.cleanup();
});

test('dragging the window is remembered and restored on the next start', async () => {
  const E = await loadMain({ win11: true });
  E.win.once_['ready-to-show']();
  E.ipc['uaw:resize']({}, { w: 440, h: 300 });
  E.win.bounds = { x: 500, y: 200, width: 440, height: 300 };
  E.win.events.moved();
  const saved = JSON.parse(fs.readFileSync(path.join(E.userData, 'window.json'), 'utf8'));
  assert.deepEqual([saved.top, saved.right], [200, 940]);
  const E2 = await loadMain({ win11: true, userData: E.userData });
  E2.win.once_['ready-to-show']();
  E2.ipc['uaw:resize']({}, { w: 440, h: 300 });
  assert.deepEqual([E2.win.bounds.x, E2.win.bounds.y], [500, 200]);
  E2.cleanup();
});

test('a saved position outside every monitor is reset to the default corner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uam-main-'));
  fs.writeFileSync(path.join(dir, 'window.json'), JSON.stringify({ top: 5000, right: 9000 }));
  const E = await loadMain({ win11: true, userData: dir });
  E.win.once_['ready-to-show']();
  E.ipc['uaw:resize']({}, { w: 440, h: 300 });
  assert.deepEqual([E.win.bounds.x, E.win.bounds.y], [1460, 20]);
  E.cleanup();
});

test('toast notifications are silent (the widget plays its own sound), truncated and bring the widget back on click', async () => {
  const E = await loadMain({ win11: true });
  E.ipc['uaw:notify']({}, { title: 'T'.repeat(500), body: 'B'.repeat(900) });
  const n = E.notes[0];
  assert.equal(n.opts.silent, true);
  assert.equal(n.opts.title.length, 120);
  assert.equal(n.opts.body.length, 300);
  assert.equal(n.shown, true);
  E.win.visible = false;
  n.clk();
  assert.equal(E.win.visible, true);
  E.ipc['uaw:notify']({}, null); // не падає
  E.cleanup();
});

test('external links: only HTTPS and only the known hosts', async () => {
  const E = await loadMain({ win11: true });
  for (const u of ['https://neptun.in.ua/', 'https://wiki.ubilling.net.ua/doku.php?id=aerialalertsapi']) E.ipc['uaw:open']({}, u);
  for (const u of ['http://neptun.in.ua/', 'https://evil.example/', 'javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe', 'https://neptun.in.ua.evil.example/', 'nonsense']) E.ipc['uaw:open']({}, u);
  assert.deepEqual(E.opened, ['https://neptun.in.ua/', 'https://wiki.ubilling.net.ua/doku.php?id=aerialalertsapi']);
  assert.deepEqual(E.win.openHandler(), { action: 'deny' }, 'window.open is denied');
  let prevented = false;
  E.win.wcEvents['will-navigate']({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'in-page navigation is blocked');
  E.cleanup();
});

test('renderer-initiated requests are restricted to NEPTUN and Ubilling', async () => {
  const E = await loadMain({ win11: true });
  const bad = await E.handlers['uaw:get']({}, 'https://evil.example/steal');
  assert.deepEqual(bad, { code: '403', body: '' });
  assert.equal(E.fetchCalls.length, 0);
  const good = await E.handlers['uaw:get']({}, 'https://ubilling.net.ua/aerialalerts/?source=jaam');
  assert.equal(good.code, '200');
  assert.equal(E.fetchCalls.length, 1);
  E.cleanup();
});

test('ready starts the polling loop and output reaches the renderer', async () => {
  const E = await loadMain({ win11: true });
  E.ipc['uaw:ready']();
  await sleep(120);
  assert.ok(E.fetchCalls.some((u) => /neptun\.in\.ua\/api\/v1\/threats/.test(u)));
  const outs = E.win.sent.filter((s) => s[0] === 'uaw:output');
  assert.ok(outs.length >= 1 && /@@nt 200@@/.test(outs[0][1]) && /@@ub 200@@/.test(outs[0][1]));
  E.cleanup();
});

test('stream: start connects to the NEPTUN WebSocket and frames are forwarded to the renderer', async () => {
  const E = await loadMain({ win11: true });
  E.ipc['uaw:stream-start']();
  assert.equal(FakeWS.all.length, 1);
  assert.equal(FakeWS.all[0].url, 'wss://neptun.in.ua/api/v1/stream');
  FakeWS.all[0].emit('open');
  FakeWS.all[0].emit('message', Buffer.from('{"type":"heartbeat"}'));
  const s = E.win.sent.filter((x) => x[0] === 'uaw:stream');
  assert.ok(s.some((x) => x[1].type === 'state' && x[1].state === 'open'));
  assert.ok(s.some((x) => x[1].type === 'frame' && x[1].data === '{"type":"heartbeat"}'));
  E.ipc['uaw:stream-stop']();
  assert.ok(E.win.sent.some((x) => x[0] === 'uaw:stream' && x[1].state === 'off'));
  E.cleanup();
});

test('closing the window only hides it (the widget lives in the tray); Quit really quits', async () => {
  const E = await loadMain({ win11: true });
  E.win.visible = true;
  let prevented = false;
  E.win.events.close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(E.win.visible, false);
  const quit = E.trays[0].menu.find((i) => /Quit/.test(i.label || ''));
  quit.click();
  assert.equal(E.quitCalled, true);
  prevented = false;
  E.win.events.close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'after Quit the window may close');
  E.cleanup();
});

test('tray menu: toggles, material, autostart', async () => {
  const E = await loadMain({ win11: true });
  const tray = E.trays[0];
  assert.equal(tray.tip, 'Ukraine Alert Map');
  const labels = tray.menu.map((i) => i.label).filter(Boolean);
  assert.ok(labels.some((l) => /Always on top/.test(l)) && labels.some((l) => /Start with Windows/.test(l)) && labels.some((l) => /Background/.test(l)));
  tray.menu.find((i) => /Always on top/.test(i.label || '')).click({ checked: true });
  assert.equal(E.win.aot, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(E.userData, 'window.json'), 'utf8')).alwaysOnTop, true);
  const bg = tray.menu.find((i) => /Background/.test(i.label || '')).submenu;
  bg.find((i) => i.label === 'Mica').click();
  assert.equal(E.win.material, 'mica');
  assert.ok(E.win.sent.some((x) => x[0] === 'uaw:material' && x[1].material === 'mica'));
  assert.ok(bg.every((i) => i.enabled !== false), 'all background options are enabled on Windows 11');
  E.cleanup();
});

test('autostart is switched on once at first run of the installed app, and never for a dev run', async () => {
  const E = await loadMain({ win11: true, packaged: true });
  assert.deepEqual(E.loginCalls, [{ openAtLogin: true }]);
  const E2 = await loadMain({ win11: true, packaged: true, userData: E.userData });
  assert.equal(E2.loginCalls, undefined, 'the user can turn it off, we do not turn it on again');
  const E3 = await loadMain({ win11: true, packaged: false });
  assert.equal(E3.loginCalls, undefined, 'npm start must not register electron.exe as a startup item');
  E.cleanup(); E2.cleanup(); E3.cleanup();
});

test('second instance: quits immediately; first instance gets focus', async () => {
  const E = await loadMain({ win11: true, lock: false });
  assert.equal(E.quitCalled, true);
  assert.equal(E.wins.length, 0);
  const E2 = await loadMain({ win11: true });
  E2.win.visible = false;
  E2.appHandlers['second-instance']();
  assert.equal(E2.win.visible, true);
  E2.cleanup();
});

test('user config.json is passed to the renderer; bad files are ignored; the tray opens it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uam-main-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ soundUrlAlert: 'file:///C:/s/siren.wav', nRadius: 100 }));
  const E = await loadMain({ win11: true, userData: dir });
  let ev = {};
  E.ipc['uaw:info'](ev);
  assert.deepEqual(ev.returnValue.config, { soundUrlAlert: 'file:///C:/s/siren.wav', nRadius: 100 });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  ev = {}; E.ipc['uaw:info'](ev);
  assert.deepEqual(ev.returnValue.config, {}, 'broken JSON gives defaults, no crash');
  fs.writeFileSync(path.join(dir, 'config.json'), '[1,2]');
  ev = {}; E.ipc['uaw:info'](ev);
  assert.deepEqual(ev.returnValue.config, {}, 'non-object JSON is ignored');
  fs.rmSync(path.join(dir, 'config.json'));
  E.trays[0].menu.find((i) => /config\.json/.test(i.label || '')).click();
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').trim().replace(/\s+/g, ''), '{}', 'an empty template is created');
  assert.equal(E.shownInFolder, path.join(dir, 'config.json'));
  E.cleanup();
});

test('info for the renderer: accent colour, material support, Windows media folder', async () => {
  const E = await loadMain({ win11: true });
  const ev = {};
  E.ipc['uaw:info'](ev);
  assert.equal(ev.returnValue.accent, '#0067c0');
  assert.equal(ev.returnValue.supportsMaterial, true);
  assert.equal(ev.returnValue.material, 'acrylic');
  assert.match(ev.returnValue.mediaDir, /^file:\/\/\/.*\/Media\/$/);
  E.cleanup();
});
