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

---

# Re-test after fe5afdb

Second independent pass over the fixes in `fe5afdb` ("Fix tester defects D1 and
D2, keep phone labels readable"), by the same tester. No application code was
changed; the only file this pass writes is this report.

- Commit under test: `fe5afdb108c8201c7619344f7e61549932e98ed5`, branch
  `feat/lan-docker-mobile`, `git rev-parse HEAD` equal to
  `origin/feat/lan-docker-mobile`, working tree clean before the run.
- The running container serves **this** commit: `GET /` and `GET /office3d.js`
  from port 4546 are byte-identical to the worktree's `public/index.html` and
  `public/office3d.js` (`cmp` clean), and the served page contains the new
  `sheetInset`/`bottomInset` code. So the measurements below exercise the fixes,
  not a stale image.
- Environment: macOS host, OrbStack Docker, container `botroom-lan` on host port
  **4546**; port 4545 (local demo, PID unchanged) and the other 12 containers
  untouched. Node 24.16.0, Playwright Chromium (headless).
- Every command ran under `env -u WMAD_ALLOWED_HOSTS -u WMAD_DEMO -u WMAD_PORT`.
- "LAN IP" is the host's own LAN address, reached from the host. As in §2, that
  path reaches the container as loopback; it is not a physical-phone test.

## Verdict (re-test)

**FAIL.** D1 is fully fixed, the 3D-label clipping fix holds, and all regression
suites and container/security checks pass. **D2 is fixed in 2D but still fails in
3D**, and the 2D phone label size requirement is **not met**. Both were claimed
fixed in `fe5afdb`.

| Item | Result |
|---|---|
| D1 `?desks=N` lowers the phone desk count (2D and 3D) | **PASS** |
| D2 phone bottom sheet does not cover the drawn room, 2D | **PASS** |
| D2 phone bottom sheet does not cover the drawn room, 3D | **FAIL** (still covers ~377–382 px) |
| 3D phone labels not clipped at the left edge | **PASS** |
| 2D phone labels ≥ ~11 px on screen | **FAIL** (≈8.9 px at 360×800, ≈9.6 px at 390×844) |
| `node --test tests/*.cjs` | **PASS** (119/119) |
| `npm run test:ui` | **PASS** (29/29) |
| `npm run test:ui:clients` | **PASS** (18/18) |
| Container healthy, 200 on 4 paths × 2 addresses | **PASS** (8/8) |
| Admin routes 403 with spoofed headers | **PASS** (27/27 403, 3/3 GET 404) |
| `docker inspect`: non-root, not privileged, no mounts | **PASS** |
| No horizontal overflow, 4 viewports × 2 modes | **PASS** (8/8) |

Counts: **10 PASS, 2 FAIL** of the 12 functional items; 3/3 suites, 8/8 HTTP
paths, 27/27 admin negatives, 8/8 overflow checks.

## R1. D1 — `?desks=N` on a phone (390×844) — PASS

Measured on the live container with the office's own `plan.desks.length`:

| `?desks=` | 2D desks | 3D desks | `WMAD_DESKS` | Room W×D (tiles) |
|---|---|---|---|---|
| (none) | 4 | 4 | – | 12.4×14.5 |
| 1 | **1** | **1** | 1 | 12.4×14.5 |
| 2 | **2** | **2** | 2 | 12.4×14.5 |
| 3 | **3** | **3** | 3 | 12.4×14.5 |
| 4 | 4 | 4 | 4 | 12.4×14.5 |
| 8 | 4 (phone cap) | 4 (phone cap) | 8 | 12.4×14.5 |
| 0 | 4 (ignored) | 4 (ignored) | – | 12.4×14.5 |
| 99 | 4 (ignored) | 4 (ignored) | – | 12.4×14.5 |

16/16 combinations correct, zero page errors, zero horizontal overflow. The
original repro (`?desks=2` → 4 desks) now gives 2 desks in both renderers. The
floor plan's outer W×D is unchanged (the room shell keeps its floors); the pod
holds fewer desks, which is what D1 asked for. `tests/responsive.cjs` now
covers 1, 2, 3, 4 and 8 at phone width.

## R2. D2 — phone bottom sheet vs drawn room — FAIL (3D)

Method: room bounds are the projection of the floor/wall corners `(0..W, 0..WALL_H,
0..D)` through the office's own camera (2D: `iso()` + `cam`; 3D:
`camera.matrixWorldInverse` + `projectionMatrix`), converted to viewport pixels.
The sheet's rect is `#side`. Sampled for ~3 s after opening and judged on the
settled state (the first samples are still inside the 340 ms ease).

