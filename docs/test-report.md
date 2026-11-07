# Test report: LAN + Docker + mobile

Independent verification of `feat/lan-docker-mobile` (commit `5efa5ae`, equal to
`origin/feat/lan-docker-mobile` at test time) against the PM requirements and
`docs/lan-docker-mobile-spec.md`. Written by a tester who did not write the code;
no application code was modified.

- Environment: macOS host, OrbStack Docker, Node 22 image, container
  `botroom-lan` on host port **4546** (port 4545 and other containers untouched).
- Clean env for every command: `env -u WMAD_ALLOWED_HOSTS -u WMAD_DEMO -u WMAD_PORT`,
  `PLAYWRIGHT_BROWSERS_PATH=<playwright cache dir>`.
- "LAN IP" below means the host's LAN address (e.g. `192.168.x.y`); it is
  reached from the host's own network stack.
- **Host-side curl is not a phone test.** Requests to the LAN IP were sent from
  the host, so the container sees them as coming from the host's address. A real
  phone, another machine or a proxy may behave differently (firewall, Wi-Fi
  client isolation, NAT). The mobile section uses Playwright at phone viewports,
  which also is not a physical phone (no real touch, no mobile browser chrome).

## Verdict

**PASS with defects.** Every requirement R2–R5 and every user goal (LAN access,
Docker, room size/mobile) works in the tested configuration. Two low/medium
defects were found, both cosmetic/UX, none security-relevant:

| # | Severity | Summary |
|---|---|---|
| D1 | Medium (UX) | `?desks=N` does not lower the phone desk count (docs claim it can). |
| D2 | Low (UX) | The phone bottom sheet overlaps the lower ~18% of the drawn room; the CSS comment claims a padding that does not exist. |

## 1. Automated suites (exact counts)

| Command | Result | Count |
|---|---|---|
| `node --test tests/*.cjs` | PASS | 118 tests, 118 pass, 0 fail, 0 skipped (≈143 s) |
| `npm run test:ui` | PASS | 29 `PASS`, 0 `FAIL` (TOTAL 29) |
| `npm run test:ui:clients` | PASS | 18 `PASS`, 0 `FAIL` (TOTAL 18) |

`tests/*.cjs` includes the suites that matter here: `lan.cjs` (admin gate,
spoofed `X-Forwarded-For`/`Forwarded`/`Origin`, token file, host matching,
relative-URL grep), `responsive.cjs` (1280x800, 360x800, 390x844, `?desks=`,
orientation swap, 3D) and `server.cjs` (existing HTTP guards).

## 2. Container HTTP checks (port 4546)

Checked from both `http://127.0.0.1:4546` and `http://<LAN IP>:4546`:

| Path | Loopback | LAN IP |
|---|---|---|
| `GET /api/ping` | 200 `{"app":"whatsmyagentdoing","admin":"loopback","demo":true}` | 200, same body |
| `GET /events` | 200 `text/event-stream`, first bytes `data: {"now":…,"lang":null,"sessions":[…]` | 200, same |
| `GET /` | 200 `text/html`, 83,189 bytes | 200, identical size |
| `GET /office3d.js` | 200 `text/javascript`, 722,206 bytes | 200, identical size |
| `GET /office.js` | 200, 79,895 bytes | 200 |
| `GET /api/scenes`, `GET /api/sessions` | 200 | 200 |

Frontend relative URLs: grep of `public/` for `localhost|127.0.0.1|http://`
finds only the inline SVG favicon's `xmlns='http://www.w3.org/2000/svg'`
namespace (not a URL fetched), and zero hits in the built `public/office3d.js`.
The committed test "the page uses relative URLs only" also passes.

### Note: LAN IP requests are seen as loopback

`/api/ping` answers `admin:"loopback"` even when the request is addressed to the
LAN IP from the host. That is expected: the host is the client, so Docker NAT
presents the host's address to the container. It means **this setup cannot prove
the non-loopback admin gate on its own**; the negative tests below therefore
went through the same path *and* the committed `tests/lan.cjs` exercises the gate
from a genuine non-loopback peer. A phone on the LAN will be non-loopback.

## 3. Security negatives (from the LAN IP)

