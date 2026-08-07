#!/usr/bin/env python3
"""
Test rapide caméra stéréo ELP 3840x1080 — Smart Optica
=======================================================
Capture le flux, sépare les 2 moitiés (L/R), vérifie la synchro,
mesure la baseline en pixels, et prépare la calibration stéréo.

Usage:
    python3 stereo_test.py                      # capture + diagnostics
    python3 stereo_test.py --fps                # mesure le framerate réel
    python3 stereo_test.py --calibrate          # calibration stéréo (damier)
    python3 stereo_test.py --depth              # teste le calcul de disparité

La caméra sort un flux UNIQUE 3840x1080 côte-à-côte :
    moitié gauche  (x 0..1919) = objectif GAUCHE
    moitié droite  (x 1920..3839) = objectif DROIT
"""

import argparse
import sys
import time

import cv2
import numpy as np

BASELINE_MM = 65.0        # écart physique entre les 2 objectifs (Driss, août 2026)
CHESSBOARD = (9, 6)       # damier intérieur (colonnes, lignes) — adapter à ton impression
SQUARE_MM = 24.0          # taille d'une case du damier en mm

DEVICE = 0                # /dev/video0 par défaut


def open_camera(device=DEVICE, width=3840, height=1080):
    cap = cv2.VideoCapture(device)
    if not cap.isOpened():
        print(f"❌ Impossible d'ouvrir /dev/video{device}")
        print("   Vérifier : ls /dev/video*  |  v4l2-ctl --list-devices")
        sys.exit(1)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    return cap


