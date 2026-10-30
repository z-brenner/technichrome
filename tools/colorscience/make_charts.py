"""Render the synthetic test charts for the current default engine parameters."""
import sys, json
import numpy as np
from PIL import Image
import tcengine as T
import tcspectral as S
import charts as C

out_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
params = T.EngineParams()
if len(sys.argv) > 2:
    for k, v in json.load(open(sys.argv[2])).items():
        if hasattr(params, k):
            setattr(params, k, tuple(v) if isinstance(v, list) else v)
params.display = 'srgb'   # charts are viewed in an sRGB viewer
eng = T.Engine(params, lut_size=33)


def develop(lin):
    return eng.develop(np.asarray(lin, dtype=np.float64))


cc = C.colorchecker_linear(white_scale=1.0)
orig = C.patches_image(list(cc))
dev = C.patches_image(list(develop(cc)))
both = Image.new('RGB', (orig.width * 2 + 20, orig.height), (20, 20, 20))
both.paste(orig, (0, 0)); both.paste(dev, (orig.width + 20, 0))
both.save(f'{out_dir}/chart_colorchecker.png')
C.hue_sweep_image(develop).save(f'{out_dir}/chart_hue_sweep.png')
C.grey_ramp_image(develop).save(f'{out_dir}/chart_grey_ramp.png')
C.skin_ramp_image(develop).save(f'{out_dir}/chart_skin_ramp.png')
# numeric report for the colorchecker
print("ColorChecker (scene sRGB8 -> developed sRGB8):")
d8 = (S.srgb_encode(develop(cc)) * 255 + 0.5).astype(int)
o8 = (S.srgb_encode(np.clip(cc, 0, 1)) * 255 + 0.5).astype(int)
for (name, _), o, d in zip(C.COLORCHECKER_SRGB8, o8, d8):
    print(f"  {name:14s} {tuple(o)} -> {tuple(d)}")
print('charts written to', out_dir)
