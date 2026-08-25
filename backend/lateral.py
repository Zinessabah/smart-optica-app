"""
Détection des mires latérales du clip — module dédié.

Clip ACTUEL (utilisé)   : 2 cercles noirs opaques Ø 4 mm, centres à 25 mm
                          → chemin PRINCIPAL (filtre adapté + BlobDetector +
                          contours/Otsu).
Nouveau design v3/v4    : étiquettes damier 2×2 à 35 mm le long du bras
                          → chemin SECOURS (scan damier 2D).

Stratégie commune : ROIs progressives (cadrage nominal → élargi → quasi
complet). L'espacement réel des mires est TOUJOURS dérivé de la distance
mesurée (25 vs 35 mm), jamais supposé.

Chaîne :
    detect_lateral_markers(image, landmarker, known_scale, spacing_mm)
        → ([(x1,y1),(x2,y2)], spacing_utilisé, diagnostics)

Fonctions pures et testables unitairement.
"""

import logging
import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np

log = logging.getLogger("smart-optica")

# ── Constantes ──────────────────────────────────────────────────────────────

LATERAL_MARKER_DIAMETER_MM = 4.0      # diamètre des mires (les deux designs)
LATERAL_MARKER_SPACING_MM = 25.0      # clip actuel : cercles noirs à 25 mm
LATERAL_MARKER_SPACING_MM_NEW = 35.0  # nouveau design v3/v4 : 35 mm le long du bras

Point = Tuple[int, int]


# ── Diagnostics ─────────────────────────────────────────────────────────────

@dataclass
class LateralDiagnostics:
    """Informations intermédiaires — pour logs et debug."""
    path: Optional[str] = None                 # "dark_circles" | "checkerboard"
    roi_used: Optional[tuple] = None           # ROI dans laquelle la paire a été trouvée
    rois_tried: List[tuple] = field(default_factory=list)
    expected_spacing_px: Optional[float] = None
    expected_radius_px: Optional[int] = None
    spacing_mm_detected: Optional[float] = None  # espacement réel des mires (25/35)


def _progressive_rois(w: int, h: int) -> List[Tuple[int, int, int, int]]:
    """ROIs de recherche : nominale → élargie → quasi complète."""
    return [
        (int(w * 0.55), int(h * 0.20), int(w * 0.90), int(h * 0.65)),   # nominal
        (int(w * 0.30), int(h * 0.10), int(w * 0.95), int(h * 0.75)),   # élargi
        (max(0, int(w * 0.03)), max(0, int(h * 0.05)),
         min(w, int(w * 0.98)), min(h, int(h * 0.90))),                 # quasi complet
    ]


# ════════════════════════════════════════════════════════════════════════════
# Chemin principal : 2 cercles noirs opaques (clip actuel)
# ════════════════════════════════════════════════════════════════════════════

def _detect_dark_circle_candidates(gray: np.ndarray, roi: tuple,
                                   expected_radius=None,
                                   min_contrast: float = 25.0) -> List[dict]:
    """
    Filtre adapté : cercles sombres sur fond plus clair (robuste aux textures).

    Pour chaque rayon candidat : contraste (moyenne anneau − moyenne disque)
    par convolution ; maxima locaux forts = candidats. NMS par distance.
    Retourne [{x, y, radius, score}] (coordonnées image).
    """
    x0, y0, x1, y1 = roi
    g = gray[y0:y1, x0:x1].astype(np.float32)
    rh, rw = g.shape
    if rh < 20 or rw < 20:
        return []

    if expected_radius:
        radii = [max(2, expected_radius - 1), expected_radius, expected_radius + 1]
    else:
        radii = [3, 4, 5, 6, 8]

    cands = []
    for r in radii:
        s = r + 7
        if 2 * s + 1 > min(rw, rh):
            continue
        disc = np.zeros((2 * s + 1, 2 * s + 1), np.uint8)
        cv2.circle(disc, (s, s), r, 1, -1)
        ring = np.zeros((2 * s + 1, 2 * s + 1), np.uint8)
        cv2.circle(ring, (s, s), r + 7, 1, -1)
        cv2.circle(ring, (s, s), r + 3, 0, -1)
        dmean = cv2.filter2D(g, -1, disc.astype(np.float32) / disc.sum())
        rmean = cv2.filter2D(g, -1, ring.astype(np.float32) / ring.sum())
        contrast = rmean - dmean
        maxf = cv2.dilate(contrast, np.ones((7, 7), np.uint8))
        mask = (contrast == maxf) & (contrast > min_contrast)
        ys, xs = np.nonzero(mask)
        margin = s + 2
        for x, y in zip(xs, ys):
            if x < margin or x >= rw - margin or y < margin or y >= rh - margin:
                continue
            cands.append({"x": int(x) + x0, "y": int(y) + y0, "radius": r,
                          "score": float(contrast[y, x])})

    # NMS : distance ≥ somme des rayons
    cands.sort(key=lambda c: c["score"], reverse=True)
    out = []
    for c in cands:
        if all((c["x"] - o["x"]) ** 2 + (c["y"] - o["y"]) ** 2 >
               (c["radius"] + o["radius"] + 3) ** 2 for o in out):
            out.append(c)
    return out


