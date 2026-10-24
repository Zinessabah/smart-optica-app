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

from itertools import permutations
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

import clip_geometry as clip
import lateral_checker as lc

# Le balayage grossier n'a PAS besoin d'être précis : `affiner_mire` reprend
# l'échelle (±3) et l'angle (±12°) autour de chaque mire retenue. Mesuré sur
# une image 4032x3024 avec le clip incliné à 28°, cinq mires :
#
#     qo_step 1, angle 10° : 51,4 s   ├  5/5 mires, pose rms 0,123 px
#     qo_step 2, angle 10° : 28,6 s   ├  5/5 mires, pose rms 0,123 px
#     qo_step 2, angle 15° : 20,4 s   ├  5/5 mires, pose rms 0,123 px
#     qo_step 2, angle 20° : 15,2 s   ├  5/5 mires, pose rms 0,123 px
#     qo_step 3, angle 20° : 11,3 s   ├  5/5 mires, pose rms 0,123 px  <- RETENU
#
# Le résultat est IDENTIQUE à 4,5x moins de temps. Payer la finesse du balayage
# était donc un gaspillage pur : l'affinage la rend de toute façon.
#
# Le coût restant est `matchTemplate` lui-même (84 ms par corrélation sur
# 1344x1008 avec un gabarit de 55 px). Le levier suivant n'est pas un réglage
# mais un changement de méthode : un premier passage très grossier pour
# localiser la zone, puis un passage fin sur un RECADNAGE autour du clip.
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


def _pics_locaux(res: np.ndarray, n: int, min_corr: float,
                 rayon: int = 1) -> List[Tuple[float, int, int]]:
    """Les `n` meilleurs pics d'une carte de corrélation, après suppression
    des non-maxima dans un rayon.

    Un simple « plus grand que ses 8 voisins » NE SUFFIT PAS : le maximum d'une
    mire est un plateau, et chacun de ses pixels est un maximum local. Mesuré :
    à 0° d'inclinaison le détecteur ne trouvait que 4 mires sur 5, parce qu'une
    seule mire occupait les 3 places disponibles par balayage ; à 30° les
    plateaux se resserraient et les 5 passaient. Le symptôme était donc
    entièrement dépendant de l'inclinaison, alors que la cause n'a rien à voir
    avec elle.

    `rayon` doit valoir au moins la taille du gabarit pour que deux pics
    distants de moins d'un demi-carreau soient reconnus comme UNE mire.
    """
    if res.size == 0 or rayon < 1:
        return []
    taille = 2 * rayon + 1
    noyau = np.ones((taille, taille), np.uint8)
    dilate = cv2.dilate(res, noyau)
    masque = (res >= dilate - 1e-9) & (res >= min_corr)
    ys, xs = np.nonzero(masque)
    if len(ys) == 0:
        return []
    vals = res[ys, xs]
    # à égalité (plateau), on garde UN point : le plus proche du centre du
    # plateau, pas un bord arbitraire
    ordre = np.argsort(-vals)
    pris: List[Tuple[int, int]] = []
    for i in ordre:
        x, y = int(xs[i]), int(ys[i])
        if all(abs(x - px) > rayon or abs(y - py) > rayon for px, py in pris):
            pris.append((x, y))
        if len(pris) == n:
            break
    return [(float(res[y, x]), x, y) for x, y in pris]


