// Responsive layout: the office stays readable on a desktop and on portrait
// phones, without horizontal overflow, with usable touch targets, and with
// the agent panel never covering the whole scene.
//
// Uses Playwright's bundled Chromium (headless shell is enough). Set
// WMAD_SCREENSHOTS=<dir> (outside the repo) to save desktop-1280x800.png,
// phone-360x800.png and phone-390x844.png.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
process.env.WMAD_NO_UPDATE_CHECK = '1';
const { DemoWatcher } = require('../src/demo');
const { createServer } = require('../src/server');

const SHOTS = process.env.WMAD_SCREENSHOTS;
const SIZES = [
  { name: 'desktop-1280x800', width: 1280, height: 800, phone: false },
  { name: 'phone-360x800', width: 360, height: 800, phone: true },
  { name: 'phone-390x844', width: 390, height: 844, phone: true },
];

// What the page looks like right now, measured in the browser.
function measure(page) {
  return page.evaluate(() => {
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const wrap = r(document.getElementById('officeWrap'));
    const side = r(document.getElementById('side'));
    const targets = [...document.querySelectorAll('body.full .controls > .btn, body.full .controls > .settings > summary, body.full .side-tab')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => { const b = r(el); return { w: Math.round(b.width), h: Math.round(b.height) }; });
    const cols = document.body.classList;
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      full: cols.contains('full'),
      sideOpen: !cols.contains('side-closed'),
      wrap: wrap && { x: wrap.x, y: wrap.y, w: wrap.width, h: wrap.height },
      side: side && { x: side.x, y: side.y, w: side.width, h: side.height },
      targets,
      caps: office.viewCaps(),
      desks: office.plan.desks.length,
      working: (office.people ? office.people.size : 0),
      offDuty: office.offDuty,
      zoom: office.cam && office.cam.zoom,
      kind: officeKind,
      frames: office.framesShown,
    };
  });
}

async function settle(page) {
  await page.waitForFunction(() => typeof office !== 'undefined' && office && office.framesShown > 4, null, { timeout: 20000 });
  await page.waitForTimeout(700);
}

