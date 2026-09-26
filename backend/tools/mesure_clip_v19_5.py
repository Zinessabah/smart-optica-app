#!/usr/bin/env python3
"""Mesure du clip v19.5 directement sur les STL exportés.

But : que chaque cote utilisée par la détection (`backend/clip_geometry.py`) soit
**revérifiable** sur la géométrie réellement imprimée, sans refaire le travail à la main.

Méthode
-------
Les 10 mires sont des aléages de révolution (Ø12,1) : un cylindre ne porte des sommets
qu'à ses **lèvres**. On isole donc les sommets de la lèvre située dans le plan de la face
(le collier, Ø13,6) et on **ajuste un cercle** (moindre carrés) pour retrouver l'AXE de la
mire — les aléages sont entaillés par les encoches d'ergot, un simple barycentre serait
biaisé de 0,2 à 0,9 mm (vérifié : c'est ce qui donnait 25,57 mm au lieu de 25,00).

Le motif est mesuré sur les deux carreaux noirs, séparés par composantes connexes.

Dépendances : numpy uniquement (les composantes connexes sont faites à la main pour ne pas
imposer scipy aux tests).

Usage :
    python tools/mesure_clip_v19_5.py [dossier_des_stl]

API :
    mesurer(chemin_corps, chemin_motif=None) -> dict
"""

import math
import sys
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# Bandes d'échantillonnage (identifiées sur le maillage) : elles isolent la lèvre
# utile sans ramasser le bâti (barre, bras, pince).
BANDE_FACIALE_Y = (0.02, 0.09)        # lèvre du collier facial, au plan de la face
BANDE_LATERALE_X = (76.70, 76.80)     # lèvre du collier latéral, au plan de la face


# ════════════════════════════════════════════════════════════════════════════
# Lecture du maillage
# ════════════════════════════════════════════════════════════════════════════

def lire_sommets(chemin: str) -> np.ndarray:
    """STL ASCII -> sommets uniques (N,3)."""
    out = []
    with open(chemin, "r", errors="replace") as f:
        for ligne in f:
            ligne = ligne.strip()
            if ligne.startswith("vertex"):
                p = ligne.split()
                out.append((float(p[1]), float(p[2]), float(p[3])))
    return np.unique(np.array(out, dtype=float), axis=0)


# ════════════════════════════════════════════════════════════════════════════
# Composantes connexes (sans scipy)
# ════════════════════════════════════════════════════════════════════════════

def composantes(pts: np.ndarray, rayon: float, min_sommets: int = 20) -> List[np.ndarray]:
    """Regroupe les sommets reliés à `rayon` près (grille + parcours en largeur)."""
    if len(pts) == 0:
        return []
    # cellule = rayon : deux points distants d'au plus `rayon` sont forcément dans
    # des cellules voisines (±1). Avec cellule = rayon/2 il en faudrait ±2, sinon
    # les anneaux se fragmentent (bug trouvé en comparant à scipy).
    cellule = rayon
    cases: Dict[Tuple[int, int, int], List[int]] = {}
    for i, p in enumerate(pts):
        c = tuple(np.floor(p / cellule).astype(int))
        cases.setdefault(c, []).append(i)

    vus = np.zeros(len(pts), dtype=bool)
    groupes = []
    for depart in range(len(pts)):
        if vus[depart]:
            continue
        vus[depart] = True
        file = [depart]
        membres = []
        while file:
            i = file.pop()
            membres.append(i)
            ci = np.floor(pts[i] / cellule).astype(int)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for j in cases.get((ci[0] + dx, ci[1] + dy, ci[2] + dz), ()):
                            if not vus[j] and np.linalg.norm(pts[j] - pts[i]) <= rayon:
                                vus[j] = True
                                file.append(j)
        if len(membres) >= min_sommets:
            groupes.append(pts[membres])
    return groupes