def _find_best_dark_pair(candidates: List[dict], expected_spacing,
                         expected_radius) -> Optional[Tuple[dict, dict]]:
    """
    Meilleure paire de cercles sombres.

    Contraintes : plus verticaux qu'horizontaux (dx ≤ dy), espacement ≈ attendu
    (±40% si échelle connue), rayons cohérents entre eux et proches de la taille
    attendue. Score départagé par le contraste des candidats.
    """
    if len(candidates) < 2:
        return None
    candidates.sort(key=lambda c: c["y"])
    best_pair, best_score = None, float("inf")
    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            dy = candidates[j]["y"] - candidates[i]["y"]
            dx = abs(candidates[j]["x"] - candidates[i]["x"])

            # La paire doit être PLUS VERTICALE qu'horizontale (le plan latéral
            # peut être légèrement incliné dans la photo).
            if dx > dy:
                continue

            d = math.hypot(dx, dy)

            if expected_spacing:
                spacing_err = abs(d - expected_spacing)
                if spacing_err > expected_spacing * 0.40:
                    continue
                score = spacing_err / expected_spacing
            else:
                # Fallback sans échelle : ratio diamètre/espacement attendu ≈ 6.25
                avg_radius = (candidates[i]["radius"] + candidates[j]["radius"]) / 2
                if avg_radius == 0:
                    continue
                score = abs(d / (2 * avg_radius) - 6.25)

            # Cohérence de taille entre les 2 mires (même Ø physique)
            rmin = min(candidates[i]["radius"], candidates[j]["radius"])
            rmax = max(candidates[i]["radius"], candidates[j]["radius"])
            if rmax > 0:
                score += (rmax - rmin) / rmax * 2.0

            # Proximité de la taille attendue quand l'échelle frontale est connue
            if expected_radius:
                avg_radius = (candidates[i]["radius"] + candidates[j]["radius"]) / 2
                score += abs(avg_radius - expected_radius) / max(1.0, expected_radius)

            # Bonus contraste : vraies mires > bruit de texture
            score -= (candidates[i].get("score", 0) + candidates[j].get("score", 0)) / 200.0

            if score < best_score:
                best_score = score
                best_pair = (candidates[i], candidates[j])

    if best_pair is None or best_score > 4:
        return None
    return best_pair


