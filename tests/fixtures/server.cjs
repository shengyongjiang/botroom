const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
assert.ok(process.argv[3], 'Run through tests/server.cjs with an isolated home');
assert.equal(process.env.HOME, process.argv[3]);
const { createServer } = require('../../src/server');
const { USER_DIR } = require('../../src/scenes');

const scene = path.join(USER_DIR, 'fixture');
fs.mkdirSync(scene, { recursive: true });
fs.writeFileSync(path.join(scene, 'manifest.json'), '{"name":"Fixture"}');
fs.writeFileSync(path.join(scene, 'hello world.json'), '{"fixture":true}\n');
fs.writeFileSync(path.join(scene, 'literal%name.json'), '{"percent":true}\n');
fs.writeFileSync(path.join(scene, 'blocked.txt'), 'not an allowed HTTP MIME type');
fs.writeFileSync(path.join(USER_DIR, 'outside.json'), '{"outside":true}');

const watcher = new EventEmitter();
watcher.sessions = () => [];
// LAN scenario: trust our proxy header and accept any Host, like WMAD_ALLOWED_HOSTS=*.
// "lan-notrust" is the same without --trust-proxy; "lan-spoof" listens on all
// interfaces so the socket peer is a real LAN address (see tests/lan.cjs).
const scenario = process.argv[2];
const lanMode = scenario === 'lan' || scenario === 'lan-notrust' || scenario === 'lan-spoof';
// The allow list comes from the environment (WMAD_ALLOWED_HOSTS=* in tests/lan.cjs).
const trustProxy = scenario !== 'lan-notrust';
const server = createServer(watcher, lanMode ? { trustProxy } : {});

function request(url, host = 'localhost', extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: extra.connect || '127.0.0.1', port: server.address().port, path: url, method: extra.method || 'GET',
      headers: { host: `${host}:${server.address().port}`, ...(extra.headers || {}) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.end();
  });
}

async function ping(host) {
  const res = await request('/api/ping', host);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.app, 'whatsmyagentdoing');
  return body;
}

async function resource(url, file, type, cache = 'no-cache') {
  const res = await request(url);
  assert.equal(res.status, 200, url);
  assert.equal(res.headers['content-type'], type);
  assert.equal(res.headers['cache-control'], cache);
  assert.deepEqual(res.body, fs.readFileSync(file), url);
}

// LAN + admin gate + cross-origin cases (see tests/lan.cjs for the setup).
const TOKEN = process.env.WMAD_TEST_TOKEN || '';
const ADMIN = { '/api/shutdown': 'stop', '/api/update': 'update', '/api/scenes/install?id=fixture': 'install' };
const LAN = { 'x-forwarded-for': '192.168.1.50' };
const LOCAL = { 'x-forwarded-for': '127.0.0.1' };
// The address a LAN client connects to (first non-internal IPv4), or null.
function lanAddress() {
  for (const list of Object.values(require('node:os').networkInterfaces())) {
    for (const x of list || []) if (x && x.family === 'IPv4' && !x.internal) return x.address;
  }
  return null;
}

async function lan() {
  const info = await ping('mybox.lan');
  // Not every scenario runs with a token, so the key set is checked in tests/lan.cjs.
  assert.equal(info.app, 'whatsmyagentdoing');
  assert.equal(info.admin, TOKEN ? 'token' : 'loopback');
  // Reads stay open to the LAN.
  for (const url of ['/api/sessions', '/api/scenes', '/']) {
    const res = await request(url, 'mybox.lan', { headers: LAN });
    assert.equal(res.status, 200, url);
  }
  // A Host that is neither an allowed name nor a local address is refused
  // (with WMAD_ALLOWED_HOSTS=* any Host is allowed; see tests/lan.cjs).
  if (!process.env.WMAD_ALLOWED_HOSTS?.includes('*')) {
    for (const host of ['evil.example', 'untrusted.example']) {
      assert.equal((await request('/api/ping', host)).status, 403, host);
    }
  }
  // Foreign Origin: refused, and no CORS headers are ever emitted. (With
  // WMAD_ALLOWED_HOSTS=* every host is "allowed", so this needs a list.)
  const foreign = await request('/api/sessions', 'mybox.lan', { headers: { ...LAN, origin: 'http://evil.example' } });
  assert.equal(foreign.status, process.env.WMAD_ALLOWED_HOSTS?.includes('*') ? 200 : 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  const same = await request('/api/sessions', 'mybox.lan', { headers: { ...LAN, origin: 'http://mybox.lan:4546' } });
  assert.equal(same.status, 200);
  // Admin routes: LAN without a token is refused, even with the custom header.
  // The gate answers 403 {"error":"admin disabled on LAN"} before any handler
  // runs (a token, when configured, is simply not sent here).
  for (const [url, h] of Object.entries(ADMIN)) {
    const res = await request(url, 'mybox.lan', { method: 'POST', headers: { ...LAN, 'x-whatsmyagentdoing': h } });
    assert.equal(res.status, 403, url);
    assert.equal(JSON.parse(res.body).error, 'admin disabled on LAN', url);
  }
  // Loopback still works (custom header required, as before). "fixture" is
  // not in the catalog, so a pass through the gate ends in the handler's 400.
  const pass = (res) => assert.notEqual(res.status, 403, 'gate refused a loopback request');
  pass(await request('/api/scenes/install?id=fixture', 'localhost', { method: 'POST', headers: { 'x-whatsmyagentdoing': 'install' } }));
  pass(await request('/api/update', 'localhost', { method: 'POST', headers: { 'x-whatsmyagentdoing': 'update' } }).catch(() => ({ status: 0 })));
  if (TOKEN) {
    // Wrong token -> 403; right token -> through to the handler.
    const bad = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LAN, 'x-whatsmyagentdoing': 'install', authorization: 'Bearer wrong' } });
    assert.equal(bad.status, 403);
    const good = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LAN, 'x-whatsmyagentdoing': 'install', authorization: `Bearer ${TOKEN}` } });
    pass(good);
    const hdr = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LAN, 'x-whatsmyagentdoing': 'install', 'x-wmad-token': TOKEN } });
    pass(hdr);
    // A token without the custom header still hits the second layer.
    const noHeader = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LAN, authorization: `Bearer ${TOKEN}` } });
    assert.equal(noHeader.status, 403);
    // A trusted proxy forwarding a loopback client counts as loopback (the
    // socket peer must itself be loopback; see spoof() below).
    const viaProxy = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LOCAL, 'x-whatsmyagentdoing': 'install' } });
    pass(viaProxy);
  }
}

