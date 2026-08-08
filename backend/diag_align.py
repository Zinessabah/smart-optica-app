#!/usr/bin/env python3
"""Diagnostic : comparer depth brute vs alignée aux positions des pupilles."""
import os, sys, time
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
sys.path.insert(0, SP)
import numpy as np
import cv2
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline,
                         AlignFilter, OBStreamType)

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
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
pl_c = p.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
cfg.enable_stream(pl_c.get_video_stream_profile(320, 0, OBFormat.RGB, 30))
p.start(cfg)
aligner = AlignFilter(OBStreamType.COLOR_STREAM)
print("⏳ 10s — place-toi devant la caméra à ~40-50cm...")
time.sleep(10)
print("Mesure...")

t0 = time.time()
for i in range(400):
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    df, cf = fs.get_depth_frame(), fs.get_color_frame()
    if df is None or cf is None:
        continue
    # Depth brute (repère depth)
    dw, dh = df.get_width(), df.get_height()
    depth_raw = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(dh, dw)
    # Depth alignée (repère color)
    adf = aligner.process(df)
    aw, ah = adf.get_width(), adf.get_height()
    depth_al = np.frombuffer(adf.get_data(), dtype=np.uint16).reshape(ah, aw)
    # Color
    cw, ch = cf.get_width(), cf.get_height()
    color = np.frombuffer(cf.get_data(), dtype=np.uint8).reshape(ch, cw, 3)

    img = mp.Image(image_format=mp.ImageFormat.SRGB,
                   data=np.ascontiguousarray(color))
    res = face_mesh.detect_for_video(img, int((time.time()-t0)*1000))
    if not res.face_landmarks:
        continue
    lm = res.face_landmarks[0]
    for name, idx in (("OG", 468), ("OD", 473)):
        u, v = int(lm[idx].x * cw), int(lm[idx].y * ch)
        u = min(max(u, 0), cw-1); v = min(max(v, 0), ch-1)
        # Même pixel dans les deux depth (si même résolution)
        z_raw = depth_raw[v, u] if (dw == cw and dh == ch) else depth_raw[min(int(v*dh/ch), dh-1), min(int(u*dw/cw), dw-1)]
        z_al = depth_al[v, u] if (aw == cw and ah == ch) else depth_al[min(int(v*ah/ch), ah-1), min(int(u*aw/cw), aw-1)]
        # Profondeur au centre de la scène
        zc_raw = depth_raw[dh//2, dw//2]
        zc_al = depth_al[ah//2, aw//2]
        print(f"[{i}] {name} px=({u},{v}) z_raw={z_raw} z_al={z_al} | centre: raw={zc_raw} al={zc_al}")
    if i > 250:
        break
p.stop()
print("OK")