For each of `POST /api/update`, `POST /api/shutdown`, `POST /api/scenes/install`
the following variants were sent, each with the matching custom header
(`x-whatsmyagentdoing: update|stop|install`) where applicable:

- plain POST; `X-Forwarded-For: 127.0.0.1`; `Forwarded: for=127.0.0.1`;
  `X-Real-IP: 127.0.0.1`; `Host: localhost`; `Host: localhost:4546`;
  `Origin: http://localhost:4546`; `Origin: http://evil.example`;
  all spoofs combined plus a bogus `Authorization: Bearer x` /
  `X-WMAD-Token: x`; and `GET` on the same path.

Result: **27/27 responses 403** (`{"ok":false,"error":"admin disabled on LAN"}`
or a bare 403 from the Host/Origin guard); the `GET` variants are 404 (no such
route). No request succeeded and none had an effect: after the run the container
was still `running (healthy)` with `RestartCount=0` and `/api/ping` 200.

Other routes in `src/server.js` that are not read-only:

- `POST /api/version` → 200, but it only refreshes the cached "latest version"
  from the update check and returns info; it changes no files or state. The
  image has no `.git`, so `canUpdate:false` and `/api/update` could not pull
  even if reached.
- `POST /api/sessions`, `POST /events` → 200 read-only snapshots (methods are
  not restricted, but the handlers only read).
- `PUT /api/scenes/install`, `GET /api/scenes/install` → 404.
- No other mutating route exists (no hooks route in this server).

Credentials: no token value in the repo. `.env` and `secrets/` are gitignored
and untracked; `.env.example` has only commented placeholders; the image
contains no `.git`, `.env` or `tests`. The container env has no token set.

## 4. Docker (R3)

- `docker compose restart` → container restarted; health `starting` → `healthy`
  in ~6 s; `/api/ping` 200 on loopback and LAN IP afterwards.
- `docker inspect` (container `botroom-lan`): `User=node` (uid 1000 inside),
  `Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`,
  `SecurityOpt=[no-new-privileges:true]`, `PortBindings 4546→4546`,
  `Mounts=[]`, `Binds=null`, `Devices=null`, tmpfs only `/tmp` and
  `/home/node/.whatsmyagentdoing`. No HOME, log, PID or docker-socket mounts.
- Inside the container: listens on `0.0.0.0:4546`; `WMAD_HOST=0.0.0.0`,
  `WMAD_DEMO=1`, `WMAD_NO_UPDATE_CHECK=1`.
- `docker build`/`up` themselves were not re-run (the running image predates
  this session and the spec forbids disturbing other containers); the build
  inputs (`Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`)
  are committed and consistent with `docs/run.md`. **Not independently
  verified: a from-scratch rebuild.**
- Port 4545 still held by the original local demo process; untouched.

## 5. Mobile / room size (R4)

Measured in Playwright (bundled Chromium) against the running container at the
LAN IP, `?full=1&quality=mid` (2D) and `?full=1&quality=high` (3D):

| Viewport | Mode | Desks | Plan W×D (tiles) | H-overflow | Min touch target | Panel | Page errors |
|---|---|---|---|---|---|---|---|
| 1280×800 | 2D | 8 | 16.6×14.5 | 0 | 36 px (desktop, not required) | side panel 340 px | 0 |
| 1280×800 | 3D | 8 | 16.6×14.5 | 0 | – | – | 0 |
| 360×800 | 2D | 4 | 12.4×14.5 | 0 | 44 px | bottom sheet 320 px | 0 |
| 360×800 | 3D | 4 | 12.4×14.5 | 0 | – | – | 0 |
| 390×844 | 2D | 4 | 12.4×14.5 | 0 | 44 px | bottom sheet 320 px | 0 |
| 390×844 | 3D | 4 | 12.4×14.5 | 0 | – | – | 0 |
| 844×390 | 2D | 8 | 16.6×14.5 | 0 | 36 px | side panel | 0 |
| 844×390 | 3D | 8 | 16.6×14.5 | 0 | – | – | 0 |

- Room is real geometry: the phone plan is narrower (12.4 vs 16.6 tiles, one
  pod column) and rebuilt on the breakpoint, not CSS-scaled.
