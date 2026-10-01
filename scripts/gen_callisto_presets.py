"""Generate per-material preset .brdf files derived from sample/brdf/callisto_brdf.brdf.

The presets are DERIVED files: the shader is copied verbatim from callisto_brdf.brdf and
only the parameter defaults differ. Edit callisto_brdf.brdf (shader / parameter list) or
the PRESETS table below, then re-run:

    python scripts/gen_callisto_presets.py

This is an interim mechanism until the viewer supports presets natively; at that point
these files are expected to be replaced by preset entries for callisto_brdf.brdf.
"""
from __future__ import annotations

import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.path.join(ROOT, "sample", "brdf", "callisto_brdf.brdf")

# name -> (description, shipped profile, {param: value(s)})
# base_color / specular / roughness come from textures in the game; values here are representative only.
PRESETS = {
    "callisto_skin_jacob": ("Jacob head skin", "SP_Jacob_Head", {}),
    "callisto_skin_generic": ("generic human skin (NPC)", "SSP_HumanSkin", {
        "roughness0_scale": 0.44, "roughness1_scale": 1.0, "lobe_mix": 0.95,
        "dual_spec_tint_r": 0.464, "dual_spec_tint_g": 1.0, "dual_spec_tint_b": 0.91,
        "spec_fresnel_falloff": 0.55, "spec_smooth_terminator": 0.3,
        "spec_term_tint_r": 1.0, "spec_term_tint_g": 1.0, "spec_term_tint_b": 1.0,
        "diffuse_smooth_terminator": 0.15, "diffuse_fresnel_peak": 1.0,
        "anti_spec_peak_r": 0.0, "anti_spec_peak_g": 1.0, "anti_spec_peak_b": 0.5,
        "anti_spec_peak_falloff": 0.125,
        "glazing_blur_radius": 0.15,
        "sss_scatter_radius": 0.6, "sss_falloff_r": 1.0, "sss_falloff_g": 0.25, "sss_falloff_b": 0.05,
        "sss_subsurface_r": 1.0, "sss_subsurface_g": 1.0, "sss_subsurface_b": 1.0,
    }),
    "callisto_eye": ("eye (sclera/iris diffuse + dual specular; no Eye shading model)", "SP_*_Eye_Main", {
        "base_color": (0.85, 0.82, 0.78), "roughness": 0.3,
        "roughness0_scale": 1.1, "roughness1_scale": 2.0, "lobe_mix": 0.175,
        "dual_spec_tint_r": 1.0, "dual_spec_tint_g": 1.4, "dual_spec_tint_b": 0.8,
        "spec_fresnel_falloff": 1.0, "spec_smooth_terminator": 0.0,
        "spec_term_tint_r": 1.0, "spec_term_tint_g": 1.0, "spec_term_tint_b": 1.0,
        "diffuse_smooth_terminator": 0.0, "diffuse_fresnel_peak": 6.0,
        "anti_spec_peak_r": 1.0, "anti_spec_peak_g": 1.0, "anti_spec_peak_b": 1.0,
        "anti_spec_peak_falloff": 1.0,
        "glazing_blur_radius": 0.0,
        "sss_scatter_radius": 0.5, "sss_falloff_r": 1.0, "sss_falloff_g": 0.65, "sss_falloff_b": 0.15,
        "sss_subsurface_r": 1.0, "sss_subsurface_g": 1.0, "sss_subsurface_b": 1.0,
    }),
    "callisto_teeth": ("teeth", "SP_Jacob_Teeth", {
        "base_color": (0.86, 0.82, 0.72), "roughness": 0.4,
        "roughness0_scale": 0.75, "roughness1_scale": 2.0, "lobe_mix": 0.7,
        "dual_spec_tint_r": 1.0, "dual_spec_tint_g": 1.0, "dual_spec_tint_b": 1.0,
        "spec_fresnel_falloff": 1.0, "spec_smooth_terminator": 0.0,
        "spec_term_tint_r": 1.0, "spec_term_tint_g": 1.0, "spec_term_tint_b": 1.0,
        "diffuse_smooth_terminator": 0.0, "diffuse_fresnel_peak": 4.0,
        "anti_spec_peak_r": 1.5, "anti_spec_peak_g": 1.5, "anti_spec_peak_b": 1.1,
        "anti_spec_peak_falloff": 4.0,
        "glazing_blur_radius": 0.0,
        "sss_scatter_radius": 1.5, "sss_falloff_r": 0.8, "sss_falloff_g": 0.5, "sss_falloff_b": 0.25,
        "sss_subsurface_r": 1.0, "sss_subsurface_g": 1.0, "sss_subsurface_b": 1.0,
    }),
    "callisto_cloth_prisoner": ("prisoner suit cloth", "SP_Player_Jacob_Cloth", {
        "base_color": (0.62, 0.45, 0.16), "roughness": 0.8,
        "roughness0_scale": 1.0, "roughness1_scale": 1.0, "lobe_mix": 1.0,
        "dual_spec_tint_r": 1.0, "dual_spec_tint_g": 0.8, "dual_spec_tint_b": 0.1,
        "spec_fresnel_falloff": 0.75, "spec_smooth_terminator": 0.5,
        "spec_term_tint_r": 0.0, "spec_term_tint_g": 0.5, "spec_term_tint_b": 1.0,
        "diffuse_smooth_terminator": 0.5, "diffuse_fresnel_peak": 5.0,
        "anti_spec_peak_r": 0.5, "anti_spec_peak_g": 0.5, "anti_spec_peak_b": 0.5,
        "anti_spec_peak_falloff": 0.5,
        "glazing_blur_radius": 0.0,
        "sss_scatter_radius": 10.0, "sss_falloff_r": 1.0, "sss_falloff_g": 0.35, "sss_falloff_b": 0.0,
        "sss_subsurface_r": 0.1, "sss_subsurface_g": 0.1, "sss_subsurface_b": 0.1,
    }),
}


