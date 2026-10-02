"""Verify the pseudo SSS of Lit Object (web/src/gl/sss.ts) against a Python reference.

Two checks, both through brdf_view's own automation (capture.mjs --batch):

1. Hook contract of every sample .brdf that declares BRDF_sss_diffuse:
   BRDF() == BRDF_sss_diffuse() * BRDF_sss_albedo() + specular, i.e. with the specular
   switched off (specular = 0) the two sides are equal. Uses evaluate (float32).

2. The screen-space filter: a sphere lit by one directional light from the side is rendered
   with SSS on, and the image's centre row is compared with a pure-Python port of the same
   algorithm (kernel, perspective, depth weight, sub-steps, recombination) applied to an
   analytic sphere. The diffuse lighting before scattering comes from the hook function
   itself (evaluate, float32), so this check does not depend on the .brdf formula.
   Images are 8-bit, so each case is captured at two exposures (whole range / terminator).

    python scripts/verify_sss.py [--out-dir DIR] [--skip-gpu]

Writes the batch file, captures and summary.md / summary.json to --out-dir (default:
verify_out/sss/, git-ignored). The reference is a custom implementation; it checks that the
viewer does what docs/pseudo_sss.md says, not that it matches any engine or game.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BRDF_DIR = os.path.join(ROOT, "sample", "brdf")

# ---- constants that must match web/src/gl/sss.ts and web/src/views/lit-object.ts
KERNEL_TAPS = 13
KERNEL_RANGE = 3.0
DEPTH_FALLOFF = 0.01
FALLOFF_MIN = 0.009
GAUSSIANS = [(0.100, 0.0484), (0.118, 0.187), (0.113, 0.567), (0.358, 1.99), (0.078, 7.41)]
SUB_STEPS = 8          # snapshots use 8 sub-steps
FOV_Y = 45.0
CAMERA_DISTANCE = 3.0  # zoom 1
MESH_EXTENT = 2.0
SSS_DEFAULTS = dict(sss_strength=1.0, sss_scatter_radius=1.2, sss_falloff_r=1.0, sss_falloff_g=0.37, sss_falloff_b=0.3,
                    sss_subsurface_r=0.48, sss_subsurface_g=0.41, sss_subsurface_b=0.28)

SIZE = 512
# A minimal .brdf with only the required hook: no albedo hook and no sss_* parameters, so the
# viewer's defaults (SSS_DEFAULTS) apply. Loaded from text ("@" names below), not from sample/brdf.
INLINE = {
    "@lambert_hook_only": """analytic
