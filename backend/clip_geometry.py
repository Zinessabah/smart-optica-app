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
l'échelle**, utilisable sans connaître les mm/px. C'est la règle de `isoceles_ratio()`
ci-dessous, appliquée par le détecteur latéral (`lateral_checker.py`).
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import math

# ── Version sous laquelle ce jeu de mires est décrit ─────────────────────────
CLIP_VERSION = "clip-v19.5-all-checkerboard"

# ── Motif : damier 2×2 identique sur les 10 mires ────────────────────────────
# 2 carreaux NOIRS en diagonale, coins intérieurs se rejoignant À L'AXE de la mire,
# motif rogné à Ø10. (Mesuré : le 3e coin de chaque carreau tombe à r = 5,01 > 5,00,
# donc il est coupé par le cercle — c'est voulu et c'est ce qui rend le damier net.)
PATTERN_SQUARE_MM = 5.00          # côté d'un carreau
PATTERN_QUADRANT_MM = 2.50        # = PATTERN_SQUARE_MM / 2 : les 4 quadrants sont échantillonnés à ±2,50 mm

# ── Signature des quadrants : elle DONNE l'orientation de la prise de vue ─────
# Les 10 damiers du clip portent la MÊME signature : quadrants NO et SE sombres,
# NE et SO clairs (relevé sur les STL : NO 0,70 / NE 0,05 / SO 0,08 / SE 0,70).
# C'est le clip lui-même qui dit comment il est vu :
#   • signature intacte (NO+SE sombres) → image NON retournée (caméra arrière) ;
#   • signature INVERSÉE (NE+SO sombres) → image en MIROIR (selfie).
# ⚠️ Une rotation de 180° ne change PAS la signature (elle échange NO↔SE et NE↔SO) :
#    le test est donc spécifique au MIROIR, pas à l'orientation de l'image.
# ⚠️ C'est la SEULE source fiable. Un client peut déclarer son `facingMode`, mais le
#    navigateur ne retourne pas toujours la capture, l'appareil photo natif produit un
#    selfie miroir, et un fichier peut venir d'ailleurs (photo déposée, admin). Le
#    clip, lui, porte l'information — et pour une mesure de DP monoculaire, se tromper
#    inverse l'œil droit et l'œil gauche.
SIGNATURE_QUADRANTS_SOMBRES = ("NO", "SE")
SIGNATURE_CONTRASTE_MIN = 8.0     # en niveaux de gris : en dessous, damier illisible

ORIENTATION_NORMALE = "normale"           # caméra arrière (ou selfie déjà retourné)
ORIENTATION_MIROIR = "miroir"             # image RETOURNÉE
ORIENTATION_INDETERMINEE = "indeterminee"  # signature illisible : on ne conclut pas


def orientation_depuis_quadrants(quadrants: Dict[str, float],
                                 contraste_min: float = SIGNATURE_CONTRASTE_MIN) -> str:
    """Orientation de la prise de vue, lue sur les 4 quadrants d'un damier.

    `quadrants` : moyennes de gris `{'NO', 'NE', 'SO', 'SE'}` autour du centre d'une
    mire. Retourne `ORIENTATION_NORMALE`, `ORIENTATION_MIROIR` ou
    `ORIENTATION_INDETERMINEE`.

    ⚠️ En dessous du contraste minimal (ou si un quadrant manque), on retourne
    `indeterminee` : mieux vaut ne rien affirmer que d'inverser gauche et droite.
    """
    try:
        no = float(quadrants["NO"])
        ne = float(quadrants["NE"])
        so = float(quadrants["SO"])
        se = float(quadrants["SE"])
    except (KeyError, TypeError, ValueError):
        return ORIENTATION_INDETERMINEE

    if max(no, ne, so, se) - min(no, ne, so, se) < contraste_min:
        return ORIENTATION_INDETERMINEE

    # Signature normale = NO+SE sont les plus SOMBRES → (NE+SO) − (NO+SE) > 0.
    ecart = (ne + so) / 2 - (no + se) / 2
    return ORIENTATION_NORMALE if ecart > 0 else ORIENTATION_MIROIR


PATTERN_DIAMETER_MM = 10.00       # Ø du motif rogné
MARKER_DISC_MM = 12.00            # Ø du disque de mire (insert)
COLLAR_DIAMETER_MM = 13.60        # Ø du collier/lèvre autour de l'insert (doc de référence du
                                  # clip v19.5 : « alésage Ø12,1 ; collier/lèvre Ø13,6 »).
                                  # Sert de BORD au gabarit de détection (`lateral_checker`) :
                                  # c'est ce contour qui fixe l'échelle lue sur la mire. Cote
                                  # de forme, jamais utilisée dans un calcul de mesure.
MARKER_DEPTH_MM = 0.6             # profondeur du motif (4 couches à 0,15)

# ── Plans de référence (le clip se porte comme des lunettes) ─────────────────
# Repère : X = largeur, Y = profondeur (+Y vers la caméra d'une photo de face), Z = hauteur.
#
# ⚠️ Les deux cotes ci-dessous désignent le CENTRE des disques, pas leur face : un insert
# fait 1,5 mm d'épaisseur, donc son centre est à 0,75 mm en retrait de sa face.
#   • faciales  : faces à y = 0,00 (face avant de la barre), centres à y = −0,75
#   • latérales : faces à |x| = 76,75, centres à |x| = 76,00
# C'est 76,75 qui porte le vertex.
# Elles s'appelaient « FACE_PLANE » jusqu'au 29/09, ce qui laissait croire à 0,75 mm près
# que le plan de face était le centre du disque. Aucun calcul ne les utilisait : le
# renommage ferme le piège sans rien changer aux mesures.
FACIAL_DISC_CENTER_Y_MM = -0.75
LATERAL_DISC_CENTER_X_MM = 76.00

