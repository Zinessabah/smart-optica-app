#!/usr/bin/env python
"""Valide la géométrie du clip v19.5 sur de VRAIES photos.

Le chemin v19.5 (3 mires alignées + 1 mire surélevée) n'était jusqu'ici validé que
sur image synthétique : les seules photos disponibles montraient un clip à 3 mires,
dont le détecteur rejette à juste titre la pseudo-4ᵉ mire. Cet outil mesure sur photo
réelle ce qu'on ne peut pas simuler — la dispersion des étalons, l'écart vertical et
le roll, sous un vrai éclairage et un vrai bruit de capteur.

Usage :
    venv/bin/python tools/valide_clip_v19_5.py photo_face.jpg [autre_photo.jpg ...]

Sortie : pour chaque photo, les mires retenues, l'échelle, la dispersion des étalons,
l'écart vertical mesuré (attendu 14,00 mm), le roll, et un VERDICT.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import clip_geometry as clip  # noqa: E402
import main  # noqa: E402


def rapport(path: str) -> None:
    data = Path(path).read_bytes()
    img = main.decode_image(data)
    h, w = img.shape[:2]
    print(f"\n{'=' * 78}\n{Path(path).name}  ({w}×{h})")

    # MediaPipe, puis le même guidage que l'endpoint — c'est le chemin réel.
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_img = main.mp.Image(image_format=main.mp.ImageFormat.SRGB, data=rgb)
    res = main.landmarker.detect(mp_img)
    if not res.face_landmarks:
        print("  ⛔ Aucun visage détecté — photo inexploitable pour ce test.")
        return
    lm = res.face_landmarks[0]
    count = len(lm)
    brow_y = min(lm[105].y if count > 105 else lm[33].y,
                 lm[334].y if count > 334 else lm[263].y)
    x0 = max(0, int((lm[234].x if count > 234 else lm[33].x) * w))
    x1 = min(w, int((lm[454].x if count > 454 else lm[263].x) * w))
    marge = int(0.05 * max(1, x1 - x0))
    crop_rect = (max(0, x0 - marge), min(w, x1 + marge))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    res_det = main.detect_facial_quadruplet(gray, int(brow_y * h),
                                            crop_rect[0], crop_rect[1], None)

    markers = res_det.get("markers") or []
    q = res_det.get("facial_quad_check") or {}
    print(f"  mires retenues     : {[(m['x'], m['y']) for m in markers]}")
    print(f"  échelle            : {res_det.get('scale_mm_per_px')} mm/px")
    print(f"  confiance          : {res_det.get('detection_confidence')}")

    if len(markers) < 3:
        print("  ⛔ Moins de 3 mires : rien à valider.")
        return

    # Écartements mesurés vs ceux du clip (invariants : ils ne dépendent pas du px)
    pts = [{"x": float(m["x"]), "y": float(m["y"])} for m in markers]
    scale = res_det.get("scale_mm_per_px") or 0.0

    def dist_mm(p, q_) -> float:
        return float(np.hypot(p["x"] - q_["x"], p["y"] - q_["y"])) * scale

    print(f"  écartement extrêmes: {dist_mm(pts[0], pts[2]):7.2f} mm "
          f"(clip : {clip.FACIAL_SPACING_EXTREME_MM:.2f})")
    print(f"  écartement adjacent: {dist_mm(pts[0], pts[1]):7.2f} / "
          f"{dist_mm(pts[1], pts[2]):7.2f} mm "
          f"(clip : {clip.FACIAL_SPACING_ADJACENT_MM:.2f})")

    if len(markers) == 4:
        centre, haute = pts[1], pts[3]
        ecart_v = abs(centre["y"] - haute["y"]) * scale
        print(f"  ÉCART VERTICAL     : {ecart_v:7.2f} mm "
              f"(clip : {clip.FACIAL_RAISED_Z_GAP_MM:.2f})  "
              f"→ écart {abs(ecart_v - clip.FACIAL_RAISED_Z_GAP_MM):.2f} mm")
        print(f"  C↔H mesuré         : {dist_mm(centre, haute):7.2f} mm "
              f"(clip : 33.11)")

    if q:
        print(f"  dispersion étalons : {100 * (q.get('scale_spread') or 0):.2f} % "
              f"(cohérent si < {100 * clip.FACIAL_SCALE_TOL:.0f} %)")
        print(f"  dispersion rapports: {100 * (q.get('ratio_spread') or 0):.2f} % "
              f"(cohérent si < {100 * clip.FACIAL_SCALE_TOL:.0f} %)")
        print(f"  quadruplet validé  : {q.get('quad_valid')}")
        if q.get("roll_deg") is not None:
            print(f"  ROLL du clip       : {q['roll_deg']:+.2f}° "
                  f"(désaccord entre les 2 références : "
                  f"{q.get('roll_disagreement_deg', 0):.2f}°)")
        else:
            print("  ROLL du clip       : indisponible (4ᵉ mire non validée)")

    # ── Verdict ───────────────────────────────────────────────────────────────
    print("  " + "-" * 74)
    if q.get("quad_valid"):
        print("  ✅ VERDICT : quadruplet v19.5 RECONNU — l'app peut mesurer "
              "l'échelle, le roll, et valider la 4ᵉ mire.")
    elif q.get("n_points") == 4:
        print("  ⚠️  VERDICT : une 4ᵉ mire est VUE mais écartée comme incohérente.")
        print("      → si ce clip porte bien 4 mires, le seuil de cohérence est "
              "TROP SERRÉ et il faut le desserrer.")
    else:
        print("  ℹ️  VERDICT : aucune 4ᵉ mire exploitable → repli sur la rangée "
              "(mesure possible, sans roll).")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        rapport(p)
    print()
