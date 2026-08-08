#!/usr/bin/env python3
"""TEST DÉCISIF d'échelle : feuille A4 remplissant tout le cadre.
Driss tient la feuille à 50cm, 80cm, 120cm (mètre ruban) → on lit la médiane.
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
print("TEST DÉCISIF ÉCHELLE")
print("Tiens une FEUILLE A4 devant la caméra, remplissant tout le cadre")
print("(comme un écran). À chaque signal, place-la à la distance indiquée")
print("(mètre ruban) et reste immobile 4 s.")
print("=" * 55)

def mesure(label):
    print(f"\n🖐️  → FEUILLE à {label} — tiens-la bien, remplis le cadre... (4 s)")
    time.sleep(4)
    vals = []
    for i in range(15):
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
        if pos.size > 1000:
            vals.extend(np.percentile(pos, [10, 50, 90]).tolist())
    if vals:
        a = np.array(vals)
        # 3 percentiles par frame → séparer
        p10, p50, p90 = a[0::3], a[1::3], a[2::3]
        print(f"  📏 {label}: P10={p10.mean():.0f}  P50(med)={p50.mean():.0f}  P90={p90.mean():.0f} mm")
    else:
        print(f"  {label}: AUCUNE mesure")

mesure("50 cm")
mesure("80 cm")
mesure("120 cm")
p.stop()
print("\nOK — P50 vs distances réelles → échelle = P50 / distance")
