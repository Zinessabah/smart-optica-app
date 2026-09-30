"""
Détection des mires latérales du clip — **DÉTECTION PAR CORRÉLATION DE FORME**.

Pourquoi ce chemin (mesuré le 29/09/2026)
-----------------------------------------
L'ancien chemin (score damier sur grille + barycentre Otsu pour le sous-pixel) rendait des
points qui n'étaient **pas** les mires. Sur les 3 photos de profil **distinctes** de l'archive :
0/3 correcte, erreurs d'écartement de 3 % à 58 %, points jusqu'à 1 200 px des mires. Trois
causes, chacune mesurée :

  · `_refine_checker_center` dérivait — barycentre Otsu des pixels sombres dans une fenêtre de
    2,2 `qo` (92 px) qui attrapait cheveux et fond sombre : score local 276 → 0, dérive 127 px ;
  · le pairage retenait le triplet dont le rapport isocèle collait le mieux parmi **toutes** les
    combinaisons, sans regarder les scores (161 candidats → scores 276/212 retenus au lieu des
    vrais à 651/443) ;
  · la ROI nominale commençait à `y = 0,20 h` alors que la mire surélevée est **16 mm** au-dessus
    de la ligne des basses (≈ 260 px) : le triangle isocèle était structurellement hors d'atteinte.

Principe retenu
---------------
On compare l'image au **gabarit du clip** — disque blanc Ø13,6 portant le damier 5 mm rogné à
Ø10 (cotes de `clip_geometry.py`) — par corrélation normalisée, sur une pyramide :

  1. **balayage grossier** sur l'image réduite ÷4 : tailles de demi-carreau issues de la
     **physique** (champ plausible 150-1 000 mm), roulis de −24° à +24°. Rappel seulement ;
  2. **affinage local** en pleine résolution autour de chaque pic (taille ±, roulis ±12°), puis
     **parabole sous-pixel** sur le pic de corrélation ;
  3. **pairage** par la géométrie du clip : triangle isocèle (rapport 1,2313, jambes égales)
     **+ les 3 mires doivent répondre à la MÊME taille de carreau à ±10 %** ;
  4. **garde-fou de champ** (`pair_is_plausible`), comme avant.

Indépendance vis-à-vis de la photo faciale
------------------------------------------
Le gabarit porte la taille physique du motif, donc **aucune échelle externe n'est nécessaire**.
`known_scale` — quand l'application le transmet — ne sert qu'à essayer **en premier** la taille
correspondante : il ne valide ni ne rejette jamais une paire. Une échelle fausse (photo latérale
prise à une autre distance que la photo de face) ne peut donc plus faire échouer la détection.

Repère du clip v19.5 (voir `clip_geometry.py`) : les 2 mires **métrologiques** sont à 25,00 mm
**le long de la branche**, à la même hauteur ; la **surélevée** est 16 mm au-dessus et 12,5 mm en
arrière (écart 20,30 mm). Dans une photo de profil les 2 métrologiques apparaissent donc côte à
côte horizontalement, la surélevée au-dessus : **aucune ROI n'est nécessaire**, et c'est ce qui
supprime le défaut de ROI.

Interface publique inchangée :
    detect_lateral_markers(image, landmarker=None, known_scale=None, marker_spacing_mm=None)
        → ([(x1,y1),(x2,y2)], LateralDiagnostics)
"""

import logging
import math
from functools import lru_cache
from itertools import combinations
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# Géométrie MESURÉE du clip (cotes revérifiées sur les STL par tests/test_clip_geometry.py)
import clip_geometry as clip

# Garde-fous de métrologie : on RÉUTILISE ce qui est déjà écrit et testé dans lateral.py
from lateral import (
    FIELD_MAX_MM,
    FIELD_MIN_MM,
    LATERAL_MARKER_SPACING_MM_NEW,
    LateralDiagnostics,
    field_width_mm,
    pair_is_plausible,
    spacing_px_bounds,
)

log = logging.getLogger("smart-optica")

# ── Cotes du motif — SOURCE UNIQUE : clip_geometry ──────────────────────────
LATERAL_CHECKER_SQUARE_MM = clip.PATTERN_SQUARE_MM              # 5,00 mm (côté d'un carreau)
LATERAL_CHECKER_QUADRANT_MM = clip.PATTERN_QUADRANT_MM          # 2,50 mm (demi-carreau)
LATERAL_COLLAR_DIAMETER_MM = clip.COLLAR_DIAMETER_MM            # 13,60 mm (bord du gabarit)

