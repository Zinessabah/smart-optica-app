"""Mesure des deux triangles faciaux sur les photos réelles du dossier uploads."""
import glob
import os

import cv2
import numpy as np

import main


def fmt(v, n=2):
    return None if v is None else round(v, n)


def main_(glob_pat="uploads/*/*_face*"):
    for p in sorted(glob.glob(glob_pat)):
        im = cv2.imdecode(np.frombuffer(open(p, 'rb').read(), np.uint8), cv2.IMREAD_COLOR)
        r = main.detect_calibration_markers(im)
        q = r.get("facial_quad_check") or {}
        tri = q.get("triangles") or {}
        print(f"  {os.path.basename(p)[:12]}  marqueurs={len(r.get('markers', []))}  "
              f"valide={q.get('quad_valid')}")
        for cote, t in (tri.get("by_side") or {}).items():
            if t:
                print(f"      {cote:6s} cote long {t['longest_mm']:6.3f} mm -> echelle "
                      f"{t['scale_mm_per_px']:.5f}  forme "
                      f"{'ok' if t['shape_ok'] else 'FAUSSE'} (residu {t['ratio_residual']*100:.2f} %)")
        if tri:
            print(f"      -> {tri['n_sides']} triangle(s), echelle moyenne {tri['scale_mm_per_px']}  "
                  f"desaccord {fmt(None if tri.get('disagreement') is None else tri['disagreement']*100)} %  "
                  f"accord={tri['sides_agree']}")
        print(f"      echelle retenue {r.get('scale_mm_per_px')}  "
              f"(mediane des etalons : {q.get('scale_median_spans')})")
        print(f"      residu max {fmt(q.get('max_span_residual_mm'))} mm   "
              f"roll {fmt(q.get('roll_deg'))}")


if __name__ == "__main__":
    main_()
