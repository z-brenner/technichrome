"""Decode a DNG with LibRaw (rawpy) to scene-linear sRGB-primaries RGB, run the Technichrome engine on it
and write side-by-side PNGs. This is the Linux stand-in for CIRAWFilter(boost 0) + the Metal kernels.

usage: python3 develop_dng.py input.dng out_prefix [--ev 0.0] [--max 1600] [--params params.json]
"""
import sys, json, argparse
import numpy as np
import rawpy
from PIL import Image
from scipy.ndimage import gaussian_filter
import tcengine as T
import tcspectral as S


def decode_linear(path, max_edge=1600):
    with rawpy.imread(path) as raw:
        rgb16 = raw.postprocess(gamma=(1, 1), no_auto_bright=True, output_bps=16, use_camera_wb=True,
                                output_color=rawpy.ColorSpace.sRGB, highlight_mode=rawpy.HighlightMode.Clip,
                                demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD, half_size=True,
                                user_flip=None)
    lin = rgb16.astype(np.float64) / 65535.0
    h, w = lin.shape[:2]
    scale = max_edge / max(h, w)
    if scale < 1.0:
        img = Image.fromarray((np.clip(lin, 0, 1) ** (1 / 2.2) * 65535).astype(np.uint16) if False else (np.clip(lin, 0, 1) * 255).astype(np.uint8))
        # resample in linear light via block averaging
        fy = int(round(1 / scale)); fy = max(fy, 1)
        H = (h // fy) * fy; W = (w // fy) * fy
        lin = lin[:H, :W].reshape(H // fy, fy, W // fy, fy, 3).mean(axis=(1, 3))
    return lin


def develop_image(lin, engine: T.Engine, diffusion_sigma=None, bloom=None):
    """Full develop including spatial stages (dye diffusion of the density image; the key stays sharp)."""
    p = engine.p
    h, w = lin.shape[:2]
    E = lin
    if bloom is not None and bloom > 0:
        Y = S.luminance_srgb(lin)
        excess = np.clip(lin - p.bloom_threshold, 0, None)
        r = p.bloom_radius_pct / 100.0 * max(h, w)
        glow = np.stack([gaussian_filter(excess[..., i], r) for i in range(3)], axis=-1)
        E = lin + bloom * glow
    norm, key = engine.densities(E)
    if diffusion_sigma is None:
        diffusion_sigma = p.diffusion_sigma_px_at_4k * max(h, w) / 4000.0
    if diffusion_sigma > 0.05:
        norm = np.stack([gaussian_filter(norm[..., i], diffusion_sigma) for i in range(3)], axis=-1)
    rgb = engine.lut_lookup(norm)
    rgb = rgb * (10.0 ** (-key))[..., None]
    rgb = np.power(np.clip(rgb, 0, 1), p.surround_exponent)
    return rgb


def to_png8(rgb_linear, out_space='srgb'):
    if out_space == 'p3':
        rgb_linear = S.apply_matrix(S.P3_TO_SRGB, rgb_linear)  # view P3 output in an sRGB viewer (clipped)
    return Image.fromarray((S.srgb_encode(np.clip(rgb_linear, 0, 1)) * 255 + 0.5).astype(np.uint8))


def naive_render(lin, ev=0.0):
    """A plain 'camera JPEG' style rendering for comparison: exposure, mild S curve, sRGB encode."""
    x = np.clip(lin * 2 ** ev, 0, None)
    # simple filmic-ish rolloff
    y = x / (1 + x * 0.15)
    return np.clip(y / (1 / (1 + 0.15)), 0, 1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('dng'); ap.add_argument('out')
    ap.add_argument('--ev', type=float, default=0.0)
    ap.add_argument('--max', type=int, default=1600)
    ap.add_argument('--params', default=None)
    ap.add_argument('--autoexpose', action='store_true', help='scale so that the 99.5th percentile luminance = 1.0 (instead of timing)')
    ap.add_argument('--no-timing', action='store_true', help='disable print timing')
    a = ap.parse_args()
    lin = decode_linear(a.dng, a.max)
    if a.autoexpose:
        Y = S.luminance_srgb(lin)
        k = 1.0 / max(np.percentile(Y, 99.5), 1e-6)
        lin = lin * k
        print('auto-exposure scale', round(k, 3))
    lin = lin * 2 ** a.ev
    params = T.EngineParams()
    if not a.autoexpose and not a.no_timing:
        g = T.geometric_mean_luminance(lin)
        tev = T.timing_exposure_ev(g, params.timing_target, params.timing_strength, params.timing_limit)
        print(f'print timing: geometric mean {g:.4f} -> {tev:+.2f} EV')
        lin = lin * 2 ** tev
    if a.params:
        d = json.load(open(a.params))
        for k, v in d.items():
            if hasattr(params, k):
                setattr(params, k, tuple(v) if isinstance(v, list) else v)
    eng = T.Engine(params, lut_size=33)
    dev = develop_image(lin, eng)
    to_png8(naive_render(lin)).save(a.out + '_plain.png')
    to_png8(dev, params.display).save(a.out + '_technichrome.png')
    print('wrote', a.out + '_plain.png', a.out + '_technichrome.png', 'size', dev.shape)