| Viewport | Mode | Sheet top | Room bottom (sheet open) | Covered by sheet | Result |
|---|---|---|---|---|---|
| 360×800 | 2D | 480 | 375 | **0 px** | PASS |
| 360×800 | 3D | 480 | 861.7 | **381.7 px** | FAIL |
| 390×844 | 2D | 524 | 405.7 | **0 px** | PASS |
| 390×844 | 3D | 524 | 901.0 | **377.0 px** | FAIL |

- **2D is fixed.** `sheetInset()` returns 320 and the room is centred in the
  space above the sheet (390×844: room y 183.7–405.7, sheet top 524; the lowest
  desk is at y≈265). The sheet no longer hides any desk.
- **3D still fails.** `fitCamera3D()` does compute `vh = ch - bottomInset` and
  widens the frustum, but the room is not inside that frustum. At 390×844 with
  the sheet open: `bottomInset=320`, `vh=463`, frustum `top=28.88`,
  `bottom=-11.60`; the far floor corner `(W,0,D)` projects to ndcY **-1.146**
  (below the frustum's -1) and the room spans screen y 452–901 while the sheet
  starts at 524. A screenshot at 390×844 3D with the panel open shows only a
  sliver of the room above the sheet; the rest is behind it. The new committed
  test ("phone bottom sheet does not cover the room") only exercises the 2D
  office, so the suite does not catch this.
- Repro: `http://<LAN IP>:4546/?full=1&quality=high` at 390×844, open the agent
  panel → the room sits mostly under the sheet.

## R3. 3D phone labels at the left edge — PASS

Instrumented the office's `roundRect` to capture the pill boxes actually drawn
(10 frames per viewport, labels move as agents walk):

| Viewport | Pills sampled | Clipped (x<0 or x+w>canvas) | x range | Pill height |
|---|---|---|---|---|
| 360×800 | 2 384 | **0** | 10.3–351.8 (canvas 0–360) | 16–24.2 px |
| 390×844 | 2 286 | **0** | 4.0–305.5 (canvas 0–390) | 16–24.2 px |

No pill leaves the canvas and none is cut at the left edge.

## R4. 2D phone label size — FAIL

The label size formula is `labelScale = min(2.2, max(1, 11 / (10 * zoom)))`, so
the on-screen size is `10 * labelScale * zoom`. On a phone the 2D fit is
width-bound (`byWidth` 0.404 / 0.438 vs `byHeight` 1.303 / 1.38), the zoom is
below 0.5, and the 2.2 cap binds:

| Viewport | 2D zoom | labelScale | Font drawn | On-screen size | Required | Result |
|---|---|---|---|---|---|---|
| 360×800 | 0.404 | 2.2 (capped) | 22 px | **8.9 px** | ≥ ~11 px | FAIL |
| 390×844 | 0.438 | 2.2 (capped) | 22 px | **9.6 px** | ≥ ~11 px | FAIL |

Confirmed by spying on the real `ctx.font` used by the label pills
(`600 22px …`) and by the drawn pill heights (35.2 px = 16×2.2). The 2.2 cap
prevents reaching 11 px at these zooms; reaching it would need
`11 / (10 × 0.404) = 2.72` at 360×800. `docs/run.md` states "at least ~11 px on
screen", so the doc and the code disagree.

## R5. Regression suites — PASS

| Command | Result | Count |
|---|---|---|
| `node --test tests/*.cjs` | PASS | 119 tests, 119 pass, 0 fail, 0 skipped |
| `npm run test:ui` | PASS | 29 `PASS`, 0 `FAIL` (TOTAL 29) |
| `npm run test:ui:clients` | PASS | 18 `PASS`, 0 `FAIL` (TOTAL 18) |

`tests/*.cjs` is one more than the first report's 118 — the new phone-`?desks=`
and bottom-sheet tests. The LAN gate tests (`X-Forwarded-For` ignored without
`--trust-proxy`, spoofed XFF/Forwarded/Origin from a LAN peer 403 with
trust-proxy on and off) and the responsive tests all pass.

## R6. Container HTTP (port 4546) — PASS

| Path | 127.0.0.1:4546 | 192.168.1.139:4546 |
|---|---|---|
| `GET /api/ping` | 200 `{"app":"whatsmyagentdoing","admin":"loopback","demo":true}` | 200, same body |
| `GET /` | 200 `text/html`, 84 365 bytes, `cache-control: no-store` | 200, identical size |
| `GET /events` | 200 `text/event-stream`, first bytes `data: {"now":…,"lang":null,"sessions":[…]` | 200, same |
| `GET /office3d.js` | 200 `text/javascript`, 722 273 bytes | 200, identical size |

8/8 = 200. (`/events` is an open stream, so curl reports a read timeout after
receiving the first frames; the status line is 200.) As in §2, the LAN-IP
request is seen as loopback by the container.

## R7. Admin routes with spoofed headers — PASS

From `http://192.168.1.139:4546`, for `POST /api/update`, `POST /api/shutdown`
and `POST /api/scenes/install` (each with its `x-whatsmyagentdoing` header),
9 variants each: plain; `X-Forwarded-For: 127.0.0.1`; `Forwarded: for=127.0.0.1`;
`X-Real-IP: 127.0.0.1`; `Host: localhost`; `Host: localhost:4546`;
`Origin: http://localhost:4546`; `Origin: http://evil.example`; all spoofs
combined plus a bogus `Authorization`/`X-WMAD-Token`. Plus `GET` on each path.

- **27/27 POSTs → 403** `{"ok":false,"error":"admin disabled on LAN"}`.
- **3/3 GETs → 404** (no such route).
- Afterwards the container was still `running (healthy)`, `RestartCount=0`,
  `/api/ping` 200 — nothing took effect.

## R8. Docker security posture — PASS

`docker inspect botroom-lan` after the whole run: `User=node`,
`Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`,
`SecurityOpt=[no-new-privileges:true]`, **`Mounts=0`**, `Binds=[]`,
`Devices=[]`, tmpfs only `/tmp` and `/home/node/.whatsmyagentdoing`,
`PortBindings 4546→4546`, health `healthy`, `RestartCount=0`. No HOME, log, PID
or docker-socket mounts. Port 4545 still held by the same local demo process.

## R9. Horizontal overflow — PASS

`documentElement.scrollWidth − clientWidth` with the panel closed and open, 2D
and 3D: **0 at all 8 combinations** (1280×800, 360×800, 390×844, 844×390 × 2D/3D),
and the document is never horizontally scrollable. Elements reported past the
viewport edge are the off-canvas slide-in panels (closed side panel at x≥width,
closed settings/today drawers at x<0) and a few `.srow` rows a few px past the
panel edge inside the panel's `overflow:hidden`; none of them makes the page
scroll sideways.

## Still open

1. **D2 in 3D** — the phone bottom sheet still covers the room in the 3D office
   (R2). The 2D path is fixed.
2. **2D phone label size** — ≈9 px instead of the documented ~11 px (R4); the
   `labelScale` cap of 2.2 is too low for the phone zoom of 0.40–0.44.
3. Carried over from the first report: a from-scratch `docker build` was not
   re-run, and all LAN checks are host-side, not from a physical phone.

# Final re-test after 4e35c13

Independent re-test of `feat/lan-docker-mobile` at commit **`4e35c13`**
("Fit the 3D room above the phone sheet, raise phone label size to 11px"), run by
a tester who did not write the code. No application code was changed. This
section re-checks the two open defects from the previous report (D2 in 3D, 2D
phone label size) **against the live container**, not only against the test
assertions, and re-runs the full regression set.

- **Repo state:** local `HEAD` = `origin/feat/lan-docker-mobile` =
  `4e35c13945ac5a24b9409a60b7ca68d8aa74aa33`; working tree clean before and
  after the run.
- **Live target:** container `botroom-lan` (`botroom:lan`, healthy, up),
  host port **4546**. Port 4545 and every other container were left untouched.
- **Byte identity:** `sha256sum` of `public/office.js`, `public/office3d.js`
  and `public/index.html` inside the container (`/app/...`) equals the local
  files: `e43fb225…b65`, `58c8d502…82a`, `008c31d6…66b` — **IDENTICAL**.
- **Measurement method:** system Chrome 156 via Playwright
  (`channel: 'chrome'`, viewport + `deviceScaleFactor: 1`), loading
  `http://127.0.0.1:4546`. The 3D room box is the **projection of every
  vertex of the live `office.room` group** through the real camera (not the
  test's 8-corner box); labels are read from the real `roundRect`/`fillText`
  calls of the live `bubble()`.
- **Environment caveat (not a product defect):** Playwright's bundled Chromium
  is not installed on this host (`~/Library/Caches/ms-playwright` does not
  exist), so the default `npm run test:ui*` fail at `chromium.launch`. The
  suites were run with their documented switch `WMAD_UI_CHANNEL=chrome`
  (system Chrome). `tests/responsive.cjs` has no such switch; it was run
  unchanged with `chromium.launch` redirected to `channel: 'chrome'` by a
  wrapper outside the repo. `npm run test:ui:clients` is `require('./ui.cjs')`
  with `WMAD_UI_CLIENTS_ONLY=1`, so as a bare file in `node --test tests/*.cjs`
  it re-runs the full UI suite.

## F1. 3D phone, bottom sheet open — PASS

Sheet opened both programmatically (`setSide(true, false)`) and by a real tap
on the "Agents" tab; identical results.

| Viewport | Sheet top | Room bbox top | Room bbox bottom | Covered | **Room width fraction** | Result |
|---|---|---|---|---|---|---|
| 360×800 | 480.0 | 93.1 | 445.1 | **0 px** (34.9 px gap) | **0.547** (81.6–278.4 of 360) | PASS |
| 390×844 | 524.0 | 96.4 | 485.4 | **0 px** (38.6 px gap) | **0.570** (83.8–306.2 of 390) | PASS |

- Sheet closed for comparison: room spans 90.1 % of the canvas width at both
  sizes (bottom 718.1 / 757.2, i.e. under where the sheet will be). Opening the
  sheet re-fits the camera (`bottomInset` 0 → 320) and the room shrinks to
  ~55–57 % width — smaller but still the dominant object in the strip above the
  sheet (height fraction 0.48–0.50 of the canvas; the room is centred in the
  320 px strip with ~35–39 px of air below it).
- Desktop 1280×800 with the side panel open: room x 47.1–892.9, panel starts at
  x 940 — no overlap (the panel is a side panel there, not a bottom sheet).
- Screenshot `final-390x844-3d-sheet-open.png` shows the room fully above the
  "Agents" sheet.

## F2. 2D phone label size — PASS (size) / overlap noted

The font actually used for the name pill was read from the live `ctx.font` at
the pill's `fillText`, per person, over 8 s (≈480 frames).

| Viewport | 2D zoom | Pill font | **On-screen size** | Frames with a sub-11 px pill | Result |
|---|---|---|---|---|---|
| 360×800 | 0.4041 | 27.22 px | **11.00 px** | 0 / 481 | PASS |
| 390×844 | 0.4378 | 25.13 px | **11.00 px** | 0 / 480 | PASS |

Every person (work, wander, leave) draws its name pill at 11.00 px on screen;
desktop keeps the 2.2× cap. This matches the documented "at least 11 px".

**Label overlap (reported, not a regression):** with the room zoomed out and
labels enlarged, pills overlap heavily on phones — 6–23 overlapping pairs per
frame at both sizes, including the large work labels (e.g. at 360×800
`design-system`/`cost-report` 245×43 px, `workspace-cli-tools`/`billing`
178×53 px; at 390×844 `design-system`/`cost-report` 226×39 px). Overlap is
slightly lower with fewer desks (`?desks=2`: 8 pairs at 360×800). The room is
still readable between the pills, and this is the direct cost of the 11 px
requirement at zoom ≈ 0.40; it is worth a follow-up (e.g. collision-aware
label placement), not a blocker.

## F3. 3D labels not clipped — PASS

Every 3D name pill drawn by the live overlay, 20 frames per state, checked
against the canvas (0–cw × 0–ch):

| Viewport | Pills/frame | Clipped, sheet closed | Clipped, sheet open |
|---|---|---|---|
| 1280×800 | 12 | 0 | 0 |
| 360×800 | 12 | 0 | 0 |
| 390×844 | 9 | 0 | 0 |

No pill leaves the canvas or is cut at the left/right edge or the top. 3D
labels also stay above the sheet when it is open (0 of 11 pills below the
sheet top at both sizes). In 2D with the sheet open, 2–3 pills per frame sit
partly under the canvas top edge (clipped at y≈0, e.g. `ml-eval@6` at
390×844): the sheet shrinks the strip and the camera re-centres, so agents
walking at the room's far edge lose the top of their pill. This is the 2D
counterpart of the 3D case and is cosmetic (the agent is still visible).

## F4. Regression — D1 `?desks=` at 390×844 — PASS

Live container, phone viewport, 2D and 3D:

| `?desks=` | 2D desks | 3D desks | Notes |
|---|---|---|---|
| 1 | 1 | 1 | |
| 2 | 2 | 2 | |
| 3 | 3 | 3 | |
| 4 | 4 | 4 | |
| 8 | 4 | 4 | phone cap of 4 wins |
| 0 | 4 | 4 | invalid → default |
| 99 | 4 | 4 | clamped to phone cap |

No page errors, no horizontal overflow in any of the 14 page loads.

## F5. Regression suites — PASS

All commands run with `env -u WMAD_*` (clean environment).

| Command | Result | Count |
|---|---|---|
| `node --test` on the 12 non-browser files of `tests/*.cjs` | PASS | 109 tests, 109 pass, 0 fail, 0 skipped |
| `tests/responsive.cjs` (via system-Chrome wrapper) | PASS | 10 tests, 10 pass (incl. the new 3D sheet and 11 px label tests) |
| `npm run test:ui` (`WMAD_UI_CHANNEL=chrome`) | PASS | 29 PASS, 0 FAIL |
| `npm run test:ui:clients` (`WMAD_UI_CHANNEL=chrome`) | PASS | 18 PASS, 0 FAIL |

The 109 + 10 + 29 = 148 is the `tests/*.cjs` total; `ui.cjs` and
`ui-clients.cjs` are the same 29 checks counted once. Without the Chrome
switch, `ui.cjs`, `ui-clients.cjs` and `responsive.cjs` cannot start on this
host (missing bundled Chromium, see the caveat above).

## F6. Container HTTP (port 4546) — PASS

Mac-host `curl` (not a phone):

| Path | 127.0.0.1:4546 | 192.168.1.139:4546 |
|---|---|---|
| `GET /api/ping` | 200 `application/json` | 200 |
| `GET /` | 200 `text/html`, 84 365 B | 200, same size |
| `GET /events` | 200 `text/event-stream`, `data: {"now":…,"sessions":[…]` | 200, same |
| `GET /office3d.js` | 200 `text/javascript`, 722 782 B | 200, same size |

8/8 = 200. The LAN-IP request is sent from the host's own network stack, so the
container sees it as loopback; this is **not** a physical-phone test.

## F7. Admin routes with spoofed headers — PASS

From `192.168.1.139:4546`: `POST /api/update`, `POST /api/shutdown`,
`POST /api/scenes/install` (each with its `x-whatsmyagentdoing` header) × 10
variants (plain, `X-Forwarded-For: 127.0.0.1`, `Forwarded: for=127.0.0.1`,
`X-Real-IP: 127.0.0.1`, `Host: localhost`, `Host: localhost:4546`,
`Origin: http://localhost:4546`, `Origin: http://evil.example`, all spoofs
combined plus bogus `Authorization`/`X-WMAD-Token`) plus `GET` on each path.

- **30/30 POSTs → 403** `{"ok":false,"error":"admin disabled on LAN"}`.
- **3/3 GETs → 404.**
- Afterwards: container `running (healthy)`, `RestartCount=0`, `/api/ping` 200.

## F8. Docker security posture — PASS

`docker inspect botroom-lan` after the whole run: `User=node` (process runs as
uid 1000), `Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`,
`CapAdd=[]`, `SecurityOpt=[no-new-privileges:true]`, **`Mounts=0`**,
`Binds=0`, `VolumesFrom=[]`, `Devices=0`, tmpfs only `/tmp` and
`/home/node/.whatsmyagentdoing`, `PortBindings 4546→4546`, `RestartCount=0`.
No HOME, log, PID or docker-socket mounts. Port 4545 untouched.

## F9. Horizontal overflow — PASS

`documentElement.scrollWidth − innerWidth`, sheet closed and open, 2D and 3D:
**0 at all 8 combinations** (1280×800, 360×800, 390×844, 844×390).

## F10. Screenshots of the live container — PASS

Saved under `.screenshots-tmp/` (git-ignored): `final-390x844-2d.png`,
`final-390x844-3d.png`, `final-390x844-3d-sheet-open.png`,
`final-360x800-2d.png`, `final-1280x800-2d.png` (plus
`final-{360x800,1280x800}-3d-sheet-open.png`). All are real captures of
`http://127.0.0.1:4546`, at the exact viewport sizes.

## Summary

| Item | Result |
|---|---|
| F1 · 3D phone, sheet open (bbox bottom ≤ sheet top, width fraction) | **PASS** (0 px covered; 0.547 / 0.570 width) |
| F2 · 2D phone label ≥ 11 px | **PASS** (11.00 px at both sizes); overlap noted |
| F3 · 3D labels not clipped | **PASS** (0 clipped, closed and open) |
| F4 · `?desks=` 1,2,3,4,8,0,99 at 390×844 | **PASS** |
| F5 · test suites | **PASS** (109 + 10 + 29 + 18) |
| F6 · HTTP 200 × 2 hosts | **PASS** (8/8) |
| F7 · admin 403 with spoofs | **PASS** (30/30) |
| F8 · container non-root, not privileged, no mounts | **PASS** |
| F9 · no horizontal overflow | **PASS** (8/8) |
| F10 · live screenshots | **PASS** |

**Overall: PASS.** Both open defects from the previous report are fixed and
verified against the live container. Remaining non-blocking observations:
2D phone labels overlap each other (cost of the 11 px minimum at zoom ≈ 0.40),
2D pills at the room's far edge are clipped by the canvas top when the sheet is
open, and all LAN checks are host-side (not from a physical phone).
