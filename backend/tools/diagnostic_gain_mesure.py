"""Ajouter une 5e mire AMÉLIORE-T-IL la mesure de la DP ? (bruit de détection inclus)

C'est la seule question qui compte pour décider d'une évolution du clip. On simule :
  • le clip vu de biais, à 500 mm, focale 1200 px, pose aléatoire ;
  • du bruit gaussien de 1 px sur TOUTES les détections (mires et pupilles) ;
  • deux méthodes :
      (a) ACTUELLE  : échelle GLOBALE = 100 mm / span des extrêmes ;
      (b) POSÉE     : pose estimée sur les mires, puis reconstruction des pupilles
                      dans leur plan (13 mm devant celui des mires) ;
  • et on compare l'erreur sur la DP binoculaire (64 mm) et monoculaire (32 mm).
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from scipy.optimize import minimize_scalar  # noqa: E402

CX, CY, F, D = 1512.0, 2016.0, 4880.0, 400.0
VERTEX = 13.0            # distance mires → plan des pupilles, en mm
DP_BINO, DP_MONO = 64.0, 32.0

CONFIGS = {
    "actuel (4 mires)": [(-50, 3), (0, 3), (50, 3), (30, 17)],
    "5 mires (+ miroir -30,17)": [(-50, 3), (0, 3), (50, 3), (30, 17), (-30, 17)],
}


def pose_aleatoire(rng):
    return (rng.uniform(-8, 8), rng.uniform(-18, 18), rng.uniform(-12, 12))


def matrice(rot):
    ax, ay, az = (math.radians(a) for a in rot)
    Rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def projete(pts_clip, R, f=F, d=D, profondeur=0.0):
    """Plan frontal à la distance d, décalé de `profondeur` (mm) vers la caméra."""
    out = []
    for (x, z) in pts_clip:
        Q = R @ np.array([x, -z, profondeur]) + np.array([0.0, 0.0, d])
        out.append((f * Q[0] / Q[2] + CX, f * Q[1] / Q[2] + CY))
    return np.array(out, np.float64)


def estime_pose(obj, img):
    def res(f):
        K = np.array([[f, 0, CX], [0, f, CY], [0, 0, 1]], np.float64)
        try:
            ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
        except cv2.error:
            return 1e6
        if not ok:
            return 1e6
        p, _ = cv2.projectPoints(obj, rv, tv, K, None)
        return float(np.sqrt(np.mean(np.sum((p.reshape(-1, 2) - img) ** 2, axis=1))))
    r = minimize_scalar(res, bounds=(1000.0, 25000.0), method="bounded",
                        options={"xatol": 1.0})
    f = float(r.x)
    K = np.array([[f, 0, CX], [0, f, CY], [0, 0, 1]], np.float64)
    ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
    if not ok or rv is None or rv.size != 3:
        return None
    R, _ = cv2.Rodrigues(rv)
    return f, R, tv.flatten()


def reconstruit(px, f, R, t, profondeur):
    """Intersection du rayon (pixel → centre optique) avec le plan des pupilles.

    Pose : X_cam = R·X_obj + t, les mires étant dans le plan X_obj_z = 0. La normale
    de ce plan, vue de la caméra, est donc n = R[:, 2]. Les pupilles sont `profondeur`
    mm en AVANT des mires (vers la caméra), soit X_obj_z = +profondeur, d'où :

        n · P = n · t + profondeur

    ⚠️ Le point délicat est ce signe : écrire `t[2] − profondeur` place le plan du
    MAUVAIS côté et fausse toute la comparaison des méthodes.
    """
    n = R[:, 2]
    X = np.array([(px[0] - CX) / f, (px[1] - CY) / f, 1.0])
    denom = n @ X
    if abs(denom) < 1e-12:
        return None
    s = (n @ t + profondeur) / denom
    return s * X


rng = np.random.default_rng(20260928)
N = 200
print(f"{N} tirages · bruit 1 px sur chaque détection · vertex {VERTEX:.0f} mm · "
      f"focale {F:.0f} px")
print(f"{'configuration':28s} {'méthode':>10s} {'erreur DP bino':>15s} "
      f"{'erreur DP mono':>15s}")
print("-" * 74)

for nom, pts in CONFIGS.items():
    obj = np.array([[x, -z, 0.0] for x, z in pts], np.float64)
    pup = [(-32.0, 32.0), (0.0, 32.0), (32.0, 32.0)]   # OD, milieu, OG (au niveau des yeux)

    err_a_bino, err_a_mono, err_b_bino, err_b_mono = [], [], [], []
    for _ in range(N):
        rot = pose_aleatoire(rng)
        R = matrice(rot)
        img_mires = projete(pts, R) + rng.normal(0, 1.0, (len(pts), 2))
        img_pup = projete([(x, z) for x, z in pup], R, profondeur=VERTEX) \
            + rng.normal(0, 1.0, (3, 2))

        # (a) échelle globale, méthode actuelle
        span_px = img_mires[2][0] - img_mires[0][0]
        ech = 100.0 / span_px if span_px > 0 else float("nan")
        dp_bino_a = abs(img_pup[2][0] - img_pup[0][0]) * ech
        dp_mono_a = abs(img_pup[2][0] - img_pup[1][0]) * ech
        err_a_bino.append(abs(dp_bino_a - DP_BINO))
        err_a_mono.append(abs(dp_mono_a - DP_MONO))

        # (b) méthode posée
        pose = estime_pose(obj, img_mires)
        if pose is None:
            continue
        f_est, R_est, t_est = pose
        P = [reconstruit(p, f_est, R_est, t_est, VERTEX) for p in img_pup]
        if any(p is None for p in P):
            continue
        dp_bino_b = float(np.linalg.norm(P[2] - P[0]))
        dp_mono_b = float(np.linalg.norm(P[2] - P[1]))
        err_b_bino.append(abs(dp_bino_b - DP_BINO))
        err_b_mono.append(abs(dp_mono_b - DP_MONO))

    for label, a, b in (("(a) actuelle", err_a_bino, err_a_mono),
                        ("(b) posée", err_b_bino, err_b_mono)):
        if not a:
            print(f"{nom:28s} {label:>10s} {'AUCUNE pose exploitable':>31s}")
            continue
        ea = sum(a) / len(a)
        eb = sum(b) / len(b)
        print(f"{nom:28s} {label:>10s} {ea:13.2f} mm {eb:13.2f} mm")
    print()