# Rayons du gabarit, en demi-carreaux (qo = 2,5 mm en pixels)
_GABARIT_R_MOTIF = (clip.PATTERN_DIAMETER_MM / 2.0) / LATERAL_CHECKER_QUADRANT_MM   # 2,000
_GABARIT_R_BORD = (LATERAL_COLLAR_DIAMETER_MM / 2.0) / LATERAL_CHECKER_QUADRANT_MM  # 2,720

# Écartement nominal du clip v19.5 (2 mires principales latérales)
LATERAL_V15_SPACING_MM = clip.LATERAL_SPACING_MM                # 25,00 mm

Point = Tuple[int, int]

# ── Réglages du balayage (mesurés, voir la référence du skill) ───────────────
# Tolérance de roulis mesurée sur photo réelle : ±6° coûte 0,06 de corrélation, ±12° en coûte
# 0,18. D'où un pas grossier de 12° (l'affinage resserre ensuite à ±12° par pas de 4°).
_ANGLES_GROSSIERS: Tuple[int, ...] = (-24, -12, 0, 12, 24)
_TOL_ROULIS_AFFINAGE = 12
_PAS_ROULIS_AFFINAGE = 4
# La corrélation est PLATE sous la vraie taille (le gabarit reste dans les quadrants) et chute
# au-dessus : l'affinage doit donc descendre plus qu'il ne monte.
_FACTEURS_QO = (0.80, 0.90, 1.00, 1.10, 1.22)
# Progression ×1,35 : à la borne haute, un candidat vaut ×1,35 de la vraie taille, ce qui laisse
# encore ~0,6 de corrélation sur les mires réelles (mesuré). Le balayage grossier ne sert qu'au
# RAPPEL ; la précision vient de l'affinage.
_QO_PROGRESSION = 1.35
_FACTEUR_PYRAMIDE = 4
_SEUIL_GROSSIER = 0.45
_SEUIL_FINAL = 0.55
_MAX_CIBLES = 8
_MARGE_AFFINAGE_PX = 12
_MERGE_QO = 0.8                 # deux pics plus proches que 0,8 qo = la même mire

# ── Tolérances du pairage ────────────────────────────────────────────────────
PAIR_TOL = 0.10            # ±10 % : 25,00 mm accepté de 22,5 à 27,5 — 20,30 mm refusé
# Jambes du triangle : 10 % (mesuré 3,4 % et 3,7 % sur photos réelles — l'écart vient de la
# projection, la photo n'étant pas exactement à 90° du plan des mires).
ISOCELE_TOL = 0.10
# Rapport côté long / jambe : mesuré 1,196 et 1,173 (théorie 1,2313 → écarts 2,9 % et 4,8 %).
RATIO_TOL = 0.08
RATIO_MIN, RATIO_MAX = 1.10, 1.45
# Les 3 mires d'un même clip sont à la même distance de la caméra : même taille de carreau.
# C'est le verrou qui écarte un triplet parasite (miroir, carrelage, reflet doré).
QO_COHERENCE_TOL = 0.10


def checker_quadrant_offsets(scale: Optional[float] = None,
                             img_w: Optional[int] = None,
                             img_h: Optional[int] = None,
                             square_mm: float = LATERAL_CHECKER_SQUARE_MM) -> List[int]:
    """Demi-carreaux (`qo`, en px) à essayer pendant le balayage grossier.

    Échelle connue → ce `qo` est essayé **en premier**, et n'exclut rien : une échelle venue de
                     la photo faciale ne doit jamais pouvoir empêcher la détection.
    Sans échelle   → progression géométrique bornée par la **physique** :
                     `qo = 2,5 mm × grand_côté / champ`, champ plausible 150-1 000 mm. Ce sont
                     des MILLIMÈTRES convertis en pixels selon une échelle candidate, jamais une
                     plage de pixels arbitraire — l'ancienne plage `[3…12]` valait ~4× trop
                     petit (le vrai `qo` est ~41 px) et coûtait 100 % du temps de balayage.
    """
    q_ref = square_mm / 2.0
    qos: List[int] = []
    if scale and scale > 0:
        qos.append(max(3, int(round(q_ref / scale))))
    if img_w and img_h:
        long_cote = max(img_w, img_h)
        q = q_ref * long_cote / FIELD_MAX_MM
        q_max = q_ref * long_cote / FIELD_MIN_MM
    else:
        q, q_max = 6.0, 80.0
    while q <= q_max:
        v = max(3, int(round(q)))
        if v not in qos:
            qos.append(v)
        q *= _QO_PROGRESSION
    return qos


