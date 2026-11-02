// End-to-end smoke test: serve dist/, open a DNG through the page's file input, wait for the print, screenshot it.
// usage: node test/smoke.cjs <file.dng> <out.png>
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');

const root = path.join(__dirname, '..', 'dist');
const [,, input, out] = process.argv;
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
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', input);
  await page.waitForFunction(() => !document.getElementById('view').hidden && document.getElementById('busy').hidden, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const info = await page.textContent('#info');
  console.log(`opened in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${info}`);
  await page.screenshot({ path: out, fullPage: false });
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
