// End-to-end smoke test: serve dist/, open one or more files through the page's file input, wait for the print,
// step through the set with the arrow keys, open the 1:1 loupe, pin a look and hold A, screenshot along the way.
// Also saves the first print (checks the JPEG's size against the decode) and, with several files, the set as a zip.
// MOBILE=1 runs it as an iPhone (touch, 3× display): the loupe opens with a touch double-tap and the drag is skipped.
// usage: [MOBILE=1] node test/smoke.cjs <out.png> <file...>
const { chromium, devices } = require('playwright');
const mobile = process.env.MOBILE === '1';
const http = require('node:http');
const path = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { unzipSync } = require('fflate');

/** Width and height from a JPEG's SOF marker. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad JPEG marker');
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}
const downloaded = async (download) => { const chunks = []; for await (const c of await download.createReadStream()) chunks.push(c); return Buffer.concat(chunks); };

const root = path.join(__dirname, '..', 'dist');
const [,, out, ...inputs] = process.argv;
if (!out || !inputs.length) { console.error('usage: node test/smoke.cjs <out.png> <file...>'); process.exit(2); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  res.end(readFileSync(file));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (mobile ? browser.newContext({ ...devices['iPhone 15'] }) : browser.newContext({ viewport: { width: 1400, height: 1000 } })).then((c) => c.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  const shown = () => page.waitForFunction(() => !document.getElementById('view').hidden && document.getElementById('busy').hidden, null, { timeout: 120000 });
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', inputs);
  await shown();
  await page.waitForTimeout(300);
  console.log(`opened in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${await page.textContent('#info')}`);
  await page.screenshot({ path: out, fullPage: false });
  const failures = [];
  const check = (cond, what) => { if (!cond) failures.push(what); };
  if (inputs.length > 1) {
    check(!(await page.isHidden('#queueNav')), 'the set navigation is shown for several files');
    check((await page.textContent('#counter')).trim() === `1 / ${inputs.length}`, 'the counter starts at 1');
    // Racing a decode: forward to the uncached second file (its decode starts) and straight back to the cached
    // first one. The overlay must clear at once and the first photograph show again.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowLeft');
    try {
      await page.waitForFunction(() => document.getElementById('busy').hidden && document.getElementById('counter').textContent.trim().startsWith('1 /'), null, { timeout: 5000 });
    } catch { check(false, 'returning to a cached photograph during a decode clears the busy overlay'); }
    const t1 = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((n) => document.getElementById('counter').textContent.trim() === `2 / ${n}` && document.getElementById('busy').hidden, inputs.length, { timeout: 120000 });
    await page.waitForTimeout(300);
    console.log(`next in ${((Date.now() - t1) / 1000).toFixed(1)} s: ${await page.textContent('#info')}`);
    await page.screenshot({ path: out.replace(/\.png$/, '-2.png'), fullPage: false });
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((n) => document.getElementById('counter').textContent.trim() === `1 / ${n}` && document.getElementById('busy').hidden, inputs.length, { timeout: 120000 });
    check((await page.textContent('#info')).includes('1 / '), 'going back shows the first again');
  }
  // The loupe: a double-click (a touch double-tap on the phone) on the canvas shows a 1:1 crop; Escape leaves it.
  const box = await page.locator('#view').boundingBox();
  if (mobile) {
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
  } else {
    await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
  }
  await page.waitForTimeout(400);
  if (mobile) {
    const dpr = await page.evaluate(() => devicePixelRatio);
    const css = await page.evaluate(() => { const r = document.getElementById('view').getBoundingClientRect(); const v = document.getElementById('view'); return { w: r.width, h: r.height, pw: v.width, ph: v.height }; });
    check(Math.abs(css.pw - css.w * dpr) <= 1 && Math.abs(css.ph - css.h * dpr) <= 1, `the loupe is 1:1 in device pixels (canvas ${css.pw}×${css.ph}, shown ${css.w}×${css.h} at ${dpr}×)`);
    check(!(await page.textContent('#hint')).includes('←'), 'touch hints say nothing about keys');
  }
  const loupeBadge = await page.textContent('#badge');
  check(loupeBadge.includes('1:1'), `the badge says 1:1 in the loupe (got "${loupeBadge}")`);
  check((await page.textContent('#info')).includes('1:1 crop'), 'the info line names the crop');
  console.log(`loupe: ${await page.textContent('#info')}`);
  await page.screenshot({ path: out.replace(/\.png$/, '-loupe.png'), fullPage: false });
  // Dragging inside the loupe moves the crop (mouse only: the touchscreen API has no drag).
  const before = (await page.textContent('#info')).match(/1:1 crop at (\d+),(\d+)/);
  if (mobile) await page.screenshot({ path: out.replace(/\.png$/, '-loupe.png'), fullPage: false });
  if (!mobile) {
  const lb = await page.locator('#view').boundingBox();
  await page.mouse.move(lb.x + lb.width * 0.5, lb.y + lb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width * 0.5 - 120, lb.y + lb.height * 0.5 - 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = (await page.textContent('#info')).match(/1:1 crop at (\d+),(\d+)/);
  check(before && after && (Number(after[1]) - Number(before[1]) === 120) && (Number(after[2]) - Number(before[2]) === 60), `dragging 120,60 CSS px moves the crop by 120,60 at dpr 1 (got ${before && before[0]} → ${after && after[0]})`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.textContent('#badge')).includes('1:1'), 'Escape leaves the loupe');
  // Save JPEG: the download is a JPEG of the decode's full size.
  const size = (await page.textContent('#info')).match(/(\d+)×(\d+)/);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#saveButton')]);
  const jpeg = await downloaded(dl);
  const dims = jpegSize(jpeg);
  check(dl.suggestedFilename().startsWith('Technichrome-') && dl.suggestedFilename().endsWith('.jpg'), `the download is named Technichrome-….jpg (got ${dl.suggestedFilename()})`);
  check(dims.width === Number(size[1]) && dims.height === Number(size[2]), `the JPEG is ${size[1]}×${size[2]} (got ${dims.width}×${dims.height})`);
  console.log(`saved ${dl.suggestedFilename()}: ${dims.width}×${dims.height}, ${(jpeg.length / 1e6).toFixed(1)} MB; ${(await page.textContent('#info')).replace(/.*· /, '')}`);
  if (inputs.length > 1) {
    // Save all: one zip with a print per file and the look's JSON.
    const [zipDl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#saveAllButton')]);
    const zip = unzipSync(new Uint8Array(await downloaded(zipDl)));
    const names = Object.keys(zip).sort();
    const jpegs = names.filter((n) => n.endsWith('.jpg'));
    const jsons = names.filter((n) => n.endsWith('.json'));
    check(jpegs.length === inputs.length, `the zip holds ${inputs.length} prints (got ${jpegs.length}: ${names.join(', ')})`);
    check(jsons.length === 1 && JSON.parse(Buffer.from(zip[jsons[0]]).toString()).separationMatrix.length === 9, 'the zip holds the look as JSON');
    for (const n of jpegs) { try { jpegSize(Buffer.from(zip[n])); } catch (e) { check(false, `${n} is a JPEG`); } }
    console.log(`saved ${zipDl.suggestedFilename()}: ${names.join(', ')}`);
    await page.waitForTimeout(200);
    check(!(await page.isHidden('#view')), 'the page is back after the set');
  }
  // Pin the look as A, change a slider, hold A: the info line says so while held.
  await page.click('#labButton');
  if (mobile) {
    // The Laboratory is a sheet over the lower part of the screen: the picture stays visible above it.
    const labBox = await page.locator('#lab').boundingBox();
    const viewBox = await page.locator('#view').boundingBox();
    const vh = page.viewportSize().height;
    check(labBox.y + labBox.height >= vh - 1 && labBox.height <= vh * 0.65 && viewBox.y < labBox.y, `the Laboratory sheet sits at the bottom (top ${labBox.y.toFixed(0)} of ${vh}) with the picture above it (top ${viewBox.y.toFixed(0)})`);
    await page.screenshot({ path: out.replace(/\.png$/, '-lab.png'), fullPage: false });
  }
  await page.click('#pinButton');
  check(!(await page.isHidden('#showAButton')), 'the hold-for-A button appears once pinned');
  await page.locator('#labBody input[type=range]').first().fill('0.5');
  await page.keyboard.down('a');
  await page.waitForTimeout(200);
  check((await page.textContent('#info')).includes('showing A'), 'holding A shows the pinned look');
  await page.keyboard.up('a');
  await page.waitForTimeout(200);
  check(!(await page.textContent('#info')).includes('showing A'), 'releasing A returns to the current look');
  if (failures.length) console.log('failed checks:\n  ' + failures.join('\n  '));
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  await browser.close();
  server.close();
  process.exit(errors.length || failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
