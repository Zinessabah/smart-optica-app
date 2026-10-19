#!/usr/bin/env python3
"""Mesure des mires faciales du clip v22.1 sur les STL BINAIRES réellement exportés.

But : la 5ᵉ mire (haute gauche, miroir de la haute droite) doit être une cote MESURÉE,
pas recopiée du document. On isole la lèvre du collier/boss dans le plan de la face
(y = +0,05), on regroupe les sommets par composante connexe, et on ajuste un cercle à
chacune pour retrouver l'AXE de la mire.

Usage : python mesure_clip_v22_1.py <dossier_stl>
"""
import math
import struct
import sys
from typing import Dict, List, Tuple

import numpy as np

BANDE_FACIALE_Y = (0.00, 0.12)     # sièges à +0,050 (v22.1) ; 0,000 sur la v22 à inserts
BANDE_LATERALE_X = (76.70, 76.80)  # lèvre du collier latéral, au plan de la face interne du bras


def lire_sommets_binaire(chemin: str) -> np.ndarray:
    """STL binaire -> sommets uniques (N,3)."""
    d = open(chemin, "rb").read()
    if len(d) < 84:
        raise ValueError(f"{chemin}: trop court pour un STL binaire")
    n = struct.unpack("<I", d[80:84])[0]
    if len(d) != 84 + 50 * n:
        raise ValueError(f"{chemin}: taille {len(d)} incompatible avec {n} triangles "
                         f"(attendu {84 + 50 * n}) — fichier ASCII ?")
    arr = np.frombuffer(d, dtype=np.uint8, count=50 * n, offset=84).reshape(n, 50)
    tri = arr[:, 12:48].copy().view("<f4").reshape(n, 3, 3)
    return np.unique(tri.reshape(-1, 3), axis=0).astype(float)


def composantes(pts: np.ndarray, rayon: float, min_sommets: int = 16) -> List[np.ndarray]:
    """Regroupe les sommets reliés à `rayon` près (grille + parcours en largeur)."""
    if len(pts) == 0:
        return []
    grille: Dict[Tuple[int, int, int], List[int]] = {}
    for i, p in enumerate(pts):
        grille.setdefault(tuple((p / rayon).astype(int)), []).append(i)
    vu = np.zeros(len(pts), dtype=bool)
    groupes = []
    for i0 in range(len(pts)):
        if vu[i0]:
            continue
        pile, idx = [i0], []
        vu[i0] = True
        while pile:
            i = pile.pop()
            idx.append(i)
            c = tuple((pts[i] / rayon).astype(int))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for j in grille.get((c[0] + dx, c[1] + dy, c[2] + dz), []):
                            if not vu[j] and np.linalg.norm(pts[j] - pts[i]) <= rayon:
                                vu[j] = True
                                pile.append(j)
        if len(idx) >= min_sommets:
            groupes.append(pts[idx])
    return groupes


def ajuste_cercle(pts: np.ndarray) -> Tuple[float, float, float, float]:
    """Cercle des moindres carrés (Kåsa) dans le plan (x, z). Retourne (cx, cz, r, residu)."""
    x, z = pts[:, 0], pts[:, 2]
    A = np.column_stack([2 * x, 2 * z, np.ones(len(x))])
    b = x * x + z * z
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cz, c = sol
    r = math.sqrt(max(c + cx * cx + cz * cz, 0.0))
    res = float(np.sqrt(np.mean((np.hypot(x - cx, z - cz) - r) ** 2)))
    return float(cx), float(cz), r, res


def mesurer(chemin: str) -> List[Dict]:
    V = lire_sommets_binaire(chemin)
    bande = V[(V[:, 1] >= BANDE_FACIALE_Y[0]) & (V[:, 1] <= BANDE_FACIALE_Y[1])]
    out = []
    # rayon 1,0 mm : le maillage laisse des trous de 0,4 à 0,9 mm le long des lèvres,
    # un rayon plus fin éclate chaque anneau en dizaines de miettes (mesuré : 344 au lieu de 5).
    for g in composantes(bande, rayon=1.0, min_sommets=16):
        # rayon extérieur du groupe : on ne garde que la lèvre la plus large
        cx0, cz0 = g[:, 0].mean(), g[:, 2].mean()
        r0 = np.hypot(g[:, 0] - cx0, g[:, 2] - cz0)
        lèvre = g[r0 > r0.max() - 0.6]
        if len(lèvre) < 8:
            continue
        cx, cz, r, res = ajuste_cercle(lèvre)
        if res > 0.35 or not (5.0 < r < 9.0):
            continue
        out.append({"x": cx, "z": cz, "r": r, "residu": res,
                    "y_min": float(g[:, 1].min()), "y_max": float(g[:, 1].max()),
                    "n": len(g)})
    return sorted(out, key=lambda m: (m["z"], m["x"]))


