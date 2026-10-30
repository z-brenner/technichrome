"""Synthetic test imagery for the colour engine: ColorChecker-like patches, hue sweeps, grey ramps,
skin ramps. All inputs are scene-linear sRGB-primaries RGB. Outputs are PNGs (sRGB or P3-tagged-as-sRGB
for quick viewing; the viewer here can't show P3, so 'display' defaults to srgb for charts)."""
import numpy as np
from PIL import Image, ImageDraw
import tcspectral as S

# Commonly cited sRGB (8-bit) values of the X-Rite ColorChecker Classic (approximate, D65).
COLORCHECKER_SRGB8 = [
    ("dark skin", (115, 82, 68)), ("light skin", (194, 150, 130)), ("blue sky", (98, 122, 157)), ("foliage", (87, 108, 67)),
    ("blue flower", (133, 128, 177)), ("bluish green", (103, 189, 170)), ("orange", (214, 126, 44)), ("purplish blue", (80, 91, 166)),
    ("moderate red", (193, 90, 99)), ("purple", (94, 60, 108)), ("yellow green", (157, 188, 64)), ("orange yellow", (224, 163, 46)),
    ("blue", (56, 61, 150)), ("green", (70, 148, 73)), ("red", (175, 54, 60)), ("yellow", (231, 199, 31)),
    ("magenta", (187, 86, 149)), ("cyan", (8, 133, 161)), ("white", (243, 243, 242)), ("neutral 8", (200, 200, 200)),
    ("neutral 6.5", (160, 160, 160)), ("neutral 5", (122, 122, 121)), ("neutral 3.5", (85, 85, 85)), ("black", (52, 52, 52)),
]


def colorchecker_linear(white_scale=1.0):
    vals = np.array([v for _, v in COLORCHECKER_SRGB8], dtype=np.float64) / 255.0
    lin = S.srgb_decode(vals)
    # the chart's white patch reflects ~90 %; treat its sRGB value as 0.9 scene white
    return lin * white_scale


def patches_image(linear_rgb_list, cols=6, size=90, gap=6, encode=S.srgb_encode):
    n = len(linear_rgb_list)
    rows = (n + cols - 1) // cols
    W = cols * (size + gap) + gap
    H = rows * (size + gap) + gap
    img = Image.new('RGB', (W, H), (20, 20, 20))
    d = ImageDraw.Draw(img)
    for i, rgb in enumerate(linear_rgb_list):
        r, c = divmod(i, cols)
        x0 = gap + c * (size + gap)
        y0 = gap + r * (size + gap)
        col = tuple(int(round(v * 255)) for v in encode(np.asarray(rgb)))
        d.rectangle([x0, y0, x0 + size, y0 + size], fill=col)
    return img


def hsv_to_rgb(h, s, v):
    """h in [0,1), s,v in [0,1] → linear-ish RGB triple (used as scene-linear directly)."""
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]


def hue_sweep_image(develop, hues=36, sats=(1.0, 0.7, 0.4, 0.15), values=(1.0, 0.5, 0.2, 0.08), cell=22):
    """Rows: for each value (brightness) × saturation; columns: hue. Left half original, right half developed."""
    rows = len(values) * len(sats)
    W = hues * cell * 2 + 3 * cell
    H = rows * cell
    img = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for vi, v in enumerate(values):
        for si, s in enumerate(sats):
            r = vi * len(sats) + si
            orig = np.array([hsv_to_rgb(h / hues, s, v) for h in range(hues)])
            dev = develop(orig)
            for h in range(hues):
                co = tuple(int(round(x * 255)) for x in S.srgb_encode(np.clip(orig[h], 0, 1)))
                cd = tuple(int(round(x * 255)) for x in S.srgb_encode(dev[h]))
                d.rectangle([h * cell, r * cell, (h + 1) * cell, (r + 1) * cell], fill=co)
                x1 = hues * cell + 3 * cell + h * cell
                d.rectangle([x1, r * cell, x1 + cell, (r + 1) * cell], fill=cd)
    return img


def grey_ramp_image(develop, n=256, h=60):
    stops = np.linspace(-7, 2, n)
    g = 2.0 ** stops
    orig = np.stack([g, g, g], axis=-1)
    dev = develop(orig)
    img = Image.new('RGB', (n, h * 2), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(n):
        co = tuple(int(round(x * 255)) for x in S.srgb_encode(np.clip(orig[i], 0, 1)))
        cd = tuple(int(round(x * 255)) for x in S.srgb_encode(dev[i]))
        d.line([(i, 0), (i, h - 1)], fill=co)
        d.line([(i, h), (i, 2 * h - 1)], fill=cd)
    return img


def skin_ramp_image(develop, cell=30):
    """A few plausible skin colours (linear sRGB, from common sRGB8 references) across an exposure ramp."""
    skins8 = [(255, 224, 196), (241, 194, 160), (224, 172, 135), (198, 134, 98), (161, 102, 74), (120, 72, 50), (84, 46, 30)]
    skins = S.srgb_decode(np.array(skins8) / 255.0)
    evs = np.linspace(-3, 1.5, 19)
    rows = len(skins)
    W = len(evs) * cell * 2 + 3 * cell
    img = Image.new('RGB', (W, rows * cell), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for r, sk in enumerate(skins):
        orig = np.array([sk * 2.0 ** ev for ev in evs])
        dev = develop(orig)
        for i in range(len(evs)):
            co = tuple(int(round(x * 255)) for x in S.srgb_encode(np.clip(orig[i], 0, 1)))
            cd = tuple(int(round(x * 255)) for x in S.srgb_encode(dev[i]))
            d.rectangle([i * cell, r * cell, (i + 1) * cell, (r + 1) * cell], fill=co)
            x1 = len(evs) * cell + 3 * cell + i * cell
            d.rectangle([x1, r * cell, x1 + cell, (r + 1) * cell], fill=cd)
    return img
