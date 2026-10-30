"""CI check for the Python prototype: the engine's defaults must reproduce the committed Swift parity
fixture (so the shipped Swift numbers equal the prototype's), and a few look invariants must hold."""
import json, os, sys
import numpy as np
import tcengine as T
import tcspectral as S
from export_fixtures import params_to_swift_json

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
FIXTURE = os.path.join(ROOT, 'Tests', 'TechnichromeCoreTests', 'Fixtures', 'parity.json')


def main():
    eng = T.Engine(lut_size=17)
    fx = json.load(open(FIXTURE))
    # 1. parameters in the fixture == current defaults
    current = params_to_swift_json(eng)
    for k, v in current.items():
        fv = fx['parameters'][k]
        if isinstance(v, (float, int)):
            assert abs(float(v) - float(fv)) < 1e-9, f"parameter {k} drifted: fixture {fv} vs prototype {v}"
        elif isinstance(v, list) and v and isinstance(v[0], (float, int)):
            assert np.allclose(v, fv, atol=1e-9), f"parameter {k} drifted: fixture {fv} vs prototype {v}"
        else:
            assert v == fv, f"parameter {k} drifted: fixture {fv} vs prototype {v}"
    # 2. outputs reproduce
    worst = 0.0
    for s in fx['samples']:
        out = eng.develop(np.array([s['input']]))[0]
        worst = max(worst, float(np.max(np.abs(out - np.array(s['output'])))))
    assert worst < 1e-6, f"fixture outputs drifted by {worst}"
    # 3. invariants: neutral stays neutral and monotonic; saturated red stays red and dark
    last = 1e9
    for stop in np.arange(2.0, -8.0, -0.5):
        g = 2.0 ** stop
        out = eng.develop(np.array([[g, g, g]]))[0]
        y = out.mean()
        assert y <= last + 1e-9, f"grey scale not monotonic at {stop}"
        if y > 0.01:
            assert abs(out[0] - out[1]) / y < 0.12 and abs(out[2] - out[1]) / y < 0.12, f"grey not neutral at {stop}: {out}"
        last = y
    red = eng.develop(np.array([[0.42, 0.04, 0.045]]))[0]
    assert red[0] > 2.5 * red[1] and red[0] > 2.5 * red[2], f"red not red: {red}"
    assert red[0] < 0.42, f"red should print darker than the scene (subtractive): {red}"
    # 4. timing: a half-stop-dark scene gets a positive, clamped correction
    ev = T.timing_exposure_ev(geometric_mean=0.09, target=0.16, strength=0.6, limit=1.25)
    assert 0.4 < ev < 0.6, ev
    assert T.timing_exposure_ev(0.001, 0.16, 1.0, 1.25) == 1.25
    # 5. screen flare: Ball's 1:64 lifts the deepest black to about 1/64 of white and leaves white alone
    assert eng.p.screen_flare == 0.0, "the shipped look has no screen flare"
    pf = T.EngineParams(screen_flare=1.0 / 64.0)
    ef = T.Engine(pf, lut_size=17)
    b = ef.develop(np.array([[0.0, 0.0, 0.0]]))[0]
    w = ef.develop(np.array([[4.0, 4.0, 4.0]]))[0]
    assert b.min() > (1.0 / 65.0) ** pf.surround_exponent * 0.98, f"flare floor missing: {b}"
    assert w.min() > 0.9, f"flare must not dim white: {w}"
    print(f"prototype OK: fixture reproduced (max err {worst:.2e}), invariants hold")


if __name__ == '__main__':
    main()