test('responsive office: desktop and portrait phones', { timeout: 180000 }, async (t) => {
  const watcher = new DemoWatcher().start();
  const server = createServer(watcher, { demo: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    watcher.stop();
    server.closeAllConnections();
    server.close();
  });
  const errors = [];
  for (const size of SIZES) {
    await t.test(`${size.name} (2D)`, async () => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'en-US', deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${size.name}: ${e.message}`));
      await page.goto(base + '/?full=1&quality=mid');
      await settle(page);
      let m = await measure(page);
      assert.equal(m.overflowX, 0, 'no horizontal overflow');
      assert.ok(m.wrap.w > 0 && m.wrap.h > 0, 'office has a size');
      if (size.phone) {
        assert.equal(m.caps.phone, true);
        assert.equal(m.caps.portrait, true);
        assert.equal(m.desks, 4, 'phone pods capped at 2x2');
        assert.ok(m.offDuty > 0, 'extra working agents go off duty');
        assert.ok(m.zoom <= m.caps.maxZoom + 1e-6, 'zoom within the phone cap');
        // The panel must not cover the whole scene.
        await page.evaluate(() => setSide(true, false));
        await page.waitForTimeout(400);
        m = await measure(page);
        assert.ok(m.sideOpen);
        assert.ok(m.side.h <= 320 + 1, `bottom sheet height capped (${m.side.h})`);
        assert.ok(m.wrap.h - m.side.h > 200, `office visible above the sheet (${m.wrap.h - m.side.h}px)`);
        assert.ok(m.side.w >= size.width - 1, 'sheet spans the width');
        for (const tg of m.targets) assert.ok(tg.w >= 44 && tg.h >= 44, `touch target ${tg.w}x${tg.h}`);
        await page.evaluate(() => setSide(false, false));
        await page.waitForTimeout(400);
      } else {
        assert.equal(m.caps.phone, false);
        assert.ok(m.sideOpen, 'desktop keeps the side panel');
        assert.ok(m.side.w >= 300, 'desktop side panel keeps its width');
        assert.ok(m.zoom <= 2 + 1e-6);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${size.name}.png`) });
      await context.close();
    });
  }
  // Room size is real geometry, not CSS scaling: a phone gets a narrower floor
  // plan than a desktop, and ?desks=N caps the room on any screen.
  await t.test('room size adapts: phone plan is narrower, ?desks=N caps it', async () => {
    const plan = async (vp, query) => {
      const context = await browser.newContext({ viewport: vp, locale: 'en-US' });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`room ${query || 'default'}: ${e.message}`));
      await page.goto(base + '/?full=1&quality=mid' + (query || ''));
      await settle(page);
      const m = await page.evaluate(() => ({ desks: office.plan.desks.length, W: office.plan.W, D: office.plan.D, cap: window.WMAD_DESKS }));
      await context.close();
      return m;
    };
    const desktop = await plan({ width: 1280, height: 800 }, '');
    const phone = await plan({ width: 390, height: 844 }, '');
    assert.equal(phone.desks, 4);
    assert.ok(phone.W < desktop.W, `phone room is narrower (${phone.W} < ${desktop.W})`);
    // ?desks=N is read before the page drops the query string.
    const four = await plan({ width: 1280, height: 800 }, '&desks=4');
    assert.equal(four.cap, 4);
    assert.equal(four.desks, 4);
    assert.ok(four.W < desktop.W, `desks=4 room is narrower (${four.W} < ${desktop.W})`);
    const eight = await plan({ width: 1280, height: 800 }, '&desks=8');
    assert.equal(eight.desks, 8);
    assert.ok(eight.W >= four.W, 'a bigger cap is not smaller');
    // D1: on a phone, ?desks=N must lower the desk count too (1..PHONE_MAX_DESKS),
    // not just cap how many agents sit down.
    for (const n of [1, 2, 3]) {
      const m = await plan({ width: 390, height: 844 }, `&desks=${n}`);
      assert.equal(m.cap, n, `desks=${n} is read`);
      assert.equal(m.desks, n, `phone room has ${n} desks`);
    }
    const phone4 = await plan({ width: 390, height: 844 }, '&desks=4');
    assert.equal(phone4.desks, 4);
    // Above the phone cap, the phone cap wins.
    const phone8 = await plan({ width: 390, height: 844 }, '&desks=8');
    assert.equal(phone8.desks, 4, 'phone cap of 4 wins over desks=8');
  });
  // D2: the phone bottom sheet must not cover the drawn room; the camera fits
  // the room into the space above it.
  await t.test('phone bottom sheet does not cover the room', async () => {
    for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
      const context = await browser.newContext({ viewport: vp, locale: 'en-US' });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`sheet ${vp.width}: ${e.message}`));
      await page.goto(base + '/?full=1&quality=mid');
      await settle(page);
      await page.evaluate(() => setSide(true, false));
      await page.waitForTimeout(900);
      const m = await page.evaluate(() => {
        const cam = office.cam, { W, D } = office.plan;
        let roomBottom = -Infinity;
        for (const x of [0, W]) for (const y of [0, D]) for (const z of [0, 2.4]) {
          roomBottom = Math.max(roomBottom, office.iso(x, y, z).y * cam.zoom + cam.oy);
        }
        const sheet = document.getElementById('side').getBoundingClientRect();
        const wrap = document.getElementById('officeWrap').getBoundingClientRect();
        return { roomBottom: roomBottom + wrap.top, sheetTop: sheet.top, inset: office.bottomInset(), wrapH: wrap.height };
      });
      assert.ok(m.inset > 0, `sheet height is reserved (${m.inset})`);
      assert.ok(m.roomBottom <= m.sheetTop + 1, `room (bottom ${Math.round(m.roomBottom)}) stays above the sheet (top ${Math.round(m.sheetTop)})`);
      await context.close();
    }
  });
  // D2 in 3D: the camera frustum must put the whole room above the sheet too.
  // The room is measured by projecting its corners through the real camera.
  await t.test('3D phone bottom sheet does not cover the room', async () => {
    for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
      const context = await browser.newContext({ viewport: vp, locale: 'en-US' });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`3D sheet ${vp.width}: ${e.message}`));
      await page.goto(base + '/?full=1&quality=high');
      try {
        await page.waitForFunction(() => typeof office !== 'undefined' && office && office.gl && office.framesShown > 4, null, { timeout: 25000 });
      } catch {
        t.diagnostic(`${vp.width}x${vp.height}: WebGL unavailable, 3D sheet test skipped`);
        await context.close();
        continue;
      }
      await page.waitForTimeout(1000);
      await page.evaluate(() => setSide(true, false));
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => {
        const cam = office.camera, { W, D } = office.plan;
        const V = office.controls.target.constructor;
        let top = Infinity, bottom = -Infinity;
        for (const x of [0, W]) for (const y of [0, 2.4]) for (const z of [0, D]) {
          const v = new V(x, y, z).project(cam);
          const sy = (1 - v.y) / 2 * office.ch;
          top = Math.min(top, sy); bottom = Math.max(bottom, sy);
        }
        const wrap = document.getElementById('officeWrap').getBoundingClientRect();
        const sheet = document.getElementById('side').getBoundingClientRect();
        return { roomTop: top + wrap.top, roomBottom: bottom + wrap.top, sheetTop: sheet.top, inset: office.bottomInset(), ch: office.ch };
      });
      assert.ok(m.inset > 0, `sheet height is reserved (${m.inset})`);
      assert.ok(m.roomBottom <= m.sheetTop + 1,
        `3D room (bottom ${Math.round(m.roomBottom)}) stays above the sheet (top ${Math.round(m.sheetTop)})`);
      assert.ok(m.roomTop >= -1, `3D room (top ${Math.round(m.roomTop)}) is not above the canvas`);
      await context.close();
    }
  });
  // 2D phone labels must render at >= 11px on screen, whatever the room zoom is.
  await t.test('2D phone labels are at least 11px on screen', async () => {
    for (const vp of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: vp, locale: 'en-US' });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`labels ${vp.width}: ${e.message}`));
      await page.goto(base + '/?full=1&quality=mid');
      await settle(page);
      // Record the font sizes bubble() actually sets, then undo the wrapper.
      const m = await page.evaluate(() => new Promise((resolve) => {
        const proto = Object.getPrototypeOf(office);
        const orig = proto.bubble;
        const fonts = [];
        proto.bubble = function (...a) {
          // The label pill sets ctx.font right before it draws; read it there.
          const ctx = this.ctx;
          const fill = ctx.fillText;
          ctx.fillText = function (t, ...rest) { fonts.push(ctx.font); return fill.call(this, t, ...rest); };
          try { return orig.apply(this, a); } finally { ctx.fillText = fill; }
        };
        requestAnimationFrame(() => requestAnimationFrame(() => {
          proto.bubble = orig;
          const zoom = office.cam.zoom;
          // The agent pill is the largest text bubble() draws (the small 9-10px
          // ones are status glyphs and the room's own signs).
          const px = fonts.map((f) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(f)?.[1] || 0)).filter((n) => n > 0);
          const labelFont = Math.max(...px);
          resolve({ zoom, labelFont, onScreen: labelFont * zoom });
        }));
      }));
      assert.ok(m.labelFont > 0, 'labels were drawn');
      assert.ok(m.onScreen >= 11 - 0.05, `label on screen ${m.onScreen.toFixed(2)}px >= 11px (font ${m.labelFont.toFixed(2)}px, zoom ${m.zoom.toFixed(3)})`);
      await context.close();
    }
  });
  // Orientation swap on the same page: the room re-fits and nothing overflows.
  await t.test('orientation swap keeps the office in bounds', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`swap: ${e.message}`));
    await page.goto(base + '/?full=1&quality=mid');
    await settle(page);
    const before = await measure(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(700);
    const after = await measure(page);
    assert.equal(after.overflowX, 0);
    assert.notEqual(Math.round(after.wrap.w), Math.round(before.wrap.w), 'office re-measured');
    assert.ok(after.wrap.h > 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(700);
    const back = await measure(page);
    assert.equal(back.overflowX, 0);
    assert.equal(back.desks, 4);
    await context.close();
  });
  // 3D office (three.js) at the same sizes, when WebGL is available.
  await t.test('3D office on desktop and phones', async () => {
    for (const size of SIZES) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'en-US' });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${size.name} 3D: ${e.message}`));
      await page.goto(base + '/?full=1&quality=high');
      try {
        await page.waitForFunction(() => typeof office !== 'undefined' && office && office.gl && office.framesShown > 4, null, { timeout: 25000 });
      } catch {
        t.diagnostic(`${size.name}: WebGL unavailable, 3D skipped`);
        await context.close();
        continue;
      }
      await page.waitForTimeout(1200);
      const m = await measure(page);
      assert.equal(m.overflowX, 0);
      assert.equal(m.kind, 'high:office');
      const zoom = await page.evaluate(() => office.camera.zoom);
      assert.ok(zoom >= 0.6 && zoom <= 2, `camera zoom clamped (${zoom})`);
      const touch = await page.evaluate(() => getComputedStyle(office.canvas).touchAction);
      assert.equal(touch, 'none', 'pinch goes to OrbitControls');
      if (size.phone) assert.equal(m.desks, 4);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${size.name}-3d.png`) });
      await context.close();
    }
  });
  assert.deepEqual(errors, [], 'no page errors');
});
