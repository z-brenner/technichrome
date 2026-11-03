// GPU parity: the WebGL pipeline of the built site must agree with the Python fixture (and therefore the
// Swift core and the Metal kernels) on the 32 fixture colours, within the same tolerance the app's simulator
// tests use. Serves dist/ with the isolation headers, opens it in headless Chromium, calls the parity hook.
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');

const root = path.join(__dirname, '..', 'dist');
const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'Tests', 'TechnichromeCoreTests', 'Fixtures', 'parity.json'), 'utf8'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };

if (!existsSync(path.join(root, 'index.html'))) { console.error('dist/ is missing: run `npm run build` first'); process.exit(2); }

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const data = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  res.end(data);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // PLAYWRIGHT_CHROMIUM_PATH points at a pre-installed Chromium when the npm package's own browser is absent.
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.__technichromeParity === 'function', null, { timeout: 30000 });
  const inputs = fixture.samples.map((s) => s.input);
  const outputs = await page.evaluate(([i, p, d]) => window.__technichromeParity(i, p, d), [inputs, fixture.parameters, fixture.lutDimension]);
  let worst = 0, worstIndex = -1;
  outputs.forEach((o, i) => {
    for (let c = 0; c < 3; c++) {
      const err = Math.abs(o[c] - fixture.samples[i].output[c]);
      if (err > worst) { worst = err; worstIndex = i; }
    }
  });
  // Tiled and windowed rendering must reproduce the whole-image render: a synthetic image printed whole, in 96 px
  // tiles with their blur halo, and as a crop through a window, compared in float.
  const tiled = await page.evaluate(() => window.__technichromeTiledCheck(331, 247, 96));
  // The same with the halation glow and the misregistration on: the glow is one field for the whole image, the
  // shift widens the halo, and tiles and crops must still reproduce the whole-image render exactly.
  const tiledSpatial = await page.evaluate(() => window.__technichromeTiledCheck(331, 247, 96, { misregistrationAt4K: 30, bloomAmount: 0.3, bloomThreshold: 0.6, bloomRadiusPercent: 3 }));
  // The glow against the CPU reference (4% of a 96 px edge: σ 3.84 px, computed at full resolution), and the
  // app's own misregistration test.
  const bloom = await page.evaluate(() => window.__technichromeBloomCheck(96, 64, 0.3, 0.6, 4));
  const shift = await page.evaluate(() => window.__technichromeShiftCheck());
  await browser.close();
  server.close();
  const tolerance = 0.02;
  console.log(`GPU vs Python fixture: worst error ${worst.toFixed(5)} on sample ${worstIndex} (tolerance ${tolerance}); isolation ok; ${errors.length} page errors`);
  const tiledTolerance = 1e-4;
  console.log(`tiled vs whole: ${tiled.tiledVsWhole.toExponential(2)} (print, ${tiled.tiles} tiles, halo ${tiled.halo} px), ${tiled.plainTiledVsWhole.toExponential(2)} (plain); crop vs whole: ${tiled.cropVsWhole.toExponential(2)} (tolerance ${tiledTolerance})`);
  const tiledOk = tiled.tiledVsWhole < tiledTolerance && tiled.plainTiledVsWhole < tiledTolerance && tiled.cropVsWhole < tiledTolerance && tiled.halo > 0 && tiled.tiles === 12;
  if (!tiledOk) console.log('tiled rendering does not match the whole-image render');
  console.log(`with glow and misregistration — tiled vs whole: ${tiledSpatial.tiledVsWhole.toExponential(2)} (halo ${tiledSpatial.halo} px); crop vs whole: ${tiledSpatial.cropVsWhole.toExponential(2)}`);
  const spatialOk = tiledSpatial.tiledVsWhole < tiledTolerance && tiledSpatial.cropVsWhole < tiledTolerance && tiledSpatial.halo > tiled.halo;
  if (!spatialOk) console.log('tiled rendering with the spatial stages does not match the whole-image render');
  const bloomTolerance = 5e-3;
  console.log(`halation vs CPU reference: ${bloom.vsReference.toExponential(2)} (tolerance ${bloomTolerance}); its effect on the print ${bloom.effect.toFixed(3)}`);
  const bloomOk = bloom.vsReference < bloomTolerance && bloom.effect > 0.01 && bloom.factor === 1;
  if (!bloomOk) console.log('the halation glow does not match the CPU reference, or does nothing');
  console.log(`misregistration: a uniform image changes by ${shift.uniform.toExponential(2)} (must be < 0.01), a checkerboard by ${shift.textured.toFixed(3)} (must be > 0.001)`);
  const shiftOk = shift.uniform < 0.01 && shift.textured > 0.001;
  if (!shiftOk) console.log('misregistration moved a uniform image, or did nothing to a textured one');
  if (!(worst < tolerance)) {
    for (let i = 0; i < Math.min(6, outputs.length); i++) {
      console.log(`  sample ${i} input ${JSON.stringify(inputs[i])} gpu ${outputs[i].map((v) => v.toFixed(4)).join(',')} expected ${fixture.samples[i].output.map((v) => v.toFixed(4)).join(',')}`);
    }
  }
  if (errors.length) console.log(errors.join('\n'));
  if (!(worst < tolerance) || !tiledOk || !spatialOk || !bloomOk || !shiftOk || errors.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
