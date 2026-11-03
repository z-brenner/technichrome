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
  // The info line follows the next render, which the software GPU can take a while over: poll, do not sleep.
  const infoSays = (text, wanted) => page.waitForFunction(([t, w]) => document.getElementById('info').textContent.includes(t) === w, [text, wanted], { timeout: 8000 }).then(() => true, () => false);
  // The preview must fit the stage whatever the header and footer take (a portrait photograph on a short screen).
  const fit = await page.evaluate(() => { const s = document.getElementById('stage').getBoundingClientRect(); const v = document.getElementById('view').getBoundingClientRect(); return { inside: v.top >= s.top - 0.5 && v.bottom <= s.bottom + 0.5 && v.left >= s.left - 0.5 && v.right <= s.right + 0.5, s: [s.top, s.bottom].map(Math.round), v: [v.top, v.bottom].map(Math.round) }; });
  check(fit.inside, `the preview lies inside the stage (stage ${fit.s.join('–')}, preview ${fit.v.join('–')})`);
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
    // The camera's own rendering: hold C. This file's embedded JPEG may be a small preview (then it says "scaled").
    await page.keyboard.down('c');
    check(await infoSays("the camera's own rendering", true), "holding C shows the camera's rendering of the second file");
    console.log(`camera's rendering (2): ${(await page.textContent('#info')).replace(/.*· (the camera.*)$/, '$1')}`);
    await page.screenshot({ path: out.replace(/\.png$/, '-2-camera.png'), fullPage: false });
    await page.keyboard.up('c');
    check(await infoSays("the camera's own rendering", false), 'releasing C returns to the print');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((n) => document.getElementById('counter').textContent.trim() === `1 / ${n}` && document.getElementById('busy').hidden, inputs.length, { timeout: 120000 });
    check((await page.textContent('#info')).includes('1 / '), 'going back shows the first again');
  }
  // The camera's own rendering of the first file, in the preview and then inside the loupe.
  const hasCamera = !(await page.isHidden('#cameraHoldButton'));
  if (hasCamera) {
    await page.keyboard.down('c');
    check(await infoSays("the camera's own rendering", true), "holding C shows the camera's rendering");
    console.log(`camera's rendering (1): ${(await page.textContent('#info')).replace(/.*· (the camera.*)$/, '$1')}`);
    await page.screenshot({ path: out.replace(/\.png$/, '-camera.png'), fullPage: false });
    await page.keyboard.up('c');
    check(await infoSays("the camera's own rendering", false), 'releasing C returns to the print');
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
  if (hasCamera) {
    await page.keyboard.down('c');
    check(await infoSays("the camera's own rendering", true), "holding C in the loupe shows the camera's rendering of the crop");
    await page.screenshot({ path: out.replace(/\.png$/, '-loupe-camera.png'), fullPage: false });
    await page.keyboard.up('c');
    check(await infoSays("the camera's own rendering", false), 'releasing C in the loupe returns to the print');
  }
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
    check(labBox.y + labBox.height >= vh - 1 && labBox.height <= vh * 0.65 && viewBox.y + viewBox.height <= labBox.y + 1, `the Laboratory sheet sits at the bottom (top ${labBox.y.toFixed(0)} of ${vh}) with the whole picture above it (bottom ${(viewBox.y + viewBox.height).toFixed(0)})`);
    // The same with a wide photograph, which the sheet used to cover almost entirely.
    await page.keyboard.press('Escape');
    await page.click('#nextButton');
    await page.waitForFunction(() => document.getElementById('busy').hidden && document.getElementById('counter').textContent.trim().startsWith('2 /'), null, { timeout: 120000 });
    await page.click('#labButton');
    await page.waitForTimeout(300);
    const wideView = await page.locator('#view').boundingBox();
    const sheet = await page.locator('#lab').boundingBox();
    check(wideView.y + wideView.height <= sheet.y + 1 && wideView.height > 60, `a wide photograph stays above the sheet (picture ${wideView.y.toFixed(0)}–${(wideView.y + wideView.height).toFixed(0)}, sheet from ${sheet.y.toFixed(0)})`);
    await page.screenshot({ path: out.replace(/\.png$/, '-lab-wide.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await page.click('#prevButton');
    await page.waitForFunction(() => document.getElementById('busy').hidden && document.getElementById('counter').textContent.trim().startsWith('1 /'), null, { timeout: 120000 });
    await page.click('#labButton');
    await page.screenshot({ path: out.replace(/\.png$/, '-lab.png'), fullPage: false });
  }
  await page.click('#pinButton');
  check(!(await page.isHidden('#showAButton')), 'the hold-for-A button appears once pinned');
  await page.locator('#labBody input[type=range]').first().fill('0.5');
  await page.keyboard.down('a');
  check(await infoSays('showing A', true), 'holding A shows the pinned look');
  await page.keyboard.up('a');
  check(await infoSays('showing A', false), 'releasing A returns to the current look');
  // A look as a link: Copy link puts it in the hash; a fresh page opened on that link gets the same sliders.
  await page.click('#linkButton');
  await page.waitForTimeout(200);
  const link = await page.evaluate(() => location.href);
  check(/#look=[A-Za-z0-9_-]+$/.test(link), `the address carries the look (${link.length} characters)`);
  const other = await page.context().newPage();
  await other.goto(link);
  await other.waitForFunction(() => document.getElementById('labBody').querySelector('input[type=range]') !== null, null, { timeout: 30000 });
  const linkedEV = await other.locator('#labBody input[type=range]').first().inputValue();
  check(linkedEV === '0.5', `the linked page restores the print exposure (got ${linkedEV})`);
  check((await other.textContent('#info')).includes('look from the link'), 'the linked page says where its look came from');
  await other.close();
  console.log(`look link: ${link.length} characters, restored print exposure ${linkedEV}`);
  // A look's name is shown as text, never as markup: a crafted name through Import JSON, pinned and held as A, and
  // through a link, must appear literally and run nothing.
  const os = require('node:os');
  const fs = require('node:fs');
  const crafted = path.join(os.tmpdir(), `technichrome-crafted-${process.pid}.json`);
  fs.writeFileSync(crafted, JSON.stringify({ name: '<img src=x onerror="window.__xss=1">', keyStrength: 0.3 }));
  await page.setInputFiles('#importInput', crafted);
  await page.waitForTimeout(300);
  // The readout: a histogram and clipping figures for what is on screen, once the Laboratory is open.
  await page.waitForFunction(() => /highlights clipped \S+% · shadows crushed \S+%/.test(document.getElementById('readoutText').textContent), null, { timeout: 8000 }).then(() => true, () => false).then((ok) => check(ok, `the readout shows clipping figures (got "${''}")`));
  console.log(`readout: ${await page.textContent('#readoutText')}`);
  check((await page.evaluate(() => { const c = document.getElementById('histogram'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++; return lit; })) > 200, 'the histogram canvas has been drawn');
  // Help: ? opens it, Escape closes it.
  await page.keyboard.press('?');
  check(!(await page.isHidden('#help')), '? opens the help');
  await page.keyboard.press('Escape');
  check(await page.isHidden('#help'), 'Escape closes the help');
  await page.click('#pinButton');
  await page.keyboard.down('a');
  check(await infoSays('showing A', true), 'the crafted look shows as A');
  const shownA = await page.textContent('#info');
  await page.keyboard.up('a');
  check(shownA.includes('<img src=x') && (await page.evaluate(() => window.__xss)) === undefined, `a crafted look name is shown as text when held as A (got "${shownA.slice(-60)}")`);
  await page.click('#linkButton');
  await page.waitForTimeout(200);
  const craftedLink = await page.evaluate(() => location.href);
  const victim = await page.context().newPage();
  await victim.goto(craftedLink);
  await victim.waitForFunction(() => document.getElementById('info').textContent.includes('look from the link'), null, { timeout: 30000 });
  await victim.waitForTimeout(300);
  const victimInfo = await victim.textContent('#info');
  check(victimInfo.includes('<img src=x') && (await victim.evaluate(() => window.__xss)) === undefined, `a crafted look name in a link is shown as text and runs nothing (got "${victimInfo.slice(-60)}")`);
  await victim.close();
  fs.unlinkSync(crafted);
  if (failures.length) console.log('failed checks:\n  ' + failures.join('\n  '));
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  await browser.close();
  server.close();
  process.exit(errors.length || failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