def fmt(v: float) -> str:
    return f"{v:g}"


def main() -> None:
    src = open(BASE, "rb").read().decode("utf-8").replace("\r\n", "\n")
    head, rest = src.split("::begin parameters\n", 1)
    params, tail = rest.split("::end parameters\n", 1)
    names = {line.split("#")[0].split()[1] for line in params.splitlines() if line.split("#")[0].strip()}
    for name, (desc, profile, values) in PRESETS.items():
        unknown = set(values) - names
        if unknown:
            raise SystemExit(f"{name}: unknown parameters {sorted(unknown)}")
        out_params = []
        for line in params.splitlines():
            decl, sep, comment = line.partition("#")
            t = decl.split()
            if not t or t[1] not in values:
                out_params.append(line)
                continue
            v = values[t[1]]
            tail_comment = f"  # {comment.strip()}" if sep else ""
            if t[0] == "color":
                out_params.append(f"color {t[1]} " + " ".join(fmt(x) for x in v) + tail_comment)
            else:
                out_params.append(f"float {t[1]} {t[2]} {t[3]} {fmt(v)}" + tail_comment)
        header = (
            "analytic\n\n"
            f"# DERIVED PRESET of callisto_brdf.brdf - {desc} ({profile}).\n"
            "# Generated by scripts/gen_callisto_presets.py; do not edit by hand.\n"
            "# The shader is identical to callisto_brdf.brdf; only parameter defaults differ.\n"
            "# Interim: intended to become a preset of callisto_brdf.brdf once the viewer\n"
            "# supports presets. base_color / specular / roughness are representative values\n"
            "# (texture-driven in the game); the Callisto parameters are the shipped profile values.\n"
            "#\n"
        )
        body = re.sub(r"^analytic\n\n", "", head)
        text = header + body + "::begin parameters\n" + "\n".join(out_params) + "\n::end parameters\n" + tail
        for d in ("sample/brdf", "web/public/brdfs"):
            path = os.path.join(ROOT, d, name + ".brdf")
            open(path, "wb").write(text.replace("\n", "\r\n").encode("utf-8"))
        print("wrote", name)


if __name__ == "__main__":
    main()
