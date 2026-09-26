"""
Détection des mires latérales du clip — **VARIANTE « choix B » (damier unifié)**.

Contexte
--------
La v15 du clip porte **le même motif sur les 10 mires** : un **damier 2×2**,
carreaux de **5 mm**, rogné à Ø10. Les mires latérales ne sont donc plus des
disques pleins.

Pourquoi cette variante
-----------------------
`lateral.py` (chemin principal) cherche des **disques sombres Ø4**. Il ne peut pas
voir un damier, et son filtre d'aire plafonné à 300 px² rend un Ø12 indétectable
à toute échelle acceptable. Unifier le *dessin* impose donc d'unifier la
*détection*.

Ce module **inverse l'ordre** : le **damier devient le chemin PRIMAIRE**. Il ne porte
AUCUN repli interne : l'ordre de repli est tenu par la chaîne (`main._detect_lateral` →
`lateral_aruco` → `lateral`). Un repli « disques noirs » gardé ici **court-circuitait le
chemin ArUco** et rendait les mires du clip v16 avec **2,5 mm d'erreur** (mesuré).

Correction clé par rapport au chemin damier de `lateral.py`
-----------------------------------------------------------
L'ancien chemin damier était calibré pour des **carreaux de 2 mm**
(`quadrant_offset = int(1.0 / scale)`). La v15 utilise des carreaux de **5 mm** :
les 4 quadrants sont donc échantillonnés à **±2,5 mm** — exactement comme la
voie faciale (`main.py`, `int(2.5 / mm_per_px)`). C'est le point qui faisait
échouer la détection à carreaux de 5 mm.

Métrologie inchangée
--------------------
Les garde-fous de vraisemblance sont **réutilisés tels quels** depuis
`lateral.py` : l'espacement réel est TOUJOURS dérivé de la distance mesurée
(25 vs 35 mm), jamais supposé, et un couple impliquant un champ physiquement
impossible est rejeté (mieux vaut un échec explicite qu'une mesure inventée).

Interface publique identique à `lateral.py` :
    detect_lateral_markers(image, landmarker=None, known_scale=None,
                           marker_spacing_mm=None)
        → ([(x1,y1),(x2,y2)], LateralDiagnostics)
"""

import logging
import math
from itertools import combinations
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

# Géométrie MESURÉE du clip (cotes revérifiées sur les STL par tests/test_clip_geometry.py)
import clip_geometry as clip

# Garde-fous de métrologie + machinerie damier : on RÉUTILISE ce qui est déjà
# écrit et testé dans lateral.py (pas de duplication, pas de divergence).
from lateral import (
    LATERAL_MARKER_SPACING_MM,
    LATERAL_MARKER_SPACING_MM_NEW,
    LateralDiagnostics,
    _checkerboard_score_at,          # noqa: F401  (réexporté pour les tests)
    _nms_points,
    _progressive_rois,
    _scan_checkerboard_grid,
    field_width_mm,
    pair_is_plausible,
    spacing_px_bounds,
)

log = logging.getLogger("smart-optica")

# ── Motif du clip v15 ───────────────────────────────────────────────────────
# Damier 2×2, carreaux de 5 mm → les 4 quadrants sont à ±2,5 mm du centre.
LATERAL_CHECKER_SQUARE_MM = 5.0
LATERAL_CHECKER_QUADRANT_MM = LATERAL_CHECKER_SQUARE_MM / 2.0        # 2,5 mm

# Écartement nominal du clip v15 (2 mires principales latérales)
LATERAL_V15_SPACING_MM = LATERAL_MARKER_SPACING_MM                   # 25 mm

Point = Tuple[int, int]


def checker_quadrant_offsets(scale: Optional[float],
                             square_mm: float = LATERAL_CHECKER_SQUARE_MM) -> List[int]:
    """Décalages quadrant (px) à essayer.

    Échelle connue → un seul décalage, celui du carreau de 5 mm (±2,5 mm).
    Sans échelle    → balayage multi-échelle (carreaux de ~2 à ~12 mm), pour ne
                      pas dépendre d'un paramètre externe.
    """
    if scale and scale > 0:
        return [max(3, int(round(square_mm / 2.0 / scale)))]
    return [3, 4, 5, 6, 8, 10, 12]


