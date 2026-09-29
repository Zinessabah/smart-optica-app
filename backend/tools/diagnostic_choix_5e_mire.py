"""QUELLE POSITION pour la 5e mire ? Robustesse au bruit de détection.

Les essais « sans bruit » donnaient 0 % d'erreur de focale partout : ils ne départagent
rien. Avec du bruit (1 px sur chaque détection, comme en vrai), c'est l'ÉTALEMENT de la
configuration qui décide — d'où ce comparatif, qui doit fixer les cotes.

Mesure retenue : l'erreur sur la DP binoculaire (64 mm) reconstruite dans le plan des
pupilles, 13 mm devant le clip. C'est la grandeur métier qui compte.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from tools.diagnostic_gain_mesure import (  # noqa: E402
    CX, CY, F, D, VERTEX, DP_BINO, DP_MONO,
    matrice, pose_aleatoire, projete, estime_pose, reconstruit,
)

BASE = [(-50, 3), (0, 3), (50, 3), (30, 17)]      # les 4 mires actuelles
PUP = [(-32.0, 32.0), (0.0, 32.0), (32.0, 32.0)]  # OD, milieu, OG au niveau des yeux

CANDIDATS = {
    "référence : 4 mires (actuel)": None,
    "+ (-30 ; 17)   miroir pur": (-30, 17),
    "+ (-30 ; 22)": (-30, 22),
    "+ (-30 ; 26)": (-30, 26),
    "+ (-30 ; 30)   plus haut": (-30, 30),
    "+ (-40 ; 26)   plus écarté": (-40, 26),
    "+ (-18 ; 26)   plus serré": (-18, 26),
    "+ (30 ; 28)    même montant": (30, 28),
    "+ (-30 ; 26) ET (30 ; 30)": ("deux", (-30, 26), (30, 30)),
}

N = 120
rng = np.random.default_rng(20260928)
tirages = [matrice(pose_aleatoire(rng)) for _ in range(N)]

print(f"{N} tirages · bruit 1 px · {F:.0f} px · {D:.0f} mm · vertex {VERTEX:.0f} mm")
print(f"{'configuration':30s} {'moyenne':>9s} {'médiane':>9s} {'p95':>9s}")
print("-" * 62)
for nom, ajout in CANDIDATS.items():
    pts = list(BASE)
    if ajout is None:
        pass
    elif ajout[0] == "deux":
        pts += [ajout[1], ajout[2]]
    else:
        pts.append(ajout)
    obj = np.array([[x, -z, 0.0] for x, z in pts], np.float64)

    errs_b, errs_m = [], []
    for R in tirages:
        # bruit de détection : 1 px d'écart-type sur chaque mire ET sur chaque pupille
        img_m = projete(pts, R) + rng.normal(0, 1.0, (len(pts), 2))
        img_p = projete(PUP, R, profondeur=VERTEX) + rng.normal(0, 1.0, (3, 2))
        pose = estime_pose(obj, img_m)
        if pose is None:
            continue
        f_est, R_est, t_est = pose
        P = [reconstruit(p, f_est, R_est, t_est, VERTEX) for p in img_p]
        if any(p is None for p in P):
            continue
        errs_b.append(abs(float(np.linalg.norm(P[2] - P[0])) - DP_BINO))
        errs_m.append(abs(float(np.linalg.norm(P[2] - P[1])) - DP_MONO))
    if not errs_b:
        print(f"{nom:30s} {'aucune pose exploitable':>31s}")
        continue
    # médiane et 95e centile : plus robustes que le max, qu'une seule pose
    # pathologique suffit à faire exploser alors que la distribution est bonne.
    print(f"{nom:30s} {sum(errs_b)/len(errs_b):7.2f} mm "
          f"{np.median(errs_b):7.2f} mm {np.percentile(errs_b, 95):7.2f} mm "
          f"(mono {sum(errs_m)/len(errs_m):.2f})")