# ── Mires faciales (5 sur le clip v22) ────────────────────────────────────
# centres des disques à y = −0,75 (faces à y = 0,00), Ø 12,00 mm chacune
FACIAL_SPACING_EXTREME_MM = 100.00    # gauche ↔ droite
FACIAL_SPACING_ADJACENT_MM = 50.00    # centre ↔ extrême

# ⚠️ v22 : la mire haute a un MIROIR. Le clip porte donc CINQ damiers faciaux —
# les trois de la barre, et DEUX mires hautes à x = ±30, z = 17.
#
# Cotes MESURÉES sur le kit réellement imprimé — `clip_v22_impression/
# clip_v22_a_imprimer` (11 INSERTS : 5 faciaux + 6 latéraux), plan facial
# y = 0,000 — avec `tools/mesure_clip_v22_1.py` :
#   barre  : x = −50,000 / 0,000 / +50,000 à z = 3,000 — EXACT sur les trois
#   hautes : x = ±30,000 à z = 16,921 (alésage) / 16,912 (collier), soit 0,08 mm
#            sous les 17,000 du SCAD (`stem_top_z`). On GARDE 17,000 : 0,08 mm est
#            inférieur à la résolution d'une impression FDM (couche de 0,20 mm).
#            Si l'écart était réel, il déplacerait le roll de 0,17° et les étalons
#            de 0,27 % — très en deçà des tolérances.
#   écartement extrême mesuré : 100,000 mm — inchangé.
#
# ⚠️ NE PAS se tromper de dossier : `Documents/clip_v221_a_imprimer` est une
#    variante à damiers PAPIER (sièges à +0,050, hautes à 16,940, STL facial de
#    285 684 octets). Les bras, eux, sont identiques au bit près (même md5).
#
# Ce que la symétrie apporte, et qui n'existait pas avec une seule mire haute :
#   • un étalon de 60,000 mm entre les deux hautes — le PLUS LONG hors barre ;
#   • la validation par RAPPORTS devient invariante au miroir, puisque le jeu
#     d'écartements est identique à gauche et à droite ;
#   • un contrôle de SYMÉTRIE : centre ↔ haute gauche et centre ↔ haute droite
#     doivent être égaux, sinon une mire a été prise pour une autre.
FACIAL_MARKERS: Tuple[Dict, ...] = (
    {"role": "facial_gauche", "x": -50.00, "y": -0.75, "z": 3.00},
    {"role": "facial_centre", "x": 0.00, "y": -0.75, "z": 3.00},
    {"role": "facial_droite", "x": 50.00, "y": -0.75, "z": 3.00},
    {"role": "facial_haute", "x": 30.00, "y": -0.75, "z": 17.00},   # 5e mire, hors de la barre
    {"role": "facial_haute_gauche", "x": -30.00, "y": -0.75, "z": 17.00},  # son MIROIR (v22)
)

# ── Quadrilatère facial : tout ce qui suit est DÉRIVÉ des positions ci-dessus ─
# Les 3 mires de la barre sont à z = 3,00 (= bar_height/2, une barre de 6 mm de
# haut) et la 4ᵉ à z = 17,00 (= stem_top_z, le haut du montant). **L'ÉCART
# VERTICAL qui pilote la détection vaut donc 14,00 mm** : la cote « 17 » est une
# POSITION, pas un décalage. Le code a longtemps utilisé 17,0 comme décalage —
# 21 % de trop. Inoffensif tant que la tolérance restait large, mais faux dès
# qu'on veut mesurer une inclinaison (rôle de la 4ᵉ mire).
FACIAL_BAR_Z_MM = 3.00                     # = bar_height / 2 (SCAD : bar_height = 6)
FACIAL_RAISED_ROLE = "facial_haute"
# ⚠️ v22 : la mire haute existe en DEUX exemplaires symétriques (x = ±30).
# `facial_haute` reste celle de droite (+30) pour ne rien casser des références
# existantes ; son miroir s'appelle `facial_haute_gauche` (−30).
FACIAL_RAISED_MIRROR_ROLE = "facial_haute_gauche"
FACIAL_RAISED_ROLES = (FACIAL_RAISED_MIRROR_ROLE, FACIAL_RAISED_ROLE)
FACIAL_CENTRE_ROLE = "facial_centre"
FACIAL_BAR_ROLES = ("facial_gauche", FACIAL_CENTRE_ROLE, "facial_droite")


def facial_marker(role: str) -> Dict:
    """La mire faciale d'un rôle donné (positions mesurées sur le STL)."""
    return next(m for m in FACIAL_MARKERS if m["role"] == role)


def facial_plan_pos(role: str) -> Tuple[float, float]:
    """Position (x, z) d'une mire faciale dans son plan (y = −0,75 constant).

    Les 4 mires faciales sont COPLANAIRES : la pose du clip se résout dans un
    plan (2D), pas dans l'espace — c'est ce qui rend l'ajustement stable.
    """
    m = facial_marker(role)
    return m["x"], m["z"]


def facial_span_mm(role_a: str, role_b: str) -> float:
    """Distance réelle entre deux mires faciales, dans leur plan commun."""
    xa, za = facial_plan_pos(role_a)
    xb, zb = facial_plan_pos(role_b)
    return math.hypot(xb - xa, zb - za)