def _detect_marker_pair_in_roi(gray: np.ndarray, roi: tuple, expected_radius,
                               expected_spacing) -> List[Point]:
    """
    Paire de mires cercles noirs dans une ROI.

    1. Filtre adapté (contraste disque/anneau)
    2. SimpleBlobDetector calibré si échelle connue
    3. Contours : seuils fixes + Otsu (robuste à l'éclairage)

    Retourne [(x1,y1),(x2,y2)] ou [].
    """
    x0, y0, x1, y1 = roi
    gray_roi = gray[y0:y1, x0:x1]
    blurred = cv2.GaussianBlur(gray_roi, (3, 3), 0)

    kernel_close = np.ones((3, 3), np.uint8)
    kernel_open = np.ones((2, 2), np.uint8)
    candidates = []

    # 1. Filtre adapté
    for c in _detect_dark_circle_candidates(gray, roi, expected_radius, min_contrast=25):
        candidates.append({"x": c["x"], "y": c["y"], "radius": c["radius"],
                           "score": c["score"], "area": np.pi * c["radius"] ** 2,
                           "circularity": 0.9})

    # 2. SimpleBlobDetector calibré
    if expected_radius and expected_radius >= 2:
        params = cv2.SimpleBlobDetector_Params()
        params.filterByColor = True
        params.blobColor = 0
        params.filterByArea = True
        min_r = max(2, expected_radius - 1)
        max_r = expected_radius + 2
        params.minArea = int(np.pi * min_r * min_r * 0.6)
        params.maxArea = int(np.pi * max_r * max_r * 1.5)
        params.filterByCircularity = True
        params.minCircularity = 0.55
        params.filterByConvexity = True
        params.minConvexity = 0.5
        params.filterByInertia = False

        detector = cv2.SimpleBlobDetector_create(params)
        for kp in detector.detect(blurred):
            cx, cy = int(kp.pt[0]) + x0, int(kp.pt[1]) + y0
            r = int(kp.size / 2)
            candidates.append({"x": cx, "y": cy, "radius": r, "score": 40.0,
                               "area": np.pi * r * r, "circularity": 0.8})

    # 3. Contours : seuils fixes + Otsu
    if len(candidates) < 2:
        min_area = max(2, int((expected_radius ** 2) * 0.3) if expected_radius else 3)
        max_area = min(300, int((expected_radius ** 2) * 6) if expected_radius else 500)

        thresholds = [35, 50, 70]
        if blurred.size:
            otsu_val, _ = cv2.threshold(blurred, 0, 255,
                                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            otsu_val = float(np.asarray(otsu_val).ravel()[0])
            if otsu_val not in thresholds:
                thresholds.append(otsu_val)

        for thresh_val in thresholds:
            _, thresh = cv2.threshold(blurred, thresh_val, 255, cv2.THRESH_BINARY_INV)
            thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel_close)
            thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel_open)

            contours_fb, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL,
                                              cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours_fb:
                area = cv2.contourArea(cnt)
                if area < min_area or area > max_area:
                    continue
                perimeter = cv2.arcLength(cnt, True)
                if perimeter == 0:
                    continue
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                if circularity < 0.40:
                    continue
                M = cv2.moments(cnt)
                if M["m00"] == 0:
                    continue
                cx = int(M["m10"] / M["m00"]) + x0
                cy = int(M["m01"] / M["m00"]) + y0
                radius = int(np.sqrt(area / np.pi))
                if expected_radius and (radius < max(1, expected_radius * 0.2)
                                        or radius > expected_radius * 3):
                    continue
                if any(abs(e["x"] - cx) < 4 and abs(e["y"] - cy) < 4
                       for e in candidates):
                    continue
                candidates.append({"x": cx, "y": cy, "radius": radius,
                                   "area": area, "circularity": circularity,
                                   "score": 30.0 + circularity * 20.0})

    if len(candidates) < 2:
        return []

    pair = _find_best_dark_pair(candidates, expected_spacing, expected_radius)

    if pair is None:
        # Dernier recours : les 2 plus grandes zones circulaires alignées verticalement
        candidates.sort(key=lambda c: c["y"])
        top2 = candidates[:2]
        dy = top2[1]["y"] - top2[0]["y"]
        dx = abs(top2[1]["x"] - top2[0]["x"])
        if dx < dy and dy > 20:
            pair = (top2[0], top2[1])

    if pair is None:
        return []
    return [(pair[0]["x"], pair[0]["y"]), (pair[1]["x"], pair[1]["y"])]


def _derive_spacing_mm(markers: List[Point], known_scale: Optional[float]) -> float:
    """
    Espacement réel des mires détectées : le plus proche de la distance mesurée
    (anti-aliasing), privilégiant le clip actuel (25 mm) en cas d'égalité.
    """
    if not (known_scale and known_scale > 0):
        return LATERAL_MARKER_SPACING_MM
    d_px = math.hypot(markers[1][0] - markers[0][0], markers[1][1] - markers[0][1])
    est_mm = round(d_px * known_scale, 2)
    return min((LATERAL_MARKER_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW),
               key=lambda s: (abs(s - est_mm), s != LATERAL_MARKER_SPACING_MM))


# ════════════════════════════════════════════════════════════════════════════
# Secours : mires damier 2×2 (nouveau design v3/v4)
# ════════════════════════════════════════════════════════════════════════════

