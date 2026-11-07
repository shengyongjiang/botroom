# LAN + Docker + mobile: design and task spec

Branch `feat/lan-docker-mobile` (base `f37d37e`): run the dashboard on a LAN via
Docker and make the office usable on a phone. No multi-room, no scheduling.
Operator guide `docs/run.md` and tester report `docs/test-report.md` are separate.

## 1. Config (new `src/config.js`)

One resolver used by `bin/cli.js` and `src/server.js`; flags win over env.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--host` | `WMAD_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in Docker) |
| `-p/--port` | `WMAD_PORT` | `4545` | listen port (Docker uses `4546`) |
| `--allowed-hosts` | `WMAD_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | comma list; `*.lan` wildcards; `*` = any |
| `--trust-proxy` | `WMAD_TRUST_PROXY` | off | trust `X-Forwarded-For` (only behind our proxy) |
| — | `WMAD_DEMO` | off | same as `--demo` |
| — | `WMAD_ADMIN_TOKEN_FILE` | unset | path to a token file (Docker secret) |
| — | `WMAD_ADMIN_TOKEN` | unset | token inline (discouraged; never commit) |

Rules: port 1–65535; `--allowed-hosts "*"` is refused when `--host` is non-loopback
and no token is set (fail closed). Never log token values; defaults unchanged.

## 2. LAN access and write protection

**Decision: loopback-only admin by default; opt-in token for LAN admin.**

- `isLoopback(req)` = socket address in `127.0.0.0/8` / `::1` (or the first
  `X-Forwarded-For` hop with `--trust-proxy`), computed once per request.
- **Host guard** (replaces the hardcoded list in `src/server.js`): parse `Host`
  (strip port, lowercase, keep `[::1]`); 403 unless it matches `allowedHosts` or
  a local interface address — keeps DNS-rebinding protection, allows `mybox.lan:4546`.
- **Write/admin routes**: `POST /api/update`, `/api/shutdown`, `/api/scenes/install`
  and the page's Update/Shut down/Install controls. Gate:
  `adminAllowed(req) = isLoopback(req) || (tokenConfigured && token ok)`.
  Token = `Authorization: Bearer <t>` or `X-WMAD-Token: <t>`, compared with
  `crypto.timingSafeEqual`. Non-loopback without token → 403
  `{ok:false,error:"admin disabled on LAN"}`. Keep the existing custom-header
  checks as a second layer (blocks cross-site form/no-preflight writes).
- **Cross-origin**: 403 any `Origin` whose host is not in `allowedHosts`; never
  emit CORS headers. Same-origin LAN pages pass.
- `GET /api/sessions|events|transcript|scenes` stay readable from LAN (read-only;
  `--private` still hides prompts/replies).
- `/api/ping` returns `{app, admin: "loopback"|"token"|"off", demo}`; the page
  hides admin buttons instead of showing dead ones.
- **Why:** phone viewing is read-only, so requiring a token there is friction that
  invites tokens in URLs; but LAN scene install/update is a real need, so a
  file-mounted token (Docker secret, not on the command line) unlocks admin.
  Safe default: no token ⇒ no LAN admin, ever.
- Docker: `WMAD_ADMIN_TOKEN_FILE=/run/secrets/wmad_admin_token` (compose
  `secrets:`; `openssl rand -hex 24`). No credentials in `public/`; the page never
  stores the token (browser admin is loopback-only; token is for `curl`).

## 3. Relative URLs

Already mostly relative; enforce and test. `index.html` uses `EventSource('/events')`,
`fetch('/api/…')`, `import('/office3d.js')`, `/scenes/…`; `popout.js` uses
origin-relative `new URL('/', location.href)`. Keep all of it that way.
- `bin/cli.js`: printed/open URL uses `localhost:PORT`; with a non-loopback
  `--host` print `http://<host>:<port>` and a "use the LAN address on your phone"
  note. `alreadyRunning`/`stopAt` keep probing `127.0.0.1` (works for `0.0.0.0`).
- Test: grep `public/index.html|office.js|popout.js` for `localhost|127.0.0.1|http://` → fail.

## 4. Docker

Files: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `docs/run.md`.
- Base `node:22-alpine` (engines `>=18`; 22 keeps `node:sqlite` for OpenCode/Hermes).
  Multi-stage: `npm ci` + `npm run build` (esbuild: `web/office3d.js` →
  `public/office3d.js`), then runtime stage with `bin src public assets
  scenes.json package.json LICENSE` only.
- Non-root: `USER node` (uid 1000); no `privileged`, no docker socket, no host
  mounts of `$HOME`, logs or PIDs. `ENV WMAD_HOST=0.0.0.0 WMAD_PORT=4546
  WMAD_DEMO=1 WMAD_NO_UPDATE_CHECK=1 NODE_ENV=production`.
