"""Edit DEFAULT engine parameter values in tcengine.py from the command line, e.g.
   python3 set_params.py neg_gamma=0.45 mat_nu=0.7458 dye_dmax="(2.8, 2.8, 2.8)"
Also: python3 set_params.py --calibrate   (recomputes dye_gain for neutral greys and writes it)."""
import re, sys


def set_value(src, name, value):
    pat = re.compile(r"(    %s: (?:float|tuple|str) = )([^#\n]+)(\s*#.*)?\n" % re.escape(name))
    m = pat.search(src)
    if not m:
        raise SystemExit(f"parameter {name} not found")
    comment = m.group(3) or ""
    return src[:m.start()] + f"{m.group(1)}{value}{comment}\n" + src[m.end():]


if __name__ == '__main__':
    src = open('tcengine.py').read()
    args = [a for a in sys.argv[1:] if a != '--calibrate']
    for a in args:
        k, v = a.split('=', 1)
        src = set_value(src, k, v)
    open('tcengine.py', 'w').write(src)
    if '--calibrate' in sys.argv:
        import importlib, tcengine as T, numpy as np
        importlib.reload(T)
        e = T.Engine(lut_size=9)
        g = e.calibrate_neutral()
        src = set_value(src, 'dye_gain', f"({g[0]:.4f}, {g[1]:.4f}, {g[2]:.4f})")
        open('tcengine.py', 'w').write(src)
        print('dye_gain =', [round(x, 4) for x in g])
    print('ok')