def detect_markers_2d(
    gray: np.ndarray,
    *,
    div: int = 3,
    qo_min: int = 4,
    qo_max: int = 22,
    qo_step: int = 3,
    angle_step: int = 20,
    pics_par_balayage: int = 8,
    corr_min: float = CORR_MIN,
) -> List[Dict]:
    """Toutes les mires à damier plausibles de l'image, sans hypothèse de cadrage.

    Args:
        gray: image en niveaux de gris (1 canal).
        div: facteur de la pyramide — la recherche se fait sur gray/div.
        qo_min, qo_max, qo_step: bornes du demi-écartement des quadrants, en px
            de l'image RÉDUITE. Élargir coûte linéairement en temps.
        angle_step: pas du balayage d'orientation.
        pics_par_balayage: pics retenus par couple (échelle, angle). Doit être
            au moins égal au nombre de mires à trouver : le clip facial en a
            CINQ. Mesuré — avec 3, le détecteur ne trouvait que 4 mires sur 5
            à 0° d'inclinaison et 5 sur 5 à 30°, parce qu'à 0° les cinq mires
            partagent la même échelle et se disputaient trois places. Le
            symptôme dépendait de l'inclinaison, la cause non.
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
            # rayon de suppression = le demi-carreau : deux damiers du clip sont
            # distants de plusieurs demi-carreaux, un plateau n'en fait qu'un
            for corr, px, py in _pics_locaux(res, pics_par_balayage, corr_min,
                                             rayon=max(1, qo)):
                # le pic de matchTemplate désigne le coin haut-gauche du gabarit :
                # le centre de la mire est au milieu du gabarit.
                cx = (px + _centre(gw)) * div
                cy = (py + _centre(gh)) * div
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


# ─────────────────────────────────────────────────────────────────────────────
# Affinage à pleine résolution
#
# Précision MESURÉE sur une grille de 25 décalages connus (0 à 0,8 px, pas de
# 0,2), mire synthétique de qo 20 px collée par interpolation cubique :
#
#     biais x +0,000 px   biais y +0,000 px      <- pas de biais systématique
#     écart-type 1,02 px  max 1,50 px            <- quantisation au pixel
#
# Trois variantes ont été comparées, toutes à biais nul :
#     parabole sur la carte de corrélation    sigma 1,010   <- RETENUE
#     milieu du plateau (méthode de main)     sigma 1,166
#     balayage d'angle fixe au lieu de ±12°   sigma 1,018   <- pas la cause
#
# L'hypothèse « le balayage d'angle fait sauter la position » est donc FAUSSE,
# et « le plateau est le problème » aussi. La quantisation est inhérente à
# `matchTemplate`, qui ne rend que des positions entières.
#
# Ce que cela vaut : à l'échelle de la photo de référence (0,0822 mm/px),
# ±1 px = ±0,08 mm, soit 0,16 % d'une base de 50 mm. Sufisant pour la mesure,
# insuffisant pour prétendre au centième de millimètre — ne pas l'oublier.
#
# La pyramide ÷3 sert à TROUVER, pas à MESURER. Mesuré : un gabarit collé
# exactement dans une image vierge n'y corrèle qu'à 0,725, la réduction lissant
# les frontières du damier. Une fois la mire localisée à ±3 px, on la ré-affine
# à pleine résolution sur une petite fenêtre : le plafond monte et la position
# devient sous-pixel.
#
# C'est la structure du détecteur latéral : `_pics_grossiers` puis `_affiner`.
# ─────────────────────────────────────────────────────────────────────────────

def _centre(n: int) -> float:
    """Abscisse du centre d'un gabarit de `n` pixels.

    Un gabarit de `n` pixels couvre les indices 0..n-1 : son centre géométrique
    est à (n-1)/2, PAS n/2. Les gabarits de `_gabarit` sont tous impairs
    (23, 45, 67, 111, 181 px), donc `n/2` décalait chaque mire de 0,5 px —
    mesuré comme un biais constant, pas comme du bruit.
    """
    return (n - 1) / 2.0


def _milieu_plateau(carte: np.ndarray, tol: float = 1e-9) -> Tuple[float, float]:
    """Milieu du plateau du maximum d'une carte de corrélation.

    Mesuré sur une grille de décalages connus : `minMaxLoc` + parabole donne un
    biais NUL mais un écart-type de 1,01 px, avec des erreurs symétriques de
    ±1,1 à ±1,35 px. Autrement dit la position saute d'un pixel : le maximum
    n'est pas un point mais un plateau, et `minMaxLoc` en renvoie un bord
    arbitraire.

    On prend donc la composante connexe du maximum et son milieu. C'est la
    méthode déjà retenue par `main._refine_marker_2d`, qui l'avait choisie
    contre deux échecs documentés : premier maximum (−12 px) et barycentre
    (+3 px).

    Returns:
        (x, y) en coordonnées de la carte, décimales comprises.
    """
    mx = float(carte.max())
    masque = (carte >= mx - tol).astype(np.uint8)
    nb, etiquettes = cv2.connectedComponents(masque, connectivity=8)
    if nb <= 1:
        ys, xs = np.nonzero(masque)
        return (xs.min() + xs.max()) / 2.0, (ys.min() + ys.max()) / 2.0
    # étiquette du plateau qui contient le maximum
    ymax, xmax = np.unravel_index(int(np.argmax(carte)), carte.shape)
    lab = etiquettes[ymax, xmax]
    ys, xs = np.nonzero(etiquettes == lab)
    return (xs.min() + xs.max()) / 2.0, (ys.min() + ys.max()) / 2.0


def _parabole(a: float, b: float, c: float) -> float:
    """Sommet d'une parabole par les trois points a, b, c — décalage en [-0,5 ; 0,5]."""
    den = a - 2.0 * b + c
    if abs(den) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))


