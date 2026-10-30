"""Fit the tone-placement parameters of the imbibition model so that a neutral grey scale lands on a
chosen *display* target (display-linear, after the viewing-condition exponent and the key image).

Run after changing curve shapes; it prints a parameter block to paste into DEFAULT_PARAMS and the
Swift EngineParameters defaults."""
import numpy as np
from scipy.optimize import minimize
import tcengine as T

# (scene-linear grey, display-linear target). A high-contrast projection-print S curve rendered for a
# phone: white just below clipping, mid-grey slightly below 0.18, slope ~1.5-1.7 through the shadows,
# a dense shoulder (blacks drop into black — Ball 1935).
TARGETS = [
    (4.0, 0.960), (2.0, 0.920), (1.0, 0.860), (0.70, 0.740), (0.50, 0.580), (0.35, 0.420), (0.18, 0.185),
    (0.09, 0.062), (0.045, 0.021), (0.02, 0.0075), (0.01, 0.0035), (0.005, 0.0018), (0.002, 0.0010),
]
NAMES = ['neg_log_e0', 'neg_gamma', 'neg_nu', 'mat_gamma', 'mat_log_e0', 'mat_nu']
BOUNDS = [(-1.8, -0.3), (0.45, 0.9), (0.2, 4.0), (1.2, 6.0), (-2.5, -0.3), (0.02, 3.0)]
WEIGHTS = np.array([0.6, 0.8, 1.5, 1.2, 1.2, 1.0, 1.5, 1.2, 1.0, 1.0, 0.8, 0.5, 0.3])


def make(vec, base, calibrate=True):
    p = T.EngineParams(**{**base.__dict__})
    for n, v in zip(NAMES, vec):
        setattr(p, n, float(v))
    if calibrate:
        T.Engine(p, lut_size=5).calibrate_neutral(iterations=6)   # writes p.dye_gain
    return p


def grey_outputs(engine):
    out = []
    for g, _ in TARGETS:
        y = engine.develop(np.array([[g, g, g]]), use_lut=False)[0].mean()
        out.append(max(y, 1e-6))
    return np.array(out)


def loss(vec, base):
    e = T.Engine(make(vec, base), lut_size=5)
    y = grey_outputs(e)
    t = np.array([t for _, t in TARGETS])
    return float(np.sum(WEIGHTS * (np.log10(y) - np.log10(t)) ** 2))


if __name__ == '__main__':
    base = T.EngineParams()
    x0 = [getattr(base, n) for n in NAMES]
    res = minimize(loss, x0, args=(base,), method='Powell', bounds=BOUNDS, options={'maxiter': 8000, 'xtol': 1e-3, 'ftol': 1e-7})
    print(res.message, 'loss', round(res.fun, 5))
    for n, v in zip(NAMES, res.x):
        print(f"    {n}: float = {v:.4f}")
    p = make(res.x, base)
    e = T.Engine(p, lut_size=5)
    print(f"    dye_gain: tuple = ({p.dye_gain[0]:.4f}, {p.dye_gain[1]:.4f}, {p.dye_gain[2]:.4f})")
    y = grey_outputs(e)
    print("grey check: scene -> display linear (target)")
    for (g, t), yy in zip(TARGETS, y):
        print(f"  {g:6.3f} -> {yy:.4f}  (target {t:.4f})  D={-np.log10(yy):.2f}")
