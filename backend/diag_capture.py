#!/usr/bin/env python3
"""Diagnostic : sauvegarde une frame color + depth alignée pour inspection."""
import os, sys
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
sys.path.insert(0, SP)
import numpy as np
import cv2
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline,
                         AlignFilter, OBStreamType)

c = Context()
dl = c.query_devices()
dev = dl.get_device_by_index(0)
print(f"Device: {dev.get_device_info().get_name()}")

p = Pipeline()
cfg = Config()
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
pl_c = p.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
cfg.enable_stream(pl_c.get_video_stream_profile(320, 0, OBFormat.RGB, 30))
p.start(cfg)
aligner = AlignFilter(OBStreamType.COLOR_STREAM)
print("Pipeline démarré — capture de référence...")

best = None
for i in range(30):
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    df, cf = fs.get_depth_frame(), fs.get_color_frame()
    if df is None or cf is None:
        continue
    adf = aligner.process(df)
    w, h = adf.get_width(), adf.get_height()
    depth = np.frombuffer(adf.get_data(), dtype=np.uint16).reshape(h, w)
    wc, hc = cf.get_width(), cf.get_height()
    color = np.frombuffer(cf.get_data(), dtype=np.uint8).reshape(hc, wc, 3)
    valid = (depth > 0).sum()
    if best is None or valid > best[0]:
        best = (valid, color.copy(), depth.copy())
    if i % 5 == 0:
        print(f"  frame {i}: color={wc}x{hc} depth valides={valid}")

_, color, depth = best
# Sauvegarder color
bgr = cv2.cvtColor(color, cv2.COLOR_RGB2BGR)
cv2.imwrite("/tmp/diag_color.jpg", bgr)
print("✅ /tmp/diag_color.jpg")
# Sauvegarder depth (visualisable : normaliser 0-8000mm → 0-255)
depth8 = np.clip(depth, 0, 2000).astype(np.float32) / 2000 * 255
cv2.imwrite("/tmp/diag_depth.jpg", depth8.astype(np.uint8))
print("✅ /tmp/diag_depth.jpg")
print(f"Profondeur: min={depth[depth>0].min() if (depth>0).any() else 0} max={depth.max()}")
p.stop()
print("OK")
