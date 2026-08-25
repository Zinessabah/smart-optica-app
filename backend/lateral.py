"""
Détection des mires latérales du clip — module dédié.

Le clip de référence porte des mires damier 2×2 alignées VERTICALEMENT sur la
tempe droite (clip v3 : Ø4mm, espacement 25mm ; clip v4 : espacement 35mm).

Chaîne de détection :
    1. get_roi()            — ROI face-guided MediaPipe, fallback fixe
    2. checkerboard_scores()— score damier le long de Y sur la bande centrale
    3. find_peaks()         — lissage gaussien + maxima locaux
    4. select_pair()        — paire à l'espacement nominal ± tolérance
    5. detect_lateral_markers() — orchestration, retourne (markers, diagnostics)

Toutes les fonctions sont pures (image en entrée, pas d'état global) et
testables unitairement.
"""

import logging
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

log = logging.getLogger("smart-optica")

# ── Constantes ──────────────────────────────────────────────────────────────

LATERAL_MARKER_DIAMETER_MM = 4.0   # diamètre des mires du clip v3
LATERAL_MARKER_SPACING_MM_V3 = 25.0  # clip v3 (main)
LATERAL_MARKER_SPACING_MM_V4 = 35.0  # clip v4 (à venir)
DEFAULT_TOLERANCE = 0.10           # rejet paire si écart espacement > ±10%
MIN_PEAK_SCORE = 5.0               # seuil de score damier pour un pic valide

Point = Tuple[int, int]


# ── Diagnostics ─────────────────────────────────────────────────────────────

@dataclass
class LateralDiagnostics:
    """Informations intermédiaires de détection — pour logs et debug."""
    roi: Optional[Tuple[int, int, int, int]] = None      # x0, y0, x1, y1
    face_detected: bool = False
    strip_x: int = 0
    quadrant_offset_px: Optional[int] = None
    expected_spacing_px: Optional[int] = None
    n_peaks: int = 0
    peaks: List[dict] = field(default_factory=list)
    spacing_error_ratio: Optional[float] = None          # écart paire/nominal


# ── Étape 1 : ROI ───────────────────────────────────────────────────────────

def get_roi(image_shape: Tuple[int, int], face_result) -> Tuple[int, int, int, int]:
    """
    Calcule la ROI (x0, y0, x1, y1) contenant la tempe droite et son clip.

    Face-guided via MediaPipe si un visage est détecté (tempe = landmark 454,
    iris droit = 473), sinon rectangle fixe côté droit de l'image.
    """
    h, w = image_shape[:2]
    face_detected = bool(face_result and face_result.face_landmarks)

    if face_detected:
        landmarks = face_result.face_landmarks[0]
        count = len(landmarks)
        temple_x = landmarks[454].x if count > 454 else (
            landmarks[234].x if count > 234 else 0.85)
        eye_y = landmarks[473].y if count > 473 else (
            landmarks[468].y if count > 468 else 0.45)

        roi = (
            int(w * max(0.55, temple_x - 0.15)),
            int(h * max(0.15, eye_y - 0.25)),
            min(w, int(w * min(0.95, temple_x + 0.10))),
            min(h, int(h * min(0.75, eye_y + 0.25))),
        )
        log.info(f"  [lateral] ROI face-guided x=[{roi[0]},{roi[2]}] y=[{roi[1]},{roi[3]}]")
    else:
        roi = (int(w * 0.55), int(h * 0.20), int(w * 0.90), int(h * 0.65))
        log.info(f"  [lateral] ROI fallback x=[{roi[0]},{roi[2]}] y=[{roi[1]},{roi[3]}]")

    return roi


# ── Étape 2 : scores damier ─────────────────────────────────────────────────

