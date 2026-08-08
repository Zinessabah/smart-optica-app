#!/usr/bin/env python3
"""Test temps réel : approcher la main → le min de la depth doit diminuer.
Affiche aussi le histogramme pour comprendre la plage réelle.
"""
import os, sys, time
SP = os.path.expanduser("~/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages")
sys.path.insert(0, SP)
import numpy as np
from pyorbbecsdk import (Context, Config, OBSensorType, OBFormat, Pipeline)

c = Context()
dl = c.query_devices()
p = Pipeline()
cfg = Config()
pl_d = p.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
cfg.enable_stream(pl_d.get_video_stream_profile(320, 0, OBFormat.Y11, 30))
p.start(cfg)

print("=" * 55)
print("TEMPS RÉEL — approche ta MAIN lentement devant la caméra")
print("(de loin vers près, ~5 s par position)")
print("=" * 55)
t0 = time.time()
try:
    while time.time() - t0 < 40:
        fs = p.wait_for_frames(1500)
        if fs is None:
            continue
        df = fs.get_depth_frame()
        if df is None:
            continue
        w, h = df.get_width(), df.get_height()
        raw = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(h, w)
        scale = df.get_depth_scale()
        z = raw.astype(np.float32) * scale
        pos = z[z > 0]
        if pos.size < 100:
            continue
        # stats globales
        pmin = pos.min()
        pmed = np.median(pos)
        pmax = pos.max()
        # % dans différentes plages
        p_300 = (pos < 300).mean() * 100
        p_600 = ((pos >= 300) & (pos < 600)).mean() * 100
        p_1000 = ((pos >= 600) & (pos < 1000)).mean() * 100
        p_2000 = ((pos >= 1000) & (pos < 2000)).mean() * 100
        p_big = (pos >= 2000).mean() * 100
        print(f"  min={pmin:5.0f} med={pmed:5.0f} max={pmax:5.0f}mm | "
              f"<30cm:{p_300:.0f}% 30-60:{p_600:.0f}% 60-100:{p_1000:.0f}% 1-2m:{p_2000:.0f}% >2m:{p_big:.0f}%")
except KeyboardInterrupt:
    pass
p.stop()
print("OK")
