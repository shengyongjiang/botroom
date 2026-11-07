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
const lanMode = process.argv[2] === 'lan';
// The allow list comes from the environment (WMAD_ALLOWED_HOSTS=* in tests/lan.cjs).
const server = createServer(watcher, lanMode ? { trustProxy: true } : {});

function request(url, host = 'localhost', extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: url, method: extra.method || 'GET',
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
async function lan() {
  const info = await ping('mybox.lan');
  assert.deepEqual(Object.keys(info).sort(), ['admin', 'app', 'demo']);
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
    // A trusted proxy forwarding a loopback client counts as loopback.
    const viaProxy = await request('/api/scenes/install?id=fixture', 'mybox.lan', { method: 'POST', headers: { ...LOCAL, 'x-whatsmyagentdoing': 'install' } });
    pass(viaProxy);
  }
}

async function main() {
  server.listen(0, '127.0.0.1');
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
