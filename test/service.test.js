'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DataService, section } = require('../src/service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Імітація класу WebSocket з пакета «ws» (on/terminate), щоб тести не залежали від мережі та сторонніх пакетів
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    FakeWebSocket.instances.push(this);
  }
  terminate() {
    if (this.dead) return;
    this.dead = true;
    setImmediate(() => this.emit('close'));
  }
}
FakeWebSocket.instances = [];

function mockServer(handlers) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    hits[p] = (hits[p] || 0) + 1;
    const h = handlers[p];
    if (!h) { res.writeHead(404); return res.end('{}'); }
    const r = typeof h === 'function' ? h(req) : h;
    res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

const GEO = { type: 'FeatureCollection', features: [1, 2, 3, 4].map((i) => ({ type: 'Feature', properties: { key: 'k' + i, rayon: 'Район ' + i }, geometry: { type: 'Polygon', coordinates: [[[30.123456, 50.987654], [31.123456, 50.987654], [31.123456, 51.987654], [30.123456, 50.987654]]] } })) };

async function setup(extra) {
  const m = await mockServer(Object.assign({
    '/nt': { body: { serverTime: 'x', threats: [] } },
    '/na': { body: { raions: [], oblasts: [] } },
    '/nm': { body: { messages: [] } },
    '/ub': { body: { states: {} } },
    '/rg': { body: GEO }
  }, extra || {}));
  const base = 'http://127.0.0.1:' + m.port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uam-'));
  let t = 1000000;
  FakeWebSocket.instances = [];
  const svc = new DataService({
    fetch: globalThis.fetch, WebSocket: FakeWebSocket, cacheDir: dir, allowHttp: true, allowedHosts: ['127.0.0.1'], retryMs: 40, now: () => t,
    urls: { nt: base + '/nt', na: base + '/na', nm: base + '/nm', ub: base + '/ub', rg: base + '/rg', ws: 'ws://fake' }
  });
  return { m, svc, dir, tick: (ms) => { t += ms; }, close: () => { svc.stop(); svc.streamStop(); m.server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('section() has the same wire format as the macOS shell script', () => {
  assert.equal(section('nt', { code: '200', body: '{"a":1}' }), '@@nt 200@@\n{"a":1}\n');
});

test('cycle() returns four sections with status codes and bodies', async () => {
  const c = await setup();
  const out = await c.svc.cycle();
  for (const n of ['nt', 'na', 'nm', 'ub']) assert.match(out, new RegExp('@@' + n + ' 200@@\\n'));
  assert.match(out, /"threats":\[\]/);
  c.close();
});

test('messages and Ubilling are cached for 10 s, threats and alerts are not', async () => {
  const c = await setup();
  await c.svc.cycle(); c.tick(3000); await c.svc.cycle();
  assert.deepEqual([c.m.hits['/nt'], c.m.hits['/na'], c.m.hits['/nm'], c.m.hits['/ub']], [2, 2, 1, 1]);
  c.tick(8000); await c.svc.cycle();
  assert.deepEqual([c.m.hits['/nm'], c.m.hits['/ub']], [2, 2]);
  c.close();
});

test('HTTP 429 pauses that endpoint for 60 s', async () => {
  const c = await setup({ '/nm': { status: 429, body: {} } });
  const out = await c.svc.cycle();
  assert.match(out, /@@nm 429@@/);
  c.tick(20000); await c.svc.cycle();
  assert.equal(c.m.hits['/nm'], 1);
  c.tick(41000); await c.svc.cycle();
  assert.equal(c.m.hits['/nm'], 2);
  c.close();
});

test('network failure gives code 000 quickly (never an empty "calm" answer)', async () => {
  const svc = new DataService({ fetch: globalThis.fetch, allowHttp: true, allowedHosts: ['127.0.0.1'], urls: { nt: 'http://127.0.0.1:9/a', na: 'http://127.0.0.1:9/b', nm: 'http://127.0.0.1:9/c', ub: 'http://127.0.0.1:9/d' } });
  const t0 = Date.now();
  const out = await svc.cycle();
  assert.ok(Date.now() - t0 < 3000);
  for (const n of ['nt', 'na', 'nm', 'ub']) assert.match(out, new RegExp('@@' + n + ' 000@@'));
});

test('only the two known hosts over HTTPS are reachable', async () => {
  let called = 0;
  const svc = new DataService({ fetch: async () => { called++; return { status: 200, text: async () => '{}' }; } });
  assert.equal(svc.isAllowed('https://neptun.in.ua/api/v1/threats'), true);
  assert.equal(svc.isAllowed('https://ubilling.net.ua/aerialalerts/?source=jaam'), true);
  assert.equal(svc.isAllowed('http://neptun.in.ua/x'), false);
  assert.equal(svc.isAllowed('https://evil.example/x'), false);
  assert.equal(svc.isAllowed('https://neptun.in.ua.evil.example/x'), false);
  assert.equal(svc.isAllowed('file:///C:/Windows/win.ini'), false);
  assert.equal(svc.isAllowed('not a url'), false);
  const r = await svc.get('https://evil.example/x');
  assert.deepEqual(r, { code: '403', body: '' });
  assert.equal(called, 0);
});

test('stream: frames are forwarded, a live stream suppresses threat polling, reconnect works', async () => {
  const c = await setup();
  const events = [];
  c.svc.on('stream', (e) => events.push(e));
  c.svc.streamStart();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, 'ws://fake');
  FakeWebSocket.instances[0].emit('open');
  assert.equal(c.svc.state, 'open');
  assert.equal(c.svc.isLive(), false, 'not live until the first frame arrives');
  FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ type: 'snapshot', ts: 'x', data: { threats: [] } })));
  assert.equal(c.svc.isLive(), true);
  assert.deepEqual(events.filter((e) => e.type === 'frame').map((e) => JSON.parse(e.data).type), ['snapshot']);
  const out = await c.svc.cycle();
  assert.match(out, /@@nt skip@@/);
  assert.equal(c.m.hits['/nt'], undefined, 'threats endpoint was not polled while live');
  assert.equal(c.m.hits['/na'], 1, 'alerts are still polled');
  c.tick(41000); // 40 с без кадрів, знову опитуємо
  assert.equal(c.svc.isLive(), false);
  assert.match(await c.svc.cycle(), /@@nt 200@@/);
  FakeWebSocket.instances[0].emit('close'); // обрив
  assert.equal(c.svc.state, 'closed');
  assert.ok(events.some((e) => e.type === 'state' && e.state === 'closed'));
  await sleep(120);
  assert.equal(FakeWebSocket.instances.length, 2, 'reconnected after the drop');
  c.svc.streamStop();
  await sleep(120);
  assert.equal(FakeWebSocket.instances.length, 2, 'no reconnect after streamStop()');
  assert.equal(c.svc.state, 'off');
  c.close();
});