- `EXPOSE 4546`; `HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e
  "fetch('http://127.0.0.1:4546/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`
  (Host `127.0.0.1` is in the allow list).
- Compose: `ports: ["4546:4546"]` (4545 untouched), `restart: unless-stopped`,
  `read_only: true` + `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges`,
  `env_file: .env`, `secrets: [wmad_admin_token]`. Demo is the default: no real
  logs, no mounts; a commented `:ro` sessions mount is the only real-data opt-in.
- `docs/run.md`: start/stop/restart, logs, health, LAN address discovery, reverse
  proxy + HTTPS + auth-boundary example (TLS at the proxy, `--trust-proxy`,
  nothing public), "4545 is the original demo".
- `.env.example`: `WMAD_PORT=4546`, `WMAD_DEMO=1`, `WMAD_ALLOWED_HOSTS=*`, commented
  `WMAD_ADMIN_TOKEN_FILE` — no secrets. `.dockerignore`: `node_modules .git tests
  docs *.log packs .env`.

## 5. Room sizing / mobile

2D (`public/office.js`):
- `buildPlan(nWorking)`: when `innerWidth <= 640`, cap pods at 4 (2×2) so desks
  stay legible; extra working agents go off-duty into the existing `+N` counter.
- `fitCamera()`: replace the hard `Math.min(..., 2)` cap with `maxZoom` from a new
  `viewCaps()` helper; on portrait fit by width only (letterbox vertically)
  instead of shrinking the whole room. Keep `setInset`.
- `resize()`: keep `ResizeObserver`; the `resize` listener (`index.html:1321`)
  also calls `office.resize()` on orientation change.
3D (`web/office3d.js`): `fitCamera3D()` uses the same `viewCaps()`, steeper
elevation on portrait, fits by width, clamps `camera.zoom` to `[0.6, 2]`;
keep `OrbitControls` pinch and set `touch-action: none` on the canvas.

Page (`public/index.html`):
- `@media (max-width: 760px)`: side panel becomes a bottom sheet
  (`height: min(45dvh, 320px)`); `panelInset()` (line 1141) returns 0 on phones
  and the office gets `padding-bottom`, so the scene is never fully covered.
- Touch targets ≥44×44 px for `.controls`/`.side-tab` at ≤640 px;
  `overflow-x: hidden` on `html, body`; `100dvh` shell for mobile chrome.

## 6. Tests (exact commands)

New: `tests/lan.cjs` (node:test), `tests/responsive.cjs` (Playwright widths);
extend `tests/fixtures/server.cjs`.

```
npm run test:server            # existing guards + new host/origin cases
node --test tests/lan.cjs      # bind 0.0.0.0, allowed-hosts, admin gate, token, cross-origin
node --test tests/responsive.cjs  # 1280x800, 360x800, 390x844, orientation swap
npm run test:ui && npm run test:ui:clients
node --test tests/*.cjs        # full suite
docker build -t botroom:lan .
docker compose up -d && sleep 5
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q)
curl -fsS http://127.0.0.1:4546/api/ping
curl -fsS -N --max-time 3 http://127.0.0.1:4546/events | head -c 200
curl -fsS http://127.0.0.1:4546/ | head -5
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4546/api/shutdown   # expect 403
docker compose restart && sleep 5 && curl -fsS http://127.0.0.1:4546/api/ping
docker compose down
```

Screenshots (outside repo): Playwright bundled chromium headless-shell only —
`WMAD_SCREENSHOTS=<dir> node tests/responsive.cjs` → `desktop-1280x800.png`,
`phone-360x800.png`, `phone-390x844.png`. Do **not** retry system Chrome
`--screenshot` (CVDisplayLink hang).

Negative tests: non-loopback `X-Forwarded-For` + no token → 403 on all four admin
routes; wrong token → 403; valid token → 200; bad `Host` → 403; foreign `Origin`
→ 403; `GET /api/sessions` from LAN → 200.

## 7. Task order (one commit each, no push)

1. `src/config.js` + CLI flags/env + help; parsing tests.
2. Host guard + `isLoopback` + origin check + admin gate in `src/server.js`;
   `/api/ping` admin field; `tests/lan.cjs`.
3. Relative-URL grep test; hide admin controls when `admin=off`.
4. Sizing: `viewCaps()` (`office.js`), `fitCamera3D()`, portrait CSS;
   `tests/responsive.cjs`.
5. Docker files; build + run on OrbStack.
6. `docs/run.md` + README pointer; tester writes `docs/test-report.md`; keep
   LICENSE (MIT) and CC0 asset notices intact.