def _checkerboard_score_at(integral: np.ndarray, w: int, h: int,
                           cx: int, cy: int, quadrant_offset: int,
                           sample_size: int) -> float:
    """
    Score du motif damier 2×2 centré sur (cx, cy).

    Un vrai damier est BIMODAL (2 quadrants sombres + 2 clairs) et fortement
    corrélé au motif NW/SE sombres, NE/SW clairs. Rejette bords de disques
    pleins et gradients (corr normalisée ≥ 0.7 exigée).
    """
    def rect_mean(px, py, size):
        px0 = max(0, min(w, px - size))
        px1 = min(w, px + size + 1)
        py0 = max(0, min(h, py - size))
        py1 = min(h, py + size + 1)
        area = (px1 - px0) * (py1 - py0)
        if area <= 0:
            return 128.0
        total = (integral[py1, px1] - integral[py0, px1]
                 - integral[py1, px0] + integral[py0, px0])
        return total / area

    nw = rect_mean(cx - quadrant_offset, cy - quadrant_offset, sample_size)
    ne = rect_mean(cx + quadrant_offset, cy - quadrant_offset, sample_size)
    sw = rect_mean(cx - quadrant_offset, cy + quadrant_offset, sample_size)
    se = rect_mean(cx + quadrant_offset, cy + quadrant_offset, sample_size)

    vals = sorted([nw, ne, sw, se])
    median = (vals[1] + vals[2]) / 2
    dark = sum(1 for v in (nw, ne, sw, se) if v < median - 15)
    bright = sum(1 for v in (nw, ne, sw, se) if v > median + 15)
    if dark < 2 or bright < 2:
        return 0.0

    c = np.array([nw, ne, sw, se], dtype=np.float64) - (nw + ne + sw + se) / 4.0
    n = np.linalg.norm(c)
    if n == 0:
        return 0.0
    corr = float(np.dot(c, np.array([-1.0, 1.0, 1.0, -1.0]))) / (n * 2.0)
    if abs(corr) < 0.7:
        return 0.0

    diag = abs(nw - se) + abs(ne - sw)
    adj = (abs(nw - ne) + abs(nw - sw) + abs(se - ne) + abs(se - sw))
    return max(0.0, adj - diag * 0.5)