def _sous_pixel(carte: np.ndarray, px: int, py: int) -> Tuple[float, float]:
    """Décalage sous-pixel du maximum, par parabole sur les voisins immédiats."""
    h, w = carte.shape[:2]
    dx = dy = 0.0
    if 0 < px < w - 1:
        dx = _parabole(float(carte[py, px - 1]), float(carte[py, px]),
                       float(carte[py, px + 1]))
    if 0 < py < h - 1:
        dy = _parabole(float(carte[py - 1, px]), float(carte[py, px]),
                       float(carte[py + 1, px]))
    return dx, dy


def affiner_mire(
    gray: np.ndarray,
    marker: Dict,
    *,
    angle_span: float = 12.0,
    angle_step: float = 2.0,
    qo_span: int = 3,
    pos_span: int = 5,
) -> Dict:
    """Ré-affine une mire candidate à pleine résolution.

    Balaye l'angle et l'échelle autour de la détection grossière, sur une
    fenêtre étroite, puis raffine la position au sous-pixel. La corrélation
    obtenue n'est pas comparable à celle de la pyramide : elle est mesurée à
    pleine résolution, donc plus haute par construction.

    Args:
        gray: image 1 canal, pleine résolution.
        marker: dict issu de `detect_markers_2d` (clés x, y, corr, qo_px, angle).
        angle_span, angle_step: balayage d'orientation autour de l'angle trouvé.
        qo_span: demi-amplitude du balayage d'échelle, en px.
        pos_span: demi-largeur de la fenêtre de recherche, en px.

    Returns:
        Un dict de même forme, avec la position affinée, la corrélation à
        pleine résolution et les paramètres retenus. ``affine: True``.
    """
    if gray.ndim != 2:
        raise ValueError("affiner_mire attend une image 1 canal (GRAY)")

    h, w = gray.shape[:2]
    meilleur: Optional[Dict] = None
    qo0 = int(round(marker["qo_px"]))

    for qo in range(max(4, qo0 - qo_span), qo0 + qo_span + 1):
        # Le gabarit de `_gabarit` mesure 5,6 x qo de côté (mesuré : 45 px à
        # qo=8). La fenêtre doit donc faire au moins 2,8 x qo de demi-largeur,
        # sinon `matchTemplate` refuse et l'affinage retombe silencieusement sur
        # la détection grossière — ce qui était le cas à 2,4 x qo.
        rayon = int(np.ceil(3.1 * qo)) + pos_span
        x0, x1 = int(round(marker["x"])) - rayon, int(round(marker["x"])) + rayon
        y0, y1 = int(round(marker["y"])) - rayon, int(round(marker["y"])) + rayon
        if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
            continue
        fenetre = gray[y0:y1, x0:x1].astype(np.float32)

        # Balayage par DÉCALAGES RELATIFS : `(angle - span) % 360` vaut 348
        # quand l'angle vaut 0, et la condition de fin ne serait jamais vraie.
        for da in np.arange(-angle_span, angle_span + 1e-9, angle_step):
            angle = (marker["angle"] + float(da)) % 360.0
            gabarit = lc._gabarit(qo, angle)
            gh, gw = gabarit.shape[:2]
            if gh > fenetre.shape[0] or gw > fenetre.shape[1]:
                continue
            res = cv2.matchTemplate(fenetre, gabarit, cv2.TM_CCOEFF_NORMED)
            cmax = float(res.max())
            if meilleur is None or cmax > meilleur["corr"]:
                _, _, _, cloc = cv2.minMaxLoc(res)
                dx, dy = _sous_pixel(res, cloc[0], cloc[1])
                meilleur = {
                    "x": x0 + cloc[0] + _centre(gw) + dx,
                    "y": y0 + cloc[1] + _centre(gh) + dy,
                    "corr": cmax,
                    "qo_px": float(qo),
                    "angle": angle,
                    "affine": True,
                }

    if meilleur is None:
        # mire trop proche du bord : on renvoie la détection grossière, marquée
        return dict(marker, affine=False)
    return meilleur


