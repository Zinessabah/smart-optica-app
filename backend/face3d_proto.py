#!/usr/bin/env python3
"""
Prototype v2 : mesure 3D du visage via Orbbec Astra Pro.

STRATÉGIE (validée par diagnostic) :
- IR + Depth viennent du MÊME capteur (lumière structurée) → pixels ALIGNÉS
  par construction (l'AlignFilter depth→color est CASSÉ sur ce firmware OpenNI).
- Détection du visage dans l'image IR (MediaPipe FaceLandmarker), pupilles
  (iris 468/473) en pixels IR → lecture depth aux mêmes pixels.
- ⚠️ Échelle : la depth Y11 est en CENTIMÈTRES (×10 pour mm), vérifié
  empiriquement (visage 60-70cm → 69-77 brut).

⚠️ Plage minimale Astra Pro : ~60 cm ! Le visage doit être à 60-100 cm.

Usage : ./backend/run_orbbec.sh backend/face3d_proto.py [--save out/] [--warmup 8]
"""
import argparse
import os
import sys
import time

import numpy as np

SP = os.path.expanduser(
    "~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages"
)
if SP not in sys.path:
    sys.path.insert(0, SP)

from pyorbbecsdk import (
    Config, Context, OBFormat, OBSensorType, Pipeline,
)

# ⚠️ ÉCHELLE DEPTH Astra Pro (firmware RD2403, OpenNI) :
# le format Y11 retourne des valeurs en CENTIMÈTRES (pas mm !).
# get_depth_scale() retourne 1.0 (trompeur) → il faut multiplier par 10.
DEPTH_CM_TO_MM = 10.0

# Intrinsèques nominales Astra Pro — capteur IR/DEPTH (même optique)
# FOV : 60° horizontal, 49.5° vertical (specs constructeur)
W, H = 320, 240
HFOV_DEG, VFOV_DEG = 60.0, 49.5
FX = (W / 2) / np.tan(np.radians(HFOV_DEG / 2))   # ≈ 277.1
FY = (H / 2) / np.tan(np.radians(VFOV_DEG / 2))   # ≈ 260.4
CX, CY = W / 2, H / 2

# MediaPipe FaceMesh — indices iris (modèle 478 landmarks)
IRIS_LEFT, IRIS_RIGHT = 468, 473


def get_pipeline():
    ctx = Context()
    dl = ctx.query_devices()
    if dl.get_count() == 0:
        print("❌ Caméra Orbbec non détectée")
        sys.exit(1)
    p = Pipeline()
    cfg = Config()
    # IR 320x240 Y10 (image) + Depth 320x240 Y11 (mesure) — même capteur
    pl_ir = p.get_stream_profile_list(OBSensorType.IR_SENSOR)
    cfg.enable_stream(pl_ir.get_video_stream_profile(320, 0, OBFormat.Y10, 30))
    pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
    p.start(cfg)
    return p


def get_ir_depth(pipeline, max_tries=20):
    """Récupère image IR + depth (mêmes pixels, même capteur)."""
    for _ in range(max_tries):
        fs = pipeline.wait_for_frames(1500)
        if fs is None:
            continue
        irf, df = fs.get_ir_frame(), fs.get_depth_frame()
        if irf is None or df is None:
            continue
        w, h = irf.get_width(), irf.get_height()
        ir_raw = np.frombuffer(irf.get_data(), dtype=np.uint16).reshape(h, w)
        ir8 = np.clip(ir_raw >> 2, 0, 255).astype(np.uint8)
        ir_rgb = np.stack([ir8, ir8, ir8], axis=-1)
        dw, dh = df.get_width(), df.get_height()
        depth = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(dh, dw)
        depth = depth.astype(np.float32) * DEPTH_CM_TO_MM  # cm → mm
        return ir_rgb, depth
    return None, None