def mesurer_laterales(chemin: str) -> List[Dict]:
    """Les mires latérales d'un bras : cercles dans le plan (y, z), à |x| ≈ 76,75.

    Même méthode que les faciales — ajustement de cercle sur la lèvre du collier —
    mais le plan de coupe est celui de la face INTERNE du bras : on isole les
    sommets à |x| ∈ [76,70 ; 76,80] et on ajuste dans (y, z).

    ⚠️ Ce sont des INSERTS sur la v22 (6 latéraux, documentés « 5 faciaux + 6
    latéraux »), donc le plan des faces est |x| = 76,75 et le CENTRE des disques
    |x| = 76,00. C'est 76,75 qui porte le vertex.
    """
    V = lire_sommets_binaire(chemin)
    bande = V[(np.abs(V[:, 0]) >= BANDE_LATERALE_X[0]) & (np.abs(V[:, 0]) <= BANDE_LATERALE_X[1])]
    out = []
    for g in composantes(bande, rayon=1.0, min_sommets=16):
        cy0, cz0 = g[:, 1].mean(), g[:, 2].mean()
        r0 = np.hypot(g[:, 1] - cy0, g[:, 2] - cz0)
        levre = g[r0 > r0.max() - 0.6]
        if len(levre) < 8:
            continue
        x, y, z = levre[:, 0], levre[:, 1], levre[:, 2]
        A = np.column_stack([2 * y, 2 * z, np.ones(len(y))])
        sol, *_ = np.linalg.lstsq(A, y * y + z * z, rcond=None)
        cy, cz, c = sol
        r = math.sqrt(max(c + cy * cy + cz * cz, 0.0))
        res = float(np.sqrt(np.mean((np.hypot(y - cy, z - cz) - r) ** 2)))
        if res > 0.35 or not (5.0 < r < 9.0):
            continue
        out.append({"x": float(np.mean(np.abs(x))), "y": cy, "z": cz, "r": r,
                    "residu": res, "n": len(g)})
    return sorted(out, key=lambda m: m["y"])


if __name__ == "__main__":
    dossier = sys.argv[1] if len(sys.argv) > 1 else "."
    import os
    for nom in ("01_facial_2bras.stl",):
        chemin = os.path.join(dossier, nom)
        if not os.path.exists(chemin):
            print(f"absent : {chemin}")
            continue
        print(f"\n=== {nom} ===")
        mires = mesurer(chemin)
        print(f"  {len(mires)} mire(s) faciale(s) trouvée(s)")
        for m in mires:
            print(f"    x = {m['x']:+8.3f}   z = {m['z']:+7.3f}   "
                  f"r = {m['r']:5.2f}   résidu = {m['residu']:.3f} mm   "
                  f"y = [{m['y_min']:+.3f} ; {m['y_max']:+.3f}]   ({m['n']} sommets)")
        if len(mires) >= 3:
            barre = [m for m in mires if m["z"] < 10]
            hautes = [m for m in mires if m["z"] >= 10]
            if len(barre) >= 2:
                xs = sorted(m["x"] for m in barre)
                print(f"\n  barre : {len(barre)} mires, x = {[round(v,3) for v in xs]}")
                print(f"          écartement extrême = {xs[-1]-xs[0]:.3f} mm "
                      f"(référence 100,000)")
            if hautes:
                print(f"  hautes : {len(hautes)} mires à z = {hautes[0]['z']:.3f}")
                for h in hautes:
                    d = [math.hypot(h["x"]-b["x"], h["z"]-b["z"]) for b in barre]
                    print(f"    x = {h['x']:+8.3f} → distances aux barres : "
                          f"{[round(v,3) for v in sorted(d)]}")
                if len(hautes) == 2:
                    print(f"    écart entre les deux hautes = "
                          f"{abs(hautes[0]['x']-hautes[1]['x']):.3f} mm  "
                          f"(symétrie : centres à ±{(hautes[0]['x']-hautes[1]['x'])/2:.3f})")
