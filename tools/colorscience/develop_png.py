"""Develop display-referred PNG/JPEG test images (linearised with the inverse sRGB curve) through the engine
and write side-by-side montages. Approximate (no RAW headroom), but fine for judging colour rendering.

usage: python3 develop_png.py out_dir img1.png img2.png ... [--ev 0] [--params p.json]
"""
import sys, os, json
import numpy as np
from PIL import Image
import tcengine as T
import tcspectral as S
from develop_dng import develop_image, to_png8


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    ev = 0.0
    params = T.EngineParams()
    if '--ev' in sys.argv:
        ev = float(sys.argv[sys.argv.index('--ev') + 1])
    if '--params' in sys.argv:
        for k, v in json.load(open(sys.argv[sys.argv.index('--params') + 1])).items():
            if hasattr(params, k):
                setattr(params, k, tuple(v) if isinstance(v, list) else v)
    out_dir, files = args[0], args[1:]
    os.makedirs(out_dir, exist_ok=True)
    eng = T.Engine(params, lut_size=33)
    for f in files:
        im = np.asarray(Image.open(f).convert('RGB'), dtype=np.float64) / 255.0
        lin = S.srgb_decode(im) * 2 ** ev
        dev = develop_image(lin, eng)
        a = Image.fromarray((im * 255 + 0.5).astype(np.uint8))
        b = to_png8(dev, params.display)
        W = a.width + b.width + 8
        m = Image.new('RGB', (W, a.height), (0, 0, 0))
        m.paste(a, (0, 0)); m.paste(b, (a.width + 8, 0))
        name = os.path.splitext(os.path.basename(f))[0]
        m.save(os.path.join(out_dir, f'{name}_pair.png'))
        print('wrote', name)
