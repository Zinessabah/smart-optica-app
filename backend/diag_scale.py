#!/usr/bin/env python3
"""Test d'échelle depth : mesure à distance connue.
Place un objet (feuille A4 / main) à des distances mesurées au mètre ruban.
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

print("=" * 50)
print("TEST D'ÉCHELLE DEPTH")
print("1. Place un OBJET (main, feuille) à 30 cm de la caméra (mètre ruban)")
print("2. Reste immobile 3 s, on enregistre")
print("3. Recommence à 60 cm, puis à 100 cm")
print("=" * 50)

def mesure(label):
    print(f"\n→ Place l'objet à {label}... (3 s)")
    time.sleep(3)
    vals = []
    for i in range(10):
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
        # centre 40x40
        reg = z[h//2-20:h//2+20, w//2-20:w//2+20]
        pos = reg[reg > 0]
        if pos.size > 10:
            vals.extend(pos.tolist())
    if vals:
        a = np.array(vals)
        print(f"  {label}: moyenne={a.mean():.0f}mm médiane={np.median(a):.0f}mm "
              f"[{a.min():.0f}-{a.max():.0f}] n={a.size}")
    else:
        print(f"  {label}: AUCUNE mesure valide")

mesure("30 cm")
mesure("60 cm")
mesure("100 cm")
p.stop()
print("\nOK — comparaison avec les distances réelles pour trouver l'échelle")