def pixel_to_3d(u, v, z):
    """Pixel IR (u,v) + profondeur z (mm) → point 3D (mm) repère caméra."""
    x = (u - CX) * z / FX
    y = (v - CY) * z / FY
    return np.array([x, y, z])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", metavar="DIR", help="sauvegarder frames")
    ap.add_argument("--warmup", type=float, default=8.0,
                    help="secondes d'attente avant mesure (se placer devant)")
    ap.add_argument("--frames", type=int, default=600, help="itérations max")
    args = ap.parse_args()

    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "models", "face_landmarker.task")
    if not os.path.exists(model_path):
        print(f"❌ Modèle introuvable : {model_path}")
        sys.exit(1)
    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
    )
    face_mesh = vision.FaceLandmarker.create_from_options(options)
    mp_image = mp.Image

    p = get_pipeline()
    print(f"🚀 Pipeline IR+Depth 320x240 — intrinsèques IR (fx={FX:.1f}, fy={FY:.1f})")
    print(f"   Échelle depth : cm→mm (×{DEPTH_CM_TO_MM:.0f})")
    if args.warmup > 0:
        print(f"⏳ {args.warmup:.0f} s — PLACE-TOI à 60-100 cm (plage min 60cm !), de face")
        time.sleep(args.warmup)
    print("📸 Mesure en cours...")

    if args.save:
        os.makedirs(args.save, exist_ok=True)

    t0 = time.time()
    measured = []
    for i in range(args.frames):
        ir_rgb, depth = get_ir_depth(p)
        if ir_rgb is None:
            continue
        h, w = ir_rgb.shape[:2]
        img = mp_image(image_format=mp.ImageFormat.SRGB,
                       data=np.ascontiguousarray(ir_rgb))
        ts = int((time.time() - t0) * 1000)
        results = face_mesh.detect_for_video(img, ts)
        if not results.face_landmarks:
            if i % 15 == 0:
                print(f"  [{i}] visage non détecté...")
            continue
        lm = results.face_landmarks[0]

        pts = {}
        ok = True
        for name, idx in (("OG", IRIS_LEFT), ("OD", IRIS_RIGHT)):
            u, v = int(lm[idx].x * w), int(lm[idx].y * h)
            u = min(max(u, 0), w - 1)
            v = min(max(v, 0), h - 1)
            z = depth[v, u]
            if z <= 0 or z > 3000:  # invalide ou > 3m
                # Essayer une fenêtre 5x5 autour (bruit/local)
                win = depth[max(0, v-2):v+3, max(0, u-2):u+3]
                vals = win[win > 0]
                if vals.size >= 3:
                    z = float(np.median(vals))
                else:
                    ok = False
                    break
            pts[name] = pixel_to_3d(u, v, z)
        if not ok:
            continue

        # DP 3D = distance euclidienne entre pupilles
        dp3d = np.linalg.norm(pts["OG"] - pts["OD"])
        measured.append(dp3d)
        if i % 10 == 0 or len(measured) == 1:
            print(
                f"  [{i}] OG({pts['OG'][0]:.0f},{pts['OG'][1]:.0f},{pts['OG'][2]:.0f}) "
                f"OD({pts['OD'][0]:.0f},{pts['OD'][1]:.0f},{pts['OD'][2]:.0f}) "
                f"→ DP3D = {dp3d:.1f} mm"
            )

        if args.save and len(measured) % 10 == 1:
            vis = ir_rgb.copy()
            for name, idx in (("OG", IRIS_LEFT), ("OD", IRIS_RIGHT)):
                u, v = int(lm[idx].x * w), int(lm[idx].y * h)
                cv2.circle(vis, (u, v), 4, (0, 255, 0), -1)
                cv2.putText(vis, name, (u + 6, v), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            cv2.putText(vis, f"DP3D={dp3d:.1f}mm", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.imwrite(os.path.join(args.save, f"frame_{len(measured):03d}.jpg"), vis)

        if len(measured) >= 30:
            break

    p.stop()
    if measured:
        arr = np.array(measured)
        print("\n=== RÉSULTAT ===")
        print(f"Mesures : {len(arr)}")
        print(f"DP3D médiane : {np.median(arr):.1f} mm")
        print(f"DP3D moyenne : {arr.mean():.1f} mm (σ={arr.std():.1f})")
        print(f"Min/Max : {arr.min():.1f} / {arr.max():.1f} mm")
    else:
        print("Aucune mesure valide — visage non détecté, trop proche (<60cm) ou trop loin.")
    print("OK")


if __name__ == "__main__":
    main()