def ajuster_cercle(pts2d: np.ndarray) -> Tuple[np.ndarray, float, float]:
    """Ajustement algébrique (Kåsa). Retourne (centre, rayon, résidu max)."""
    x, y = pts2d[:, 0], pts2d[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(x))]
    sol, *_ = np.linalg.lstsq(A, x**2 + y**2, rcond=None)
    centre = sol[:2]
    rayon = math.sqrt(max(sol[2] + centre[0] ** 2 + centre[1] ** 2, 0.0))
    residu = float(np.abs(np.linalg.norm(pts2d - centre, axis=1) - rayon).max())
    return centre, rayon, residu


# ════════════════════════════════════════════════════════════════════════════
# Mesures
# ════════════════════════════════════════════════════════════════════════════

def _mires_dans_bande(corps: np.ndarray, axe: int, bande: Sequence[float],
                      plan: Tuple[int, int]) -> List[Dict]:
    i, j = plan
    sel = corps[(corps[:, axe] >= bande[0]) & (corps[:, axe] <= bande[1])]
    mires = []
    for g in composantes(sel, rayon=1.5, min_sommets=20):
        centre, rayon, residu = ajuster_cercle(g[:, (i, j)])
        mires.append({"plan": (round(float(centre[0]), 3), round(float(centre[1]), 3)),
                      "diametre_mm": round(2 * rayon, 3),
                      "residu_mm": round(residu, 3),
                      "sommets": len(g)})
    mires.sort(key=lambda m: (round(m["plan"][0], 1), round(m["plan"][1], 1)))
    return mires


def mesurer(chemin_corps: str, chemin_motif: Optional[str] = None) -> Dict:
    """Mesure le clip. Cotes en mm, dans le repère du clip (X largeur, Y profondeur, Z hauteur)."""
    corps = lire_sommets(chemin_corps)
    mn, mx = corps.min(axis=0), corps.max(axis=0)

    faciales = _mires_dans_bande(corps, 1, BANDE_FACIALE_Y, (0, 2))     # alésage selon Y
    laterales = {}
    for signe, nom in ((+1, "+x"), (-1, "-x")):
        bande = (BANDE_LATERALE_X[0], BANDE_LATERALE_X[1]) if signe > 0 \
            else (-BANDE_LATERALE_X[1], -BANDE_LATERALE_X[0])
        laterales[nom] = _mires_dans_bande(corps, 0, bande, (1, 2))     # alésage selon X

    def ecarts(points):
        out = {}
        for a in range(len(points)):
            for b in range(a + 1, len(points)):
                d = math.dist(points[a], points[b])
                out[f"{points[a]}↔{points[b]}"] = round(d, 3)
        return out

    res = {
        "bbox": {"x": round(float(mx[0] - mn[0]), 3),
                 "y": round(float(mx[1] - mn[1]), 3),
                 "z": round(float(mx[2] - mn[2]), 3)},
        "faciales": faciales,
        "ecartements_faciaux": ecarts([m["plan"] for m in faciales]),
        "laterales": laterales,
        "ecartements_lateraux": {cote: ecarts([m["plan"] for m in mires])
                                 for cote, mires in laterales.items()},
    }

    if chemin_motif:
        res["motif"] = _mesurer_motif(chemin_motif)
    return res


