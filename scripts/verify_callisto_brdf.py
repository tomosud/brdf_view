"""Compare sample/brdf/callisto_*.brdf against a reference port of the shipped formula.

The reference is a direct Python port of the reconstructed shipped lighting code
(skin_mat_lean docs/pseudocode_callisto_brdf_realis.md, section 1, plus the BasePass
roughness pre-scale confirmed in the GPU capture). The .brdf side is evaluated on the
GPU through brdf_view's evaluate API (capture.mjs --batch, float32, before any
exposure / tone mapping / gamma).

    python scripts/verify_callisto_brdf.py [--out-dir DIR] [--skip-gpu]

Both sides are compared as BRDF * N.L (the shipped code returns lighting with N.L;
the .brdf returns the BRDF without it). Writes samples, GPU values and a summary
(summary.json, summary.md) to --out-dir (default: verify_out/, git-ignored).

Not modelled on either side (out of scope of a point-light BRDF comparison):
Dual Normal (one N), Glazing Blur, area-light normalization, the 4-bit quantization
of m, the 8-bit GBuffer roughness, SSS / transmission.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BRDF_DIR = os.path.join(ROOT, "sample", "brdf")
PRESETS = [
    "callisto_brdf",
    "callisto_eye",
    "callisto_teeth",
    "callisto_cloth_prisoner",
]
M_VALUES = [0.0, 0.25, 0.5, 0.75, 1.0]
LIGHT_THETAS = [0, 15, 30, 45, 60, 75, 85, 89, 90, 100, 120, 150]
VIEW_THETAS = [0, 30, 60, 80, 89]
PHIS = [0, 45, 90, 135, 180]  # light azimuth; the view is at phi 0
# Extra parameter sets for terms the shipped presets leave at zero / neutral.
EXTRA = {
    "callisto_brdf": [
        {"roughness": 0.9},  # avg * roughness > 1: the BasePass saturate matters
        {"roughness": 0.02},  # lower bound
        {"spec_smooth_terminator": 0.0, "diffuse_smooth_terminator": 0.0},  # zero widths
        {"anti_spec_peak_falloff": 4.0, "diffuse_fresnel_peak": 6.0},
    ],
}


# ---------------------------------------------------------------- .brdf parameters
def read_params(name: str) -> dict:
    text = open(os.path.join(BRDF_DIR, name + ".brdf"), encoding="utf-8").read()
    block = text.split("::begin parameters", 1)[1].split("::end parameters", 1)[0]
    out = {}
    for line in block.splitlines():
        t = line.split("#")[0].split()
        if not t:
            continue
        if t[0] == "float":
            out[t[1]] = float(t[4])
        elif t[0] == "color":
            out[t[1]] = [float(x) for x in t[2:5]]
        elif t[0] == "bool":
            out[t[1]] = t[2].lower() in ("1", "true")
    return out


# ---------------------------------------------------------------- reference (shipped formula)
def sat(x: float) -> float:
    return min(max(x, 0.0), 1.0)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep01(x: float) -> float:
    t = sat(x)
    return t * t * (3.0 - 2.0 * t)


def srgb_to_linear(c: float) -> float:
    c = sat(c)
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def normalize(v):
    n = math.sqrt(dot(v, v))
    return [x / n for x in v]


def d_ggx(r: float, NoH: float) -> float:
    a2 = r ** 4
    d = (NoH * a2 - NoH) * NoH + 1.0
    return a2 / (math.pi * d * d)


def vis_smith_joint_approx(r: float, NoV: float, NoL: float) -> float:
    a = r * r
    vis_v = NoL * (NoV * (1 - a) + a)
    vis_l = NoV * (NoL * (1 - a) + a)
    return 0.5 / (vis_v + vis_l)


def reference(p: dict, L, V, N=(0.0, 0.0, 1.0)):
    """Lighting (Diffuse + Spec, both with N.L) per pseudocode_callisto_brdf_realis.md 1."""
    m = sat(p["advanced_strength"])
    pk = lambda n: [p[n + "_r"], p[n + "_g"], p[n + "_b"]]
    anti_peak = [lerp(1, c, m) for c in pk("anti_spec_peak")]
    anti_fall = max(lerp(1, p["anti_spec_peak_falloff"], m), 1e-5)
    dual_tint = [lerp(1, c, m) for c in pk("dual_spec_tint")]
    diff_fres = lerp(1, p["diffuse_fresnel_peak"], m)
    diff_term = m * p["diffuse_smooth_terminator"]
    spec_term_w = [m * p["spec_smooth_terminator"] * c for c in pk("spec_term_tint")]
    fres_fall = lerp(1, p["spec_fresnel_falloff"], m)

    H = normalize([L[i] + V[i] for i in range(3)])
    NdL = sat(dot(N, L))
    NdH = sat(dot(N, H))
    LoH = sat(dot(L, H))
    NoL = NdL
    NoV_raw = dot(N, V)
    VoH = sat(dot(V, H))
    if NoL <= 0 or NoV_raw <= 0:
        return [0.0, 0.0, 0.0]
    NoV = sat(abs(NoV_raw) + 1e-5)  # UE: Context NoV

    base = [srgb_to_linear(c) for c in p["base_color"]]
    F0 = [0.08 * sat(p["specular"])] * 3

    # diffuse
    diffuse = []
    for i in range(3):
        d = base[i] / math.pi * NdL
        d *= lerp(diff_fres, 1, math.sqrt(LoH))
        d *= lerp(anti_peak[i], 1, NdH ** anti_fall)
        d *= 1.0 if diff_term == 0 else smoothstep01(NdL / diff_term)
        diffuse.append(d)

    # roughness: BasePass writes saturate(R * lerp(1, avg, m)), avg = lerp(R0, R1, LobeMix);
    # the light reads it back with * R0 / avg (R1 likewise), floor 0.02, then lerp by m.
    R = p["roughness"]
    R0, R1, mix = p["roughness0_scale"], p["roughness1_scale"], p["lobe_mix"]
    avg = lerp(R0, R1, mix)
    Rg = sat(R * lerp(1, avg, m))
    r0 = lerp(max(Rg, 0.02), max(sat(R0 / avg * Rg), 0.02), m)
    r1 = lerp(max(Rg, 0.02), max(sat(R1 / avg * Rg), 0.02), m)

    Fc = (1 - VoH) ** (5 * max(fres_fall, 1e-5))
    F_0 = [F0[i] + (sat(50 * F0[1]) - F0[i]) * Fc for i in range(3)]
    F0t = [F0[i] * dual_tint[i] for i in range(3)]
    F_1 = [F0t[i] + (sat(50 * F0t[1]) - F0t[i]) * Fc for i in range(3)]
    k0 = d_ggx(r0, NdH) * vis_smith_joint_approx(r0, NoV, NoL)
    k1 = d_ggx(r1, NdH) * vis_smith_joint_approx(r1, NoV, NoL)
    spec = [lerp(k0 * F_0[i], k1 * F_1[i], mix) * NoL for i in range(3)]

    w_avg = sum(spec_term_w) / 3
    t = min(abs(NoV_raw) + 1e-5, 1)
    for i in range(3):
        w = lerp(w_avg, spec_term_w[i], t)
        spec[i] *= 1.0 if w == 0 else smoothstep01(NoL / w)
    return [diffuse[i] + spec[i] for i in range(3)]


# ---------------------------------------------------------------- samples
def sph(theta_deg: float, phi_deg: float):
    t, f = math.radians(theta_deg), math.radians(phi_deg)
    return [math.sin(t) * math.cos(f), math.sin(t) * math.sin(f), math.cos(t)]


def make_samples():
    out = []
    for tv in VIEW_THETAS:
        for tl in LIGHT_THETAS:
            for pl in PHIS:
                out.append({"L": sph(tl, pl), "V": sph(tv, 0.0), "thetaL": tl, "phiL": pl, "thetaV": tv})
    return out


def cases():
    for name in PRESETS:
        base = read_params(name)
        for m in M_VALUES:
            yield name, {"advanced_strength": m}, {**base, "advanced_strength": m}
        for extra in EXTRA.get(name, []):
            for m in (0.5, 1.0):
                over = {**extra, "advanced_strength": m}
                yield name, over, {**base, **over}


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "verify_out"))
    ap.add_argument("--skip-gpu", action="store_true", help="reuse GPU values from a previous run")
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    samples = make_samples()
    all_cases = list(cases())
    jobs = []
    for k, (name, over, _) in enumerate(all_cases):
        jobs.append({
            "brdf": name + ".brdf",
            "eval": {"samples": [{"L": s["L"], "V": s["V"]} for s in samples], "params": over},
            "evalOut": f"gpu_{k:03d}.json",
        })
    batch = os.path.join(out_dir, "jobs.json")
    json.dump({"jobs": jobs}, open(batch, "w"), indent=1)

    if not args.skip_gpu:
        cmd = ["node", os.path.join(ROOT, "web", "scripts", "capture.mjs"), "--batch", batch]
        r = subprocess.run(cmd, cwd=os.path.join(ROOT, "web"), capture_output=True, text=True, encoding="utf-8")
        sys.stderr.write(r.stderr[-2000:])
        if r.returncode != 0:
            raise SystemExit(f"capture failed ({r.returncode})")

    rows = []
    worst_all = 0.0
    for k, (name, over, params) in enumerate(all_cases):
        gpu = json.load(open(os.path.join(out_dir, f"gpu_{k:03d}.json")))["rgb"]
        worst = (0.0, None)
        skipped = 0
        for s, g in zip(samples, gpu):
            ref = reference(params, s["L"], s["V"])
            # At roughness ~0.02 the GGX peak (N.H -> 1) is dominated by float32
            # cancellation in D_GGX (same on the GPU in the game); not a formula difference.
            H = normalize([s["L"][i] + s["V"][i] for i in range(3)])
            if params["roughness"] < 0.05 and H[2] > 1 - 1e-5 and s["L"][2] > 0 and s["V"][2] > 0:
                skipped += 1
                continue
            nol = max(s["L"][2], 0.0)
            for c in range(3):
                got = g[c] * nol
                err = abs(got - ref[c]) / max(abs(ref[c]), 1e-3)
                if err > worst[0]:
                    worst = (err, {"thetaL": s["thetaL"], "phiL": s["phiL"], "thetaV": s["thetaV"],
                                   "channel": "rgb"[c], "ref": ref[c], "brdf": got})
        worst_all = max(worst_all, worst[0])
        rows.append({"brdf": name, "params": over, "max_rel_err": worst[0], "at": worst[1], "skipped_peak": skipped})

    tol = 1e-3
    summary = {"samples_per_case": len(samples), "cases": len(rows), "tolerance": tol,
               "max_rel_err": worst_all, "rows": rows}
    json.dump(summary, open(os.path.join(out_dir, "summary.json"), "w"), indent=1)
    lines = ["| .brdf | params | max rel. err | verdict |", "| --- | --- | --- | --- |"]
    # skipped_peak: mirror-peak samples left out at roughness < 0.05 (float32 precision)
    for r in rows:
        ok = "一致" if r["max_rel_err"] <= tol else "差あり"
        note = f" (peak {r['skipped_peak']} samples skipped)" if r["skipped_peak"] else ""
        lines.append(f"| {r['brdf']} | `{json.dumps(r['params'])}` | {r['max_rel_err']:.2e} | {ok}{note} |")
    open(os.path.join(out_dir, "summary.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    bad = [r for r in rows if r["max_rel_err"] > tol]
    print(f"{len(rows)} cases x {len(samples)} samples x 3 channels; max relative error {worst_all:.3e}")
    for r in bad:
        print("  MISMATCH", r["brdf"], r["params"], f"{r['max_rel_err']:.3e}", r["at"])
    if not bad:
        print(f"all within {tol:g}")


if __name__ == "__main__":
    main()