def facial_direction_deg(role_from: str, role_to: str) -> float:
    """Direction du segment `role_from → role_to` (degrés, + = vers le haut).

    C'est la RÉFÉRENCE DU ROLL : l'angle mesuré sur la photo moins cette valeur
    donne l'inclinaison du clip dans le plan image. Comme la 4ᵉ mire sort de la
    rangée, la photo peut être redressée **sans aucune détection de visage** —
    la référence est mécanique.
    """
    xa, za = facial_plan_pos(role_from)
    xb, zb = facial_plan_pos(role_to)
    return math.degrees(math.atan2(zb - za, xb - xa))


FACIAL_RAISED_Z_GAP_MM = facial_marker(FACIAL_RAISED_ROLE)["z"] - FACIAL_BAR_Z_MM
FACIAL_RAISED_X_FROM_CENTRE_MM = (facial_marker(FACIAL_RAISED_ROLE)["x"]
                                  - facial_marker(FACIAL_CENTRE_ROLE)["x"])

# ── Les couples de mires qui portent un étalon : la SEULE liste à tenir à jour ──
# Tout le reste (écartements, rapports, contrôles) en est dérivé. Ils étaient
# auparavant écrits deux fois — une fois pour les spans, une fois pour les paires —
# et le commentaire promettait déjà « une seule liste ». Il n'y en a plus qu'une.
_FACIAL_PAIRES: Dict[str, Tuple[str, str]] = {
    "extreme":            ("facial_gauche", "facial_droite"),
    "adjacente":          (FACIAL_CENTRE_ROLE, "facial_droite"),
    # vers la mire haute droite (x = +30)
    "haute_centre":       (FACIAL_CENTRE_ROLE, FACIAL_RAISED_ROLE),
    "haute_droite":       ("facial_droite", FACIAL_RAISED_ROLE),
    "haute_gauche":       ("facial_gauche", FACIAL_RAISED_ROLE),
    # vers son MIROIR (x = −30) — même jeu d'écartements, d'où l'invariance au miroir
    "haute_miroir_centre":  (FACIAL_CENTRE_ROLE, FACIAL_RAISED_MIRROR_ROLE),
    "haute_miroir_gauche":  ("facial_gauche", FACIAL_RAISED_MIRROR_ROLE),
    "haute_miroir_droite":  ("facial_droite", FACIAL_RAISED_MIRROR_ROLE),
    # ⚠️ 60,000 mm : l'étalon le PLUS LONG hors barre (contre 50 mm pour une
    # adjacente). Sur une photo de face, le bruit de pixel s'y rapporte le moins —
    # c'est le meilleur estimateur d'échelle du clip, et il n'existait pas avant
    # que la mire haute ait son miroir.
    "entre_hautes":       (FACIAL_RAISED_MIRROR_ROLE, FACIAL_RAISED_ROLE),
}

# Écartements connus, en mm, nommés par le couple qu'ils joignent.
# `extreme` (100,00 mm) est l'étalon de référence : les rapports ci-dessous sont
# INVARIANTS D'ÉCHELLE, donc vérifiables sans connaître les mm/px.
FACIAL_QUAD_SPANS_MM: Dict[str, float] = {
    nom: facial_span_mm(ra, rb) for nom, (ra, rb) in _FACIAL_PAIRES.items()
}

FACIAL_QUAD_RATIOS: Dict[str, float] = {
    name: span / FACIAL_QUAD_SPANS_MM["extreme"]
    for name, span in FACIAL_QUAD_SPANS_MM.items()
}

# Références de roll : directions indépendantes vers les mires hautes. Les comparer
# entre elles contrôle la mesure d'inclinaison sans autre information. Depuis la
# v22 il y en a QUATRE (deux par mire haute, symétriques) : le roll devient la
# moyenne de quatre mesures au lieu de deux, et leur dispersion est un contrôle.
_FACIAL_ROLL_PAIRES: Dict[str, Tuple[str, str]] = {
    "haute_centre":        (FACIAL_CENTRE_ROLE, FACIAL_RAISED_ROLE),
    "haute_gauche":        ("facial_gauche", FACIAL_RAISED_ROLE),
    "haute_miroir_centre": (FACIAL_CENTRE_ROLE, FACIAL_RAISED_MIRROR_ROLE),
    "haute_miroir_droite": ("facial_droite", FACIAL_RAISED_MIRROR_ROLE),
}

FACIAL_ROLL_REFS_DEG: Dict[str, float] = {
    nom: facial_direction_deg(ra, rb) for nom, (ra, rb) in _FACIAL_ROLL_PAIRES.items()
}

# Tolérances du contrôle croisé du quadrilatère.
FACIAL_SCALE_TOL = 0.02          # les étalons doivent concorder à ±2 %
FACIAL_ROLL_TOL_DEG = 3.0        # accord exigé entre les 2 références de roll
# Symétrie des deux mires hautes (v22) : écart relatif admis entre les deux
# distances au centre (33,1059 mm chacune). Volontairement plus large que les 2 %
# des étalons : on écarte la mire prise pour une autre, pas le bruit de pixel.
FACIAL_SYMMETRY_TOL = 0.05
# ── Validation des écartements en MILLIMÈTRES (et non en relatif) ───────────
# ⚠️ Les rapports d'écartements ne sont invariants que sous une vue FRONTALE
# ORTHOGRAPHIQUE. Sur une vraie photo prise de biais — le cas NORMAL — ils
# dérivent, et un seuil relatif de 2 % rejette alors une détection juste.
# Mesuré sur une photo réelle du clip : 6,67 % de dispersion, dont 4,65 % pour le
# SEUL écartement le plus court (24,4 mm), causés par 1 mm d'erreur de point.
# Un écart relatif punit donc les petits écartements hors de toute proportion.
# On juge à la place chaque écartement en MILLIMÈTRES du clip, contre l'échelle
# médiane : le critère est uniforme, et il a un sens physique direct.
# 2,0 mm : au-delà, c'est un point qui n'est pas celui du clip (la détection
# mesure 1 mm sur photo réelle, et la plus courte portée est de 24,4 mm).
FACIAL_SPAN_TOL_MM = 2.0


