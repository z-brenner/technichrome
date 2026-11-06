"""Fit the engine's dye model (tcengine.Dye: a main lobe with its own shape exponent plus Gaussian side lobes) to the
measured Technicolor dye spectra digitised in data/technicolor_dyes_digitised.csv, and report the fit error.

Two sets, the ones tcengine.DYE_SETS ships besides the engine's own "Technichrome v1":

* "UK (NSMM 12593)": FilmColors' multispectral measurement of pure-dye areas of a British leader, absolute absorbance.
  The base and stain are taken out as one neutral density, the lowest reading in the figure (0.08, magenta at 710 nm):
  the clear base cannot absorb more than the least absorbing dye patch does, and the engine adds its own base density
  (print_dmin). Each dye keeps whatever it absorbs above that, its unwanted absorptions included.
* "US 1949 (Samson and Delilah)": FilmColors' statistically extracted absorbances of a 1949 trailer, relative units
  with an unknown zero, so each dye's own minimum over 400-710 nm is taken as zero. The extracted magenta rises again
  above 660 nm and the yellow above 570 nm, where the same trailer's spectrophotometer eigenspectra (Flueckiger et al.
  2018, Fig. 16, the FIG16 columns) show almost nothing (magenta 0.03-0.06, yellow 0.00-0.09): those ranges are left
  out of the fit as artefacts of the extraction, and no lobe is fitted there.

The fit is least squares on the peak-normalised curve over the measured range (400-710 nm, 10 nm), the model
normalised the same way. The result is rounded to the precision the presets carry (nm to 1, amplitude to 0.01, shape
to 0.01) and the error reported is that of the rounded lobes, as a fraction of the peak.

usage: python3 fit_dyes.py            (fit, print the lobes and their error; compare with tcengine.DYE_SETS)
       python3 fit_dyes.py --gains    (also re-balance each shipped set's gains for neutral greys, calibrate_neutral)
"""
import csv, os, sys
import numpy as np
from scipy.optimize import least_squares
import tcengine as T

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data', 'technicolor_dyes_digitised.csv')
DYES = ('cyan', 'magenta', 'yellow')
UK_BASE = 0.08   # lowest absorbance in the NSMM 12593 figure (magenta, 710 nm): an upper bound on base + stain


def load(path=DATA):
    rows = [r for r in csv.reader(open(path)) if r and not r[0].startswith('#')]
    head = rows[0]
    cols = {h: [float(r[i]) if r[i] != '' else np.nan for r in rows[1:]] for i, h in enumerate(head)}
    return np.array(cols['wavelength_nm']), {h: np.array(v) for h, v in cols.items() if h != 'wavelength_nm'}


def model(x, wl, sides):
    """Main lobe (mu, sigma_left, sigma_right, shape) plus `sides` Gaussian lobes (mu, sigma_left, sigma_right, amp)."""
    a = T.asym_gauss(wl, x[0], x[1], x[2], x[3])
    for k in range(sides):
        m, s1, s2, amp = x[4 + 4 * k: 8 + 4 * k]
        a = a + amp * T.asym_gauss(wl, m, s1, s2, 2.0)
    return a


def to_lobes(x, sides):
    """The fitted vector as the engine's lobe tuples, rounded as the presets carry them."""
    lobes = [(round(x[0]), round(x[1]), round(x[2]), 1.0, round(x[3], 2))]
    for k in range(sides):
        m, s1, s2, amp = x[4 + 4 * k: 8 + 4 * k]
        lobes.append((round(m), round(s1), round(s2), round(amp, 2), 2.0))
    return [tuple(float(v) for v in l) for l in lobes]


def lobes_curve(lobes, wl):
    a = np.zeros_like(wl, dtype=np.float64)
    for mu, sl, sr, amp, shape in lobes:
        a += amp * T.asym_gauss(wl, mu, sl, sr, shape)
    return a


def target(values, floor):
    t = np.asarray(values, dtype=np.float64) - floor
    return t / np.nanmax(t)


