#!/usr/bin/env python3
"""Test simultanéité depth+color à basse résolution (USB 2.0)."""
import sys, os, time
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
os.environ["LD_LIBRARY_PATH"] = SP
sys.path.insert(0, SP)
import numpy as np
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline,
                         AlignFilter, OBStreamType)

c = Context()
dl = c.query_devices()
if dl.get_count() == 0:
    print("NO DEVICE"); sys.exit(1)
dev = dl.get_device_by_index(0)
print(f"Device: {dev.get_device_info().get_name()}")

p = Pipeline()
cfg = Config()
# Depth 320x240 Y11 30fps
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
dprof = pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30)
cfg.enable_stream(dprof)
print(f"Depth: {dprof.get_width()}x{dprof.get_height()}@{dprof.get_fps()}")
# Color 320x240 RGB 30fps (réduit pour la bande passante)
pl_c = p.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
cprof = pl_c.get_video_stream_profile(320, 0, OBFormat.RGB, 30)
cfg.enable_stream(cprof)
print(f"Color: {cprof.get_width()}x{cprof.get_height()}@{cprof.get_fps()}")

try:
    p.start(cfg)
    print("🚀 Pipeline démarré")
except Exception as e:
    print(f"❌ start: {e}"); sys.exit(1)

aligner = AlignFilter(OBStreamType.COLOR_STREAM)
t0 = time.time()
n = 0
for i in range(60):
    fs = p.wait_for_frames(1500)
    if fs is None:
        continue
    df = fs.get_depth_frame()
    cf = fs.get_color_frame()
    if df is not None and cf is not None:
        n += 1
        if n <= 2 or n % 10 == 0:
            w, h = df.get_width(), df.get_height()
            data = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(h, w)
            valid = (data > 0).sum()
            print(f"  f{n}: DEPTH {w}x{h} (valides {valid}) + COLOR {cf.get_width()}x{cf.get_height()}")
    if n >= 30:
        break
dt = time.time() - t0
print(f"FPS (frames complètes): {n/dt:.1f}")

# Test AlignFilter sur une frame
if n > 0:
    fs = p.wait_for_frames(1500)
    if fs:
        df = fs.get_depth_frame()
        if df:
            try:
                adf = aligner.process(df)
                w, h = adf.get_width(), adf.get_height()
                data = np.frombuffer(adf.get_data(), dtype=np.uint16).reshape(h, w)
                print(f"✅ AlignFilter: depth alignée {w}x{h}, valides {(data>0).sum()}")
            except Exception as e:
                print(f"⚠️ AlignFilter échec: {e}")
p.stop()
print("OK")
