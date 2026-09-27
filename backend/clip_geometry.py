"""Géométrie de référence du CLIP v19.5 — source unique des cotes.

D'où viennent ces valeurs
-------------------------
Elles sont **mesurées sur les STL réellement exportés** (`clip_reference_v19_5_corps.stl`
pour les logements, `clip_reference_v19_5_ins_damier_noir.stl` pour le motif), par le
script `tools/mesure_clip_v19_5.py` : les 10 mires sont des aléages de révolution, on
isole les sommets de leurs lèvres et on **ajuste un cercle** (les aléages sont coupés par
les encoches d'ergot, un simple barycentre serait biaisé). Les valeurs sont ensuite
confrontées au source paramétrique `clip_reference_v19_5.scad`.

    | cote                          | mesuré STL | **référence officielle** | écart  |
    |-------------------------------|-----------:|------------------------:|------:|
    | faciales extrêmes             |     100,00 |                 100,00 |  0,00 |
    | faciales adjacentes           |      50,00 |                  50,00 |  0,00 |
    | latérales basses (paire métro) |      25,00 |                  25,00 |  0,00 |
    | latérale surélevée ↔ basse     |      20,30 |                  20,30 |  0,00 |
    | positions faciales (x, y, z)  | -50/0/50/30, -0.75/3/17 | idem | 0,00 |
    | positions latérales (x, y, z) | ±76, -39/-26,5/-14, 12/28 | idem | 0,00 |
    | carreau du damier             |       5,00 |                  5,00 |  0,00 |
    | offset de quadrant            |       2,50 |                  2,50 |  0,00 |
    | Ø du motif                    |      10,00 |                 10,00 |  0,00 |
    | Ø du disque de mire           |      12,00 |                 12,00 |  0,00 |
    | plan des faces faciales (y)   |      -0,75 |                 -0,75 |  0,00 |
    | plan des faces latérales (x)  |      76,00 |                 76,00 |  0,00 |

L'écart surélevée ↔ basse vaut exactement **20,3039 mm** (√(12,5² + 16²)) ; le clip le
documente sous la valeur ronde « 20,30 ». Seul le rapport des deux écartements compte
pour la détection, et il vaut 1,2313 — sans ambiguïté.

Pourquoi ces cotes pilotent la détection
----------------------------------------
Le clip n'a **ni réglette ni graduation** : sa seule métrologie est celle de ses
**écartements connus**. L'échelle d'une photo se déduit donc TOUJOURS par
`échelle = écartement_connu / distance_px` — jamais d'un IPD supposé (le « 63 mm
pour tout le monde » que le clip existe précisément pour supprimer).

⚠ Le piège du pairage latéral
-----------------------------
Les 6 latérales ne forment PAS 3 paires alignées. Les deux qui donnent 25,00 mm sont les
**basses** (z = 12, même plan) ; la **surélevée** (z = 28) est à **20,30 mm de chacune**.
Un détecteur qui apparierait la surélevée avec une basse mesurerait **20,30 au lieu de
25,00 mm**, soit **19 % d'erreur d'échelle** — et donc autant sur le vertex.

Le triangle latéral (20,30 / 20,30 / 25,00) est donc **isocèle** : le côté métrologique
est toujours **le plus long**, dans un rapport de 1,232 — critère **indépendant de
l'échelle**, utilisable sans connaître les mm/px. C'est la règle appliquée par le
détecteur (`lateral.isoceles_metrological_pair`).
"""

from dataclasses import dataclass
from typing import Dict, List, Tuple

import math

# ── Version sous laquelle ce jeu de mires est décrit ─────────────────────────
CLIP_VERSION = "clip-v19.5-all-checkerboard"

# ── Motif : damier 2×2 identique sur les 10 mires ────────────────────────────
# 2 carreaux NOIRS en diagonale, coins intérieurs se rejoignant À L'AXE de la mire,
# motif rogné à Ø10. (Mesuré : le 3e coin de chaque carreau tombe à r = 5,01 > 5,00,
# donc il est coupé par le cercle — c'est voulu et c'est ce qui rend le damier net.)
PATTERN_SQUARE_MM = 5.00          # côté d'un carreau
PATTERN_QUADRANT_MM = 2.50        # = PATTERN_SQUARE_MM / 2 : les 4 quadrants sont échantillonnés à ±2,50 mm
PATTERN_DIAMETER_MM = 10.00       # Ø du motif rogné
MARKER_DISC_MM = 12.00            # Ø du disque de mire (insert)
MARKER_DEPTH_MM = 0.6             # profondeur du motif (4 couches à 0,15)

# ── Plans de référence (le clip se porte comme des lunettes) ─────────────────
# Repère : X = largeur, Y = profondeur (+Y vers la caméra d'une photo de face), Z = hauteur.
FACIAL_FACE_PLANE_Y_MM = -0.75     # les 4 faces faciales sont coplanaires (y = -0.75)
LATERAL_FACE_PLANE_X_MM = 76.00    # les faces latérales sont dans les plans |x| = 76,00

# ── Mires faciales (4) ───────────────────────────────────────────────────────
# positions dans le plan y = -0.75 (Ø 12,00 mm chacune)
FACIAL_SPACING_EXTREME_MM = 100.00    # gauche ↔ droite
FACIAL_SPACING_ADJACENT_MM = 50.00    # centre ↔ extrême