# (dye, x0, lower, upper, number of side lobes, wavelengths fitted) per set; side lobes in the order the Laboratory's
# sliders read them: cyan [main, green side, blue side], magenta [main, blue side, red side], yellow [main, green tail, …].
SPECS = {
    'UK (NSMM 12593)': {
        'column': 'NSMM12593', 'floor': lambda d: UK_BASE,
        'cyan': ([645, 50, 40, 2.5, 560, 40, 40, 0.1, 415, 40, 40, 0.1], [600, 15, 15, 1.5, 500, 10, 10, 0, 380, 10, 10, 0], [690, 120, 120, 5, 600, 80, 80, 0.6, 470, 120, 120, 0.6], 2, None),
        'magenta': ([540, 45, 45, 2.5, 420, 40, 40, 0.3, 640, 30, 30, 0.1], [510, 15, 15, 1.5, 380, 10, 10, 0, 590, 10, 10, 0], [570, 120, 120, 5, 480, 120, 120, 0.6, 720, 80, 80, 0.6], 2, None),
        # Its peak lies at or below 400 nm, where nothing was measured: the main lobe is kept symmetric (one width for
        # both sides, the least assumption) and its peak no lower than 390 nm.
        'yellow': ([400, 60, 60, 2.5, 550, 20, 20, 0.1, 660, 30, 30, 0.05], [390, 15, 15, 1.5, 510, 10, 10, 0, 600, 10, 10, 0], [450, 150, 150, 5, 590, 80, 80, 0.4, 720, 80, 80, 0.3], 2, None, True),
    },
    'US 1949 (Samson and Delilah)': {
        'column': 'SAMSON1949', 'floor': lambda d: np.nanmin(d),
        'cyan': ([650, 45, 90, 2.2, 560, 20, 60, 0.1, 395, 40, 60, 0.15], [600, 15, 15, 1.5, 500, 10, 10, 0, 360, 10, 10, 0], [690, 120, 150, 5, 600, 80, 100, 0.6, 470, 120, 120, 0.6], 2, None),
        'magenta': ([545, 45, 50, 2.5, 405, 60, 20, 0.1], [510, 15, 15, 1.5, 360, 10, 5, 0], [570, 120, 120, 5, 480, 120, 80, 0.6], 1, 660),
        'yellow': ([455, 60, 40, 2.4], [400, 15, 15, 1.5], [490, 150, 120, 5], 0, 570),
    },
}


def fit(wl, values, floor, x0, lb, ub, sides, cutoff, symmetric=False):
    t = target(values, floor)
    use = np.isfinite(t) & ((wl <= cutoff) if cutoff else True)
    tie = (lambda x: np.r_[x[:2], x[1], x[3:]]) if symmetric else (lambda x: x)   # sigma_left stands for both sides

    def res(x):
        c = model(tie(x), wl, sides)
        return (c / c[use].max() - t)[use]
    best = None
    for jitter in (0.0, -0.1, 0.1):   # a few starts: the shape exponent and the widths trade against each other
        start = np.clip(np.array(x0, dtype=np.float64) * (1 + jitter * np.r_[0, 1, 1, 0.5, np.zeros(len(x0) - 4)]), lb, ub)
        r = least_squares(res, start, bounds=(lb, ub))
        if best is None or r.cost < best.cost:
            best = r
    lobes = to_lobes(tie(best.x), sides)
    c = lobes_curve(lobes, wl)
    err = c / c[use].max() - t
    return lobes, t, use, float(np.sqrt(np.mean(err[use] ** 2))), float(np.max(np.abs(err[use])))


def fit_all(verbose=True):
    wl, cols = load()
    out = {}
    for name, spec in SPECS.items():
        out[name] = {}
        if verbose:
            print(f'\n{name}')
        for dye in DYES:
            values = cols[f"{spec['column']}_{dye}"]
            x0, lb, ub, sides, cutoff, *symmetric = spec[dye]
            lobes, t, use, rms, worst = fit(wl, values, spec['floor'](values), x0, lb, ub, sides, cutoff, *symmetric)
            out[name][dye] = (lobes, rms, worst)
            if verbose:
                note = f', fitted to {cutoff} nm' if cutoff else ''
                print(f'  {dye:8s} {lobes}\n           error rms {rms:.3f}, max {worst:.3f} of peak over {int(use.sum())} wavelengths{note}')
    return wl, cols, out


if __name__ == '__main__':
    wl, cols, fits = fit_all()
    # The shipped sets must be these fits (the presets carry the rounded lobes).
    for name, by_dye in fits.items():
        shipped = T.DYE_SETS.get(name)
        if shipped is None:
            print(f'\n{name} is not in tcengine.DYE_SETS')
            continue
        same = all([tuple(l) for l in getattr(shipped.dyes, d).lobes] == by_dye[d][0] for d in DYES)
        print(f'\n{name}: tcengine.DYE_SETS {"matches" if same else "DIFFERS FROM"} this fit')
    # Cross-check of the US set against the spectrophotometer eigenspectra of the same trailer (Fig. 16).
    fig = np.isfinite(cols['FIG16_cyan'])
    print('\nUS 1949 fit vs Flueckiger et al. 2018 Fig. 16 (both min-max normalised over 400-700 nm):')
    for dye in DYES:
        lobes = fits['US 1949 (Samson and Delilah)'][dye][0]
        c = lobes_curve(lobes, wl[fig])
        c = (c - c.min()) / (c.max() - c.min())
        d = c - cols[f'FIG16_{dye}'][fig]
        print(f'  {dye:8s} rms {np.sqrt(np.mean(d ** 2)):.3f}, max {np.max(np.abs(d)):.3f}')
    if '--gains' in sys.argv:
        print('\nGains re-balanced for neutral greys (calibrate_neutral) with the shipped look:')
        for name, ds in T.DYE_SETS.items():
            e = T.Engine(T.EngineParams(dye_gain=ds.gains), dyes=ds.dyes, lut_size=9)
            g = e.calibrate_neutral()
            print(f'  {name:30s} ({g[0]:.4f}, {g[1]:.4f}, {g[2]:.4f})   shipped {ds.gains}')
