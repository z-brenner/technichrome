"""Global fit (differential evolution) of the tone-placement parameters. See fit_tone.py for the targets."""
import json, sys
import numpy as np
from scipy.optimize import differential_evolution
import tcengine as T
from fit_tone import TARGETS, NAMES, BOUNDS, WEIGHTS, make, grey_outputs

t = np.array([tt for _, tt in TARGETS])


def loss(vec):
    e = T.Engine(make(vec, T.EngineParams()), lut_size=5)
    y = grey_outputs(e)
    return float(np.sum(WEIGHTS * (np.log10(y) - np.log10(t)) ** 2))


if __name__ == '__main__':
    res = differential_evolution(loss, BOUNDS, maxiter=250, popsize=20, tol=1e-8, seed=11, polish=True)
    print(res.message, 'loss', round(res.fun, 5))
    out = {n: float(v) for n, v in zip(NAMES, res.x)}
    for n, v in out.items():
        print(f"    {n}: float = {v:.4f}")
    e = T.Engine(make(res.x, T.EngineParams()), lut_size=5)
    y = grey_outputs(e)
    for (g, tt), yy in zip(TARGETS, y):
        print(f"  {g:6.3f} -> {yy:.4f}  (target {tt:.4f})  D={-np.log10(yy):.2f}")
    json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else 'fit_result.json', 'w'), indent=2)