- Orientation swap on one live page (390×844 → 844×390 → 390×844): desk count
  goes 4 → 8 → 4, zoom re-fits, zero horizontal overflow at every step, and
  0 of 9–12 people end up outside the plan bounds.
- 3D canvas has `touch-action: none`; OrbitControls/pinch is available.
- `?desks=N` (desktop): `desks=2` → 4 desks (one pod), `desks=4` → 4,
  `desks=8` → 8, `desks=40` → 8 (capped by the demo session count),
  `desks=99`/`desks=abc` → ignored (back to the default 8). All had zero
  overflow and no errors.

### Still hardcoded (noted, as documented)

4-desk phone cap (`PHONE_MAX_DESKS`), 640 px phone breakpoint, 760 px
bottom-sheet breakpoint, room width/depth floors (`D ≥ 14.5`, right column 7.2,
meeting room 5.2), 4.2×4.7 pod pitch, 3D camera distance 40 / lift 0.58 (1.15
portrait) / zoom `[0.6, 2]`, 7 wanderers, and scene packs (fixed floor plan,
ignore `?desks=`). `docs/run.md` lists these honestly. One mismatch: the doc
says the phone zoom cap is `[0.6, 2]`, but `viewCaps()` reports `maxZoom: 3` on
phones — cosmetic doc drift only.

## 6. Defects

**D1 (Medium, UX): `?desks=N` cannot lower the phone desk count.**
`docs/run.md` says "`?desks=` can only lower it" (the phone cap), but the
opposite is true: only the number of *seated* agents is capped, the floor plan
stays 4 desks.
Repro: open `http://<LAN IP>:4546/?full=1&quality=mid&desks=2` at 390×844 →
`office.plan.desks.length == 4`, plan 12.4×14.5 (identical to no parameter),
`window.WMAD_DESKS == 2`, and 3 agents are off duty. Same in 3D
(`quality=high&desks=2` → 4 desks). Cause: `buildPlan()` uses
`Math.max(1, Math.ceil(seats / 4))` pods, so any cap of 1–4 yields one pod of 4
desks. `tests/responsive.cjs` only checks `?desks=` at 1280×800, so the suite
does not catch it. Fix: either honour a cap < 4 on phones (fewer desks per
pod) or correct the doc to "on phones `?desks=` only limits how many agents sit
down; the room stays one 4-desk pod".

**D2 (Low, UX): phone bottom sheet covers the lower part of the room.**
The CSS comment at the `@media (max-width: 760px)` block says the office keeps
a `padding-bottom` so the room stays visible above the sheet, but no such rule
exists (`#officeWrap` computed `padding-bottom: 0px`), and `panelInset()` is 0
on phones. Measured at 390×844 with the sheet open: drawn room spans y≈341–565,
sheet top at y=524, so ~41 px (~18%) of the room is hidden (desk rows at the
bottom). The sheet is capped at 320 px and the scene is not covered entirely,
so this does not fail R4, but it contradicts the comment and the doc's "the
office keeps a visible area above it" phrasing.
Repro: 390×844, open the agent panel → bottom row of desks sits under the sheet.

## 7. Requirement checklist

| Req | Result | Evidence |
|---|---|---|
| R2 LAN: configurable bind/port, relative URLs, Host guard, write routes gated, no bundled credentials | **PASS** | §2, §3; `tests/lan.cjs` |
| R3 Docker: committed files, non-root, no privileged/HOME/socket mounts, 0.0.0.0 inside, 4546, healthcheck, documented start/stop/restart | **PASS** (rebuild not re-run) | §4 |
| R4 Mobile: room adapts, portrait phones readable, touch targets, panel not covering all, no horizontal overflow, desktop not regressed, 2D+3D, orientation | **PASS** with D1/D2 | §5 |
| R5 Tests: responsive tests, LAN/cross-origin negatives, Docker health/SSE/static/restart | **PASS** | §1, §3, §4 |
| Goal: LAN access | **PASS** (host-side only; not a phone test) | §2 |
| Goal: Docker deployment | **PASS** | §4 |
| Goal: room size / mobile | **PASS** with D1/D2 | §5 |

Screenshots (kept outside the repo) cover desktop 1280×800, phones 360×800 and
390×844, landscape 844×390, each in 2D and 3D.
