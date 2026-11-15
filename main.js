'use strict';
// Ukraine Alert Map для Windows 11: головний процес.
// Мережа (опитування, WebSocket) живе тут, інтерфейс (src/widget.js) лише малює.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, Notification, net, shell, screen, nativeImage, systemPreferences
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { DataService } = require('./src/service');

const APP_ID = 'com.sandeymq.ukraine-alert-map';
const OPEN_HOSTS = ['neptun.in.ua', 'ubilling.net.ua', 'wiki.ubilling.net.ua'];
const ICON = path.join(__dirname, 'src', 'assets', 'icon.png');
const MATERIALS = ['acrylic', 'mica', 'none'];

app.setAppUserModelId(APP_ID); // потрібно для сповіщень Windows

// Mica/Acrylic підтримуються з Windows 11 22H2 (build 22621)
function winBuild() {
  const m = /^10\.0\.(\d+)/.exec(os.release());
  return m ? parseInt(m[1], 10) : 0;
}
const SUPPORTS_MATERIAL = process.platform === 'win32' && winBuild() >= 22621;

let win = null;
let tray = null;
let svc = null;
let quitting = false;
let zoom = 1;
let css = { w: 440, h: 300 };
let state = { top: null, right: null, alwaysOnTop: false, material: 'acrylic', initDone: false };
let stateFile = '';

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && typeof s === 'object') state = Object.assign(state, s);
  } catch (e) { /* перший запуск */ }
  if (MATERIALS.indexOf(state.material) < 0) state.material = 'acrylic';
}
function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { /* не критично */ }
}

// Файл налаштувань користувача: %APPDATA%\Ukraine Alert Map\config.json (необов'язковий; перекриває значення за замовчуванням)
function userConfigPath() { return path.join(app.getPath('userData'), 'config.json'); }
function readUserConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch (e) { return {}; }
}
function openUserConfig() {
  const f = userConfigPath();
  try { if (!fs.existsSync(f)) fs.writeFileSync(f, '{\n}\n'); } catch (e) { /* ignore */ }
  shell.showItemInFolder(f);
}

function onScreen(x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + w > a.x + 40 && x < a.x + a.width - 40 && y + 40 > a.y && y < a.y + a.height - 40;
  });
}

function defaultAnchor() {
  const a = screen.getPrimaryDisplay().workArea;
  return { top: a.y + 20, right: a.x + a.width - 20 };
}