def _dist2(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def facial_scale_estimates(points_px: Dict[str, Tuple[float, float]]) -> Dict[str, float]:
    """Échelle (mm/px) déduite de CHAQUE écartement connu du quadrilatère facial.

    Le clip n'a ni réglette ni graduation : chacun de ses écartements est un
    étalon. Les confronter est un auto-contrôle — une mire prise pour une autre,
    ou un damier parasite, les fait diverger. L'échelle faciale n'était jusqu'ici
    tirée que du span des extrêmes (100 mm) ; la 4ᵉ mire en donne deux autres,
    dont deux INCLINÉS (donc insensibles à une rotation dans le plan).

    `points_px` : centres MESURÉS par rôle, dans un repère quelconque (les
    rapports seuls comptent, l'unité est le pixel de l'image).
    """
    out: Dict[str, float] = {}
    for nom, (ra, rb) in _FACIAL_PAIRES.items():
        if ra not in points_px or rb not in points_px:
            continue
        span = _dist2(points_px[ra], points_px[rb])
        if span > 0:
            out[nom] = FACIAL_QUAD_SPANS_MM[nom] / span
    return out


def facial_roll_by_ref(points_px: Dict[str, Tuple[float, float]]) -> Dict[str, float]:
    """Inclinaison du clip (degrés) vue depuis CHAQUE référence vers la 4ᵉ mire.

    `roll = direction_mesurée − direction_du_clip`. La 4ᵉ mire sort de la
    rangée, donc le segment qui la joint a une pente connue du clip (25,02° depuis
    le centre, 9,93° depuis la gauche) : toute rotation du clip s'y ajoute. Deux
    références indépendantes ⇒ contrôle croisé, et aucune détection de visage
    n'est nécessaire — la référence est mécanique.

    ⚠ Repère image : `y` croît vers le BAS. On inverse son signe pour parler la
    même langue que le clip (z = hauteur, croissante vers le haut) ; sans cela le
    roll sortirait de signe opposé.
    """
    out: Dict[str, float] = {}
    for nom, (ra, rb) in _FACIAL_ROLL_PAIRES.items():
        if ra not in points_px or rb not in points_px:
            continue
        (ax, ay), (bx, by) = points_px[ra], points_px[rb]
        mesure = math.degrees(math.atan2(-(by - ay), bx - ax))
        out[nom] = mesure - FACIAL_ROLL_REFS_DEG[nom]
    return out


def facial_quad_check(points_px: Dict[str, Tuple[float, float]],
                      scale_tol: float = FACIAL_SCALE_TOL,
                      roll_tol_deg: float = FACIAL_ROLL_TOL_DEG,
                      symmetry_tol: float = FACIAL_SYMMETRY_TOL,
                      span_tol_mm: float = FACIAL_SPAN_TOL_MM) -> Dict:
    """Diagnostic complet du quadrilatère facial : échelle, cohérence, roll.

    Trois apports, tous fondés sur la géométrie mesurée du clip :

    **A. Auto-contrôle des étalons** — `scale_by_span` donne l'échelle déduite de
    chaque écartement ; `scale_spread` leur dispersion relative. Une dispersion
    au-delà de `scale_tol` signale une mire prise pour une autre (ou un damier
    parasite), donc une échelle fausse pour TOUTES les mesures.

    **B. Validation sans échelle** — `ratio_spread` compare les rapports
    d'écartements MESURÉS à ceux du clip. Comme ils sont invariants d'échelle, le
    quadruplet est validable avant même de connaître les mm/px (même principe que
    le rapport 1,2313 du triangle latéral).

    **C. Roll du clip** — `roll_deg` est l'inclinaison dans le plan image, vue
    par deux références indépendantes ; `roll_disagreement_deg` est leur écart.
    Il permet de redresser la photo sur une référence MÉCANIQUE plutôt que sur
    l'angle inter-pupillaire (qui dépend d'un visage détecté), et de signaler un
    clip posé de travers.

    Retourne un dict sérialisable (JSON), sûr même si des mires manquent.
    """
    est = facial_scale_estimates(points_px)
    roll = facial_roll_by_ref(points_px)
    sym = facial_raised_symmetry(points_px)
    tri = facial_triangles_scale(points_px)


    scale = None
    spread = None
    if len(est) >= 2:
        vals = sorted(est.values())
        med = vals[len(vals) // 2]
        if med > 0:
            scale = med
            spread = (vals[-1] - vals[0]) / med

    # ── L'échelle par les DEUX TRIANGLES faciaux (idée Driss) ────────────────
    # Dès qu'un triangle est identifié par sa FORME, c'est lui qui porte
    # l'échelle : son côté le plus long joint le centre à l'extrême — deux mires
    # de barre — donc la mire haute n'entre plus dans l'échelle. C'est ce qui
    # supprime la dépendance mesurée à 3,6 %.
    # La médiane des étalons reste exposée (`scale_median_spans`) pour comparaison
    # et pour les cas où aucun triangle n'est identifiable (clip à une seule mire
    # haute, mire haute masquée).
    scale_median_spans = scale
    if tri["scale_mm_per_px"]:
        scale = tri["scale_mm_per_px"]

    # ── Résidus en MILLIMÈTRES, contre l'échelle médiane ────────────────────
    # Chaque écartement est comparé à sa valeur sur le clip, en mm. Uniforme :
    # le plus court (24,4 mm) n'est pas davantage puni que le plus long (100 mm).
    residus_mm: Dict[str, float] = {}
    max_residu_mm = None
    if scale:
        for nom, (ra, rb) in _FACIAL_PAIRES.items():
            if ra in points_px and rb in points_px:
                span_px = _dist2(points_px[ra], points_px[rb])
                if span_px > 0:
                    residus_mm[nom] = abs(span_px * scale - FACIAL_QUAD_SPANS_MM[nom])
        if residus_mm:
            max_residu_mm = max(residus_mm.values())

    # Rapports normalisés : chaque écartement mesuré / théorique, puis divisé par
    # le plus grand. Tous valent 1,0 pour un quadruplet correct, quelle que soit
    # l'échelle ; leur dispersion est la mesure d'incohérence.
    ratios: Dict[str, float] = {}
    ratio_spread = None
    if len(est) >= 2:
        maxi = max(est.values())
        ratios = {nom: v / maxi for nom, v in est.items()}
        rs = sorted(ratios.values())
        ratio_spread = (rs[-1] - rs[0]) / rs[-1] if rs[-1] > 0 else None

    roll_deg = None
    disagreement = None
    if roll:
        vals_r = sorted(roll.values())
        if len(vals_r) == 1:
            roll_deg = vals_r[0]
        else:
            roll_deg = sum(vals_r) / len(vals_r)
            disagreement = vals_r[-1] - vals_r[0]

    return {
        "n_points": len(points_px),
        "scale_mm_per_px": scale,
        "scale_by_span": est,
        "scale_spread": spread,
        "scale_consistent": spread is not None and spread <= scale_tol,
        "ratio_by_span": ratios,
        "ratio_spread": ratio_spread,
        "ratios_consistent": ratio_spread is not None and ratio_spread <= scale_tol,
        "roll_deg": roll_deg,
        "roll_by_ref": roll,
        "roll_disagreement_deg": disagreement,
        "roll_consistent": (disagreement is not None
                            and disagreement <= roll_tol_deg),
        # ── v22 : les deux mires hautes ────────────────────────────────────
        # Absent (`{}`) sur un clip à une seule mire haute — le champ est toujours
        # présent pour que le contrat de réponse ne dépende pas du clip rencontré.
        "raised_symmetry": sym,
        "raised_symmetric": (sym["dissymetrie_max"] <= symmetry_tol) if sym else None,
        "n_raised": len([r for r in (FACIAL_RAISED_ROLE, FACIAL_RAISED_MIRROR_ROLE)
                         if r in points_px]),
        # ── Les deux triangles faciaux ──────────────────────────────────────
        "triangles": tri,
        "scale_median_spans": scale_median_spans,
        # ── Résidus en mm : le critère qui porte l'acceptation ──────────────
        "span_residual_mm": residus_mm,
        "max_span_residual_mm": max_residu_mm,
        "spans_consistent": (max_residu_mm is not None
                             and max_residu_mm <= span_tol_mm),
    }


def facial_points_from_markers(markers: List[Dict]) -> Dict[str, Tuple[float, float]]:
    """Associe les mires MESURÉES à leurs rôles, pour `facial_quad_check`.

    `markers` : liste de dicts `{'x', 'y', ...}` dans l'ordre rendu par le
    détecteur — `[gauche, centre, droite, mire haute, (mire haute miroir)]`.
    L'ordre est celui du clip (et non un tri par x), car la mire haute tombe
    ENTRE le centre et l'extrême.

    ⚠️ **Le 5ᵉ point est facultatif** : un clip v19.5 n'a qu'une mire haute, et
    une photo peut n'en montrer qu'une. Les 4 premiers rôles sont alors servis
    comme avant, sans rien changer.

    ⚠️ **Un échange des deux mires hautes est SANS EFFET** : leur jeu
    d'écartements est symétrique (`haute_centre` = `haute_miroir_centre`, etc.),
    donc les spans, les rapports et le contrôle de symétrie sont identiques que
    l'image soit en miroir ou non. C'est la raison pour laquelle la v22 rend la
    validation invariante au miroir, là où le clip à une seule mire haute exigeait
    de refléter les abscisses avant de vérifier.
    """
    if len(markers) < 4:
        return {}
    roles = ("facial_gauche", FACIAL_CENTRE_ROLE, "facial_droite", FACIAL_RAISED_ROLE)
    if len(markers) >= 5:
        roles = roles + (FACIAL_RAISED_MIRROR_ROLE,)
    return {role: (float(m["x"]), float(m["y"])) for role, m in zip(roles, markers)}


# ── Les DEUX triangles faciaux : l'échelle par la FORME (idée Driss) ─────────
# Le clip porte de quoi former DEUX triangles symétriques, un par côté :
#     droite : centre (0 ; 3) · droite (+50 ; 3) · haute droite (+30 ; 17)
#     gauche : centre (0 ; 3) · gauche (−50 ; 3) · haute gauche (−30 ; 17)
# Chacun a les mêmes trois côtés — 50,000 / 33,1059 / 24,4131 mm — donc la même
# forme. C'est le principe du triangle LATÉRAL transposé en vue de face : le côté
# le plus long porte l'échelle, la FORME identifie le triangle sans supposer
# d'échelle.
#
# ⚠️ Ce que cela corrige, mesuré : l'échelle était la MÉDIANE de 5 à 9 étalons,
#    dont TROIS dépendaient de la mire haute et bougeaient ensemble — ils
#    l'emportaient sur les deux de la barre, et l'échelle variait de 3,6 % entre
#    deux variantes de détection (0,1032 contre 0,0995 mm/px). Ici le côté le
#    plus long d'un triangle facial joint le CENTRE et l'EXTRÊME : deux mires de
#    barre, et la mire haute n'entre plus dans l'échelle du tout.
# ⚠️ Et les deux triangles doivent donner LA MÊME échelle — un contrôle croisé
#    que le clip à une seule mire haute ne pouvait pas offrir.
FACIAL_TRIANGLES: Dict[str, Tuple[str, str, str]] = {
    "droite": (FACIAL_CENTRE_ROLE, "facial_droite", FACIAL_RAISED_ROLE),
    "gauche": (FACIAL_CENTRE_ROLE, "facial_gauche", FACIAL_RAISED_MIRROR_ROLE),
}
# DEUX tolerances, et elles ne jouent PAS le meme role :
#   - la FORME identifie le triangle (a-t-on pris les bonnes mires ?). Elle est
#     franche : sous perspective les rapports de cotes se deforment - mesure 5,26 %
#     sur une photo juste. Elle n'a pas a juger la metrologie ;
#   - l'ACCORD entre les deux cotes est le vrai controle croise : les deux
#     triangles sont symetriques sur le clip, ils doivent rendre la meme echelle.
#     C'est lui qui est serre.
FACIAL_TRIANGLE_SHAPE_TOL = 0.12
FACIAL_TRIANGLE_SCALE_TOL = 0.02


def facial_triangle_sides_mm(side: str) -> Dict[str, float]:
    """Les trois côtés d'un triangle facial, en mm — dérivés, jamais recopiés."""
    a, b, c = FACIAL_TRIANGLES[side]
    return {f"{a}|{b}": facial_span_mm(a, b),
            f"{a}|{c}": facial_span_mm(a, c),
            f"{b}|{c}": facial_span_mm(b, c)}


def facial_triangle_scale(points_px: Dict[str, Tuple[float, float]],
                          side: str) -> Optional[Dict]:
    """Échelle déduite d'UN triangle facial, par sa forme.

    Le côté le PLUS LONG porte l'échelle (50,000 mm : centre ↔ extrême, deux
    mires de barre) ; les RAPPORTS des deux autres côtés à celui-là identifient
    le triangle sans supposer d'échelle — une forme fausse signale qu'on n'a pas
    pris les bonnes mires.
    """
    a, b, c = FACIAL_TRIANGLES[side]
    if not all(r in points_px for r in (a, b, c)):
        return None
    mm = facial_triangle_sides_mm(side)
    px = {f"{ra}|{rb}": _dist2(points_px[ra], points_px[rb])
          for ra, rb in ((a, b), (a, c), (b, c))}
    if min(px.values()) <= 0:
        return None

    nom_long = max(mm, key=lambda k: mm[k])
    echelle = mm[nom_long] / px[nom_long]
    ratios_mm = {n: mm[n] / mm[nom_long] for n in mm if n != nom_long}
    ratios_px = {n: px[n] / px[nom_long] for n in mm if n != nom_long}
    ecarts = {n: abs(ratios_px[n] - ratios_mm[n]) / ratios_mm[n] for n in ratios_mm}
    pire = max(ecarts.values())
    return {"side": side,
            "scale_mm_per_px": echelle,
            "longest": nom_long,
            "longest_mm": mm[nom_long],
            "ratio_by_side": ratios_px,
            "ratio_residual": pire,
            "shape_ok": pire <= FACIAL_TRIANGLE_SHAPE_TOL}


def facial_triangles_scale(points_px: Dict[str, Tuple[float, float]],
                           scale_tol: float = FACIAL_TRIANGLE_SCALE_TOL) -> Dict:
    """Échelle MOYENNE des deux triangles faciaux, et leur accord.

    Les deux triangles étant symétriques sur le clip, ils doivent rendre la même
    échelle : leur écart est un contrôle croisé direct. La moyenne divise le bruit
    de pixel par racine de deux quand les deux côtés sont exploitables.
    """
    par_cote = {s: facial_triangle_scale(points_px, s) for s in FACIAL_TRIANGLES}
    valides = {s: t for s, t in par_cote.items() if t and t["shape_ok"]}

    out: Dict = {"by_side": par_cote, "n_sides": len(valides),
                 "scale_mm_per_px": None, "disagreement": None,
                 "sides_agree": None, "sides": sorted(valides)}
    if valides:
        out["scale_mm_per_px"] = (sum(t["scale_mm_per_px"] for t in valides.values())
                                  / len(valides))
    if len(valides) == 2:
        v = sorted(t["scale_mm_per_px"] for t in valides.values())
        out["disagreement"] = (v[1] - v[0]) / ((v[0] + v[1]) / 2) if v[0] + v[1] else None
        out["sides_agree"] = (out["disagreement"] is not None
                              and out["disagreement"] <= scale_tol)
    return out


def facial_raised_symmetry(points_px: Dict[str, Tuple[float, float]]) -> Dict[str, float]:
    """Contrôle de SYMÉTRIE des deux mires hautes (v22).

    Sur le clip, `centre ↔ haute droite` et `centre ↔ haute gauche` valent tous
    deux 33,1059 mm, et `gauche ↔ haute droite` = `droite ↔ haute gauche` =
    81,2158 mm. Ces égalités sont vraies quelle que soit l'échelle : leur écart
    RELATIF est donc un contrôle direct, sans rien supposer.

    Une dissymétrie franche signifie qu'une mire a été prise pour une autre — ou
    que le détecteur a posé un point sur un damier qui n'est pas celui du clip.
    C'est le seul contrôle du clip qui exploite la symétrie de la v22.
    """
    if FACIAL_RAISED_MIRROR_ROLE not in points_px or FACIAL_RAISED_ROLE not in points_px:
        return {}
    c = points_px.get(FACIAL_CENTRE_ROLE)
    g = points_px.get("facial_gauche")
    d = points_px.get("facial_droite")
    if c is None:
        return {}
    a = _dist2(points_px[FACIAL_CENTRE_ROLE], points_px[FACIAL_RAISED_MIRROR_ROLE])
    b = _dist2(points_px[FACIAL_CENTRE_ROLE], points_px[FACIAL_RAISED_ROLE])
    if min(a, b) <= 0:
        return {}
    out = {
        "centre_haute_gauche": a,
        "centre_haute_droite": b,
        "dissymetrie_centre": abs(a - b) / ((a + b) / 2),
    }
    if g is not None and d is not None:
        e = _dist2(points_px["facial_gauche"], points_px[FACIAL_RAISED_ROLE])
        f = _dist2(points_px["facial_droite"], points_px[FACIAL_RAISED_MIRROR_ROLE])
        if min(e, f) > 0:
            out["gauche_haute_droite"] = e
            out["droite_haute_gauche"] = f
            out["dissymetrie_croisee"] = abs(e - f) / ((e + f) / 2)
    out["dissymetrie_max"] = max(v for k, v in out.items() if k.startswith("dissymetrie"))
    return out

# ── Mires latérales (6 : 3 par côté, symétriques) ────────────────────────────
# centres des disques dans les plans |x| = 76,00 (faces à |x| = 76,75), Ø 12,00 mm chacune
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


# ── Homographie du plan facial (NON VALIDÉE, NON BRANCHÉE) ──────────────────
# ⚠️ ÉTAT RÉEL, mesuré : `homographie_4_points` + `focale_et_residu_rigidite`
# lèvent « correspondances dégénérées » sur une projection AFFINE — cas d'un plan
# rigide parfaitement valide — car la DLT à 4 points est singulière pour des
# données affines. Sur une vraie photo, l'homographie passe mais la rigidité ne
# trouve AUCUNE focale (résidu 100 %), y compris quand la détection est juste.
# Ce chemin n'est donc PAS utilisé pour l'acceptation : l'app juge les écarts en
# millimètres (`FACIAL_SPAN_TOL_MM`). Ne pas rebrancher sans l'avoir corrigé et
# vérifié sur un cas analytique à focale connue.
# ── Homographie du plan facial : valider la géométrie EN PERSPECTIVE ─────────
# Les 4 mires faciales sont COPLANAIRES (y = −0,75) et leurs positions dans ce plan
# sont connues. Quatre correspondances plan ↔ image déterminent donc une homographie
# H (8 paramètres, exacte par construction).
#
# ⚠️ Une homographie à 4 points ne VALIDE rien : elle reproduit ces 4 points
# exactement, résidu nul par construction. Ce qui valide, c'est la contrainte de
# RIGIDITÉ du plan — critère de Zhang : si H est bien la projection d'un plan rigide,
# alors K⁻¹H = [m1 m2 m3] doit vérifier   m1·m2 = 0   et   |m1| = |m2|.
#
# Ces deux contraintes sont LINÉAIRES en g = 1/f² (f = focale en pixels), donc elles
# fournissent à la fois une ESTIMATION de la focale et un RÉSIDU sans dimension qui
# mesure l'écart à la rigidité. C'est ce résidu qui remplace les rapports de distances
# — dont l'invariance suppose, elle, une vue frontale orthographique : c'est pourquoi
# elle échoue sur une vraie photo prise de biais.
FACIAL_PLAN_ROLES = ("facial_gauche", FACIAL_CENTRE_ROLE, "facial_droite", FACIAL_RAISED_ROLE)


def _resoudre_systeme(matrice: List[List[float]],
                      second_membre: List[float]) -> List[float]:
    """Élimination de Gauss avec pivot partiel. None si le système est singulier."""
    n = len(matrice)
    a = [list(matrice[i]) + [second_membre[i]] for i in range(n)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        inv = 1.0 / a[col][col]
        for r in range(n):
            if r == col:
                continue
            facteur = a[r][col] * inv
            if facteur:
                for c in range(col, n + 1):
                    a[r][c] -= facteur * a[col][c]
    return [a[i][n] / a[i][i] for i in range(n)]


def _normalisation(points: List[Tuple[float, float]]) -> Tuple[List[Tuple[float, float]], List[List[float]]]:
    """Normalisation isotrope (Hartley) : centroïde à l'origine, distance moyenne √2.

    Sans elle, les coordonnées du plan (≈100 mm) et celles de l'image (≈1000 px)
    diffèrent de quatre ordres de grandeur et le système 8×8 devient mal conditionné.
    """
    n = float(len(points))
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    d = [math.hypot(p[0] - cx, p[1] - cy) for p in points]
    moyenne = sum(d) / n
    s = (math.sqrt(2.0) / moyenne) if moyenne > 1e-12 else 1.0
    T = [[s, 0.0, -s * cx], [0.0, s, -s * cy], [0.0, 0.0, 1.0]]
    return [(s * (p[0] - cx), s * (p[1] - cy)) for p in points], T


def _matmul(a: List[List[float]], b: List[List[float]]) -> List[List[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _inverse_3x3(m: List[List[float]]) -> List[List[float]]:
    det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
           - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
           + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
    if abs(det) < 1e-15:
        raise ValueError("matrice non inversible")
    c = [[(m[1][1] * m[2][2] - m[1][2] * m[2][1]),
          -(m[0][1] * m[2][2] - m[0][2] * m[2][1]),
          (m[0][1] * m[1][2] - m[0][2] * m[1][1])],
         [-(m[1][0] * m[2][2] - m[1][2] * m[2][0]),
          (m[0][0] * m[2][2] - m[0][2] * m[2][0]),
          -(m[0][0] * m[1][2] - m[0][2] * m[1][0])],
         [(m[1][0] * m[2][1] - m[1][1] * m[2][0]),
          -(m[0][0] * m[2][1] - m[0][1] * m[2][0]),
          (m[0][0] * m[1][1] - m[0][1] * m[1][0])]]
    return [[c[i][j] / det for j in range(3)] for i in range(3)]


def homographie_4_points(plan_pts: List[Tuple[float, float]],
                         image_pts: List[Tuple[float, float]]) -> List[List[float]]:
    """Homographie plan → image à partir de 4 correspondances (h22 posé à 1).

    ⚠️ Exacte par CONSTRUCTION sur ces 4 points : elle ne prouve pas que la
    détection est bonne. La validation se fait par `focale_et_residu_rigidite`.
    """
    if len(plan_pts) != 4 or len(image_pts) != 4:
        raise ValueError("il faut exactement 4 correspondances")
    pn, Tp = _normalisation(plan_pts)
    in_, Ti = _normalisation(image_pts)

    matrice, second = [], []
    for (X, Z), (u, v) in zip(pn, in_):
        matrice.append([X, Z, 1.0, 0.0, 0.0, 0.0, -X * u, -Z * u])
        second.append(u)
        matrice.append([0.0, 0.0, 0.0, X, Z, 1.0, -X * v, -Z * v])
        second.append(v)
    h = _resoudre_systeme(matrice, second)
    if h is None:
        raise ValueError("correspondances dégénérées")
    Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]]
    return _matmul(_inverse_3x3(Ti), _matmul(Hn, Tp))


def focale_et_residu_rigidite(H: List[List[float]], cx: float, cy: float
                              ) -> Tuple[float, float]:
    """Focale estimée (px) et résidu de rigidité du plan, d'après H.

    Contraintes de Zhang pour un plan rigide, avec K = diag(f, f, 1) et le point
    principal en (cx, cy) :

        m1·m2 = 0            et       |m1|² − |m2|² = 0,   avec [m1 m2 m3] = K⁻¹H

    En posant e(h) = (h_x − cx·h_w, h_y − cy·h_w) et g = 1/f², elles deviennent
    LINÉAIRES en g :

        g·(e1·e2)        + h1w·h2w        = 0
        g·(|e1|² − |e2|²) + (h1w² − h2w²) = 0

    On estime g au sens des moindres carrés, puis on retourne le résidu RELATIF
    (sans dimension) : |m1·m2| et ||m1|² − |m2|²| rapportés à |m1|² + |m2|².
    Un plan rigide vu par une vraie caméra donne un résidu voisin de zéro ; des mires
    mal appariées donnent une homographie « tordue » qu'aucune focale ne rend rigide.
    """
    h1 = (H[0][0], H[1][0], H[2][0])
    h2 = (H[0][1], H[1][1], H[2][1])
    e1 = (h1[0] - cx * h1[2], h1[1] - cy * h1[2])
    e2 = (h2[0] - cx * h2[2], h2[1] - cy * h2[2])

    a1 = e1[0] * e2[0] + e1[1] * e2[1]
    a2 = (e1[0] ** 2 + e1[1] ** 2) - (e2[0] ** 2 + e2[1] ** 2)
    b1 = h1[2] * h2[2]
    b2 = h1[2] ** 2 - h2[2] ** 2

    den = a1 * a1 + a2 * a2
    if den <= 1e-15:
        return 0.0, 1.0
    g = -(a1 * b1 + a2 * b2) / den
    if g <= 1e-15:
        # Aucune focale réelle ne rend le plan rigide.
        return 0.0, 1.0
    f = 1.0 / math.sqrt(g)

    m1 = (e1[0] / f, e1[1] / f, h1[2])
    m2 = (e2[0] / f, e2[1] / f, h2[2])
    n1 = m1[0] ** 2 + m1[1] ** 2 + m1[2] ** 2
    n2 = m2[0] ** 2 + m2[1] ** 2 + m2[2] ** 2
    echelle = n1 + n2
    if echelle <= 1e-15:
        return f, 1.0
    t1 = m1[0] * m2[0] + m1[1] * m2[1] + m1[2] * m2[2]
    t2 = n1 - n2
    residu = max(abs(t1), abs(t2)) / echelle
    return f, residu


def point_image_vers_plan(H: List[List[float]], u: float, v: float
                          ) -> Tuple[float, float]:
    """Coordonnées dans le PLAN du clip (mm) d'un point de l'image.

    ⚠️ Valable pour les points situés DANS ce plan. Les pupilles sont ~13 mm en avant
    (plan des verres) : la même homographie donne alors une erreur systématique de
    l'ordre du rapport (distance mires–pupilles / distance caméra), d'où l'étape
    ultérieure de pose 3D. Pour les mesures de l'app, c'est cette transformation qui
    remplace l'échelle GLOBALE (mm/px) supposée constante : elle donne le facteur
    d'échelle LOCAL, donc une mesure juste même sur une photo prise de biais.
    """
    Hi = _inverse_3x3(H)
    w = Hi[2][0] * u + Hi[2][1] * v + Hi[2][2]
    if abs(w) < 1e-12:
        raise ValueError("point à l'infini du plan")
    return ((Hi[0][0] * u + Hi[0][1] * v + Hi[0][2]) / w,
            (Hi[1][0] * u + Hi[1][1] * v + Hi[1][2]) / w)


def points_plan_facial() -> List[Tuple[float, float]]:
    """Les 4 mires faciales dans leur plan, en mm : (x, z)."""
    return [(facial_marker(role)["x"], facial_marker(role)["z"])
            for role in FACIAL_PLAN_ROLES]
