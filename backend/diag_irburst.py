#!/usr/bin/env python3
"""Capture IR brute pendant 20s (toutes les 2s) pour inspection visuelle."""
import os, sys, time
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
sys.path.insert(0, SP)
import numpy as np
import cv2
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline)

c = Context()
dl = c.query_devices()
p = Pipeline()
cfg = Config()
pl_ir = p.get_stream_profile_list(OBSensorType.IR_SENSOR)
cfg.enable_stream(pl_ir.get_video_stream_profile(320, 0, OBFormat.Y10, 30))
p.start(cfg)

outdir = "/tmp/irburst"
os.makedirs(outdir, exist_ok=True)
print("🎥 Capture IR 20s — BOUGE-TOI devant la caméra (60-100cm), tourne la tête")
t0 = time.time()
k = 0
while time.time() - t0 < 20:
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    irf = fs.get_ir_frame()
    if irf is None:
        continue
    w, h = irf.get_width(), irf.get_height()
    raw = np.frombuffer(irf.get_data(), dtype=np.uint16).reshape(h, w)
    ir8 = np.clip(raw >> 2, 0, 255).astype(np.uint8)
    cv2.imwrite(f"{outdir}/ir_{k:03d}.jpg", ir8)
    k += 1
    time.sleep(2)
p.stop()
print(f"✅ {k} frames sauvegardées dans {outdir}")
print("OK")