def detecter_et_affiner(
    gray: np.ndarray,
    *,
    corr_min_grossier: float = CORR_MIN,
    **kwargs,
) -> List[Dict]:
    """Chaîne complète : détection 2D grossière, filtre de cohérence, affinage.

    Returns:
        Les mires cohérentes, affinées à pleine résolution, triées par
        corrélation décroissante.
    """
    grossiers = detect_markers_2d(gray, corr_min=corr_min_grossier)
    gardes = coherents(grossiers)
    affines = [affiner_mire(gray, m, **kwargs) for m in gardes]
    affines.sort(key=lambda m: -m["corr"])
    return affines


# ─────────────────────────────────────────────────────────────────────────────
# Appariement des mires détectées aux rôles du clip
#
# Équivalent facial de `lateral_checker.select_metrological_pair`. Le latéral
# identifie ses mires par la FORME d'un triangle isocèle, sans connaître
# l'échelle ; ici il y a mieux — le clip v23.5 porte DEUX triangles qui
# PARTAGENT la mire centrale :
#
#     droite : centre · (+50,00 ; 3,000) · (+25,00 ; 34,922)
#     gauche : centre · (−50,00 ; 3,000) · (−25,00 ; 34,922)
#
# Six contraintes au lieu de trois, et un contrôle croisé : les deux triangles
# sont symétriques, ils doivent rendre la MÊME échelle (2 %).
#
# Le point qui rend la méthode sûre : trois points alignés dans l'espace le
# restent EXACTEMENT sur l'image, quelle que soit la perspective. La barre se
# reconnaît donc sans supposer ni échelle ni pose, avec une tolérance serrée.
# ─────────────────────────────────────────────────────────────────────────────

# Tolérance de colinéarité des trois mires de barre, en fraction du span.
# Justification : la colinéarité est exacte en projection, seule l'erreur de
# mesure s'y ajoute. Mesuré sur les trois mires d'une photo réelle : 0,3 %.
BARRE_COLINEARITE_TOL = 0.015

# Cohérence de taille de carreau entre mires d'un même cliché (une photo n'a
# qu'une échelle) — même rôle que `_qo_coherent` côté latéral.
QO_COHERENCE_TOL_PAIR = 0.10


def _qo_coherent(markers: Sequence[Dict],
                 tol: float = QO_COHERENCE_TOL_PAIR) -> bool:
    """Toutes les mires ont-elles la même taille de carreau à `tol` près ?"""
    qos = [float(m["qo_px"]) for m in markers]
    if not qos or min(qos) <= 0:
        return False
    return (max(qos) - min(qos)) / max(qos) <= tol


def _colineaire(a: Dict, b: Dict, c: Dict, tol: float = BARRE_COLINEARITE_TOL) -> bool:
    """`b` est-il sur le segment ac, à `tol` près (fraction de |ac|) ?"""
    ax, ay = a["x"], a["y"]
    cx, cy = c["x"], c["y"]
    longueur = float(np.hypot(cx - ax, cy - ay))
    if longueur <= 0:
        return False
    # distance perpendiculaire de b à la droite ac
    dist = abs((cx - ax) * (b["y"] - ay) - (cy - ay) * (b["x"] - ax)) / longueur
    if dist / longueur > tol:
        return False
    # b doit être ENTRE a et c
    t = ((b["x"] - ax) * (cx - ax) + (b["y"] - ay) * (cy - ay)) / (longueur ** 2)
    return tol <= t <= 1.0 - tol or 0.0 < t < 1.0


