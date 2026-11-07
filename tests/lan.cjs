// LAN access: config resolution, Host guard, admin gate, token and cross-origin.
// Each server case runs in a child process (tests/fixtures/server.cjs) so an
// uncaught request error fails the test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../src/config');

const FIXTURE = path.join(__dirname, 'fixtures/server.cjs');

function runFixture(scenario, env = {}, t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-lan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const clean = { ...process.env };
  for (const k of ['WMAD_ADMIN_TOKEN', 'WMAD_ADMIN_TOKEN_FILE', 'WMAD_ALLOWED_HOSTS', 'WMAD_TRUST_PROXY', 'WMAD_DEMO', 'WMAD_HOST', 'WMAD_PORT']) delete clean[k];
  const child = spawnSync(process.execPath, [FIXTURE, scenario, home], {
    env: { ...clean, HOME: home, USERPROFILE: home, WMAD_NO_UPDATE_CHECK: '1', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('admin gate without a token: LAN writes 403, reads 200, foreign Origin 403, bad Host 403', (t) => {
  runFixture('lan', { WMAD_ALLOWED_HOSTS: '*' }, t);
});

test('admin gate with a token file: wrong token 403, right token 200', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, 'test-token-0123456789\n');
  runFixture('lan', { WMAD_ALLOWED_HOSTS: '*', WMAD_ADMIN_TOKEN_FILE: file, WMAD_TEST_TOKEN: 'test-token-0123456789' }, t);
});

test('config: defaults are unchanged (loopback, 4545, localhost only)', () => {
  const cfg = config.resolve({}, {});
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 4545);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '[::1]']);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.token, null);
  assert.equal(cfg.loopback, true);
});

test('config: flags win over env; env fills the rest', () => {
  const env = { WMAD_HOST: '0.0.0.0', WMAD_PORT: '4546', WMAD_ALLOWED_HOSTS: 'a.lan, *.lan', WMAD_TRUST_PROXY: '1', WMAD_DEMO: '1' };
  const cfg = config.resolve({ port: '5000', host: '127.0.0.1' }, env);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 5000);
  assert.deepEqual(cfg.allowedHosts, ['a.lan', '*.lan']);
  assert.equal(cfg.trustProxy, true);
  assert.equal(cfg.demo, true);
  assert.equal(config.resolve({}, env).port, 4546);
  assert.equal(config.resolve({ trustProxy: false }, env).trustProxy, false);
});

test('config: ports outside 1-65535 are refused', () => {
  for (const p of ['0', '65536', '-1', 'abc', '1.5']) assert.throws(() => config.resolve({ port: p }, {}), /Invalid port/);
  assert.equal(config.resolve({ port: '1' }, {}).port, 1);
  assert.equal(config.resolve({ port: 65535 }, {}).port, 65535);
});

test('config: "*" allowed-hosts is permitted on a LAN bind (admin stays gated) and warns', () => {
  const cfg = config.resolve({ host: '0.0.0.0', allowedHosts: '*' }, {});
  assert.deepEqual(cfg.allowedHosts, ['*']);
  assert.equal(cfg.warnings.length, 1);
  assert.ok(!cfg.warnings[0].includes('refused'));
  // With a token, no warning: the operator opted into LAN admin.
  assert.equal(config.resolve({ host: '0.0.0.0', allowedHosts: '*' }, { WMAD_ADMIN_TOKEN: 'x' }).warnings, undefined);
});

test('config: token comes from the file (trimmed) and never from a missing file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, '  abc123  \n');
  assert.equal(config.resolve({}, { WMAD_ADMIN_TOKEN_FILE: file }).token, 'abc123');
  assert.equal(config.resolve({}, { WMAD_ADMIN_TOKEN_FILE: path.join(dir, 'missing') }).token, null);
  assert.equal(config.resolve({}, { WMAD_ADMIN_TOKEN: 'inline' }).token, 'inline');
  assert.equal(config.resolve({}, { WMAD_ADMIN_TOKEN: '   ' }).token, null);
});

test('host matching: port stripped, case ignored, [::1] kept, *.lan wildcards', () => {
  assert.equal(config.hostNameOf('MyBox.LAN:4546'), 'mybox.lan');
  assert.equal(config.hostNameOf('[::1]:4546'), '[::1]');
  assert.equal(config.hostNameOf('[::1]'), '[::1]');
  assert.ok(config.matchesHost('[::1]:4545', ['[::1]']));
  assert.ok(config.matchesHost('mybox.lan:4546', ['*.lan']));
  assert.ok(!config.matchesHost('mybox.lan.example', ['*.lan']));
  assert.ok(!config.matchesHost('evil.example', ['localhost', '127.0.0.1', '[::1]']));
  assert.ok(config.matchesHost('anything', ['*']));
  assert.ok(!config.matchesHost('', ['*']));
});

test('loopback helpers', () => {
  assert.ok(config.isLoopbackBind('127.0.0.1'));
  assert.ok(config.isLoopbackBind('::1'));
  assert.ok(!config.isLoopbackBind('0.0.0.0'));
  assert.ok(!config.isLoopbackBind('192.168.1.10'));
  assert.ok(config.isLoopbackHost('127.0.0.1'));
});

test('server binds 0.0.0.0 and answers on the LAN address with the configured Host', async (t) => {
  const { DemoWatcher } = require('../src/demo');
  const { createServer } = require('../src/server');
  const watcher = new DemoWatcher().start();
  const server = createServer(watcher, { demo: true, allowedHosts: 'mybox.lan' });
  t.after(() => { watcher.stop(); server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  const get = (host) => new Promise((resolve, reject) => {
    const req = require('node:http').get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
  const lan = await get(`mybox.lan:${port}`);
  assert.equal(lan.status, 200);
  assert.equal(lan.body.admin, 'loopback');
  assert.equal(lan.body.demo, true);
  // A Host naming one of this machine's own addresses is accepted too.
  const addrs = Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal);
  if (addrs.length) assert.equal((await get(`${addrs[0].address}:${port}`)).status, 200);
  const evil = await new Promise((resolve, reject) => {
    const req = require('node:http').get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(evil, 403);
  // The socket itself is reachable on all interfaces (IPv4 wildcard bind).
  const s = net.connect(port, '127.0.0.1');
  await new Promise((r) => s.once('connect', r));
  s.destroy();
});