# ════════════════════════════════════════════════════════════════════════════
# Gabarit : le motif du clip, dessiné à la taille qo
# ════════════════════════════════════════════════════════════════════════════

@lru_cache(maxsize=1024)
def _gabarit(qo_px: int, angle: int) -> np.ndarray:
    """Gabarit du damier du clip : collier blanc Ø13,6, motif Ø10 rogné, quadrants NO/SE noirs.

    C'est le rendu synthétique des cotes MESURÉES du clip (`clip_geometry`), comparé à l'image
    par `TM_CCOEFF_NORMED`. Le contour blanc du collier fixe l'échelle lue : sur les 3 photos
    réelles, le maximum de corrélation redonne le `qo` vrai à 0 % près.
    """
    r_motif = _GABARIT_R_MOTIF * qo_px
    r_bord = _GABARIT_R_BORD * qo_px
    n = 2 * int(math.ceil(r_bord)) + 1
    c = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    dx, dy = (xx - c).astype(np.float32), (yy - c).astype(np.float32)
    d2 = dx * dx + dy * dy
    dedans = d2 <= r_motif * r_motif
    t = np.full((n, n), 128.0, np.float32)          # hors du collier : neutre
    t[d2 <= r_bord * r_bord] = 255.0                # collier blanc
    # Signature du clip : quadrants NO et SE SOMBRES (clip_geometry.SIGNATURE_QUADRANTS_SOMBRES)
    t[dedans] = np.where((dx * dy)[dedans] > 0, 0.0, 255.0)
    if angle:
        t = cv2.warpAffine(t, cv2.getRotationMatrix2D((c, c), angle, 1.0), (n, n),
                           flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                           borderValue=128.0)
    return t


def _parabole(v0: float, v1: float, v2: float) -> float:
    """Décalage sous-pixel du sommet d'une parabole passant par (-1, 0, +1)."""
    d = v0 - 2.0 * v1 + v2
    if abs(d) < 1e-9:
        return 0.0
    return float(np.clip(0.5 * (v0 - v2) / d, -0.5, 0.5))


def _sous_pixel(res: np.ndarray, pic: Tuple[int, int]) -> Tuple[float, float]:
    """Décalage sous-pixel (dx, dy) du pic d'une carte de corrélation."""
    px, py = pic
    dx = _parabole(res[py, px - 1], res[py, px], res[py, px + 1]) \
        if 0 < px < res.shape[1] - 1 else 0.0
    dy = _parabole(res[py - 1, px], res[py, px], res[py + 1, px]) \
        if 0 < py < res.shape[0] - 1 else 0.0
    return dx, dy