def _scan_checkerboard_grid(gray, integral, w, h, x0, y0, x1, y1,
                            quadrant_offset, step) -> List[tuple]:
    """Score damier sur grille 2D dans la ROI → [(cx, cy, score)] au-dessus du seuil."""
    sample_size = max(2, quadrant_offset // 3)
    pts = []
    for cy in range(y0, y1, step):
        for cx in range(x0, x1, step):
            v = _checkerboard_score_at(integral, w, h, cx, cy,
                                       quadrant_offset, sample_size)
            if v > 8:
                pts.append((cx, cy, float(v)))
    return pts


def _nms_points(pts: List[tuple], merge_r: float) -> List[dict]:
    """NMS local : meilleur score par cellule de taille merge_r."""
    cands = []
    for cx, cy, v in pts:
        found = False
        for c in cands:
            if abs(cx - c["x"]) <= merge_r and abs(cy - c["y"]) <= merge_r:
                if v > c["score"]:
                    c["x"], c["y"], c["score"] = cx, cy, v
                found = True
                break
        if not found:
            cands.append({"x": cx, "y": cy, "score": v})
    return cands


def _find_best_checkerboard_pair(cands: List[dict], exp_px) -> Optional[Tuple[dict, dict]]:
    """Meilleure paire damier : distance ≈ attendue (±35%), scores élevés."""
    best_pair, best_score = None, float("inf")
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            d = math.hypot(cands[i]["x"] - cands[j]["x"],
                           cands[i]["y"] - cands[j]["y"])
            if exp_px:
                if abs(d - exp_px) > exp_px * 0.35:
                    continue
                score = abs(d - exp_px) / exp_px
            else:
                if d < 15:
                    continue
                score = 0.0
            score -= (cands[i]["score"] + cands[j]["score"]) / 400.0
            if score < best_score:
                best_score = score
                best_pair = (cands[i], cands[j])
    return best_pair


def _detect_checkerboard_pair_in_roi(gray, integral, w, h, roi,
                                     scale) -> Tuple[Optional[List[Point]], Optional[float]]:
    """
    Paire de mires DAMIER 2×2 dans la ROI (secours nouveau design).

    Multi-échelle (taille de motif) et multi-espacement (25/35 mm).
    Retourne (markers, spacing_mm) ou (None, None).
    """
    x0, y0, x1, y1 = roi
    if scale and scale > 0:
        qo_list = [max(3, int(1.0 / scale))]  # quadrant 2mm → offset 1mm
    else:
        qo_list = [3, 4, 6, 8, 10]            # scan multi-échelle
    spacings = [LATERAL_MARKER_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW]

    best = None  # (markers, spacing_mm, score_total)
    for qo in qo_list:
        step = max(2, qo // 2)
        pts = _scan_checkerboard_grid(gray, integral, w, h, x0, y0, x1, y1, qo, step)
        if len(pts) < 2:
            continue
        cands = _nms_points(pts, merge_r=qo + step)
        if len(cands) < 2:
            continue
        for spacing_mm in spacings:
            exp_px = (spacing_mm / scale) if scale and scale > 0 else None
            pair = _find_best_checkerboard_pair(cands, exp_px)
            if pair and (best is None or pair[0]["score"] + pair[1]["score"] > best[2]):
                markers = [(pair[0]["x"], pair[0]["y"]), (pair[1]["x"], pair[1]["y"])]
                best = (markers, spacing_mm, pair[0]["score"] + pair[1]["score"])

    if not best:
        return None, None
    markers = best[0]
    return markers, _derive_spacing_mm(markers, scale)


# ════════════════════════════════════════════════════════════════════════════
# Orchestration
# ════════════════════════════════════════════════════════════════════════════

def detect_lateral_markers(image: np.ndarray, landmarker=None,
                           known_scale: Optional[float] = None,
                           marker_spacing_mm: Optional[float] = None,
                           ) -> Tuple[List[Point], LateralDiagnostics]:
    """
    Détecte les 2 mires latérales du clip.

    Chemin principal : cercles noirs (clip actuel, Ø4mm, 25mm).
    Secours          : damier 2×2 (design v3/v4, 25/35mm).
    ROIs progressives aux deux chemins.

    marker_spacing_mm : force l'espacement attendu ; sinon dérivé de la mesure.

    Retourne ([(x1,y1),(x2,y2)], diagnostics) — liste vide si échec.
    """
    diag = LateralDiagnostics()
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Dimensions attendues (cercles Ø4mm, espacement paramétré)
    spacing_nominal = marker_spacing_mm or LATERAL_MARKER_SPACING_MM
    expected_spacing = expected_radius = None
    if known_scale and known_scale > 0:
        expected_spacing = spacing_nominal / known_scale
        expected_radius = int(2.0 / known_scale)  # rayon = 2mm
        diag.expected_spacing_px = expected_spacing
        diag.expected_radius_px = expected_radius
        log.info(f"  [lateral] scale={known_scale:.4f}mm/px · "
                 f"spacing={expected_spacing:.0f}px · r={expected_radius}px")
    else:
        log.warning("  [lateral] ⚠️ SANS échelle frontale — détection sans contrainte")

    rois = _progressive_rois(w, h)
    diag.rois_tried = rois

    # ── 1. Clip actuel : 2 cercles noirs opaques ──
    for roi in rois:
        markers = _detect_marker_pair_in_roi(gray, roi, expected_radius,
                                             expected_spacing)
        if markers:
            spacing_mm = _derive_spacing_mm(markers, known_scale)
            diag.path = "dark_circles"
            diag.roi_used = roi
            diag.spacing_mm_detected = spacing_mm
            log.info(f"  [lateral] ✅ Cercles noirs {spacing_mm:.0f}mm "
                     f"(ROI {roi}): {markers}")
            return markers, diag

    # ── 2. Secours : damier 2×2 (design v3/v4) ──
    integral = cv2.integral(gray)
    for roi in rois:
        markers, spacing_mm = _detect_checkerboard_pair_in_roi(
            gray, integral, w, h, roi, known_scale)
        if markers:
            diag.path = "checkerboard"
            diag.roi_used = roi
            diag.spacing_mm_detected = spacing_mm
            log.info(f"  [lateral] ✅ Damier {spacing_mm:.0f}mm "
                     f"(ROI {roi}): {markers}")
            return markers, diag

    log.info("  [lateral] ❌ Aucune paire trouvée")
    return [], diag
