#!/usr/bin/env python3
"""
Test caméra Orbbec Astra Pro 3D via SDK v1 (pyorbbecsdk 1.10.16).

⚠️ IMPORTANT : l'Astra Pro (PID 0x0403) est un modèle OpenNI protocol (2017).
Elle n'est PAS supportée par Orbbec SDK v2 (UVC protocol) — utiliser le SDK v1.
Installation (venv backend) :
    pip install pyorbbecsdk2  → NE FONCTIONNE PAS pour l'Astra Pro
    SDK v1 : cloner https://github.com/orbbec/pyorbbecsdk (branche main),
             compiler le binding pybind11 (cmake + pybind11), copier
             pyorbbecsdk.cpython-312-*.so + libOrbbecSDK.so* dans site-packages.

Règles udev (déjà installées) :
    99-obsensor-libusb.rules → MODE 0666, GROUP video pour 2bc5:0403/0501

Usage :
    python orbbec_test.py --probe      # détection + capteurs + profils
    python orbbec_test.py --depth      # capture depth 640x480@30 Y11 (FPS)
    python orbbec_test.py --color      # capture color 640x480@30 RGB
    python orbbec_test.py --range      # distribution des distances
    python orbbec_test.py --save out/  # sauvegarde depth .npy + color .jpg

Résultats mesurés (août 2026, USB 2.0) :
    - Depth 640x480@30 Y11 : ~28 FPS, 82% pixels valides
    - Color 640x480@30 RGB : OK (aussi 1280x960 MJPEG via V4L2 /dev/video0)
    - Depth+Color 640x480 simultanés : PAS de frames (bande passante USB2.0
      + frame sync non supporté) → alterner ou réduire à 320x240
    - Plage utile mesurée : 63mm - 6m (médiane scène bureau ~330mm)
"""
import argparse
import os
import sys
import time

import numpy as np

from pyorbbecsdk import (
    Config, Context, OBFormat, OBSensorType, Pipeline,
)

SP = os.path.expanduser(
    "~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages"
)
if SP not in sys.path:
    sys.path.insert(0, SP)

DEPTH_W, DEPTH_H = 640, 480
DEPTH_FMT = OBFormat.Y11   # format natif Astra Pro (Y11/Y12, pas Y16)
COLOR_W, COLOR_H = 640, 480


def get_device():
    ctx = Context()
    dl = ctx.query_devices()
    if dl.get_count() == 0:
        print("❌ Aucun appareil Orbbec. Vérifier : lsusb (2bc5:0403) + règles udev.")
        sys.exit(1)
    return ctx, dl.get_device_by_index(0)


def probe():
    ctx, dev = get_device()
    info = dev.get_device_info()
    print(f"Appareil : {info.get_name()} — SN {info.get_serial_number()}")
    sl = dev.get_sensor_list()
    print(f"Capteurs : {sl.get_count()}")
    p = Pipeline()
    for i in range(sl.get_count()):
        st = sl.get_sensor_by_index(i).get_type()
        pl = p.get_stream_profile_list(st)
        print(f"  {st} ({pl.get_count()} profils) :")
        for pi in range(min(pl.get_count(), 12)):
            vp = pl.get_stream_profile_by_index(pi).as_video_stream_profile()
            print(f"    {vp.get_width()}x{vp.get_height()}@{vp.get_fps()} {vp.get_format()}")


def capture_depth(frames=45, timeout_ms=2000):
    ctx, dev = get_device()
    p = Pipeline()
    cfg = Config()
    pl = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    prof = pl.get_video_stream_profile(DEPTH_W, 0, DEPTH_FMT, 30)
    cfg.enable_stream(prof)
    print(f"🚀 Depth {DEPTH_W}x{DEPTH_H}@{prof.get_fps()} {prof.get_format()}")
    p.start(cfg)
    t0 = time.time()
    n = 0
    for _ in range(frames * 2):
        fs = p.wait_for_frames(timeout_ms)
        if fs is None:
            continue
        df = fs.get_depth_frame()
        if df is None:
            continue
        n += 1
        if n <= 3 or n % 15 == 0:
            w, h = df.get_width(), df.get_height()
            data = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(h, w)
            cx, cy = w // 2, h // 2
            zone = data[cy - 30:cy + 30, cx - 30:cx + 30]
            print(f"  f{n}: centre={data[cy, cx]}mm zone[{zone.min()}-{zone.max()}]")
        if n >= frames:
            break
    dt = time.time() - t0
    print(f"FPS : {n / dt:.1f}")
    p.stop()
    return n / dt