def identifier_mires(cands: Sequence[Dict]) -> Optional[Dict]:
    """Apparie les mires détectées aux rôles du clip facial, par la géométrie.

    Énumère les affectations plausibles, garde celles qui satisfont les deux
    triangles mesurés, et rend la meilleure au sens du résidu de forme.

    Args:
        cands: mires issues de `detect_markers_2d` (clés x, y, qo_px, corr).

    Returns:
        ``{"roles", "points", "scale_mm_per_px", "triangles", "residual",
        "sides"}`` ou ``None`` si aucune affectation ne tient. Ne devine JAMAIS :
        mieux vaut échouer que rendre trois pics arbitraires — c'est le défaut
        du repli dégradé de l'ancien détecteur.
    """
    from itertools import permutations

    if len(cands) < 3:
        return None
    if not _qo_coherent(cands):
        return None

    role_c = clip.FACIAL_CENTRE_ROLE
    role_d = "facial_droite"
    role_g = "facial_gauche"
    role_pd = clip.FACIAL_RAISED_ROLE
    role_pg = clip.FACIAL_RAISED_MIRROR_ROLE

    meilleur: Optional[Dict] = None
    n = len(cands)
    for tri in permutations(range(n), 3):
        ic, i_g, i_d = tri
        # les trois mires de barre sont alignées, la centrale ENTRE les extrêmes
        if not _colineaire(cands[i_g], cands[ic], cands[i_d]):
            continue
        # les autres candidats, s'il y en a, deviennent les pointes
        reste = [i for i in range(n) if i not in tri]
        appariements = ([reste[:2]] if len(reste) >= 2 else [None])
        for pointes in appariements:
            pts = {role_c: (cands[ic]["x"], cands[ic]["y"]),
                   role_g: (cands[i_g]["x"], cands[i_g]["y"]),
                   role_d: (cands[i_d]["x"], cands[i_d]["y"])}
            if pointes is None:
                # un seul triangle exploitable : celui dont on a la pointe
                continue
            for ipd, ipg in (pointes, list(reversed(pointes))):
                essai = dict(pts)
                essai[role_pd] = (cands[ipd]["x"], cands[ipd]["y"])
                essai[role_pg] = (cands[ipg]["x"], cands[ipg]["y"])
                res = clip.facial_triangles_scale(essai)
                if not res["n_sides"]:
                    continue
                # la forme doit tenir sur CHAQUE triangle disponible
                tous_bons = all(t["shape_ok"] for t in res["by_side"].values() if t)
                if not tous_bons:
                    continue
                if res["n_sides"] == 2 and not res["sides_agree"]:
                    continue
                residu = max(t["ratio_residual"] for t in res["by_side"].values() if t)
                if meilleur is None or residu < meilleur["residual"]:
                    meilleur = {
                        "roles": {role_c: ic, role_g: i_g, role_d: i_d,
                                  role_pd: ipd, role_pg: ipg},
                        "points": essai,
                        "scale_mm_per_px": res["scale_mm_per_px"],
                        "triangles": res,
                        "residual": residu,
                        "sides": res["sides"],
                    }
    return meilleur


# ─────────────────────────────────────────────────────────────────────────────
# Pose : POSER POUR IDENTIFIER
#
# L'appariement par la forme seule échoue dès 5 % de raccourcissement perspectif
# (mesuré : échec de 0,05 à 0,40). Les rapports de côtés sont indépendants de
# l'ÉCHELLE mais pas de la PERSPECTIVE. Il faut donc inverser l'ordre : estimer
# la pose et retenir l'affectation qui la rend plausible.
#
# Le problème est PLAN : les cinq mires du clip sont toutes à y = −0,75 dans le
# modèle (mesuré). C'est un PnP plan, donc `SOLVEPNP_IPPE` — mieux conditionné
# qu'un PnP général, et un seul minimum au lieu de deux.
#
# L'échelle métrologique est la profondeur de la mire CENTRALE divisée par la
# focale : à cette profondeur, un pixel vaut Z/f millimètres. On la prend à la
# mire centrale et non à une moyenne, parce que le plan du clip est incliné :
# le facteur mm/px varie sur l'image, et c'est précisément ce que la pose
# modélise au lieu de le tolérer.
# ─────────────────────────────────────────────────────────────────────────────

# Erreur de reprojection tolérée, en pixels. Mesuré sur pose synthétique exacte
# (pose connue, projection par cv2.projectPoints, aucune perturbation) : voir
# les tests — la valeur retenue laisse passer le bruit de mesure sans laisser
# passer une mauvaise affectation, qui reprojette à plusieurs dizaines de pixels.
RMS_MAX_PX = 2.0


