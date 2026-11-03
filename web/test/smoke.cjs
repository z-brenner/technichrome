// End-to-end smoke test: serve dist/, open one or more files through the page's file input, wait for the print,
// step through the set with the arrow keys, open the 1:1 loupe, pin a look and hold A, screenshot along the way.
// usage: node test/smoke.cjs <out.png> <file...>
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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
  // The loupe: a double-click on the canvas shows a 1:1 crop; Escape leaves it.
  const box = await page.locator('#view').boundingBox();
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(400);
  const loupeBadge = await page.textContent('#badge');
  check(loupeBadge.includes('1:1'), `the badge says 1:1 in the loupe (got "${loupeBadge}")`);
  check((await page.textContent('#info')).includes('1:1 crop'), 'the info line names the crop');
  console.log(`loupe: ${await page.textContent('#info')}`);
  await page.screenshot({ path: out.replace(/\.png$/, '-loupe.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.textContent('#badge')).includes('1:1'), 'Escape leaves the loupe');
  // Pin the look as A, change a slider, hold A: the info line says so while held.
  await page.click('#labButton');
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