FACIAL_MARKERS: Tuple[Dict, ...] = (
    {"role": "facial_gauche", "x": -50.00, "y": -0.75, "z": 3.00},
    {"role": "facial_centre", "x": 0.00, "y": -0.75, "z": 3.00},
    {"role": "facial_droite", "x": 50.00, "y": -0.75, "z": 3.00},
    {"role": "facial_haute", "x": 30.00, "y": -0.75, "z": 17.00},   # 4e mire, hors de la barre
)

# ── Mires latérales (6 : 3 par côté, symétriques) ────────────────────────────
# positions dans le plan |x| = 76,00 (Ø 12,00 mm chacune)
LATERAL_SPACING_MM = 25.00            # paire MÉTROLOGIQUE = les deux mires basses
LATERAL_MARKER_Z_LOW_MM = 12.00       # hauteur commune des deux mires basses
LATERAL_MARKER_Z_RAISED_MM = 28.00    # hauteur de la mire surélevée (= 12 + 16)

# Écart surélevée ↔ chacune des basses. Le clip le décrit comme « 20,30 mm » ; la
# valeur EXACTE se déduit de la géométrie : la surélevée est au MILIEU en profondeur
# (y = −26,5, entre −14 et −39) et 16 mm plus haut → √(12,5² + 16²) = 20,3039 mm.
LATERAL_RAISED_Y_GAP_MM = 12.50
LATERAL_RAISED_Z_GAP_MM = 16.00
LATERAL_RAISED_GAP_MM = math.hypot(LATERAL_RAISED_Y_GAP_MM, LATERAL_RAISED_Z_GAP_MM)
LATERAL_RAISED_GAP_NOMINAL_MM = 20.30   # valeur ronde employée dans les documents du clip

LATERAL_MARKERS: Tuple[Dict, ...] = (
    {"role": "laterale_eloignee", "side": "+x", "x": 76.00, "y": -39.00, "z": 12.00},
    {"role": "laterale_surelevee", "side": "+x", "x": 76.00, "y": -26.50, "z": 28.00},
    {"role": "laterale_proche", "side": "+x", "x": 76.00, "y": -14.00, "z": 12.00},
    {"role": "laterale_eloignee", "side": "-x", "x": -76.00, "y": -39.00, "z": 12.00},
    {"role": "laterale_surelevee", "side": "-x", "x": -76.00, "y": -26.50, "z": 28.00},
    {"role": "laterale_proche", "side": "-x", "x": -76.00, "y": -14.00, "z": 12.00},
)

# Rôles des deux mires qui portent la métrologie (une par côté)
METROLOGICAL_ROLES = ("laterale_proche", "laterale_eloignee")

# Toutes les distances entre mires latérales d'un MÊME côté : le détecteur doit
# distinguer la paire métrologique (25,00) du piège (20,30).
LATERAL_SAME_SIDE_SPACINGS_MM = (LATERAL_SPACING_MM, LATERAL_RAISED_GAP_MM)

# ── Encombrement du corps ────────────────────────────────────────────────────
BODY_BBOX_MM = {"x": 156.00, "y": 65.00, "z": 71.80}

# ── Provenance (pour les tests : ils revérifient ces cotes sur le STL) ───────
MEASUREMENT = {
    "source": "clip_reference_v19_5_corps.stl + clip_reference_v19_5_ins_damier_noir.stl",
    "method": "ajustement de cercle sur les lèvres d'alésage + composantes connexes",
    "tolerance_mm": 0.06,
}


def isoceles_ratio() -> float:
    """Rapport longueur / base du triangle latéral (25,00 / 20,3042 = 1,2313).

    Sert de critère de pairage INDÉPENDANT de l'échelle : sur les 3 mires d'un côté,
    la paire métrologique est celle dont la distance est `isoceles_ratio()` fois
    celle des deux autres côtés.
    """
    return LATERAL_SPACING_MM / LATERAL_RAISED_GAP_MM


def lateral_same_side_markers(side: str) -> List[Dict]:
    """Les 3 mires latérales d'un côté ('+x' ou '-x')."""
    return [m for m in LATERAL_MARKERS if m["side"] == side]


def lateral_metrological_pair(side: str = "+x") -> Tuple[Dict, Dict]:
    """La paire métrologique explicite : les DEUX MIRES BASSES de ce côté.

    C'est la réponse attendue par l'app : jamais « la meilleure paire trouvée »,
    toujours celle qui porte les 25,00 mm.
    """
    mires = {m["role"]: m for m in lateral_same_side_markers(side)}
    return mires["laterale_proche"], mires["laterale_eloignee"]


def lateral_raised_marker(side: str = "+x") -> Dict:
    """La mire surélevée (le piège à 20,30 mm)."""
    return next(m for m in lateral_same_side_markers(side)
                if m["role"] == "laterale_surelevee")


def expected_spacing_px(spacing_mm: float, scale_mm_per_px: float) -> float:
    """Distance attendue en pixels pour un écartement connu du clip."""
    if not scale_mm_per_px or scale_mm_per_px <= 0:
        raise ValueError("échelle invalide")
    return spacing_mm / scale_mm_per_px


def scale_from_span(known_spacing_mm: float, span_px: float) -> float:
    """Échelle mm/px déduite d'un écartement CONNU du clip.

    C'est LA formule de l'app : le clip n'a ni réglette ni graduation, toute
    l'échelle vient de ses écartements.
    """
    if not span_px or span_px <= 0:
        raise ValueError("distance en pixels invalide")
    return known_spacing_mm / span_px