// Spoofing: headers must never turn a non-loopback peer into loopback.
// Every admin route, with and without the custom header, must stay 403.
const SPOOF = [
  { 'x-forwarded-for': '127.0.0.1' },
  { 'x-forwarded-for': '::1' },
  { 'x-forwarded-for': 'localhost' },
  { 'x-forwarded-for': '127.0.0.1, 192.168.1.50' },
  { forwarded: 'for=127.0.0.1' },
  { forwarded: 'for="[::1]";proto=http' },
  { 'x-real-ip': '127.0.0.1' },
  { 'x-forwarded-host': 'localhost' },
  { origin: 'http://127.0.0.1:4546' },
  { origin: 'http://localhost:4546' },
];
async function spoof(connect) {
  const base = { connect };
  const tryAdmin = async (url, h, headers) => {
    const res = await request(url, 'mybox.lan', { ...base, method: 'POST', headers: { ...headers, 'x-whatsmyagentdoing': h } });
    assert.equal(res.status, 403, `${url} ${JSON.stringify(headers)}`);
    return res;
  };
  for (const headers of SPOOF) {
    for (const [url, h] of Object.entries(ADMIN)) {
      await tryAdmin(url, h, headers);
      // ...and never more permissive without the custom header either.
      const bare = await request(url, 'mybox.lan', { ...base, method: 'POST', headers });
      assert.equal(bare.status, 403, `${url} ${JSON.stringify(headers)}`);
    }
    // GET on an admin route never mutates: the gate refuses it, or (loopback
    // only) the route's own method check does; it is never a 200.
    const get = await request('/api/scenes/install?id=fixture', 'mybox.lan', { ...base, headers });
    assert.ok(get.status === 403 || get.status === 404, `GET /api/scenes/install ${get.status} ${JSON.stringify(headers)}`);
  }
  // A spoofed Host of a loopback name is not "the LAN address" either: with
  // the default allow list it is refused, with '*' it is allowed but still
  // cannot reach admin (checked above).
  const reads = await request('/api/sessions', 'mybox.lan', { ...base, headers: { 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(reads.status, 200);
  // The ping still reports loopback-only admin (no token in this scenario).
  const info = await ping('mybox.lan');
  assert.equal(info.admin, 'loopback');
}

async function main() {
  server.listen(0, scenario === 'lan-spoof' || scenario === 'lan-notrust' ? '0.0.0.0' : '127.0.0.1');
  await once(server, 'listening');
  try {
    const scenario = process.argv[2];
    if (scenario === 'assets' || scenario === 'scenes') {
      const prefixes = scenario === 'assets' ? ['/assets/'] : ['/scenes/', '/scenes/fixture/'];
      for (const prefix of prefixes) {
        for (const suffix of ['%', '%2', '%GG', '%E0%A4', '%FF']) {
          const url = prefix + suffix;
          assert.equal((await request(url)).status, 400, url);
          await ping();
          if (scenario === 'assets') {
            await resource('/assets/agents%2F%63laude.png', path.join(__dirname, '../../assets/agents/claude.png'), 'image/png');
          } else {
            await resource('/scenes/fixture/hello%20world.json', path.join(scene, 'hello world.json'), 'application/json');
          }
        }
      }
    } else if (scenario === 'lan') {
      await lan();
    } else if (scenario === 'lan-notrust' || scenario === 'lan-spoof') {
      const addr = lanAddress();
      assert.ok(addr, 'lan-spoof needs a non-loopback IPv4 address');
      // The socket peer is this machine's LAN address: not loopback.
      await spoof(addr);
      // A loopback peer is loopback whatever headers it sends (that is the
      // CLI and the healthcheck); only the LAN peer above must stay refused.
    } else {
      assert.equal(scenario, 'guards');
      for (const url of ['/assets/%', '/scenes/%']) {
        assert.equal((await request(url, 'untrusted.example')).status, 403, url);
      }
      for (const host of ['localhost', '127.0.0.1', '[::1]']) await ping(host);
      for (const url of [
        '/assets/%2e%2e%2fpackage.json', '/scenes/fixture/%2e%2e%2foutside.json',
        '/scenes/%2e%2e%2ffixture/manifest.json', '/assets/agents/README.md',
        '/scenes/fixture/blocked.txt', '/assets/missing.png', '/scenes/missing/manifest.json',
      ]) assert.equal((await request(url)).status, 404, url);
      await resource('/scenes/fixture/literal%25name.json', path.join(scene, 'literal%name.json'), 'application/json');
      await resource('/office.js', path.join(__dirname, '../../public/office.js'), 'text/javascript; charset=utf-8', 'no-store');
      await ping();
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