def split_stereo(frame):
    """3840x1080 → (gauche, droite) chacun 1920x1080."""
    h, w = frame.shape[:2]
    return frame[:, : w // 2], frame[:, w // 2 :]


def test_capture():
    print(f"📷 Ouverture /dev/video{DEVICE} ...")
    cap = open_camera()
    ok, frame = cap.read()
    if not ok or frame is None:
        print("❌ Lecture échouée")
        sys.exit(1)

    h, w = frame.shape[:2]
    print(f"✅ Frame capturée : {w}x{h}")

    left, right = split_stereo(frame)
    lh, lw = left.shape[:2]
    print(f"   Gauche : {lw}x{lh} | Droite : {lw}x{lh}")

    # Sauvegarde pour inspection visuelle
    cv2.imwrite("/tmp/stereo_left.jpg", left)
    cv2.imwrite("/tmp/stereo_right.jpg", right)
    cv2.imwrite("/tmp/stereo_full.jpg", frame)
    print("   💾 Sauvegardées : /tmp/stereo_left.jpg, stereo_right.jpg, stereo_full.jpg")

    # Différence de luminosité moyenne entre les 2 objectifs (diagnostic)
    l_mean = left.mean()
    r_mean = right.mean()
    print(f"   Luminosité moyenne — G: {l_mean:.1f} | D: {r_mean:.1f} "
          f"{'✅' if abs(l_mean - r_mean) < 15 else '⚠️ écart important (auto-exposure à régler)'}")

    cap.release()
    print("\n🎯 Prochaine étape : inspecter les 2 images (vérifier même netteté, même cadrage).")


def test_fps():
    print(f"📷 Mesure du framerate réel (5s) ...")
    cap = open_camera()
    n, t0 = 0, time.time()
    while time.time() - t0 < 5:
        ok, frame = cap.read()
        if ok:
            n += 1
    dt = time.time() - t0
    print(f"✅ {n} frames en {dt:.1f}s → {n / dt:.1f} fps")
    print("   (MJPEG USB 2.0 : attendu ~30-60fps ; si <15fps, réduire la résolution)")
    cap.release()


def calibrate():
    """Calibration stéréo : capture N paires de damier, résout stéréoCalibrate."""
    import glob
    import os

    print("🎯 Calibration stéréo — imprime un damier 9×6, case ~24mm")
    print("   Monte-le bien à plat, sous bon éclairage. Captures de 20 paires...")
    cap = open_camera()
    objp = np.zeros((CHESSBOARD[0] * CHESSBOARD[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0 : CHESSBOARD[0], 0 : CHESSBOARD[1]].T.reshape(-1, 2)
    objp *= SQUARE_MM

    objpoints, imgpoints_l, imgpoints_r = [], [], []
    pairs = 0
    while pairs < 20:
        ok, frame = cap.read()
        if not ok:
            continue
        left, right = split_stereo(frame)
        gray_l = cv2.cvtColor(left, cv2.COLOR_BGR2GRAY)
        gray_r = cv2.cvtColor(right, cv2.COLOR_BGR2GRAY)
        ret_l, corners_l = cv2.findChessboardCorners(gray_l, CHESSBOARD, None)
        ret_r, corners_r = cv2.findChessboardCorners(gray_r, CHESSBOARD, None)
        if ret_l and ret_r:
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
            corners_l = cv2.cornerSubPix(gray_l, corners_l, (11, 11), (-1, -1), criteria)
            corners_r = cv2.cornerSubPix(gray_r, corners_r, (11, 11), (-1, -1), criteria)
            objpoints.append(objp)
            imgpoints_l.append(corners_l)
            imgpoints_r.append(corners_r)
            pairs += 1
            print(f"   ✓ Paire {pairs}/20 — damier trouvé des 2 côtés")
        # Petit aperçu
        disp = np.hstack([left, right])
        cv2.imshow("Calibration (espace = suivant)", cv2.resize(disp, (1280, 360)))
        if cv2.waitKey(1) & 0xFF == ord(" "):
            continue
    cap.release()
    cv2.destroyAllWindows()

    if len(objpoints) < 10:
        print("❌ Pas assez de paires valides — vérifier damier, éclairage, mise au point")
        sys.exit(1)

    print("⚙️ Résolution stéréoCalibrate ...")
    gray = cv2.cvtColor(cv2.imread("/tmp/stereo_left.jpg"), cv2.COLOR_BGR2GRAY) \
        if os.path.exists("/tmp/stereo_left.jpg") else np.zeros((1080, 1920), np.uint8)
    K = np.eye(3)
    D = np.zeros((1, 5))
    rms, K1, D1, K2, D2, R, T, E, F = cv2.stereoCalibrate(
        objpoints, imgpoints_l, imgpoints_r,
        K, D, K, D, gray.shape[::-1],
        flags=cv2.CALIB_FIX_INTRINSIC,
    )
    print(f"✅ RMS = {rms:.3f} px  (idéalement < 0.5)")

    R1, R2, P1, P2, Q, _, _ = cv2.stereoRectify(
        K1, D1, K2, D2, gray.shape[::-1], R, T, alpha=0)

    np.savez("/tmp/stereo_calib.npz",
             K1=K1, D1=D1, K2=K2, D2=D2, R=R, T=T,
             R1=R1, R2=R2, P1=P1, P2=P2, Q=Q,
             baseline_mm=BASELINE_MM)
    print("💾 Calibration sauvegardée : /tmp/stereo_calib.npz")
    print(f"   Baseline détectée (mm) : {np.linalg.norm(T) * SQUARE_MM:.1f}")


def test_depth():
    """Disparité SGBM sur une paire — validation rapide."""
    data = np.load("/tmp/stereo_calib.npz")
    left = cv2.imread("/tmp/stereo_left.jpg")
    right = cv2.imread("/tmp/stereo_right.jpg")
    if left is None or right is None:
        print("❌ Lance d'abord : python3 stereo_test.py (capture) + --calibrate")
        sys.exit(1)
    h, w = left.shape[:2]
    map1l, map2l = cv2.initUndistortRectifyMap(data["K1"], data["D1"], data["R1"], data["P1"], (w, h), cv2.CV_32FC1)
    map1r, map2r = cv2.initUndistortRectifyMap(data["K2"], data["D2"], data["R2"], data["P2"], (w, h), cv2.CV_32FC1)
    gl = cv2.remap(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY), map1l, map2l, cv2.INTER_LINEAR)
    gr = cv2.remap(cv2.cvtColor(right, cv2.COLOR_BGR2GRAY), map1r, map2r, cv2.INTER_LINEAR)

    sgbm = cv2.StereoSGBM_create(
        minDisparity=0, numDisparities=128, blockSize=11,
        P1=8 * 3 * 11**2, P2=32 * 3 * 11**2, uniquenessRatio=10,
        speckleWindowSize=100, speckleRange=32,
    )
    disp = sgbm.compute(gl, gr).astype(np.float32) / 16.0
    disp[disp <= 0] = np.nan
    # Profondeur = f * B / disparité
    f_px = data["P1"][0, 0]
    depth = (f_px * data["baseline_mm"] / disp) / 1000.0  # mètres
    valid = depth[~np.isnan(depth)]
    if len(valid):
        print(f"✅ Disparité OK — profondeur médiane : {np.median(valid):.2f} m "
              f"(plage {np.nanpercentile(valid,5):.2f} – {np.nanpercentile(valid,95):.2f} m)")
    else:
        print("⚠️ Pas de disparité valide — vérifier calibration et contraste de la scène")
    cv2.imwrite("/tmp/stereo_disp.png", (disp * 4).astype(np.uint8))
    print("💾 /tmp/stereo_disp.png (disparité, plus clair = plus proche)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", action="store_true")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--depth", action="store_true")
    ap.add_argument("--device", type=int, default=DEVICE)
    args = ap.parse_args()
    DEVICE = args.device
    if args.fps:
        test_fps()
    elif args.calibrate:
        calibrate()
    elif args.depth:
        test_depth()
    else:
        test_capture()