def _mesurer_motif(chemin: str) -> Dict:
    """Mesure le damier 2×2 : côté de carreau, offset de quadrant, Ø du motif.

    Géométrie du motif : 2 carreaux NOIRS en diagonale dont les coins INTÉRIEURS se
    rejoignent à l'AXE de la mire, l'ensemble rogné à Ø10. Les 3 autres coins de chaque
    carreau tombent à r = 5,01 > 5,00 : ils sont donc coupés par le cercle. Conséquence
    mesurable : chaque carreau ne garde qu'UN sommet « intérieur » (au centre de la mire),
    et tout le reste de sa frontière est l'arc de cercle.

    Donc : `etendue` (les 2 carreaux bout à bout) = 2 × côté, et le côté se lit des deux
    façons indépendantes qui doivent concorder — (a) l'étendue / 2, (b) la distance du
    coin intérieur (≈0) au bord du motif (≈5,00).
    """
    noir = lire_sommets(chemin)
    damiers = composantes(noir, rayon=5.5, min_sommets=12)
    etendues, coins_par_damier, diams = [], [], []
    ecarts_coin = []
    for g in damiers:
        cc = g[:, :2]
        boite = cc.min(axis=0), cc.max(axis=0)
        centre = (boite[0] + boite[1]) / 2.0
        etendues.append(float(boite[1][0] - boite[0][0]))
        diams.append(float(np.ptp(cc[:, 0])))
        r = np.linalg.norm(cc - centre, axis=1)
        coins = cc[r < 0.5]                    # sommets intérieurs (coins des carreaux)
        coins_par_damier.append(len(coins))
        if len(coins):
            # le coin intérieur est à l'axe : sa distance au bord du motif = le côté
            ecarts_coin.append(float(np.abs(cc - centre).max()
                                     - np.linalg.norm(coins - centre, axis=1).mean()))
    carreau = float(np.mean(etendues)) / 2.0 if etendues else None
    return {
        "damiers": len(damiers),
        "carreaux": int(sum(coins_par_damier)) // 2 if coins_par_damier else 0,
        "carreau_mm": round(carreau, 3) if carreau else None,
        "carreau_par_coin_mm": round(float(np.mean(ecarts_coin)), 3) if ecarts_coin else None,
        "offset_mm": round(carreau / 2.0, 3) if carreau else None,
        "diametre_mm": round(float(np.mean(diams)), 3) if diams else None,
    }


# ════════════════════════════════════════════════════════════════════════════
# CLI
# ════════════════════════════════════════════════════════════════════════════

def main(argv: List[str]) -> int:
    dossier = argv[1] if len(argv) > 1 else "/home/driss/Documents"
    corps = f"{dossier}/clip_reference_v19_5_corps.stl"
    motif = f"{dossier}/clip_reference_v19_5_ins_damier_noir.stl"

    r = mesurer(corps, motif)
    print("=" * 72)
    print("MESURE DU CLIP v19.5 — sur les STL exportés")
    print("=" * 72)
    print(f"\nCorps : {r['bbox']['x']:.2f} × {r['bbox']['y']:.2f} × {r['bbox']['z']:.2f} mm")

    print("\nMIRES FACIALES (plan y = 0) :")
    for m in r["faciales"]:
        print(f"  x={m['plan'][0]:7.2f}  z={m['plan'][1]:6.2f}   Ø {m['diametre_mm']:5.2f} mm"
              f"   (résidu {m['residu_mm']:.3f})")
    print("  écartements :")
    for k, v in r["ecartements_faciaux"].items():
        if v > 1:
            print(f"    {k} : {v:.2f} mm")

    for cote, mires in r["laterales"].items():
        print(f"\nMIRES LATÉRALES côté {cote} (plan |x| = 76,75) :")
        for m in mires:
            print(f"  y={m['plan'][0]:7.2f}  z={m['plan'][1]:6.2f}   Ø {m['diametre_mm']:5.2f} mm"
                  f"   (résidu {m['residu_mm']:.3f})")
        print("  écartements :")
        for k, v in r["ecartements_lateraux"][cote].items():
            print(f"    {k} : {v:.2f} mm")

    if "motif" in r:
        mo = r["motif"]
        print(f"\nMOTIF DAMIER : {mo['damiers']} damiers · {mo['carreaux']} carreaux noirs")
        print(f"  côté du carreau : {mo['carreau_mm']:.2f} mm (étendue/2)"
              f" · {mo['carreau_par_coin_mm']:.2f} mm (coin intérieur → bord)"
              f"   → offset de quadrant {mo['offset_mm']:.2f} mm")
        print(f"  Ø du motif rogné : {mo['diametre_mm']:.2f} mm")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
