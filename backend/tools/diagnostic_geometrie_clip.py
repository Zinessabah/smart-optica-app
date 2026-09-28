"""QUELLE GÉOMÉTRIE DE MIRES rend la pose (et donc l'échelle) déterminable ?

Constat de départ : le quadruplet facial actuel (3 mires alignées + 1) est une
configuration DÉGÉNÉRÉE — la focale et la distance sont corrélées, aucune solution
n'est privilégiée (cf. tools/diagnostic_pose.py).

On teste ici des évolutions PLAUSIBLES du clip, en mesurant sur projections
synthétiques à focale connue (1200 px, 500 mm) si l'estimation redevient fiable.
Le critère est l'erreur sur la focale, sur 6 poses différentes.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from scipy.optimize import minimize_scalar  # noqa: E402

CX, CY = 1512.0, 2016.0
F_VRAIE, D = 1200.0, 500.0
POSES = [(0, 8, 0), (0, 15, 5), (5, 10, -8), (8, -12, 6), (-6, 18, 0), (10, 5, 12)]


def projete(points_3d, rot, d=D, f=F_VRAIE):
    ax, ay, az = (math.radians(a) for a in rot)
    Rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    R = Rz @ Ry @ Rx
    out = []
    for P in points_3d:
        # plan FRONTAL : (x, z) avec z VERTICAL
        Q = R @ np.array([P[0], -P[1], 0.0]) + np.array([0.0, 0.0, d])
        out.append((float(f * Q[0] / Q[2] + CX), float(f * Q[1] / Q[2] + CY)))
    return np.array(out, np.float64)


def estime_f(obj, img, planaire):
    flag = cv2.SOLVEPNP_IPPE if planaire else cv2.SOLVEPNP_ITERATIVE

    def res(f):
        K = np.array([[f, 0, CX], [0, f, CY], [0, 0, 1]], np.float64)
        try:
            ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=flag)
        except cv2.error:
            return 1e6
        if not ok:
            return 1e6
        p, _ = cv2.projectPoints(obj, rv, tv, K, None)
        return float(np.sqrt(np.mean(np.sum((p.reshape(-1, 2) - img) ** 2, axis=1))))

    r = minimize_scalar(res, bounds=(400.0, 20000.0), method="bounded",
                        options={"xatol": 1.0})
    return float(r.x), float(r.fun)


# Repère : plan facial à Y = 0, barre à Z = 0 (les cotes du clip sont ramenées là)
CONFIGS = {
    "actuel : G,C,D + haute(30,17)":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (30, 17))],
    "5e mire MIROIR (-30,17)":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (30, 17), (-30, 17))],
    "5e mire SOUS la barre (30,-11)":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (30, 17), (30, -11))],
    "5e mire SOUS le centre (0,-11)":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (30, 17), (0, -11))],
    "5e + 6e : miroir + sous centre":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (30, 17), (-30, 17), (0, -11))],
    "haute décalée EN X (60,17)":
        [(x, z) for x, z in ((-50, 3), (0, 3), (50, 3), (60, 17))],
}

print(f"Focale vraie {F_VRAIE:.0f} px · distance {D:.0f} mm · {len(POSES)} poses")
print(f"{'configuration':40s} {'erreur focale (moy.)':>21s} {'pire cas':>10s}")
print("-" * 74)
for nom, pts in CONFIGS.items():
    obj = np.array([[x, -z, 0.0] for x, z in pts], np.float64)
    planaire = True   # toutes ces mires appartiennent au plan frontal du clip
    erreurs = []
    for rot in POSES:
        img = projete(pts, rot)
        f_est, _ = estime_f(obj, img, planaire)
        erreurs.append(100.0 * abs(f_est - F_VRAIE) / F_VRAIE)
    moy = sum(erreurs) / len(erreurs)
    verdict = "OK" if moy < 10 else ("limite" if moy < 30 else "DÉGÉNÉRÉ")
    print(f"{nom:40s} {moy:19.1f}%  {max(erreurs):8.1f}%   {verdict}")
