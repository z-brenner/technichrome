// A hook for test/gl-parity.cjs: renders given scene-linear colours through the WebGL pipeline and returns
// the display-linear P3 result, the same check the iPhone app's simulator tests run on the Metal kernels.

import { type EngineParameters } from './engine/parameters';
import { GLEngine } from './gl/engine';

declare global {
  interface Window {
    __technichromeParity?: (inputs: number[][], parameters: EngineParameters, lutDimension: number) => number[][];
  }
}

export function installParityHook(engine: GLEngine) {
  window.__technichromeParity = (inputs, parameters, lutDimension) => {
    const probe = new GLEngine(document.createElement('canvas'), lutDimension);
    const n = inputs.length;
    const rgb = new Float32Array(n * 3);
    inputs.forEach((v, i) => { rgb[i * 3] = v[0]; rgb[i * 3 + 1] = v[1]; rgb[i * 3 + 2] = v[2]; });
    const source = probe.uploadLinear(rgb, n, 1);
    const target = probe.createFloatTarget(n, 1);
    probe.render(source, parameters, { exposureScale: Math.pow(2, parameters.exposureEV), spatial: false, output: 'linearP3', target });
    const out = probe.readFloat(target);
    probe.deleteTarget(target);
    probe.deleteSource(source);
    void engine;
    return inputs.map((_, i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]);
  };
}