// Вікно підлаштовується під картку; правий верхній кут лишається на місці (якщо він у межах екрана)
function applySize() {
  if (!win || win.isDestroyed()) return;
  const w = Math.max(200, Math.round(css.w * zoom));
  const h = Math.max(60, Math.round(css.h * zoom));
  if (state.right == null || state.top == null || !onScreen(state.right - w, state.top, w, h)) {
    const d = defaultAnchor();
    state.right = d.right;
    state.top = d.top;
  }
  win.setBounds({ x: Math.round(state.right - w), y: Math.round(state.top), width: w, height: h });
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function showWin() {
  if (!win) return;
  win.show();
  win.focus();
}

function setMaterial(mat) {
  if (MATERIALS.indexOf(mat) < 0) return;
  state.material = mat;
  saveState();
  if (win && SUPPORTS_MATERIAL) {
    try { win.setBackgroundMaterial(mat); } catch (e) { /* стара збірка Electron */ }
  }
  send('uaw:material', { material: SUPPORTS_MATERIAL ? mat : 'none' });
  buildTray();
}

function createWindow() {
  const material = SUPPORTS_MATERIAL ? state.material : 'none';
  win = new BrowserWindow({
    width: Math.round(css.w), height: Math.round(css.h), show: false,
    frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: true, alwaysOnTop: !!state.alwaysOnTop, title: 'Ukraine Alert Map', icon: ICON,
    // Mica/Acrylic вимагають НЕ transparent-вікна й прозорого backgroundColor; без матеріалу: суцільний темний фон
    backgroundColor: material === 'none' ? '#1c1c1e' : '#00000000',
    backgroundMaterial: material,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, // віджет має працювати й коли сховано в трей (сповіщення!)
      autoplayPolicy: 'no-user-gesture-required', spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => { applySize(); win.show(); });
  win.on('moved', () => {
    const b = win.getBounds();
    state.top = b.y;
    state.right = b.x + b.width;
    saveState();
  });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildTray() {
  if (!tray) return;
  const startup = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Сховати віджет / Hide' : 'Показати віджет / Show', click: () => { if (win.isVisible()) win.hide(); else showWin(); buildTray(); } },
    { type: 'separator' },
    { label: 'Поверх усіх вікон / Always on top', type: 'checkbox', checked: !!state.alwaysOnTop,
      click: (i) => { state.alwaysOnTop = i.checked; if (win) win.setAlwaysOnTop(i.checked); saveState(); } },
    { label: 'Запускати з Windows / Start with Windows', type: 'checkbox', checked: startup, enabled: app.isPackaged,
      click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); buildTray(); } },
    { label: 'Фон / Background', submenu: [
      { label: 'Acrylic', type: 'radio', checked: state.material === 'acrylic', enabled: SUPPORTS_MATERIAL, click: () => setMaterial('acrylic') },
      { label: 'Mica', type: 'radio', checked: state.material === 'mica', enabled: SUPPORTS_MATERIAL, click: () => setMaterial('mica') },
      { label: 'Суцільний / Solid', type: 'radio', checked: state.material === 'none', click: () => setMaterial('none') }
    ] },
    { label: 'Файл налаштувань / Open config.json', click: openUserConfig },
    { label: 'Скинути положення / Reset position', click: () => { const d = defaultAnchor(); state.right = d.right; state.top = d.top; saveState(); applySize(); } },
    { type: 'separator' },
    { label: 'Вийти / Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Ukraine Alert Map');
  tray.on('click', () => { if (win.isVisible()) win.hide(); else showWin(); buildTray(); });
  buildTray();
}

function accent() {
  try {
    const c = systemPreferences.getAccentColor(); // RRGGBBAA
    return /^[0-9a-f]{8}$/i.test(c) ? '#' + c.slice(0, 6) : '#0078d4';
  } catch (e) { return '#0078d4'; }
}

function registerIpc() {
  ipcMain.on('uaw:info', (e) => {
    e.returnValue = {
      platform: process.platform, accent: accent(), version: app.getVersion(), locale: app.getLocale(),
      material: SUPPORTS_MATERIAL ? state.material : 'none', supportsMaterial: SUPPORTS_MATERIAL, config: readUserConfig(),
      mediaDir: 'file:///' + path.join(process.env.SystemRoot || 'C:\\Windows', 'Media').replace(/\\/g, '/') + '/'
    };
  });
  ipcMain.on('uaw:ready', () => {
    svc.ensureRaions().catch(() => { /* без районів працює штриховка */ });
    svc.start(6000);
  });
  ipcMain.on('uaw:stream-start', () => svc.streamStart());
  ipcMain.on('uaw:stream-stop', () => svc.streamStop());
  ipcMain.handle('uaw:get', (_e, url) => svc.get(String(url)));
  ipcMain.on('uaw:notify', (_e, m) => {
    if (!m || !Notification.isSupported()) return;
    const n = new Notification({ title: String(m.title || '').slice(0, 120), body: String(m.body || '').slice(0, 300), silent: true, icon: ICON });
    n.on('click', showWin);
    n.show();
  });
  ipcMain.on('uaw:open', (_e, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'https:' && OPEN_HOSTS.indexOf(u.hostname) >= 0) shell.openExternal(u.href);
    } catch (e) { /* ignore */ }
  });
  ipcMain.on('uaw:resize', (_e, s) => {
    if (!s || !isFinite(s.w) || !isFinite(s.h) || s.w <= 0 || s.h <= 0) return;
    css = { w: Math.min(s.w, 1200), h: Math.min(s.h, 2400) };
    applySize();
  });
  ipcMain.on('uaw:zoom', (_e, z) => {
    z = Number(z);
    if (!(z >= 0.5 && z <= 2) || !win) return;
    zoom = z;
    win.webContents.setZoomFactor(z);
    applySize();
  });
  ipcMain.on('uaw:hide', () => { if (win) win.hide(); buildTray(); });
}

function start() {
  stateFile = path.join(app.getPath('userData'), 'window.json');
  loadState();
  svc = new DataService({ fetch: (u, o) => net.fetch(u, o), WebSocket, cacheDir: path.join(app.getPath('userData'), 'cache') });
  svc.on('output', (t) => send('uaw:output', t));
  svc.on('stream', (m) => send('uaw:stream', m));
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  createTray();
  // Автозапуск за замовчуванням увімкнено при першому запуску встановленої версії (вимикається в меню трея)
  if (app.isPackaged && !state.initDone) {
    app.setLoginItemSettings({ openAtLogin: true });
    state.initDone = true;
    saveState();
    buildTray();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWin);
  app.on('window-all-closed', () => { /* живемо в треї */ });
  app.on('before-quit', () => {
    quitting = true;
    if (svc) { svc.stop(); svc.streamStop(); }
  });
  app.whenReady().then(start);
}
