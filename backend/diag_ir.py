#!/usr/bin/env python3
"""Test : détection visage MediaPipe dans l'image IR (alignée avec depth par construction)."""
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
# IR + depth simultanés (même capteur → alignés)
pl_ir = p.get_stream_profile_list(OBSensorType.IR_SENSOR)
cfg.enable_stream(pl_ir.get_video_stream_profile(320, 0, OBFormat.Y10, 30))
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
try:
    p.start(cfg)
    print("🚀 IR + Depth démarrés")
except Exception as e:
    print(f"❌ start: {e}"); sys.exit(1)

print("⏳ 10s — place-toi devant la caméra...")
time.sleep(10)
print("Test détection IR...")

t0 = time.time()
detected = 0
for i in range(400):
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    irf = fs.get_ir_frame()
    df = fs.get_depth_frame()
    if irf is None or df is None:
        continue
    w, h = irf.get_width(), irf.get_height()
    ir_raw = np.frombuffer(irf.get_data(), dtype=np.uint16).reshape(h, w)
    # Y10 → 8 bits (shift 2)
    ir8 = np.clip(ir_raw >> 2, 0, 255).astype(np.uint8)
    rgb = np.stack([ir8, ir8, ir8], axis=-1)  # faux RGB
    dw, dh = df.get_width(), df.get_height()
    depth = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(dh, dw)

    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    res = face_mesh.detect_for_video(img, int((time.time()-t0)*1000))
    if res.face_landmarks:
        detected += 1
        lm = res.face_landmarks[0]
        if detected <= 3 or detected % 10 == 0:
            for name, idx in (("OG", 468), ("OD", 473)):
                u, v = int(lm[idx].x * w), int(lm[idx].y * h)
                u = min(max(u, 0), w-1); v = min(max(v, 0), h-1)
                # IR et depth : mêmes dimensions ? sinon mapping
                z = depth[v, u] if (dw == w and dh == h) else depth[min(int(v*dh/h),dh-1), min(int(u*dw/w),dw-1)]
                print(f"  [{detected}] {name} px=({u},{v}) z={z}mm")
            if detected == 1:
                vis = cv2.cvtColor(rgb, cv2.COLOR_GRAY2BGR) if False else np.stack([ir8,ir8,ir8],axis=-1)
                for name, idx in (("OG",468),("OD",473)):
                    u, v = int(lm[idx].x*w), int(lm[idx].y*h)
                    cv2.circle(vis, (u,v), 4, (0,255,0), -1)
                cv2.imwrite("/tmp/ir_face.jpg", vis)
                print("  💾 /tmp/ir_face.jpg")
    if detected >= 30:
        break
p.stop()
print(f"IR détections: {detected}/30")
print("OK")