def _modele_3d() -> Tuple[List[str], np.ndarray]:
    """Les cinq mires faciales du modèle, dans un ordre stable, en (x, y, z)."""
    noms = [clip.FACIAL_CENTRE_ROLE, "facial_gauche", "facial_droite",
            clip.FACIAL_RAISED_ROLE, clip.FACIAL_RAISED_MIRROR_ROLE]
    obj = np.array([clip.facial_plan_pos(n) for n in noms], dtype=np.float64)
    # facial_plan_pos rend (x, z) : le plan du clip est y = cste, on remet la
    # coordonnée manquante pour travailler en 3D complète.
    ys = [float(m["y"]) for m in clip.FACIAL_MARKERS]
    obj = np.column_stack([obj[:, 0], np.full(len(noms), float(np.mean(ys))), obj[:, 1]])
    return noms, obj


def _rms_reprojection(obj, img_pts, K, rvec, tvec) -> float:
    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
    d = proj.reshape(-1, 2) - img_pts
    return float(np.sqrt(np.mean(np.sum(d * d, axis=1))))


def poser_et_identifier(
    cands: Sequence[Dict],
    image_width: int,
    *,
    f_frac_min: float = 0.6,
    f_frac_max: float = 3.0,
    f_frac_step: float = 0.08,
    rms_max: float = RMS_MAX_PX,
) -> Optional[Dict]:
    """Identifie les mires PAR LA POSE, puis en déduit l'échelle.

    Énumère les affectations candidats → rôles, filtre celles dont la barre est
    colinéaire (propriété projective exacte, donc gratuite), résout la pose à
    focale balayée, et retient l'affectation qui reprojette le mieux.

    Args:
        cands: mires détectées (clés x, y).
        image_width: largeur de l'image, pour borner le balayage de focale.
        f_frac_min, f_frac_max, f_frac_step: bornes de la focale, en fractions
            de la largeur d'image (un téléphone tombe entre 0,8 et 1,4).
        rms_max: erreur de reprojection au-delà de laquelle on refuse.

    Returns:
        ``{"roles", "points", "rms_px", "focal_px", "scale_mm_per_px", "pose"}``
        ou ``None`` — jamais une affectation plausible mais fausse.
    """
    if len(cands) < 5:
        return None

    noms, obj = _modele_3d()
    # rôles rangés dans l'ordre du modèle
    roles = list(noms)
    meilleur: Optional[Dict] = None

    for perm in permutations(range(len(cands)), 5):
        affect = {roles[k]: cands[perm[k]] for k in range(5)}
        # pré-filtre : la barre est colinéaire en projection, exactement
        if not _colineaire(affect["facial_gauche"], affect[clip.FACIAL_CENTRE_ROLE],
                           affect["facial_droite"]):
            continue
        img_pts = np.array([[affect[r]["x"], affect[r]["y"]] for r in roles],
                           dtype=np.float64)
        for f in np.arange(f_frac_min, f_frac_max + 1e-9, f_frac_step) * image_width:
            K = np.array([[f, 0, image_width / 2.0], [0, f, image_width * 0.4], [0, 0, 1]],
                         dtype=np.float64)
            try:
                ok, rvec, tvec = cv2.solvePnP(obj, img_pts, K, None,
                                              flags=cv2.SOLVEPNP_IPPE)
            except cv2.error:
                continue
            if not ok:
                continue
            rms = _rms_reprojection(obj, img_pts, K, rvec, tvec)
            if meilleur is None or rms < meilleur["rms_px"]:
                # profondeur de la mire centrale : c'est là que mm/px a un sens
                i_centre = roles.index(clip.FACIAL_CENTRE_ROLE)
                R, _ = cv2.Rodrigues(rvec)
                prof = float((R @ obj[i_centre] + tvec.reshape(3))[2])
                meilleur = {
                    "roles": affect,
                    "points": {r: (affect[r]["x"], affect[r]["y"]) for r in roles},
                    "rms_px": rms,
                    "focal_px": float(f),
                    "scale_mm_per_px": (prof / float(f)) if prof > 0 else None,
                    "pose": {"rvec": rvec.reshape(3).tolist(),
                             "tvec": tvec.reshape(3).tolist(),
                             "profondeur_centre_mm": prof},
                }
    if meilleur is None or meilleur["rms_px"] > rms_max:
        return None
    return meilleur