def _pics_grossiers(gray: np.ndarray, qos: Sequence[int],
                    angles: Sequence[int], seuil: float) -> List[Dict]:
    """Pics de corrélation sur l'image RÉDUITE (rappel), en coordonnées pleine résolution.

    ⚠️ Le `qo` rapporté est celui du gabarit RÉELLEMENT employé (`qo_petit × facteur`), pas le
    `qo` nominal de la boucle : sous le facteur de réduction, plusieurs `qo` nominaux s'écrasent
    sur la même taille réduite (4, 5, 6, 9 et 12 donnent tous 3 à ÷4). Rapporter le nominal
    faisait ensuite partir l'affinage d'une taille fausse (4 au lieu de 12) et la mire était
    perdue — c'est exactement l'échec mesuré sur la scène à 2 mires des tests.
    """
    h, w = gray.shape[:2]
    f = _FACTEUR_PYRAMIDE
    petite = cv2.resize(gray, (max(8, w // f), max(8, h // f)), interpolation=cv2.INTER_AREA)
    # tailles réduites réellement distinctes : sous la résolution du facteur, balayer plusieurs
    # `qo` nominaux ne ferait que répéter le même gabarit
    qos_petits = sorted({max(3, int(round(qo / f))) for qo in qos})
    pics: List[Dict] = []
    for qo_petit in qos_petits:
        k = max(3, qo_petit | 1)
        for ang in angles:
            t = _gabarit(qo_petit, ang)
            if t.shape[0] >= min(petite.shape):
                continue
            res = cv2.matchTemplate(petite, t, cv2.TM_CCOEFF_NORMED)
            dil = cv2.dilate(res, np.ones((k, k), np.uint8))
            ys, xs = np.nonzero((res >= dil - 1e-9) & (res > seuil))
            off = t.shape[0] // 2
            for y, x in zip(ys, xs):
                pics.append({"corr": float(res[y, x]), "qo": float(qo_petit * f),
                             "angle": int(ang),
                             "x": float((int(x) + off) * f), "y": float((int(y) + off) * f)})
    pics.sort(key=lambda p: -p["corr"])
    # regroupement : un seul pic par mire (les 2 mires métrologiques sont à 10 qo l'une de
    # l'autre, donc 0,8 qo ne peut pas les confondre)
    garde: List[Dict] = []
    for p in pics:
        if all(math.hypot(p["x"] - g["x"], p["y"] - g["y"]) > _MERGE_QO * p["qo"] for g in garde):
            garde.append(p)
    return garde


def _affiner(gray: np.ndarray, pic: Dict) -> Optional[Dict]:
    """Affine (x, y, qo, roulis) en PLEINE résolution autour d'un pic grossier.

    Fenêtre = le gabarit le plus grand + 12 px de marge : le pic grossier est déjà à quelques
    pixels près, un balayage large ne ferait que coûter. Sous-pixel par parabole sur le pic.
    """
    h, w = gray.shape[:2]
    qo0, ang0 = pic["qo"], pic["angle"]
    t_max = _gabarit(max(3, int(round(qo0 * max(_FACTEURS_QO)))), ang0)
    r = t_max.shape[0] // 2 + _MARGE_AFFINAGE_PX
    cx0, cy0 = int(round(pic["x"])), int(round(pic["y"]))
    x0, x1 = max(0, cx0 - r), min(w, cx0 + r)
    y0, y1 = max(0, cy0 - r), min(h, cy0 + r)
    fen = gray[y0:y1, x0:x1]
    if fen.size == 0:
        return None
    meilleur: Optional[Dict] = None
    for fq in _FACTEURS_QO:
        qo = max(3, int(round(qo0 * fq)))
        for ang in range(ang0 - _TOL_ROULIS_AFFINAGE,
                         ang0 + _TOL_ROULIS_AFFINAGE + 1, _PAS_ROULIS_AFFINAGE):
            t = _gabarit(qo, ang)
            if t.shape[0] > min(fen.shape) - 2:
                continue
            res = cv2.matchTemplate(fen, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, ml = cv2.minMaxLoc(res)
            if meilleur is None or mx > meilleur["corr"]:
                off = t.shape[0] // 2
                dx, dy = _sous_pixel(res, ml)
                meilleur = {"corr": float(mx), "qo": float(qo), "angle": int(ang),
                            "x": x0 + ml[0] + off + dx, "y": y0 + ml[1] + off + dy}
    return meilleur


# ════════════════════════════════════════════════════════════════════════════
# Pairage métrologique
# ════════════════════════════════════════════════════════════════════════════

def _distance(a: Dict, b: Dict) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _qo_coherent(cands: Sequence[Dict], tol: float = QO_COHERENCE_TOL) -> bool:
    """Les mires répondent-elles à la même taille de carreau (±`tol`) ?

    Sans information de taille (`qo` absent), on ne bloque pas : la fonction reste utilisable
    sur des candidats qui ne portent que (x, y, score).
    """
    tailles = [c.get("qo") for c in cands]
    if any(q is None or q <= 0 for q in tailles):
        return True
    return (max(tailles) - min(tailles)) / max(tailles) <= tol


def select_metrological_pair(cands: List[Dict], scale: Optional[float],
                             ) -> Tuple[Optional[Tuple[Dict, Dict]], Dict]:
    """Choisit la paire MÉTROLOGIQUE du clip — jamais « la meilleure paire trouvée ».

    Le clip v19.5 porte **3 mires latérales par côté** : deux **basses** à **25,00 mm**
    (seule la paire basse est métrologique) et une **surélevée** à **20,3039 mm** de
    chacune. Apparier la surélevée avec une basse donne **20,30 au lieu de 25,00 mm**,
    soit 19 % d'erreur d'échelle — et autant sur le vertex.

    Trois règles, dans cet ordre :

    1. **Triangle isocèle** (≥ 3 candidats) : les 3 mires forment un triangle
       25,00 / 20,3039 / 20,3039. Le côté métrologique est donc toujours **le plus long**
       (rapport 1,2313). Critère **indépendant de l'échelle** — donc utilisable avant de
       connaître les mm/px. **Verrou supplémentaire** : quand les candidats portent leur taille
       de carreau (`qo`), les 3 mires doivent répondre à la **même taille à ±10 %** — une photo
       n'a qu'une échelle. C'est ce verrou qui écarte un triplet parasite : sans lui, un faux
       triplet peut satisfaire seul le rapport isocèle (mesuré le 29/09).
    2. **Échelle connue** : la paire doit coller à un écartement CONNU du clip (25,00 mm ;
       35,00 mm seulement pour les anciens designs). Une paire à ~20,30 mm est **refusée
       explicitement** plutôt que promue en « paire trouvée ».
    3. **Sans échelle** : la paire la plus longue (le côté métrologique), sous réserve de
       plausibilité du champ — vérifiée par l'appelant.

    Retourne `(paire, info)` ; `paire` vaut `None` si rien de métrologique n'est trouvé.
    """
    info: Dict = {
        "n_candidates": len(cands),
        "candidates": [(round(c["x"]), round(c["y"]), round(float(c["score"]), 1))
                       for c in cands],
        "isoceles": False,
        "trap_rejected": False,
        "raised_rejected": False,
        "pair_is_metrological": None,
        "spacing_mm": None,
        "pair_roles": None,
        "qo_coherent": None,
        # Les 3 mires du clip v19.5 : la paire métrologique (base 25,00 mm) + la SURÉLEVÉE.
        # L'app s'en sert pour VÉRIFIER le placement de ses 3 marqueurs (rapport base/patte
        # = 1,2313 ± tolérance) : c'est ce qui rend l'échelle vérifiable au lieu d'être crue.
        "raised": None,          # (x, y) de la surélevée — None si non établie
        "ratio_err_pct": None,   # écart MESURÉ du rapport base/patte au rapport du clip
    }
    if len(cands) < 2:
        return None, info

    ratio = clip.isoceles_ratio()

    # ── 1. Triangle isocèle : le côté le plus long EST la paire métrologique ──
    if len(cands) >= 3:
        meilleur = None
        for i, j, k in combinations(range(len(cands)), 3):
            trio = (cands[i], cands[j], cands[k])
            if not _qo_coherent(trio):
                continue                        # 3 tailles de carreau : ce n'est pas un cliché
            cotes = sorted(
                [(_distance(cands[i], cands[j]), (i, j)),
                 (_distance(cands[i], cands[k]), (i, k)),
                 (_distance(cands[j], cands[k]), (j, k))],
                key=lambda c: -c[0])
            (d_long, paire), (d_a, _), (d_b, _) = cotes
            if min(d_a, d_b) <= 0:
                continue
            if abs(d_a - d_b) / max(d_a, d_b) > ISOCELE_TOL:
                continue                        # ce n'est pas un triangle isocèle
            r = d_long / max(d_a, d_b)
            if not (RATIO_MIN <= r <= RATIO_MAX):
                continue                        # le côté métrologique ne ressort pas assez
            err = abs(r - ratio) / ratio
            if err > RATIO_TOL:
                continue                        # le rapport ne colle pas à celui du clip
            if meilleur is None or err < meilleur[0]:
                surleve = ({i, j, k} - set(paire)).pop()
                meilleur = (err, paire, surleve)
        if meilleur is not None:
            _, (i, j), surleve = meilleur
            info.update(isoceles=True, spacing_mm=clip.LATERAL_SPACING_MM,
                        pair_is_metrological=True, raised_rejected=True,
                        qo_coherent=_qo_coherent((cands[i], cands[j], cands[surleve])),
                        pair_roles=("laterale_basse", "laterale_basse"),
                        # On rend les 3 mires : la paire (base) ET la surélevée, avec l'écart du
                        # rapport base/patte au rapport du clip. C'est ce triplet qui permet à
                        # l'app de vérifier le placement de ses 3 marqueurs.
                        raised=(int(cands[surleve]["x"]), int(cands[surleve]["y"])),
                        ratio_err_pct=round((r / ratio - 1) * 100, 3))
            log.info(f"  [lateral·B] pairage par triangle isocèle : mires "
                     f"{i}/{j} appariées (25,00 mm), mire {surleve} surélevée écartée")
            return (cands[i], cands[j]), info

    # ── 2. Échelle connue : la paire doit coller à un écartement CONNU du clip ──
    if scale and scale > 0:
        choix = [(clip.LATERAL_SPACING_MM, True), (LATERAL_MARKER_SPACING_MM_NEW, False)]
        meilleur = None
        for i, j in combinations(range(len(cands)), 2):
            d_mm = _distance(cands[i], cands[j]) * scale
            for spacing_mm, metrologique in choix:
                err = abs(d_mm - spacing_mm)
                if err <= spacing_mm * PAIR_TOL:
                    if meilleur is None or err < meilleur[0]:
                        meilleur = (err, (i, j), spacing_mm, metrologique, d_mm)
                    break
            else:
                if abs(d_mm - clip.LATERAL_RAISED_GAP_MM) <= clip.LATERAL_RAISED_GAP_MM * PAIR_TOL:
                    info["trap_rejected"] = True
        if meilleur is not None:
            _, (i, j), spacing_mm, metrologique, d_mm = meilleur
            info.update(spacing_mm=spacing_mm, pair_is_metrological=metrologique,
                        pair_roles=("laterale_basse", "laterale_basse") if metrologique
                        else None)
            return (cands[i], cands[j]), info
        if info["trap_rejected"]:
            log.warning("  [lateral·B] ⛔ PAIRE SURÉLEVÉE REFUSÉE : écartement mesuré "
                        f"≈ {clip.LATERAL_RAISED_GAP_MM:.2f} mm (la surélevée) — ce n'est "
                        "PAS la paire métrologique de 25,00 mm. Mieux vaut un échec "
                        "explicite qu'une échelle fausse de 19 %.")
        else:
            log.warning("  [lateral·B] ⛔ Aucun écartement CONNU du clip dans "
                        f"±{PAIR_TOL*100:.0f} % (25,00 / 35,00 mm) pour l'échelle "
                        "fournie — refus plutôt qu'une paire inventée.")
        return None, info

    # ── 3. Sans échelle : la paire la plus longue (le côté métrologique) ──────
    meilleur = None
    for i, j in combinations(range(len(cands)), 2):
        d = _distance(cands[i], cands[j])
        if meilleur is None or d > meilleur[0]:
            meilleur = (d, i, j)
    _, i, j = meilleur
    info.update(spacing_mm=LATERAL_V15_SPACING_MM,
                qo_coherent=_qo_coherent((cands[i], cands[j])))
    return (cands[i], cands[j]), info


# ════════════════════════════════════════════════════════════════════════════
# Orchestration
# ════════════════════════════════════════════════════════════════════════════

def detect_lateral_markers(image: np.ndarray, landmarker=None,
                           known_scale: Optional[float] = None,
                           marker_spacing_mm: Optional[float] = None,
                           ) -> Tuple[List[Point], LateralDiagnostics]:
    """Détecte la paire MÉTROLOGIQUE de mires latérales (damier 2×2 du clip v19.5).

    Aucune ROI : le balayage couvre l'image entière (la mire surélevée est 16 mm au-dessus de la
    ligne des basses, toute fenêtre devinée risque de la couper). Aucune échelle requise.

    Aucun repli interne : la chaîne d'appel (`main._detect_lateral`) essaie ensuite le chemin
    ArUco puis les clips antérieurs.

    Retourne ([(x1,y1),(x2,y2)], diagnostics) — liste vide si échec.
    """
    diag = LateralDiagnostics()
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)

    spacing_nominal = marker_spacing_mm or LATERAL_V15_SPACING_MM
    qos = checker_quadrant_offsets(known_scale, w, h)
    diag.rois_tried = [(0, 0, w, h)]        # plus de ROI : balayage plein cadre
    if known_scale and known_scale > 0:
        diag.expected_spacing_px = spacing_nominal / known_scale
        diag.expected_radius_px = int(2.0 / known_scale)
        log.info(f"  [lateral·B] échelle frontale {known_scale:.4f} mm/px → demi-carreau "
                 f"{qos[0]} px essayé en premier ({len(qos)} tailles au total : l'échelle "
                 "frontale ne contraint PAS la détection)")
    else:
        log.info(f"  [lateral·B] SANS échelle frontale — {len(qos)} tailles de carreau issues "
                 f"du champ plausible {FIELD_MIN_MM:.0f}-{FIELD_MAX_MM:.0f} mm : {qos}")

    # ── 1. balayage grossier (rappel) ───────────────────────────────────────
    brut = _pics_grossiers(gray, qos, _ANGLES_GROSSIERS, _SEUIL_GROSSIER)
    log.info(f"  [lateral·B] balayage grossier plein cadre : {len(brut)} pic(s) ≥ "
             f"{_SEUIL_GROSSIER}")

    # ── 2. affinage local en pleine résolution (précision) ──────────────────
    cands: List[Dict] = []
    for pic in brut[:_MAX_CIBLES]:
        fin = _affiner(gray, pic)
        if fin and fin["corr"] >= _SEUIL_FINAL:
            cands.append({"x": fin["x"], "y": fin["y"], "score": fin["corr"],
                          "qo": fin["qo"], "angle": fin["angle"]})
    cands.sort(key=lambda c: -c["score"])
    diag.n_candidates = len(cands)
    diag.candidates = [(round(c["x"]), round(c["y"]), round(c["score"], 3)) for c in cands]
    log.info(f"  [lateral·B] après affinage : {len(cands)} mire(s) ≥ {_SEUIL_FINAL} · "
             f"taille de carreau lue : {[int(c['qo']) for c in cands]} px")

    if len(cands) < 2:
        log.info("  [lateral·B] ❌ moins de 2 mires franches — aucune paire (mieux vaut un "
                 "échec explicite qu'une paire inventée)")
        return [], diag

    # ── 3. pairage métrologique ─────────────────────────────────────────────
    paire, info = select_metrological_pair(cands, known_scale)
    diag.pair_is_metrological = info.get("pair_is_metrological")
    diag.raised_rejected = info.get("raised_rejected")
    diag.triangle_isoceles = info.get("isoceles")
    diag.pair_roles = info.get("pair_roles")
    diag.qo_coherent = info.get("qo_coherent")
    diag.raised_mire = info.get("raised")
    diag.ratio_err_pct = info.get("ratio_err_pct")
    if info.get("trap_rejected"):
        diag.trap_spacing_rejected = True
    if paire is None:
        log.warning("  [lateral·B] ⛔ %d damier(s) du clip vu(s) mais aucune paire "
                    "métrologique — échec explicite (pas de repli sur un autre modèle)",
                    diag.n_candidates)
        return [], diag

    # ── 4. garde-fou de champ ───────────────────────────────────────────────
    d_px = _distance(paire[0], paire[1])
    spacing_mm = info.get("spacing_mm") or LATERAL_V15_SPACING_MM
    if not pair_is_plausible(d_px, spacing_mm, w, h):
        lo, hi = spacing_px_bounds(
            (LATERAL_V15_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW), w, h)
        log.warning(
            f"  [lateral·B] ⛔ Damier REJETÉ : {d_px:.0f}px pour {spacing_mm:.0f}mm → champ de "
            f"{field_width_mm(d_px, spacing_mm, w, h):.0f}mm (écartement attendu "
            f"{lo:.0f}-{hi:.0f}px). Ce n'est pas le clip.")
        return [], diag

    markers = [(int(round(paire[0]["x"])), int(round(paire[0]["y"]))),
               (int(round(paire[1]["x"])), int(round(paire[1]["y"])))]
    tailles = [c["qo"] for c in paire if c.get("qo")]
    diag.qo_px = round(sum(tailles) / len(tailles), 1) if tailles else None
    diag.path = "checkerboard"
    diag.roi_used = (0, 0, w, h)
    diag.spacing_mm_detected = spacing_mm
    log.info(f"  [lateral·B] ✅ Damier {spacing_mm:.2f}mm "
             f"({'paire métrologique' if diag.pair_is_metrological else 'design antérieur'}"
             f"{', %d candidats' % diag.n_candidates if diag.n_candidates else ''}"
             f"{', carreau lu ' + str(diag.qo_px) + 'px' if diag.qo_px else ''}"
             f") plein cadre : {markers}")
    return markers, diag
