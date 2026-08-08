#!/usr/bin/env python3
"""Diagnostic : où la depth est-elle valide sur le visage ? (lunettes = réflexion IR)"""
import os, sys, time
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
sys.path.insert(0, SP)
import numpy as np
import cv2
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline)

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions

model_path = os.path.expanduser(
    "~/hermes-workspace/smart-optica-app/backend/models/face_landmarker.task")
options = vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=model_path),
    running_mode=vision.RunningMode.VIDEO, num_faces=1,
    output_face_blendshapes=False, output_facial_transformation_matrixes=False,
)
face_mesh = vision.FaceLandmarker.create_from_options(options)

c = Context()
dl = c.query_devices()
dev = dl.get_device_by_index(0)
p = Pipeline()
cfg = Config()
pl_ir = p.get_stream_profile_list(OBSensorType.IR_SENSOR)
cfg.enable_stream(pl_ir.get_video_stream_profile(320, 0, OBFormat.Y10, 30))
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
p.start(cfg)
print("⏳ 10s — place-toi à 70-80 CM de la caméra (hors plage minimale 60cm)...")
time.sleep(10)
print("Analyse zones depth...")

# Indices landmarks utiles (modèle 478)
# 1 = nez (tip), 33 = oeil droit coin ext, 263 = oeil gauche coin ext,
# 133 = oeil droit coin int, 362 = oeil gauche coin int, 10 = front, 152 = menton
ZONES = [("front", 10), ("nez", 1), ("menton", 152), ("joueD", 123), ("joueG", 352),
         ("sourcilD", 107), ("sourcilG", 336), ("larmeD", 168), ("larmeG", 397)]

t0 = time.time()
best = None
for i in range(300):
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    irf, df = fs.get_ir_frame(), fs.get_depth_frame()
    if irf is None or df is None:
        continue
    w, h = irf.get_width(), irf.get_height()
    ir_raw = np.frombuffer(irf.get_data(), dtype=np.uint16).reshape(h, w)
    ir8 = np.clip(ir_raw >> 2, 0, 255).astype(np.uint8)
    rgb = np.stack([ir8, ir8, ir8], axis=-1)
    dw, dh = df.get_width(), df.get_height()
    depth = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(dh, dw)

    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    res = face_mesh.detect_for_video(img, int((time.time()-t0)*1000))
    if not res.face_landmarks:
        continue
    lm = res.face_landmarks[0]
    # score = pixels valides dans le visage
    face_mask = np.zeros_like(depth)
    for ld in res.face_landmarks[0]:
        u, v = int(ld.x * dw), int(ld.y * dh)
        if 0 <= u < dw and 0 <= v < dh:
            face_mask[v, u] = 1
    score = int((face_mask > 0).sum())
    if best is None or score > best[0]:
        best = (score, depth.copy(), ir8.copy(), lm)
    if i > 250:
        break

score, depth, ir8, lm = best
if lm is None:
    print("❌ Aucun visage détecté — vérifie position/distance")
    sys.exit(1)
print(f"Dimensions: IR={w}x{h} Depth={dw}x{dh}")
print(f"Pixels visage valides: {score} / {(depth>0).sum()} total depth")
# Grille 3x3 autour du visage : validité
print("\n=== Validité depth autour du visage ===")
for name, idx in ZONES:
    u, v = int(lm[idx].x * dw), int(lm[idx].y * dh)
    u = min(max(u, 0), dw-1); v = min(max(v, 0), dh-1)
    # fenêtre 9x9 autour
    win = depth[max(0,v-4):v+5, max(0,u-4):u+5]
    vals = win[win > 0]
    if vals.size:
        print(f"  {name:9s} ({u:3d},{v:3d}): z={vals.mean():.0f}mm [{vals.min()}-{vals.max()}] (n={vals.size}/81)")
    else:
        print(f"  {name:9s} ({u:3d},{v:3d}): INVALIDE (0)")

# yeux : fenêtre plus large (verres réfléchissants)
for name, idx in (("OG", 468), ("OD", 473)):
    u, v = int(lm[idx].x * dw), int(lm[idx].y * dh)
    win = depth[max(0,v-10):v+11, max(0,u-10):u+11]
    vals = win[win > 0]
    print(f"  oeil {name} fenêtre 21x21: {'z=' + str(vals.mean()):.0f}mm n={vals.size}/441" if vals.size else f"  oeil {name}: INVALIDE (0)")

p.stop()
print("OK")