def _quadrant_means(integral: np.ndarray, cx: np.ndarray, cy: np.ndarray,
                    offset: int, sample: int, w: int, h: int) -> dict:
    """
    Moyennes lumineuses des 4 quadrants autour de chaque point (cx, cy),
    vectorisé via image intégrale.

    integral : image intégrale (h+1, w+1). cx/cy : tableaux de centres.
    offset   : demi-distance entre quadrants (px). sample : demi-taille d'échantillon.
    """
    def rect_mean(px: np.ndarray, py: np.ndarray) -> np.ndarray:
        px0 = np.clip(px - sample, 0, w)
        px1 = np.clip(px + sample + 1, 0, w)
        py0 = np.clip(py - sample, 0, h)
        py1 = np.clip(py + sample + 1, 0, h)
        area = (px1 - px0) * (py1 - py0)
        area = np.maximum(area, 1)
        total = (integral[py1, px1] - integral[py0, px1]
                 - integral[py1, px0] + integral[py0, px0])
        return total / area

    return {
        "nw": rect_mean(cx - offset, cy - offset),
        "ne": rect_mean(cx + offset, cy - offset),
        "sw": rect_mean(cx - offset, cy + offset),
        "se": rect_mean(cx + offset, cy + offset),
    }


def checkerboard_scores(gray: np.ndarray, roi: Tuple[int, int, int, int],
                        quadrant_offset: Optional[int]) -> Tuple[np.ndarray, int, int]:
    """
    Score damier 2×2 pour chaque ligne Y de la ROI, moyenné sur la bande
    verticale centrale (motif : NW/SE sombres, NE/SW clairs).

    Retourne (scores[len_y], strip_x, strip_w).
    """
    h, w = gray.shape[:2]
    roi_x0, roi_y0, roi_x1, roi_y1 = roi

    # Bande verticale centrée sur la ROI
    off = quadrant_offset if quadrant_offset else 15
    strip_x = (roi_x0 + roi_x1) // 2
    strip_w = max(8, off)
    x0 = max(0, strip_x - strip_w // 2)
    x1 = min(w, strip_x + strip_w // 2)

    integral = cv2.integral(gray)
    sample = max(2, off // 3)
    half_w = max(1, (x1 - x0) // 2)

    # Centres à scorer : chaque ligne Y × chaque colonne X de la bande
    ys = np.arange(roi_y0, roi_y1)
    dxs = np.arange(-half_w, half_w + 1)
    yy, dd = np.meshgrid(ys, dxs, indexing="ij")
    cy = yy.ravel()
    cx = (strip_x + dd).ravel()

    q = _quadrant_means(integral, cx.astype(int), cy.astype(int), off, sample, w, h)

    # Motif damier : diagonales contrastées, adjacences non
    diag = np.abs(q["nw"] - q["se"]) + np.abs(q["ne"] - q["sw"])
    adj = (np.abs(q["nw"] - q["ne"]) + np.abs(q["nw"] - q["sw"])
           + np.abs(q["se"] - q["ne"]) + np.abs(q["se"] - q["sw"]))
    contrast = np.clip(adj - diag * 0.5, 0, None)

    # Moyenne horizontale par ligne
    contrast_2d = contrast.reshape(len(ys), len(dxs))
    scores = contrast_2d.mean(axis=1)

    return scores.astype(np.float32), strip_x, x1 - x0


# ── Étape 3 : pics ──────────────────────────────────────────────────────────

def find_peaks(scores: np.ndarray, y_origin: int, sigma: float,
               threshold: float = MIN_PEAK_SCORE) -> List[dict]:
    """
    Lissage gaussien puis maxima locaux au-dessus du seuil.

    Retourne [{"y", "x", "score"}] triés par score descendant.
    """
    smoothed = gaussian_filter1d(scores.astype(np.float64), sigma=sigma)
    peaks = []
    for i in range(1, len(smoothed) - 1):
        if smoothed[i] > smoothed[i - 1] and smoothed[i] >= smoothed[i + 1] \
                and smoothed[i] > threshold:
            peaks.append({"y": y_origin + i, "x": 0, "score": float(smoothed[i])})
    peaks.sort(key=lambda p: (-p["score"], p["y"]))
    log.info(f"  [lateral] {len(peaks)} pics trouvés")
    return peaks


# ── Étape 4 : sélection de paire ────────────────────────────────────────────

def select_pair(peaks: List[dict], expected_spacing_px: Optional[float],
                nominal_spacing_mm: float,
                tolerance: float = DEFAULT_TOLERANCE) -> Optional[Tuple[dict, dict]]:
    """
    Sélectionne la meilleure paire de pics verticalement alignés dont
    l'espacement correspond au nominal ±tolérance.

    Avec échelle connue : rejet strict (None si aucune paire cohérente).
    Sans échelle : les 2 meilleurs pics (non garanti, signalé dans diagnostics).
    """
    if len(peaks) < 2:
        return None

    best_pair = None
    best_err = float("inf")

    for i in range(len(peaks)):
        for j in range(i + 1, len(peaks)):
            dy = abs(peaks[j]["y"] - peaks[i]["y"])
            err = abs(dy - expected_spacing_px) / expected_spacing_px
            if err > tolerance:
                continue
            if err < best_err:
                best_err = err
                best_pair = (peaks[i], peaks[j])

    if best_pair:
        log.info(f"  [lateral] ✅ Paire {nominal_spacing_mm}mm "
                 f"(écart {best_err*100:.1f}%): "
                 f"({best_pair[0]['y']}) → ({best_pair[1]['y']})")
        return best_pair

    log.warning(f"  [lateral] ❌ Aucune paire à ±{int(tolerance*100)}% "
                f"de {nominal_spacing_mm}mm — rejet")
    return None


# ── Étape 5 : orchestration ─────────────────────────────────────────────────

def detect_lateral_markers(image: np.ndarray, landmarker,
                           known_scale: Optional[float] = None,
                           marker_spacing_mm: float = LATERAL_MARKER_SPACING_MM_V3,
                           ) -> Tuple[List[Point], LateralDiagnostics]:
    """
    Détecte les 2 mires latérales du clip.

    known_scale       : échelle calibration frontale (mm/px) — contraint la recherche.
    marker_spacing_mm : espacement nominal des mires (25 v3, 35 v4).

    Retourne ([ (x1,y1), (x2,y2) ] ordonnées haut→bas, diagnostics).
    Liste vide si échec.
    """
    diag = LateralDiagnostics()
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Dimensions attendues
    if known_scale and known_scale > 0:
        diag.expected_spacing_px = marker_spacing_mm / known_scale
        diag.quadrant_offset_px = max(3, int(2.5 / known_scale))
        log.info(f"  [lateral] scale={known_scale:.4f} mm/px · "
                 f"spacing={diag.expected_spacing_px:.0f}px · "
                 f"offset={diag.quadrant_offset_px}px")
    else:
        log.warning("  [lateral] ⚠️ SANS échelle frontale — détection sans contrainte")

    # 1. ROI
    face_result = None
    if landmarker is not None:
        import mediapipe as mp
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        face_result = landmarker.detect(mp_img)
    diag.face_detected = bool(face_result and face_result.face_landmarks)

    roi = get_roi((h, w), face_result)
    diag.roi = roi
    roi_x0, roi_y0, roi_x1, roi_y1 = roi

    # Garde-fou : ROI dégénérée
    if roi_x1 - roi_x0 < 20 or roi_y1 - roi_y0 < 40:
        log.warning("  [lateral] ❌ ROI trop petite")
        return [], diag

    # 2-3. Scores + pics
    scores, strip_x, strip_w = checkerboard_scores(gray, roi, diag.quadrant_offset_px)
    diag.strip_x = strip_x
    sigma = (diag.quadrant_offset_px / 4) if diag.quadrant_offset_px else 4.0
    peaks = find_peaks(scores, roi_y0, sigma)
    for p in peaks:
        p["x"] = strip_x
    diag.n_peaks = len(peaks)
    diag.peaks = peaks[:10]

    if len(peaks) < 2:
        return [], diag

    # 4. Paire
    pair = select_pair(peaks, diag.expected_spacing_px, marker_spacing_mm)

    # Sans échelle : fallback top2 (explicitement non garanti)
    if pair is None and not diag.expected_spacing_px:
        top2 = sorted(peaks[:2], key=lambda p: p["y"])
        if top2[1]["y"] - top2[0]["y"] > 20:
            log.warning("  [lateral] ⚠️ Fallback top2 SANS échelle (non garanti)")
            pair = (top2[0], top2[1])

    if pair is None:
        return [], diag

    markers = [(pair[0]["x"], pair[0]["y"]), (pair[1]["x"], pair[1]["y"])]
    dy = abs(markers[1][1] - markers[0][1])
    if diag.expected_spacing_px:
        diag.spacing_error_ratio = abs(dy - diag.expected_spacing_px) / diag.expected_spacing_px

    log.info(f"  [lateral] ✅ Mires: {markers} dy={dy}px")
    return markers, diag