# ════════════════════════════════════════════════════════════════════════════
# Chemin PRIMAIRE : damier 2×2 (carreaux 5 mm) — clip v15
# ════════════════════════════════════════════════════════════════════════════

def _refine_checker_center(gray: np.ndarray, cx: int, cy: int, qo: int,
                           iters: int = 4) -> Tuple[int, int]:
    """Raffine le centre d'un damier → précision SOUS-PIXEL.

    Le score damier forme un PLATEAU (il reste maximal tant que les 4
    échantillons tombent dans les bons carreaux) : le maximiser ne donne pas un
    centre net (erreur mesurée ~5 px).

    Propriété exploitable : les **2 carreaux NOIRS sont en diagonale**, donc leur
    barycentre EST le centre du motif. On itère « seuil d'Otsu → centroïde des
    pixels sombres → recentrage » (mean-shift) : la fenêtre se recentre sur le
    motif, ce qui annule le biais dû à une fenêtre décalée.
    """
    h, w = gray.shape[:2]
    r = max(int(2.2 * qo), qo + 4)
    fx, fy = float(cx), float(cy)
    for _ in range(max(1, iters)):
        x0, x1 = max(0, int(round(fx)) - r), min(w, int(round(fx)) + r + 1)
        y0, y1 = max(0, int(round(fy)) - r), min(h, int(round(fy)) + r + 1)
        win = gray[y0:y1, x0:x1]
        if win.size < 25:
            break
        t, _ = cv2.threshold(win, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Convention OpenCV : la classe SOMBRE est `src <= t` (et non `src < t`).
        # Sur un damier binaire, OTSU renvoie t = la valeur sombre elle-même :
        # `win < t` donnerait un masque VIDE.
        mask = win <= float(t)             # classe sombre = les 2 carreaux noirs
        if int(mask.sum()) < 4:
            break
        ys, xs = np.nonzero(mask)
        nfx = x0 + float(xs.mean())
        nfy = y0 + float(ys.mean())
        moved = abs(nfx - fx) + abs(nfy - fy)
        fx, fy = nfx, nfy
        if moved < 0.5:
            break
    return int(round(fx)), int(round(fy))


# ── Tolérances du pairage ────────────────────────────────────────────────────
PAIR_TOL = 0.10            # ±10 % : 25,00 mm accepté de 22,5 à 27,5 — 20,30 mm refusé
ISOCELE_TOL = 0.15         # les 2 petits côtés du triangle latéral doivent être égaux
RATIO_MIN, RATIO_MAX = 1.10, 1.45   # le côté métrologique doit ressortir (rapport 1,2313)


def _distance(a: Dict, b: Dict) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


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
       (rapport 1,2313). Critère **indépendant de l'échelle** — donc utilisable avant
       de connaître les mm/px.
    2. **Échelle connue** : la paire doit coller à un écartement CONNU du clip (25,00 mm ;
       35,00 mm seulement pour les anciens designs). Une paire à ~20,30 mm est **refusée
       explicitement** plutôt que promue en « paire trouvée ».
    3. **Sans échelle** : la paire la plus longue (le côté métrologique), sous réserve de
       plausibilité du champ — vérifiée par l'appelant.

    Retourne `(paire, info)` ; `paire` vaut `None` si rien de métrologique n'est trouvé.
    """
    info: Dict = {
        "n_candidates": len(cands),
        "candidates": [(c["x"], c["y"], round(float(c["score"]), 1)) for c in cands],
        "isoceles": False,
        "trap_rejected": False,
        "raised_rejected": False,
        "pair_is_metrological": None,
        "spacing_mm": None,
        "pair_roles": None,
    }
    if len(cands) < 2:
        return None, info

    ratio = clip.isoceles_ratio()

    # ── 1. Triangle isocèle : le côté le plus long EST la paire métrologique ──
    if len(cands) >= 3:
        meilleur = None
        for i, j, k in combinations(range(len(cands)), 3):
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
            if meilleur is None or err < meilleur[0]:
                surleve = ({i, j, k} - set(paire)).pop()
                meilleur = (err, paire, surleve)
        if meilleur is not None:
            _, (i, j), surleve = meilleur
            info.update(isoceles=True, spacing_mm=clip.LATERAL_SPACING_MM,
                        pair_is_metrological=True, raised_rejected=True,
                        pair_roles=("laterale_basse", "laterale_basse"))
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

    # ── 3. Sans échelle : la paire la plus longue (le côté métrologique) ──
    meilleur = None
    for i, j in combinations(range(len(cands)), 2):
        d = _distance(cands[i], cands[j])
        if meilleur is None or d > meilleur[0]:
            meilleur = (d, i, j)
    _, i, j = meilleur
    info.update(spacing_mm=clip.LATERAL_SPACING_MM)
    return (cands[i], cands[j]), info


def _detect_checker_pair_in_roi(gray: np.ndarray, integral: np.ndarray,
                                w: int, h: int, roi: tuple,
                                scale: Optional[float],
                                ) -> Tuple[Optional[List[Point]], Optional[float], Dict]:
    """Paire MÉTROLOGIQUE de mires DAMIER 2×2 dans une ROI.

    Multi-échelle (taille de carreau) et pairage par la GÉOMÉTRIE DU CLIP
    (voir `select_metrological_pair`) : on ne rend jamais « la meilleure paire
    trouvée », mais celle qui porte l'écartement métrologique de 25,00 mm.

    Retourne (markers, spacing_mm, info) ou (None, None, info).
    """
    x0, y0, x1, y1 = roi

    best = None  # (markers, spacing_mm, score_total, qo, info)
    info_dernier = {}
    # Toutes les mires du clip v19.5 sont des damiers IDENTIQUES : si on en voit une
    # seule, c'est le clip v19.5. Ce compteur sert au garde-fou de la chaîne d'appel
    # (`main._detect_lateral`) : ne JAMAIS retomber sur ArUco/disques noirs quand des
    # damiers du clip sont visibles — ces chemins rendraient une paire fausse (mesuré :
    # 27,69 mm au lieu de 25,00 mm, soit 10,8 % d'erreur d'échelle).
    vus = 0
    vus_cands: List = []
    for qo in checker_quadrant_offsets(scale):
        step = max(2, qo // 2)
        pts = _scan_checkerboard_grid(gray, integral, w, h, x0, y0, x1, y1, qo, step)
        if not pts:
            continue
        cands = _nms_points(pts, merge_r=qo + step)
        if len(cands) > vus:
            vus = len(cands)
            vus_cands = [(c["x"], c["y"], round(float(c["score"]), 1)) for c in cands]
        if len(cands) < 2:
            continue

        paire, info = select_metrological_pair(cands, scale)
        info_dernier = info
        if paire is None:
            continue
        score = paire[0]["score"] + paire[1]["score"]
        if best is None or score > best[2]:
            # Rafinement sous-pixel : centroïde des carreaux noirs
            r0 = _refine_checker_center(gray, paire[0]["x"], paire[0]["y"], qo)
            r1 = _refine_checker_center(gray, paire[1]["x"], paire[1]["y"], qo)
            spacing = info.get("spacing_mm") or LATERAL_V15_SPACING_MM
            best = ([r0, r1], spacing, score, qo, info)

    if not best:
        if not info_dernier:
            info_dernier = {"n_candidates": vus, "candidates": vus_cands,
                            "isoceles": False, "trap_rejected": False,
                            "raised_rejected": False, "pair_is_metrological": None,
                            "spacing_mm": None, "pair_roles": None}
        else:
            info_dernier["n_candidates"] = max(vus, info_dernier.get("n_candidates", 0))
            if vus > len(info_dernier.get("candidates") or []):
                info_dernier["candidates"] = vus_cands
        return None, None, info_dernier
    return best[0], best[1], best[4]


# ════════════════════════════════════════════════════════════════════════════
# Orchestration
# ════════════════════════════════════════════════════════════════════════════

def detect_lateral_markers(image: np.ndarray, landmarker=None,
                           known_scale: Optional[float] = None,
                           marker_spacing_mm: Optional[float] = None,
                           ) -> Tuple[List[Point], LateralDiagnostics]:
    """Détecte la paire MÉTROLOGIQUE de mires latérales (damier 2×2 du clip v19.5).

    3 mires par côté : 2 basses à 25,00 mm (métrologiques) + 1 surélevée à 20,3039 mm
    de chacune. Le pairage suit la GÉOMÉTRIE DU CLIP, jamais « la meilleure paire
    trouvée » (voir `select_metrological_pair`).

    Aucun repli interne : la chaîne d'appel (`main._detect_lateral`) essaie ensuite
    le chemin ArUco puis les clips antérieurs.

    Retourne ([(x1,y1),(x2,y2)], diagnostics) — liste vide si échec.
    """
    diag = LateralDiagnostics()
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    spacing_nominal = marker_spacing_mm or LATERAL_V15_SPACING_MM
    if known_scale and known_scale > 0:
        diag.expected_spacing_px = spacing_nominal / known_scale
        diag.expected_radius_px = int(2.0 / known_scale)   # pour le secours disques
        log.info(f"  [lateral·B] scale={known_scale:.4f}mm/px · "
                 f"carreau={LATERAL_CHECKER_SQUARE_MM:.0f}mm "
                 f"(quadrant {LATERAL_CHECKER_QUADRANT_MM:.1f}mm → "
                 f"{checker_quadrant_offsets(known_scale)[0]}px) · "
                 f"spacing={diag.expected_spacing_px:.0f}px")
    else:
        log.warning("  [lateral·B] ⚠️ SANS échelle frontale — détection sans contrainte "
                    "(balayage multi-échelle)")

    rois = _progressive_rois(w, h)
    diag.rois_tried = rois

    # ── 1. DAMIER 2×2 (clip v19.5) — pairage MÉTROLOGIQUE ──
    integral = cv2.integral(gray)
    for roi in rois:
        markers, spacing_mm, info = _detect_checker_pair_in_roi(
            gray, integral, w, h, roi, known_scale)
        # Les diagnostics sont renseignés même en cas de refus (piège surélevée) et
        # ACCUMULÉS sur les ROI : un damier vu dans une ROI ne doit pas être effacé par
        # une ROI vide, sinon la chaîne d'appel croirait le clip absent et retomberait
        # sur ArUco/disques noirs.
        n_vus = info.get("n_candidates", 0) or 0
        if n_vus > (diag.n_candidates or 0):
            diag.n_candidates = n_vus
            diag.candidates = info.get("candidates", [])
        diag.pair_is_metrological = info.get("pair_is_metrological")
        diag.raised_rejected = info.get("raised_rejected")
        diag.triangle_isoceles = info.get("isoceles")
        diag.pair_roles = info.get("pair_roles")
        if info.get("trap_rejected"):
            diag.trap_spacing_rejected = True
        if markers:
            d_px = math.hypot(markers[1][0] - markers[0][0],
                              markers[1][1] - markers[0][1])
            if not pair_is_plausible(d_px, spacing_mm, w, h):
                lo, hi = spacing_px_bounds(
                    (LATERAL_V15_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW), w, h)
                log.warning(
                    f"  [lateral·B] ⛔ Damier REJETÉ : {d_px:.0f}px pour "
                    f"{spacing_mm:.0f}mm → champ de "
                    f"{field_width_mm(d_px, spacing_mm, w, h):.0f}mm "
                    f"(écartement attendu {lo:.0f}-{hi:.0f}px). Ce n'est pas le clip.")
                continue
            diag.path = "checkerboard"
            diag.roi_used = roi
            diag.spacing_mm_detected = spacing_mm
            log.info(f"  [lateral·B] ✅ Damier {spacing_mm:.2f}mm "
                     f"({'paire métrologique' if diag.pair_is_metrological else 'ancien design'}"
                     f"{(', ' + str(info.get('n_candidates')) + ' candidats') if info.get('n_candidates') else ''}"
                     f") (ROI {roi}) : {markers}")
            return markers, diag

    log.info("  [lateral·B] ❌ Aucune paire PLAUSIBLE trouvée — aucune échelle ne sera "
             "déduite (mieux vaut un échec explicite qu'une mesure inventée)")
    return [], diag
