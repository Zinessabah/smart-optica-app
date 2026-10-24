"""Détection 2D des mires à damier du clip facial.

Pourquoi ce module existe
-------------------------
Le détecteur historique (`main._scan_facial_strip`) balaie **une seule ligne
horizontale**, à une hauteur donnée, avec un carreau supposé. C'est un outil
1D appliqué à une image 2D : il ne trouve les mires que si la photo est déjà
droite, à peu près de face et à la bonne échelle.

Mesuré sur une photo réelle, deux cadrages de la MÊME image donnaient deux
triplets différents — (257, 2191) (881, 2198) (1473, 2205) d'un côté,
(2316, 1227) (2666, 1245) (2947, 1213) de l'autre. Ce n'est pas une question
de précision : c'est de l'instabilité.

Ici on cherche **en 2D**, comme le fait déjà le détecteur latéral : pyramide
d'images, gabarit de damier corrélé sur une grille d'échelles et
d'orientations, puis filtrage par **cohérence d'échelle et d'orientation**.

Mesure sur photo réelle (1872×4160, pyramide ÷3, 324 corrélations, 7,4 s) :

    (729, 1941)  corr 0,725   qo 30 px  angle 270°
    (1092, 1632) corr 0,650   qo 36 px  angle 260°
    (1077, 2217) corr 0,644   qo 36 px  angle 270°
    (1731,  129) corr 0,563   qo 12 px  angle 230°   <- bruit (autre échelle)
    (123,  2760) corr 0,509   qo 18 px  angle  30°   <- bruit (autre angle)

Les trois vraies mires partagent l'échelle et l'orientation ; le bruit non.
Leur triangle vaut 585 / 477 / 444 px, soit 1 / 0,815 / 0,759, à comparer au
1 / 0,81 / 0,81 du clip : les deux longs côtés à 0,6 %, le troisième à 6 %
(perspective — c'est la pose qui devra l'absorber, pas une tolérance).

Le gabarit réutilisé est celui du détecteur latéral
(`lateral_checker._gabarit`) : un disque à damier 2×2 avec collier blanc. Il
s'applique aux mires faciales sans modification — contrairement à ce que
laissait croire un premier test mal positionné.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

import lateral_checker as lc

# Corrélation minimale pour retenir un pic. Mesuré : vraies mires 0,64–0,73,
# bruit 0,49–0,56 sur la photo de référence ; 0,58 sépare les deux populations.
#
# ⚠️ Ce plafond de 0,73 n'est PAS une qualité de détection : c'est celui de la
# pyramide ÷3. Mesuré en collant un gabarit dans une image vierge, donc sans
# aucun défaut de prise de vue, la corrélation ne monte qu'à 0,725 — la
# réduction de résolution lisse les frontières du damier. Un affinage à pleine
# résolution relèvera ce plafond ; d'ici là, comparer une corrélation à 1,0
# n'a pas de sens.
CORR_MIN = 0.58

# Tolérance de cohérence d'échelle entre mires d'un même clip (rapport des qo).
QO_RATIO_TOL = 1.25

# Tolérance d'orientation entre mires d'un même clip : le clip est rigide, tous
# ses damiers tournent ensemble. Mesuré : 260–270° pour les vraies mires.
ANGLE_TOL_DEG = 25.0


def _pics_locaux(res: np.ndarray, n: int, min_corr: float) -> List[Tuple[float, int, int]]:
    """Les `n` meilleurs maxima locaux d'une carte de corrélation.

    Un maximum local = plus grand que ses 8 voisins. Sans ce filtre, les `n`
    meilleurs points d'un même damier seraient tous sur le même pic.
    """
    if res.size == 0:
        return []
    noyau = np.ones((3, 3), np.uint8)
    dilate = cv2.dilate(res, noyau)
    masque = (res >= dilate - 1e-9) & (res >= min_corr)
    ys, xs = np.nonzero(masque)
    if len(ys) == 0:
        return []
    vals = res[ys, xs]
    ordre = np.argsort(-vals)[:n]
    return [(float(vals[i]), int(xs[i]), int(ys[i])) for i in ordre]


def detect_markers_2d(
    gray: np.ndarray,
    *,
    div: int = 3,
    qo_min: int = 4,
    qo_max: int = 22,
    qo_step: int = 2,
    angle_step: int = 10,
    pics_par_balayage: int = 3,
    corr_min: float = CORR_MIN,
) -> List[Dict]:
    """Toutes les mires à damier plausibles de l'image, sans hypothèse de cadrage.

    Args:
        gray: image en niveaux de gris (1 canal).
        div: facteur de la pyramide — la recherche se fait sur gray/div.
        qo_min, qo_max, qo_step: bornes du demi-écartement des quadrants, en px
            de l'image RÉDUITE. Élargir coûte linéairement en temps.
        angle_step: pas du balayage d'orientation.
        pics_par_balayage: pics retenus par couple (échelle, angle).
        corr_min: corrélation minimale.

    Returns:
        Liste de dicts ``{"x", "y", "corr", "qo_px", "angle"}`` en coordonnées
        de l'image PLEINE, triée par corrélation décroissante.
    """
    if gray.ndim != 2:
        raise ValueError("detect_markers_2d attend une image 1 canal (GRAY)")

    h, w = gray.shape[:2]
    petite = cv2.resize(
        gray, (max(1, w // div), max(1, h // div)), interpolation=cv2.INTER_AREA
    ).astype(np.float32)

    trouves: List[Dict] = []
    for qo in range(qo_min, qo_max + 1, qo_step):
        for angle in range(0, 360, angle_step):
            gabarit = lc._gabarit(qo, angle)
            gh, gw = gabarit.shape[:2]
            if gh >= petite.shape[0] or gw >= petite.shape[1]:
                continue
            res = cv2.matchTemplate(petite, gabarit, cv2.TM_CCOEFF_NORMED)
            for corr, px, py in _pics_locaux(res, pics_par_balayage, corr_min):
                # le pic de matchTemplate désigne le coin haut-gauche du gabarit :
                # le centre de la mire est au milieu du gabarit.
                cx = (px + gw / 2.0) * div
                cy = (py + gh / 2.0) * div
                trouves.append({
                    "x": cx,
                    "y": cy,
                    "corr": corr,
                    "qo_px": qo * div,
                    "angle": angle,
                })

    # Fusion des doublons : deux balayages voisins (angle ±10°, qo ±2) tombent
    # sur la même mire. On garde le meilleur de chaque groupe, à un rayon de
    # demi-mire près.
    trouves.sort(key=lambda m: -m["corr"])
    uniques: List[Dict] = []
    for m in trouves:
        rayon = max(10.0, 0.8 * m["qo_px"])
        if any(abs(m["x"] - u["x"]) <= rayon and abs(m["y"] - u["y"]) <= rayon
               for u in uniques):
            continue
        uniques.append(m)
    return uniques


def coherents(markers: Sequence[Dict], *, qo_ratio_tol: float = QO_RATIO_TOL,
              angle_tol: float = ANGLE_TOL_DEG) -> List[Dict]:
    """Ne garde que les mires compatibles entre elles : même échelle, même angle.

    Un clip est rigide : tous ses damiers ont la même taille sur l'image et la
    même orientation. Deux détections qui divergent de plus de `qo_ratio_tol`
    sur l'échelle ou de `angle_tol` sur l'angle ne peuvent pas appartenir au
    même clip.

    Mesuré sur la photo de référence : les 3 vraies mires (qo 30–36 px, 260–270°)
    sont conservées, le bruit (qo 12 et 18 px, 30° et 230°) est écarté.
    """
    if not markers:
        return []
    tris = sorted(markers, key=lambda m: -m["corr"])
    gardes: List[Dict] = [tris[0]]
    for m in tris[1:]:
        if all(_compatibles(m, g, qo_ratio_tol, angle_tol) for g in gardes):
            gardes.append(m)
    return gardes


def _compatibles(a: Dict, b: Dict, qo_ratio_tol: float, angle_tol: float) -> bool:
    grand, petit = max(a["qo_px"], b["qo_px"]), min(a["qo_px"], b["qo_px"])
    if petit <= 0 or grand / petit > qo_ratio_tol:
        return False
    # les angles sont modulo 180° : un damier tourné de 180° est identique
    d = abs(a["angle"] - b["angle"]) % 180.0
    return min(d, 180.0 - d) <= angle_tol


def triangle_ratios(markers: Sequence[Dict]) -> Optional[Dict]:
    """Rapports des trois côtés du triangle formé par trois mires.

    Sert de contrôle géométrique : le clip facial donne 1 / 0,81 / 0,81
    (50 / 40,5 / 40,5 mm). La perspective déforme ces rapports, d'où une
    tolérance large — c'est la pose qui tranchera, pas ce contrôle.
    """
    if len(markers) != 3:
        return None
    pts = np.array([[m["x"], m["y"]] for m in markers], dtype=np.float64)
    d = [float(np.linalg.norm(pts[i] - pts[j]))
         for i, j in ((0, 1), (1, 2), (0, 2))]
    plus_long = max(d)
    if plus_long <= 0:
        return None
    return {
        "distances_px": d,
        "rapports": [v / plus_long for v in d],
        "plus_long_px": plus_long,
    }
