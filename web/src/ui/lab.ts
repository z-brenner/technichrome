// The Laboratory: every engine parameter the app exposes, as sliders bound to a parameters object.

import { type EngineParameters, TECHNICHROME_V1 } from '../engine/parameters';

export interface LabState {
  parameters: EngineParameters;
  /** Per-photograph print exposure on top of the parameters, in stops (the app's printExposureEV). */
  printExposureEV: number;
  /** Era of the silver key: 0.15 (shipped), 1 (1935 full key), 0.5 (light), 0 (post-1944). */
}

type Getter = (s: LabState) => number;
type Setter = (s: LabState, v: number) => void;

interface SliderSpec { title: string; min: number; max: number; step: number; format: (v: number) => string; get: Getter; set: Setter; note?: string }

const f2 = (v: number) => v.toFixed(2);
const ev = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`;

function lobe(dye: 'cyan' | 'magenta' | 'yellow', index: number, field: 'mu' | 'amplitude'): { get: Getter; set: Setter } {
  return {
    get: (s) => s.parameters[dye].lobes[index]?.[field] ?? 0,
    set: (s, v) => { const l = s.parameters[dye].lobes[index]; if (l) l[field] = v; },
  };
}

const SECTIONS: { title: string; sliders: SliderSpec[]; extra?: (state: LabState, rerender: () => void) => HTMLElement }[] = [
  {
    title: 'Exposure',
    sliders: [
      { title: 'Print exposure', min: -2, max: 2, step: 0.05, format: ev, get: (s) => s.printExposureEV, set: (s, v) => { s.printExposureEV = v; } },
      { title: 'Timing strength', min: 0, max: 1, step: 0.05, format: f2, get: (s) => s.parameters.timingStrength, set: (s, v) => { s.parameters.timingStrength = v; } },
      { title: 'Timing target (scene key)', min: 0.08, max: 0.3, step: 0.005, format: (v) => v.toFixed(3), get: (s) => s.parameters.timingTarget, set: (s, v) => { s.parameters.timingTarget = v; } },
      { title: 'Viewing compensation', min: 0.7, max: 1.1, step: 0.01, format: (v) => `γ ${v.toFixed(2)}`, get: (s) => s.parameters.surroundExponent, set: (s, v) => { s.parameters.surroundExponent = v; } },
    ],
  },
  {
    title: 'Separation negatives',
    sliders: [
      { title: 'Gamma', min: 0.3, max: 1.2, step: 0.01, format: f2, get: (s) => s.parameters.negative.gamma, set: (s, v) => { s.parameters.negative.gamma = v; } },
      { title: 'Speed point (log E)', min: -2.5, max: 0.5, step: 0.01, format: f2, get: (s) => s.parameters.negative.logE0, set: (s, v) => { s.parameters.negative.logE0 = v; } },
      { title: 'Asymmetry ν', min: 0.05, max: 3, step: 0.01, format: f2, get: (s) => s.parameters.negative.nu, set: (s, v) => { s.parameters.negative.nu = v; } },
    ],
  },
  {
    title: 'Matrices and dye transfer',
    sliders: [
      { title: 'Matrix gamma', min: 1, max: 6, step: 0.01, format: f2, get: (s) => s.parameters.matrixGamma, set: (s, v) => { s.parameters.matrixGamma = v; } },
      { title: 'Printing light (log E)', min: -2.5, max: 0, step: 0.01, format: f2, get: (s) => s.parameters.matrixLogE0, set: (s, v) => { s.parameters.matrixLogE0 = v; } },
      { title: 'Asymmetry ν', min: 0.05, max: 3, step: 0.01, format: f2, get: (s) => s.parameters.matrixNu, set: (s, v) => { s.parameters.matrixNu = v; } },
      { title: 'Cyan contrast', min: 0.5, max: 1.5, step: 0.005, format: (v) => v.toFixed(3), get: (s) => s.parameters.dyeGain[0], set: (s, v) => { s.parameters.dyeGain[0] = v; } },
      { title: 'Magenta contrast', min: 0.5, max: 1.5, step: 0.005, format: (v) => v.toFixed(3), get: (s) => s.parameters.dyeGain[1], set: (s, v) => { s.parameters.dyeGain[1] = v; } },
      { title: 'Yellow contrast', min: 0.5, max: 1.5, step: 0.005, format: (v) => v.toFixed(3), get: (s) => s.parameters.dyeGain[2], set: (s, v) => { s.parameters.dyeGain[2] = v; } },
      { title: 'Cyan printer light', min: -1.5, max: 1.5, step: 0.01, format: ev, get: (s) => s.parameters.dyeLightEV[0], set: (s, v) => { s.parameters.dyeLightEV[0] = v; } },
      { title: 'Magenta printer light', min: -1.5, max: 1.5, step: 0.01, format: ev, get: (s) => s.parameters.dyeLightEV[1], set: (s, v) => { s.parameters.dyeLightEV[1] = v; } },
      { title: 'Yellow printer light', min: -1.5, max: 1.5, step: 0.01, format: ev, get: (s) => s.parameters.dyeLightEV[2], set: (s, v) => { s.parameters.dyeLightEV[2] = v; } },
    ],
  },
  {
    title: 'Silver key image (1932–c.1944)',
    sliders: [
      { title: 'Key strength', min: 0, max: 1, step: 0.01, format: f2, get: (s) => s.parameters.keyStrength, set: (s, v) => { s.parameters.keyStrength = v; } },
      { title: 'Key gamma', min: 0.2, max: 2, step: 0.01, format: f2, get: (s) => s.parameters.key.gamma, set: (s, v) => { s.parameters.key.gamma = v; } },
      { title: 'Key printing light', min: -2.5, max: 0, step: 0.01, format: f2, get: (s) => s.parameters.key.logE0, set: (s, v) => { s.parameters.key.logE0 = v; } },
    ],
    extra: (state, rerender) => segmented('Print era', [
      ['1935 · full key', 1], ['1939–44 · light key', 0.5], ['shipped · 0.15', 0.15], ['post-1944 · none', 0],
    ], () => state.parameters.keyStrength, (v) => { state.parameters.keyStrength = v; rerender(); }),
  },
  {
    title: 'Print and projection',
    sliders: [
      { title: 'Projector colour temperature', min: 3200, max: 7000, step: 50, format: (v) => `${v.toFixed(0)} K`, get: (s) => s.parameters.projectorCCT, set: (s, v) => { s.parameters.projectorCCT = v; } },
      { title: 'Base density', min: 0, max: 0.3, step: 0.005, format: (v) => v.toFixed(3), get: (s) => s.parameters.printDMin, set: (s, v) => { s.parameters.printDMin = v; } },
      { title: 'Screen flare (fraction of white)', min: 0, max: 0.03, step: 0.0005, format: (v) => v.toFixed(4), get: (s) => s.parameters.screenFlare, set: (s, v) => { s.parameters.screenFlare = v; }, note: 'Ball, 1935: projected contrast "about 1 to 64"' },
      { title: 'Cyan peak', min: 580, max: 700, step: 1, format: (v) => `${v.toFixed(0)} nm`, ...lobe('cyan', 0, 'mu') },
      { title: 'Cyan green absorption', min: 0, max: 0.6, step: 0.01, format: f2, ...lobe('cyan', 1, 'amplitude') },
      { title: 'Cyan blue absorption', min: 0, max: 0.6, step: 0.01, format: f2, ...lobe('cyan', 2, 'amplitude') },
      { title: 'Magenta peak', min: 500, max: 600, step: 1, format: (v) => `${v.toFixed(0)} nm`, ...lobe('magenta', 0, 'mu') },
      { title: 'Magenta blue absorption', min: 0, max: 0.6, step: 0.01, format: f2, ...lobe('magenta', 1, 'amplitude') },
      { title: 'Yellow peak', min: 400, max: 490, step: 1, format: (v) => `${v.toFixed(0)} nm`, ...lobe('yellow', 0, 'mu') },
    ],
  },
  {
    title: 'Spatial',
    sliders: [
      { title: 'Dye diffusion (px @ 4K)', min: 0, max: 4, step: 0.05, format: (v) => `${v.toFixed(2)} px`, get: (s) => s.parameters.diffusionSigmaAt4K, set: (s, v) => { s.parameters.diffusionSigmaAt4K = v; } },
    ],
  },
];

function segmented(title: string, options: [string, number][], get: () => number, set: (v: number) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const head = document.createElement('div'); head.className = 'row-head'; head.textContent = title; wrap.appendChild(head);
  const seg = document.createElement('div'); seg.className = 'seg';
  for (const [label, value] of options) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    if (Math.abs(get() - value) < 1e-9) b.classList.add('on');
    b.addEventListener('click', () => set(value));
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  return wrap;
}

/** Builds the panel. `onChange` is called after every edit; `onCubeChange` is implied by the engine's own cache key. */
const OPEN_KEY = 'technichrome-lab-open';

/** Which sections are open: Exposure by default, then whatever was last chosen (kept per browser, best effort). */
function openSections(): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return saved as Record<string, boolean>;
  } catch { /* no storage: the defaults */ }
  return { Exposure: true };
}

function rememberOpen(open: Record<string, boolean>) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* no storage: nothing kept */ }
}

export function buildLab(container: HTMLElement, state: LabState, onChange: () => void) {
  const render = () => {
    container.innerHTML = '';
    const open = openSections();
    for (const section of SECTIONS) {
      const sec = document.createElement('div'); sec.className = 'section' + (open[section.title] ? ' open' : '');
      const title = document.createElement('button'); title.type = 'button'; title.className = 'section-title'; title.textContent = section.title;
      title.setAttribute('aria-expanded', String(!!open[section.title]));
      title.addEventListener('click', () => {
        const now = !sec.classList.contains('open');
        sec.classList.toggle('open', now);
        title.setAttribute('aria-expanded', String(now));
        open[section.title] = now;
        rememberOpen(open);
      });
      sec.appendChild(title);
      const body = document.createElement('div'); body.className = 'section-body';
      for (const spec of section.sliders) {
        const row = document.createElement('div'); row.className = 'row';
        const head = document.createElement('div'); head.className = 'row-head';
        const name = document.createElement('span'); name.textContent = spec.title;
        const value = document.createElement('span'); value.className = 'value'; value.textContent = spec.format(spec.get(state));
        head.append(name, value);
        const input = document.createElement('input');
        input.type = 'range'; input.min = String(spec.min); input.max = String(spec.max); input.step = String(spec.step);
        input.value = String(spec.get(state));
        input.setAttribute('aria-label', spec.title);
        input.addEventListener('input', () => {
          spec.set(state, Number(input.value));
          value.textContent = spec.format(spec.get(state));
          onChange();
        });
        row.append(head, input);
        if (spec.note) {
          const note = document.createElement('div'); note.className = 'row-note';
          const text = document.createElement('span'); text.textContent = spec.note;
          note.appendChild(text);
          if (spec.title.startsWith('Screen flare')) {
            const b64 = document.createElement('button'); b64.type = 'button'; b64.textContent = '1:64';
            b64.addEventListener('click', () => { spec.set(state, 1 / 64); input.value = String(1 / 64); value.textContent = spec.format(1 / 64); onChange(); });
            const off = document.createElement('button'); off.type = 'button'; off.textContent = 'off';
            off.addEventListener('click', () => { spec.set(state, 0); input.value = '0'; value.textContent = spec.format(0); onChange(); });
            const btns = document.createElement('span'); btns.append(b64, ' ', off);
            note.appendChild(btns);
          }
          row.appendChild(note);
        }
        body.appendChild(row);
      }
      if (section.extra) body.appendChild(section.extra(state, () => { render(); onChange(); }));
      sec.appendChild(body);
      container.appendChild(sec);
    }
  };
  render();
  return { rerender: render };
}

export function defaultLabState(): LabState {
  return { parameters: JSON.parse(JSON.stringify(TECHNICHROME_V1)) as EngineParameters, printExposureEV: 0 };
}
