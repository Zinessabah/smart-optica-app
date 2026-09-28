"""La POSE (R, t) + focale est-elle déterminable là où l'homographie échoue ?

GEOMETRIE : le clip est un plan FRONTAL (perpendiculaire a l'axe optique). Sa cote z
est VERTICALE — l'ecrire en 3e composante reviendrait a dire que la mire haute est
14 mm plus LOIN au lieu de 14 mm plus HAUT, ce qui n'est pas la geometrie du clip.

Constat : les 3 mires de la rangée sont COLINEAIRES (Z = 3 dans le plan), or une
homographie exige 4 points dont aucun 3 alignés → matrice 8x8 de rang 7, solution non
unique. La pose n'a que 6 degrés de liberté pour 8 contraintes : elle reste
déterminable, et la focale se cherche en 1D en minimisant le résidu de reprojection.

Vérification sur projections synthétiques à focale CONNUE.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from scipy.optimize import minimize_scalar  # noqa: E402

import clip_geometry as cg  # noqa: E402

CX, CY = 1512.0, 2016.0
PLAN = cg.points_plan_facial()
OBJ = np.array([[X, Z, 0.0] for X, Z in PLAN], np.float64)


def projection(points, f, d, rot):
    ax, ay, az = (math.radians(a) for a in rot)
    Rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    R = Rz @ Ry @ Rx
    return [(float(f * (R @ np.array([X, -Z, 0.0]) + np.array([0.0, 0.0, d]))[0]
                   / (R @ np.array([X, -Z, 0.0]) + np.array([0.0, 0.0, d]))[2] + CX),
             float(f * (R @ np.array([X, -Z, 0.0]) + np.array([0.0, 0.0, d]))[1]
                   / (R @ np.array([X, -Z, 0.0]) + np.array([0.0, 0.0, d]))[2] + CY))
            for (X, Z) in points]


def residu_pour_f(f, img_pts):
    """Résidu RMS de reprojection (px) pour une focale donnée, pose réestimée."""
    K = np.array([[f, 0, CX], [0, f, CY], [0, 0, 1]], np.float64)
    try:
        ok, rvec, tvec = cv2.solvePnP(OBJ, img_pts, K, None,
                                      flags=cv2.SOLVEPNP_IPPE)
    except cv2.error:
        return 1e6
    if not ok:
        return 1e6
    proj, _ = cv2.projectPoints(OBJ, rvec, tvec, K, None)
    return float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - img_pts) ** 2, axis=1))))


def estime(img_pts, f_min=500.0, f_max=12000.0):
    r = minimize_scalar(lambda f: residu_pour_f(f, img_pts), bounds=(f_min, f_max),
                        method="bounded", options={"xatol": 1.0})
    return float(r.x), float(r.fun)


print(f"{'pose':>16s} {'f vraie':>8s} {'f estimee':>10s} {'erreur':>8s} {'residu px':>10s}")
print("-" * 58)
for rot in ((0, 0, 6), (0, 12, 0), (5, 10, -8), (0, 25, 0), (10, 0, 15)):
    for f_vraie in (1200.0, 2600.0):
        img = np.array(projection(PLAN, f_vraie, 500.0, rot), np.float64)
        f_est, res = estime(img)
        print(f"{str(rot):>16s} {f_vraie:8.0f} {f_est:10.1f} "
              f"{100*(f_est-f_vraie)/f_vraie:7.1f}% {res:10.4f}")

print("\n— dégradation : on décale la 4e mire, le résidu doit grimper —")
img = np.array(projection(PLAN, 2000.0, 500.0, (5, 10, -8)), np.float64)
f0, r0 = estime(img)
print(f"  nominal                : f={f0:7.1f}  résidu {r0:.4f} px")
for d in (2, 4, 8, 15):
    abime = img.copy()
    abime[3] += (d, d)
    f1, r1 = estime(abime)
    print(f"  4e mire décalée de {d:2d} px : f={f1:7.1f}  résidu {r1:7.4f} px")
