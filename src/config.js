'use strict';

// One place for bind address, port, Host allow list and the LAN admin token.
// Flags win over environment variables; every default keeps the old
// loopback-only behaviour.

const fs = require('fs');
const os = require('os');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4545;
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function truthy(v) {
  return v != null && !/^(0|false|no|off|)$/i.test(String(v).trim());
}

function parsePort(v, what = 'port') {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid ${what}: ${v} (expected 1-65535)`);
  return n;
}

// "localhost, 127.0.0.1,*.lan" -> ["localhost","127.0.0.1","*.lan"]
function parseHosts(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '0:0:0:0:0:0:0:1';
}

// Bind addresses that only accept local connections.
function isLoopbackBind(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '' || h === 'localhost' || h === '::1' || /^127\./.test(h);
}

// Host header -> bare host name: strip the port, lowercase, keep IPv6 brackets.
function hostNameOf(header) {
  let h = String(header || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

function matchesHost(hostHeader, allowed) {
  const h = hostNameOf(hostHeader);
  if (!h) return false;
  for (const a of allowed) {
    if (a === '*' || a === h) return true;
    if (a.startsWith('*.') && h.length > a.length - 1 && h.endsWith(a.slice(1))) return true;
  }
  return false;
}

// Addresses of this machine: a Host naming one of them is not a rebinding attack.
function localAddresses() {
  const out = new Set(['localhost', '127.0.0.1', '[::1]']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const x of list || []) {
        if (!x || !x.address) continue;
        const a = x.address.toLowerCase();
        out.add(a.includes(':') ? `[${a}]` : a);
      }
    }
  } catch {}
  return out;
}

// The token is read once from a file (Docker secret) or, discouraged, inline.
// Never log the value; only whether one is configured.
function readToken(env = process.env) {
  const file = env.WMAD_ADMIN_TOKEN_FILE;
  if (file) {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      return t || null;
    } catch {
      return null;
    }
  }
  const inline = env.WMAD_ADMIN_TOKEN;
  return inline && inline.trim() ? inline.trim() : null;
}

// Flags (already parsed by bin/cli.js) and env -> the resolved settings.
function resolve(flags = {}, env = process.env) {
  const host = String(flags.host ?? env.WMAD_HOST ?? DEFAULT_HOST);
  const port = parsePort(flags.port ?? env.WMAD_PORT ?? DEFAULT_PORT);
  const allowedHosts = parseHosts(flags.allowedHosts ?? env.WMAD_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS);
  const trustProxy = flags.trustProxy != null ? !!flags.trustProxy : truthy(env.WMAD_TRUST_PROXY);
  const token = readToken(env);
  const demo = !!(flags.demo || truthy(env.WMAD_DEMO));
  const cfg = { host, port, allowedHosts, trustProxy, token, demo, loopback: isLoopbackBind(host) };
  // "*" is fine: admin routes are separately loopback/token-gated and foreign
  // Origins are rejected, so a wide Host list does not widen what a page can do.
  // It is still worth a warning when the server is reachable from the LAN.
  if (allowedHosts.includes('*') && !cfg.loopback && !token) {
    cfg.warnings = ['allowed-hosts "*" with a non-loopback bind: any Host is accepted; admin stays loopback-only (set WMAD_ADMIN_TOKEN_FILE to allow token admin).'];
  }
  return cfg;
}

module.exports = {
  DEFAULT_HOST, DEFAULT_PORT, DEFAULT_ALLOWED_HOSTS,
  resolve, parsePort, parseHosts, hostNameOf, matchesHost, localAddresses,
  isLoopbackHost, isLoopbackBind, truthy,
};
