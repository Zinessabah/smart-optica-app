"""Le critère de Zhang retrouve-t-il la focale sur une projection synthétique ?

On projette le plan des 4 mires faciales avec une pose et une focale CONNUES, puis on
vérifie que `focale_et_residu_rigidite` retrouve la focale et donne un résidu ~0.
Si ce test échoue, toute la démarche est à revoir — autant le savoir maintenant.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

import clip_geometry as cg  # noqa: E402

LARGEUR, HAUTEUR = 3024.0, 4032.0      # photo iPhone (portrait)


def projection(points_plan, f, d, rot_deg=(0.0, 0.0, 0.0), cx=None, cy=None):
    """Pose du plan (X, Z) dans le repère caméra, puis projection perspective."""
    cx = LARGEUR / 2 if cx is None else cx
    cy = HAUTEUR / 2 if cy is None else cy
    ax, ay, az = (math.radians(a) for a in rot_deg)
    Rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    R = Rz @ Ry @ Rx
    out = []
    for (X, Z) in points_plan:
        # plan des mires : Y = 0 dans ce repère, centré, puis posé à la distance d
        P = R @ np.array([X, 0.0, Z]) + np.array([0.0, 0.0, d])
        out.append((f * P[0] / P[2] + cx, f * P[1] / P[2] + cy))
    return out, (cx, cy)


plan = cg.points_plan_facial()
print(f"plan des 4 mires (X, Z) = {plan}")
print(f"{'pose (rx,ry,rz)':>18s} {'f vraie':>8s} {'f estimée':>10s} "
      f"{'erreur':>8s} {'résidu':>9s}")
print("-" * 60)

for rot in ((0, 0, 6), (0, 12, 0), (5, 10, -8), (0, 25, 0), (10, 0, 15), (0, 40, 0)):
    for f_vraie in (1200.0, 2600.0):
        pts, (cx, cy) = projection(plan, f_vraie, 500.0, rot)
        try:
            H = cg.homographie_4_points(plan, pts)
        except ValueError as e:
            print(f"{str(rot):>18s} {f_vraie:8.0f}   {e}")
            continue
        f_est, residu = cg.focale_et_residu_rigidite(H, cx, cy)
        err = 100.0 * (f_est - f_vraie) / f_vraie if f_est else float("nan")
        print(f"{str(rot):>18s} {f_vraie:8.0f} {f_est:10.1f} {err:7.1f}% {residu:9.2e}")

print("\n— vue frontale (rot 0) : la focale n'est PAS estimable (h20 = h21 = 0) —")
try:
    pts0, (cx0, cy0) = projection(plan, 2000.0, 500.0, (0, 0, 0))
    cg.homographie_4_points(plan, pts0)
    print("  homographie calculée (inattendu)")
except ValueError as e:
    print(f"  {e} → on retombe sur les rapports de distances, qui SONT valides "
          f"sans perspective")

# Témoin : une mire DÉPLACÉE de 8 px doit faire grimper le résidu
pts, (cx, cy) = projection(plan, 2000.0, 500.0, (0, 12, 0))
H_ok = cg.homographie_4_points(plan, pts)
print(f"\nnominal (mire à sa place)  : résidu {cg.focale_et_residu_rigidite(H_ok, cx, cy)[1]:.2e}")
for deplacement in (2, 4, 8, 15):
    abime = list(pts)
    abime[3] = (abime[3][0] + deplacement, abime[3][1] + deplacement)
    H = cg.homographie_4_points(plan, abime)
    _, r = cg.focale_et_residu_rigidite(H, cx, cy)
    print(f"4e mire décalée de {deplacement:2d} px  : résidu {r:.2e}")
