#!/usr/bin/env python3
"""
Prototype vertex + angle pantoscopique — analyse du profil de profondeur.

Pipeline : COLOR 1280x720 MJPG + DEPTH 320x240 Y11 simultanés.
Le visage est de PROFIL avec les lunettes (monture).
On analyse la coupe de profondeur le long de l'axe œil → verre pour
repérer : sommet cornéen (min local) + marche du plan du verre.

Usage : ./backend/run_orbbec.sh backend/profil_vertex.py --save /tmp/profil_vx
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
    Config, Context, FormatConvertFilter, OBConvertFormat, OBFormat,
    OBSensorType, Pipeline,
)

DEPTH_CM_TO_MM = 10.0  # échelle Astra Pro : valeurs en cm

# Intrinsèques nominales
# COLOR 1280x720 : FOV 73.5°H × 59.5°V
W_C, H_C = 1280, 720
FX_C = (W_C / 2) / np.tan(np.radians(73.5 / 2))   # ≈ 858
FY_C = (H_C / 2) / np.tan(np.radians(59.5 / 2))   # ≈ 629
CX_C, CY_C = W_C / 2, H_C / 2

# DEPTH/IR 320x240 : FOV 60°H × 49.5°V
W_D, H_D = 320, 240
FX_D = (W_D / 2) / np.tan(np.radians(60 / 2))     # ≈ 277
FY_D = (H_D / 2) / np.tan(np.radians(49.5 / 2))   # ≈ 260
CX_D, CY_D = W_D / 2, H_D / 2


def get_pipeline():
    ctx = Context()
    if ctx.query_devices().get_count() == 0:
        print("❌ Caméra non détectée")
        sys.exit(1)
    p = Pipeline()
    cfg = Config()
    pl_c = p.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
    cfg.enable_stream(pl_c.get_video_stream_profile(1280, 720, OBFormat.MJPG, 30))
    pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
    p.start(cfg)
    conv = FormatConvertFilter()
    conv.set_format_convert_format(OBConvertFormat.MJPG_TO_RGB888)
    return p, conv


def get_frames(p, conv):
    for _ in range(20):
        fs = p.wait_for_frames(1500)
        if fs is None:
            continue
        cf, df = fs.get_color_frame(), fs.get_depth_frame()
        if cf is None or df is None:
            continue
        rgb = conv.process(cf)
        wc, hc = rgb.get_width(), rgb.get_height()
        color = np.frombuffer(rgb.get_data(), dtype=np.uint8).reshape(hc, wc, 3)
        wd, hd = df.get_width(), df.get_height()
        depth = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(hd, wd)
        depth = depth.astype(np.float32) * DEPTH_CM_TO_MM
        return color, depth
    return None, None


def color_to_depth_px(u, v):
    """Mappe un pixel color → pixel depth (approximation coaxiale par FOV).
    Les 2 caméras ont des FOV différents mais sont ~coaxiales."""
    # angle par rapport au centre color
    ax = (u - CX_C) / FX_C
    ay = (v - CY_C) / FY_C
    ud = int(CX_D + FX_D * ax)
    vd = int(CY_D + FY_D * ay)
    return max(0, min(ud, W_D - 1)), max(0, min(vd, H_D - 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", metavar="DIR", help="sauvegarder frames annotées")
    ap.add_argument("--warmup", type=float, default=10.0)
    ap.add_argument("--frames", type=int, default=800)
    args = ap.parse_args()

    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "models", "face_landmarker.task")
    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO, num_faces=1,
        output_face_blendshapes=False, output_facial_transformation_matrixes=False,
    )
    fm = vision.FaceLandmarker.create_from_options(options)

    p, conv = get_pipeline()
    print(f"🚀 COLOR {W_C}x{H_C} + DEPTH {W_D}x{H_D} — profil vertex")
    if args.warmup > 0:
        print(f"⏳ {args.warmup:.0f}s — PROFIL à 60-80cm avec LUNETTES (monture)")
        time.sleep(args.warmup)
    print("📸 Capture + analyse...")

    if args.save:
        os.makedirs(args.save, exist_ok=True)

    t0 = time.time()
    best = None
    for i in range(args.frames):
        color, depth = get_frames(p, conv)
        if color is None:
            continue
        img = mp.Image(image_format=mp.ImageFormat.SRGB,
                       data=np.ascontiguousarray(color))
        res = fm.detect_for_video(img, int((time.time() - t0) * 1000))
        if not res.face_landmarks:
            continue
        lm = res.face_landmarks[0]

        # Heuristique profil : un œil écrasé (largeur faible)
        wD = abs(lm[33].x - lm[133].x)
        wG = abs(lm[362].x - lm[263].x)
        ratio = min(wD, wG) / max(wD, wG) if max(wD, wG) > 0 else 0
        if ratio >= 0.5:
            continue  # pas un profil

        # Zone oculaire : centre entre les 2 yeux
        ex = (lm[33].x + lm[133].x + lm[362].x + lm[263].x) / 4
        ey = (lm[33].y + lm[133].y + lm[362].y + lm[263].y) / 4
        uc, vc = int(ex * W_C), int(ey * H_C)
        ud, vd = color_to_depth_px(uc, vc)

        # Analyse du profil de profondeur le long de l'axe horizontal (X)
        # autour de la ligne des yeux, dans la depth
        row = depth[max(0, vd - 8):vd + 8, :]
        col_valid = np.nanmean(np.where(row > 0, row, np.nan), axis=0)
        if np.isnan(col_valid).all():
            continue
        # Trouver le sommet cornéen : min local de profondeur dans la zone
        # centrale (autour de l'œil)
        x0 = max(0, ud - 80)
        x1 = min(W_D, ud + 80)
        zone = col_valid[x0:x1]
        zi = np.nanargmin(zone)
        corn_x_d = x0 + zi
        corn_z = zone[zi]
        # Marche du verre : chercher une discontinuité (gradient) devant l'œil
        grad = np.abs(np.diff(col_valid[max(0, ud - 60):ud + 60]))
        gmax = np.nanargmax(grad) if grad.size else 0
        vx_x_d = max(0, ud - 60) + gmax

        best = (color.copy(), depth.copy(), lm, (uc, vc), (ud, vd),
                (corn_x_d, corn_z), (vx_x_d, col_valid[vx_x_d] if vx_x_d < W_D else 0),
                ratio)
        if i % 10 == 0:
            print(f"  [{i}] profil ratio={ratio:.2f} cornée@({corn_x_d},{corn_z:.0f}mm) "
                  f"verre@({vx_x_d},{col_valid[vx_x_d] if vx_x_d < W_D else 0:.0f}mm)")
        if i > 60:
            break

    p.stop()
    if best is None:
        print("❌ Pas de profil détecté")
        sys.exit(1)
    color, depth, lm, (uc, vc), (ud, vd), (cx_d, cz), (vx_d, vz), ratio = best

    # === Calcul vertex ===
    # Vertex = distance cornée → plan du verre, le long de l'axe X (mm)
    vertex_mm = abs(vz - cz) if vz > 0 else float("nan")
    # Version pixel : échelle mm/px de la depth
    px_mm = cz / FX_D if cz > 0 else float("nan")
    vertex_px = abs(vx_d - cx_d) * px_mm if (vx_d > 0 and px_mm == px_mm) else float("nan")

    print("\n=== RÉSULTAT PROFIL VERTEX ===")
    print(f"Profil: {'G' if wD < wG else 'D'} (ratio yeux={ratio:.2f})")
    print(f"Sommet cornéen (depth): px=({cx_d},{vd}) z={cz:.0f}mm")
    print(f"Marche verre (depth):   px=({vx_d},{vd}) z={vz:.0f}mm")
    print(f"Vertex (via profondeur): {vertex_mm:.1f} mm")
    print(f"Vertex (via pixels):     {vertex_px:.1f} mm")

    if args.save:
        # Annotation color
        vis = cv2.cvtColor(color, cv2.COLOR_RGB2BGR).copy()
        cv2.circle(vis, (uc, vc), 6, (0, 0, 255), -1)
        cv2.putText(vis, "oeil", (uc + 8, vc), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
        cv2.imwrite(os.path.join(args.save, "color.jpg"), vis)
        # Annotation depth (avec les 2 points)
        visd = cv2.cvtColor((depth / np.nanmax(depth) * 255).astype(np.uint8),
                            cv2.COLOR_GRAY2BGR) if np.nanmax(depth) > 0 else depth.astype(np.uint8)
        cv2.circle(visd, (cx_d, vd), 4, (0, 0, 255), -1)
        cv2.circle(visd, (vx_d, vd), 4, (0, 255, 0), -1)
        cv2.imwrite(os.path.join(args.save, "depth.jpg"), visd)
        # Coupe de profondeur
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        row = depth[max(0, vd - 8):vd + 8, :]
        col = np.nanmean(np.where(row > 0, row, np.nan), axis=0)
        plt.figure(figsize=(10, 4))
        plt.plot(col)
        plt.axvline(cx_d, color="r", label="cornée")
        plt.axvline(vx_d, color="g", label="verre")
        plt.xlabel("pixel depth X"); plt.ylabel("profondeur (mm)")
        plt.legend(); plt.title(f"Coupe profondeur ligne des yeux — vertex={vertex_mm:.1f}mm")
        plt.tight_layout()
        plt.savefig(os.path.join(args.save, "coupe.png"))
        print(f"💾 annoté dans {args.save}")
    print("OK")


if __name__ == "__main__":
    main()