def capture_color(frames=45, timeout_ms=2000):
    ctx, dev = get_device()
    p = Pipeline()
    cfg = Config()
    pl = p.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
    prof = pl.get_video_stream_profile(COLOR_W, 0, OBFormat.RGB, 30)
    cfg.enable_stream(prof)
    print(f"🚀 Color {COLOR_W}x{COLOR_H}@{prof.get_fps()} {prof.get_format()}")
    p.start(cfg)
    t0 = time.time()
    n = 0
    last = None
    for _ in range(frames * 2):
        fs = p.wait_for_frames(timeout_ms)
        if fs is None:
            continue
        cf = fs.get_color_frame()
        if cf is None:
            continue
        n += 1
        last = cf
        if n % 15 == 0:
            print(f"  f{n}: COLOR {cf.get_width()}x{cf.get_height()}")
        if n >= frames:
            break
    dt = time.time() - t0
    print(f"FPS : {n / dt:.1f}")
    p.stop()
    if last is not None:
        w, h = last.get_width(), last.get_height()
        arr = np.frombuffer(last.get_data(), dtype=np.uint8).reshape(h, w, 3)
        cv2_ok = False
        try:
            import cv2
            cv2.imwrite("/tmp/orbbec_color.jpg", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
            cv2_ok = True
        except Exception:
            pass
        print(f"Image couleur sauvegardée: /tmp/orbbec_color.jpg ({'cv2' if cv2_ok else 'sans cv2'})")
    return n / dt


def depth_range():
    ctx, dev = get_device()
    p = Pipeline()
    cfg = Config()
    pl = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    prof = pl.get_video_stream_profile(DEPTH_W, 0, DEPTH_FMT, 30)
    cfg.enable_stream(prof)
    p.start(cfg)
    best, best_score = None, 0
    for _ in range(20):
        fs = p.wait_for_frames(1500)
        if fs is None:
            continue
        df = fs.get_depth_frame()
        if df is None:
            continue
        w, h = df.get_width(), df.get_height()
        data = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(h, w)
        valid = (data > 0) & (data < 8000)
        score = valid.sum()
        if score > best_score:
            best_score, best = score, data.copy()
    p.stop()
    if best is None:
        print("AUCUNE frame valide"); return
    print(f"Frame {best.shape[1]}x{best.shape[0]}, pixels valides : "
          f"{best_score}/{best.size} ({100 * best_score / best.size:.0f}%)")
    valid = best[(best > 0) & (best < 8000)]
    if valid.size:
        print(f"Plage : {valid.min()}mm - {valid.max()}mm | Médiane {np.median(valid):.0f}mm")
        hist, _ = np.histogram(valid, bins=[0, 300, 600, 900, 1200, 2000, 4000, 8000])
        labels = ["0-30cm", "30-60cm", "60-90cm", "90-120cm", "1.2-2m", "2-4m", "4-8m"]
        for cnt, lab in zip(hist, labels):
            bar = "#" * int(40 * cnt / valid.size)
            print(f"  {lab:9s}: {cnt:6d} px {bar}")
    print("OK")


def save(outdir):
    os.makedirs(outdir, exist_ok=True)
    ctx, dev = get_device()
    p = Pipeline()
    cfg = Config()
    pl = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    prof = pl.get_video_stream_profile(DEPTH_W, 0, DEPTH_FMT, 30)
    cfg.enable_stream(prof)
    p.start(cfg)
    for _ in range(10):
        fs = p.wait_for_frames(2000)
        if fs is None:
            continue
        df = fs.get_depth_frame()
        if df is None:
            continue
        w, h = df.get_width(), df.get_height()
        data = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(h, w)
        np.save(os.path.join(outdir, "orbbec_depth.npy"), data)
        print(f"✅ Depth sauvegardé: {outdir}/orbbec_depth.npy ({w}x{h}, "
              f"valides {(data>0).sum()})")
        break
    p.stop()
    print("OK")


def main():
    ap = argparse.ArgumentParser(description="Test Orbbec Astra Pro (SDK v1)")
    ap.add_argument("--probe", action="store_true", help="détection + profils")
    ap.add_argument("--depth", action="store_true", help="capture depth FPS")
    ap.add_argument("--color", action="store_true", help="capture color FPS")
    ap.add_argument("--range", action="store_true", help="distribution distances")
    ap.add_argument("--save", metavar="DIR", help="sauvegarder depth .npy")
    args = ap.parse_args()

    if args.probe:
        probe()
    if args.depth:
        capture_depth()
    if args.color:
        capture_color()
    if args.range:
        depth_range()
    if args.save:
        save(args.save)
    if not any([args.probe, args.depth, args.color, args.range, args.save]):
        ap.print_help()


if __name__ == "__main__":
    main()