test('stream: an error also triggers a reconnect, and a stale socket cannot corrupt the state', async () => {
  const c = await setup();
  c.svc.streamStart();
  const first = FakeWebSocket.instances[0];
  first.emit('open');
  first.emit('error', new Error('boom'));
  await sleep(120);
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  second.emit('open');
  first.emit('message', Buffer.from('{"type":"heartbeat"}')); // старий сокет мовчить
  assert.equal(c.svc.lastFrame, 0);
  c.svc.streamStop();
  c.close();
});

test('raion borders: downloaded once, reduced to 2 decimals, cached on disk, sent a single time', async () => {
  const c = await setup();
  await c.svc.ensureRaions();
  assert.equal(c.m.hits['/rg'], 1);
  const file = path.join(c.dir, 'raions.geojson');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/\d+\.\d{3}/.test(text), 'coordinates have at most 2 decimals');
  assert.match(text, /30\.12,50\.98|30\.12,50\.99/);
  assert.match(await c.svc.cycle(), /@@rg 200@@/);
  assert.doesNotMatch(await c.svc.cycle(), /@@rg /);
  const again = new DataService({ fetch: globalThis.fetch, cacheDir: c.dir, allowHttp: true, allowedHosts: ['127.0.0.1'], urls: c.svc.urls });
  await again.ensureRaions(); // новий екземпляр бере з диска й не качає знову
  assert.equal(c.m.hits['/rg'], 1);
  assert.ok(again.rgText && again.rgText.length > 10);
  c.close();
});

test('invalid raion data is ignored and nothing is cached', async () => {
  const c = await setup({ '/rg': { body: { features: [] } } });
  await c.svc.ensureRaions();
  assert.equal(fs.existsSync(path.join(c.dir, 'raions.geojson')), false);
  assert.doesNotMatch(await c.svc.cycle(), /@@rg /);
  c.close();
});
