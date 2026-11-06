// GPU parity: the WebGL pipeline of the built site must agree with the Python fixture (and therefore the
// Swift core and the Metal kernels) on every fixture colour, for the shipped look and each parameter variant the
// fixture carries: within 5e-4 absolute (the half-float density targets alone account for up to about 2e-4) and
// 0.1 ΔE00 per colour, since an absolute bound alone would let a shadow move by more than a just-noticeable
// difference. Both outputs: the linear P3 print, and the sRGB canvas's sRGB print (decoded here), which must be the
// fixture's sRGB print (the P3 print converted and soft-clipped with Rec. 709 weights, one definition everywhere). Serves dist/ with the isolation headers, opens it in
// headless Chromium, calls the parity hook.
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');

const root = path.join(__dirname, '..', 'dist');
const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'Tests', 'TechnichromeCoreTests', 'Fixtures', 'parity.json'), 'utf8'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };

// CIELAB of display-linear Display P3 (D65, white Y = 1) and CIEDE2000 with kL = kC = kH = 1 (Sharma, Wu & Dalal,
// Color Res. Appl. 30(1), 2005). P3 → XYZ is the matrix the engine derives from the P3 primaries and D65.
const P3_TO_XYZ = [[0.4865709486482, 0.2656676931691, 0.1982172852344], [0.2289745640697, 0.6917385218365, 0.0792869140937], [0, 0.0451133818589, 1.043944368901]];
const SRGB_TO_XYZ = [[0.412390799266, 0.3575843393839, 0.1804807884018], [0.2126390058715, 0.7151686787678, 0.0721923153607], [0.0193308187156, 0.1191947797946, 0.9505321522497]];
const WHITE = P3_TO_XYZ.map((row) => row[0] + row[1] + row[2]);
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
function p3ToLab(rgb, toXYZ = P3_TO_XYZ) {
  const f = toXYZ.map((row, i) => {
    const t = (row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]) / WHITE[i];
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C7 = (c) => Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7));
  const G = 0.5 * (1 - C7((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => { const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh / 2 * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2, hs = h1p + h2p;
  const hbp = C1p * C2p === 0 ? hs : Math.abs(h1p - h2p) <= 180 ? hs / 2 : hs < 360 ? (hs + 360) / 2 : (hs - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const Sl = 1 + 0.015 * (Lbp - 50) ** 2 / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hbp - 275) / 25) ** 2)) * rad) * 2 * C7(Cbp);
  const l = (L2 - L1) / Sl, c = (C2p - C1p) / Sc, h = dHp / Sh;
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}
// The metric itself, on test pairs 1, 7, 17, 25 and 34 of Sharma et al.
for (const [p, q, de] of [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 0, 0], [50, -1, 2], 2.3669], [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644], [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082]]) {
  if (Math.abs(deltaE2000(p, q) - de) > 1e-4) { console.error(`CIEDE2000 gives ${deltaE2000(p, q)} for Sharma's ${de}`); process.exit(2); }
}

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
  const blocks = [{ name: 'shipped look', parameters: fixture.parameters, samples: fixture.samples }, ...fixture.variants];
  const results = [];
  for (const block of blocks) {
    const inputs = block.samples.map((s) => s.input);
    for (const output of ['linearP3', 'sRGB']) {
      const srgb = output === 'sRGB';
      const raw = await page.evaluate(([i, p, d, o]) => window.__technichromeParity(i, p, d, o), [inputs, block.parameters, fixture.lutDimension, output]);
      const outputs = srgb ? raw.map((o) => o.map(srgbDecode)) : raw;   // the sRGB canvas is given encoded values
      let worst = 0, worstIndex = -1, worstDE = 0, worstDEIndex = -1;
      outputs.forEach((o, i) => {
        const expected = srgb ? block.samples[i].outputSRGB : block.samples[i].output;
        for (let c = 0; c < 3; c++) {
          const err = Math.abs(o[c] - expected[c]);
          if (err > worst) { worst = err; worstIndex = i; }
        }
        const toXYZ = srgb ? SRGB_TO_XYZ : P3_TO_XYZ;
        const de = deltaE2000(p3ToLab(o, toXYZ), p3ToLab(expected, toXYZ));
        if (de > worstDE) { worstDE = de; worstDEIndex = i; }
      });
      results.push({ block, output, outputs, worst, worstIndex, worstDE, worstDEIndex });
    }
  }
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
  const tolerance = 5e-4, deTolerance = 0.1;
  for (const r of results) {
    console.log(`GPU vs Python fixture (${r.block.name}, ${r.output === 'sRGB' ? 'sRGB print' : 'P3'}): worst error ${r.worst.toExponential(2)} on sample ${r.worstIndex} (tolerance ${tolerance}), ` +
      `worst ΔE00 ${r.worstDE.toFixed(4)} on sample ${r.worstDEIndex} (tolerance ${deTolerance})`);
  }
  console.log(`isolation ok; ${errors.length} page errors`);
  const failed = results.filter((r) => !(r.worst < tolerance && r.worstDE < deTolerance));
  const parityOk = failed.length === 0;
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
  for (const r of failed) {
    console.log(`${r.block.name} (${r.output}) does not match the fixture:`);
    for (let i = 0; i < Math.min(6, r.outputs.length); i++) {
      const expected = r.output === 'sRGB' ? r.block.samples[i].outputSRGB : r.block.samples[i].output;
      console.log(`  sample ${i} input ${JSON.stringify(r.block.samples[i].input)} gpu ${r.outputs[i].map((v) => v.toFixed(4)).join(',')} expected ${expected.map((v) => v.toFixed(4)).join(',')}`);
    }
  }
  if (errors.length) console.log(errors.join('\n'));
  if (!parityOk || !tiledOk || !spatialOk || !bloomOk || !shiftOk || errors.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