::begin parameters
::end parameters
::begin shader
vec3 BRDF_sss_diffuse(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y) { return vec3(0.3183098862); }
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y) { return BRDF_sss_diffuse(L, V, N, X, Y); }
::end shader
""",
}
# (label, .brdf, size of the sphere's diameter in cm, parameter overrides)
CASES = [
    ("jacob_3cm", "callisto_brdf", 3.0, {}),
    ("jacob_20cm", "callisto_brdf", 20.0, {}),
    ("jacob_3cm_half", "callisto_brdf", 3.0, {"sss_strength": 0.5}),
    ("jacob_3cm_lambert", "callisto_brdf", 3.0, {"advanced_strength": 0.0}),
    ("teeth_6cm", "callisto_teeth", 6.0, {}),
    ("cloth_40cm", "callisto_cloth_prisoner", 40.0, {}),
    ("hook_only_6cm", "@lambert_hook_only", 6.0, {}),
]
EXPOSURES = [1.0, 5.0]
COLUMNS = list(range(40, SIZE - 40, 8))  # columns of the centre row that are compared


# ---------------------------------------------------------------- .brdf files
def read_brdf(name: str):
    """-> (text, float parameter defaults, all parameter names)"""
    text = INLINE[name] if name in INLINE else open(os.path.join(BRDF_DIR, name + ".brdf"), encoding="utf-8").read()
    block = text.split("::begin parameters", 1)[1].split("::end parameters", 1)[0]
    params, names = {}, set()
    for line in block.splitlines():
        t = line.split("#")[0].split()
        if not t:
            continue
        names.add(t[1])
        if t[0] == "float":
            params[t[1]] = float(t[4])
    return text, params, names


def load_job(name: str) -> dict:
    """Batch-job keys that load a .brdf: a bundled sample by file name, or an inline one by text."""
    if name in INLINE:
        return {"state": {"v": 1, "brdfs": [{"name": name[1:] + ".brdf", "source": INLINE[name], "visible": True, "params": {}}]}}
    return {"brdf": name + ".brdf"}


def sss_brdfs():
    out = []
    for f in sorted(os.listdir(BRDF_DIR)):
        if f.endswith(".brdf") and "vec3 BRDF_sss_diffuse" in open(os.path.join(BRDF_DIR, f), encoding="utf-8").read():
            out.append(f[:-5])
    return out


# ---------------------------------------------------------------- kernel (same as sss.ts)
def profile(r: float, falloff: float) -> float:
    rr = r / (0.001 + falloff)
    return sum(w * math.exp(-(rr * rr) / (2.0 * v)) / (2.0 * math.pi * v) for w, v in GAUSSIANS)


def separable_kernel(falloff_rgb, taps=KERNEL_TAPS):
    fall = [max(f, FALLOFF_MIN) for f in falloff_rgb]
    total = 2 * taps - 1
    rng = 3.0 if total > 20 else 2.0
    step = 2.0 * rng / (total - 1)
    offs = []
    for i in range(total):
        o = -rng + i * step
        offs.append(rng * (-1.0 if o < 0 else 1.0) * o * o / (rng * rng))
    rgb = []
    for i in range(total):
        w0 = abs(offs[i] - offs[i - 1]) if i > 0 else 0.0
        w1 = abs(offs[i] - offs[i + 1]) if i < total - 1 else 0.0
        rgb.append([(w0 + w1) / 2.0 * profile(offs[i], f) for f in fall])
    sums = [sum(k[c] for k in rgb) for c in range(3)]
    mid = taps - 1
    return [[rgb[mid + i][c] / sums[c] for c in range(3)] + [abs(offs[mid + i])] for i in range(taps)]


# ---------------------------------------------------------------- scene (analytic sphere, Lit Object camera)
class Scene:
    """Unit sphere at the origin, camera on +z looking at it (litObject.camera theta 90, phi 90)."""

    def __init__(self, size: int):
        self.size = size
        self.tan = math.tan(math.radians(FOV_Y) / 2.0)
        self.eye = (0.0, 0.0, CAMERA_DISTANCE)

    def hit(self, i: int, j: int):
        """Pixel (i, j) with j counted from the bottom -> (position = normal, view depth) or None."""
        n = self.size
        dx = ((i + 0.5) / n * 2.0 - 1.0) * self.tan
        dy = ((j + 0.5) / n * 2.0 - 1.0) * self.tan
        d = (dx, dy, -1.0)
        dl = math.sqrt(dx * dx + dy * dy + 1.0)
        d = (d[0] / dl, d[1] / dl, d[2] / dl)
        b = self.eye[2] * d[2]
        disc = b * b - (CAMERA_DISTANCE * CAMERA_DISTANCE - 1.0)
        if disc <= 0.0:
            return None
        t = -b - math.sqrt(disc)
        p = (d[0] * t, d[1] * t, self.eye[2] + d[2] * t)
        return p, CAMERA_DISTANCE - p[2]

    def view(self, p):
        v = (self.eye[0] - p[0], self.eye[1] - p[1], self.eye[2] - p[2])
        vl = math.sqrt(sum(x * x for x in v))
        return [x / vl for x in v]


def blur_reference(scene: Scene, diffuse: dict, params: dict, size_cm: float, columns):
    """Centre row after the horizontal and vertical pass. diffuse: {(i, j): rgb} for every pixel used."""
    n = scene.size
    cm_per_unit = size_cm / MESH_EXTENT
    px_per_cm_depth1 = 0.5 * n / scene.tan / cm_per_unit
    kern = separable_kernel([params["sss_falloff_r"], params["sss_falloff_g"], params["sss_falloff_b"]])
    scale = params["sss_scatter_radius"] / KERNEL_RANGE * params["sss_strength"]
    taps = []
    for i in range(KERNEL_TAPS - 1):
        for s in range(SUB_STEPS):
            t = (s + 0.5) / SUB_STEPS
            a, b = kern[i], kern[i + 1]
            taps.append(([a[c] + (b[c] - a[c]) * t for c in range(3)], (a[3] + (b[3] - a[3]) * t) * scale))
    depth = {}

    def depth_at(i, j):
        key = (i, j)
        if key not in depth:
            h = scene.hit(i, j) if 0 <= i < n and 0 <= j < n else None
            depth[key] = h[1] if h else 0.0
        return depth[key]

    def one_pass(source, i, j, di, dj):
        z0 = depth_at(i, j)
        if z0 <= 0.0:
            return None
        step = px_per_cm_depth1 / z0
        acc = [0.0, 0.0, 0.0]
        div = [0.0, 0.0, 0.0]
        for w, off in taps:
            for side in (-1.0, 1.0):
                # gl_FragCoord is the pixel centre: floor(i + 0.5 + offset)
                qi = math.floor(i + 0.5 + side * off * step * di)
                qj = math.floor(j + 0.5 + side * off * step * dj)
                z = depth_at(qi, qj)
                if z <= 0.0:
                    continue
                c = source(qi, qj)
                dz = (z - z0) * cm_per_unit
                dw = math.exp(-DEPTH_FALLOFF * dz * dz)
                for k in range(3):
                    acc[k] += w[k] * c[k] * dw
                    div[k] += w[k] * dw
        c0 = source(i, j)
        return [acc[k] / div[k] if div[k] > 0.0 else c0[k] for k in range(3)]

    h_cache = {}

    def h_pass(i, j):
        key = (i, j)
        if key not in h_cache:
            h_cache[key] = one_pass(lambda a, b: diffuse[(a, b)], i, j, 1, 0)
        return h_cache[key]

    j = n // 2
    return {i: one_pass(h_pass, i, j, 0, 1) for i in columns if depth_at(i, j) > 0.0}


def pixels_needed(scene: Scene, params: dict, size_cm: float, columns):
    """Every pixel the reference reads for the centre row: (column, row) pairs on the sphere."""
    n = scene.size
    cm_per_unit = size_cm / MESH_EXTENT
    reach_px = params["sss_scatter_radius"] * params["sss_strength"] * (0.5 * n / scene.tan / cm_per_unit) / (CAMERA_DISTANCE - 1.0)
    r = int(math.ceil(reach_px)) + 2
    j0 = n // 2
    need = set()
    cols = set()
    for i in columns:
        for di in range(-r, r + 1):
            if 0 <= i + di < n:
                cols.add(i + di)
    for i in cols:
        need.add((i, j0))
    for i in columns:
        for dj in range(-r, r + 1):
            if not 0 <= j0 + dj < n:
                continue
            for di in range(-r, r + 1):
                if 0 <= i + di < n:
                    need.add((i + di, j0 + dj))
    return [p for p in sorted(need) if scene.hit(*p)]


# ---------------------------------------------------------------- PNG (8-bit RGBA / RGB, non-interlaced)
def read_png(path: str):
    data = open(path, "rb").read()
    pos, chunks, ihdr = 8, [], None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            chunks.append(body)
        pos += 12 + length
    w, h, depth, ctype = ihdr[:4]
    if depth != 8 or ctype not in (2, 6):
        raise SystemExit(f"{path}: unsupported PNG (bit depth {depth}, colour type {ctype})")
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(b"".join(chunks))
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, bpp, rows


# ---------------------------------------------------------------- main
def run_capture(batch: str):
    cmd = ["node", os.path.join(ROOT, "web", "scripts", "capture.mjs"), "--batch", batch]
    r = subprocess.run(cmd, cwd=os.path.join(ROOT, "web"), capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        print(r.stdout[-2000:])
        print(r.stderr[-4000:])
        raise SystemExit(f"capture failed ({r.returncode})")
    return r.stderr


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "verify_out", "sss"))
    ap.add_argument("--skip-gpu", action="store_true", help="reuse the captures already in --out-dir")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out_dir)
    os.makedirs(out, exist_ok=True)
    scene = Scene(SIZE)
    light = [1.0, 0.0, 0.0]  # incident theta 90, phi 0: from the right of the screen
    jobs = []

    # 1. hook contract: specular off -> BRDF == diffuse * albedo
    dirs = []
    for tl in (0, 30, 60, 85, 100):
        for tv in (0, 40, 80):
            for ph in (0, 60, 180):
                dirs.append({"thetaL": tl, "phiL": ph, "thetaV": tv, "phiV": 0})
    hook_brdfs = sss_brdfs()
    for name in hook_brdfs:
        for comp in ("brdf", "sssDiffuse", "sssAlbedo"):
            jobs.append({"brdf": name + ".brdf", "evalOut": f"hook_{name}_{comp}.json",
                         "eval": {"samples": dirs, "params": {"specular": 0.0}, "component": comp}})

    # 2. filter: per case, the diffuse light of every pixel the reference reads + two captures
    cases = []
    for label, name, size_cm, over in CASES:
        _, params, names = read_brdf(name)
        params = {**SSS_DEFAULTS, **params, **over}
        need = pixels_needed(scene, params, size_cm, COLUMNS)
        samples = []
        for (i, j) in need:
            p, _ = scene.hit(i, j)
            samples.append({"L": light, "V": scene.view(p), "N": list(p)})
        # white albedo and no specular (where the .brdf has such parameters): the image is the diffuse alone
        over_eval = {**over, **({"base_color": [1, 1, 1]} if "base_color" in names else {}), **({"specular": 0.0} if "specular" in names else {})}
        jobs.append({**load_job(name), "evalOut": f"diffuse_{label}.json",
                     "eval": {"samples": samples, "params": over_eval, "component": "sssDiffuse"}})
        opt = {"litObject.object": "sphere", "litObject.ibl": False, "plot.nDotL": True, "litObject.hideBackground": True,
               "litObject.camera.theta": 90, "litObject.camera.phi": 90, "litObject.camera.zoom": 1,
               "litObject.gamma": 1, "litObject.sss": True, "litObject.sizeCm": size_cm, "display.toneMap": False}
        sets = {**over, **({"base_color": "1,1,1"} if "base_color" in names else {}), **({"specular": 0} if "specular" in names else {})}
        shot = {**load_job(name), "set": sets, "light": "90,0", "view": "litObject", "width": SIZE, "height": SIZE}
        for e in EXPOSURES:
            jobs.append({**shot, "opt": {**opt, "litObject.exposure": e}, "out": f"{label}_e{e:g}.png"})
        jobs.append({**shot, "opt": {**opt, "litObject.exposure": EXPOSURES[0], "litObject.sss": False}, "out": f"{label}_off.png"})
        cases.append((label, name, size_cm, params, need))

    batch = os.path.join(out, "batch.json")
    json.dump({"jobs": jobs}, open(batch, "w"), indent=1)
    if not a.skip_gpu:
        log = run_capture(batch)
        gpu = next((line for line in log.splitlines() if "WebGL renderer" in line), "")
        print(gpu)

    summary = {"hooks": [], "filter": []}
    md = ["# Pseudo SSS verification", ""]
    ok_all = True

    md += ["## 1. Hook contract (specular = 0): BRDF = BRDF_sss_diffuse x BRDF_sss_albedo", "",
           "| .brdf | samples | max abs error | result |", "| --- | --- | --- | --- |"]
    for name in hook_brdfs:
        rgb = {c: json.load(open(os.path.join(out, f"hook_{name}_{c}.json")))["rgb"] for c in ("brdf", "sssDiffuse", "sssAlbedo")}
        err = max(abs(rgb["brdf"][i][k] - rgb["sssDiffuse"][i][k] * rgb["sssAlbedo"][i][k])
                  for i in range(len(dirs)) for k in range(3))
        ok = err < 1e-5
        ok_all &= ok
        summary["hooks"].append(dict(brdf=name, max_abs_err=err, ok=ok))
        md.append(f"| {name} | {len(dirs)} | {err:.1e} | {'ok' if ok else 'FAIL'} |")
    md.append("")

    md += ["## 2. Filter: centre row of a side-lit sphere, viewer vs reference", "",
           "Values are linear, per unit light (the diffuse term is about N.L / pi). 8-bit captures: the",
           "quantization step is 1/255 divided by 2^exposure.", "",
           "| case | sphere diameter cm | exposure | columns | max abs error | quantization step | max change by SSS | result |",
           "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    j0 = SIZE // 2
    for label, name, size_cm, params, need in cases:
        vals = json.load(open(os.path.join(out, f"diffuse_{label}.json")))["rgb"]
        nol = {}
        for (i, j), v in zip(need, vals):
            p, _ = scene.hit(i, j)
            s = max(p[0] * light[0] + p[1] * light[1] + p[2] * light[2], 0.0)  # "Multiply by N.L"
            nol[(i, j)] = [max(x, 0.0) * s for x in v]
        ref = blur_reference(scene, nol, params, size_cm, COLUMNS)
        sub = [params["sss_subsurface_r"], params["sss_subsurface_g"], params["sss_subsurface_b"]]
        final = {i: [nol[(i, j0)][k] + (ref[i][k] - nol[(i, j0)][k]) * min(max(sub[k], 0.0), 1.0) for k in range(3)] for i in ref}
        change = max(abs(final[i][k] - nol[(i, j0)][k]) for i in final for k in range(3))
        for e in EXPOSURES:
            w, h, bpp, rows = read_png(os.path.join(out, f"{label}_e{e:g}.png"))
            row = rows[h - 1 - j0]
            gain = 2.0 ** e
            err, used = 0.0, 0
            for i, c in final.items():
                for k in range(3):
                    shown = row[i * bpp + k] / 255.0
                    expect = c[k] * gain
                    if expect > 0.98 or shown >= 0.999:  # clipped at this exposure
                        continue
                    err = max(err, abs(shown - expect) / gain)
                    used += 1
            step = 1.0 / 255.0 / gain
            ok = err <= 1.5 * step + 2e-4
            ok_all &= ok
            summary["filter"].append(dict(case=label, brdf=name, size_cm=size_cm, exposure=e, compared=used,
                                          max_abs_err=err, quantization=step, max_change=change, ok=ok))
            md.append(f"| {label} | {size_cm:g} | {e:g} | {len(final)} | {err:.5f} | {step:.5f} | {change:.4f} | {'ok' if ok else 'FAIL'} |")
        # SSS off must equal the unscattered diffuse
        w, h, bpp, rows = read_png(os.path.join(out, f"{label}_off.png"))
        row = rows[h - 1 - j0]
        gain = 2.0 ** EXPOSURES[0]
        err = max(abs(row[i * bpp + k] / 255.0 - nol[(i, j0)][k] * gain) / gain for i in final for k in range(3)
                  if nol[(i, j0)][k] * gain < 0.98)
        ok = err <= 1.5 / 255.0 / gain + 2e-4
        ok_all &= ok
        summary["filter"].append(dict(case=label + " (SSS off)", brdf=name, size_cm=size_cm, exposure=EXPOSURES[0],
                                      max_abs_err=err, ok=ok))
        md.append(f"| {label} (SSS off) | {size_cm:g} | {EXPOSURES[0]:g} | {len(final)} | {err:.5f} | {1 / 255 / gain:.5f} | 0 | {'ok' if ok else 'FAIL'} |")
    md += ["", f"Overall: {'ok' if ok_all else 'FAIL'}", ""]

    summary["ok"] = ok_all
    json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)
    open(os.path.join(out, "summary.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md))
    print("\n".join(md))
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
