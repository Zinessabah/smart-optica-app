"""
Smart Optica — Backend API
FastAPI + MediaPipe (Tasks API) + OpenCV pour la détection faciale et calibration.
POST /api/analyze  →  reçoit une image, retourne les coordonnées des repères
"""

import io
import logging
import numpy as np
import cv2
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import urllib.request
import os

from lateral import (
    LATERAL_MARKER_SPACING_MM,
    pair_is_plausible,
    field_width_mm,
    LATERAL_MARKER_SPACING_MM_NEW,
)
# Détection latérale — clip v19.5 : **damier unifié** en chemin PRINCIPAL (IDs identiques → position/rôle).
# Clip v16 : ArUco 4×4 en SECOURS. Clips antérieurs : disques/damier en DERNIER RECOURS.
import logging as _logging
from lateral_checker import detect_lateral_markers as _detect_lateral_checker
from lateral_aruco import detect_lateral_markers as _detect_lateral_aruco
from lateral import detect_lateral_markers as _detect_lateral_legacy

# Version de clip déclarée côté backend (doit matcher le clip et l'app)
CLIP_VERSION = "clip-v19.5-all-checkerboard"


def _detect_lateral(image, landmarker=None, known_scale=None, marker_spacing_mm=None):
    """Damier unifié d'abord (clip v19.5) ; ArUco (clip v16) en secours ; legacy en dernier."""
    markers, diag = _detect_lateral_checker(
        image, landmarker, known_scale=known_scale, marker_spacing_mm=marker_spacing_mm)
    if markers:
        return markers, diag
    _logging.getLogger("smart-optica").info(
        "  [lateral] Damier non trouvé → repli sur ArUco (clip v16)")
    markers, diag = _detect_lateral_aruco(
        image, landmarker, known_scale=known_scale, marker_spacing_mm=marker_spacing_mm)
    if markers:
        return markers, diag
    _logging.getLogger("smart-optica").info(
        "  [lateral] ArUco non trouvé → repli sur les variantes antérieures")
    return _detect_lateral_legacy(
        image, landmarker, known_scale=known_scale, marker_spacing_mm=marker_spacing_mm)

from image_quality import (
    check_resolution,
    validate_image_bytes,
    KIND_FACE,
    KIND_PROFILE,
)
from geometry import reproject_points

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("smart-optica")

app = FastAPI(title="Smart Optica API", version="1.0.0")

# Auth multi-utilisateurs (JWT + PostgreSQL)
from auth import router as auth_router  # noqa: E402
from admin import admin as admin_router  # noqa: E402
from measurements import measurements_router  # noqa: E402
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(measurements_router)

# CORS — liste blanche d'origines (configurable via env, défaut = serveurs de dev Vite)
# Ne JAMAIS mettre "*" en production : risque d'appels inter-sites malveillants.
_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:5173,https://localhost:5173,https://100.75.240.11:5173,http://localhost:5174,https://localhost:5174,https://100.75.240.11:5174",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ── Téléchargement du modèle FaceLandmarker ──
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(__file__), "face_landmarker.task")


def ensure_model():
    if not os.path.exists(MODEL_PATH):
        log.info("Téléchargement du modèle MediaPipe FaceLandmarker...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        log.info("Modèle téléchargé")
    return MODEL_PATH


# Chargement du modèle au démarrage
model_path = ensure_model()
base_options = python.BaseOptions(model_asset_path=model_path)
options = vision.FaceLandmarkerOptions(
    base_options=base_options,
    output_face_blendshapes=False,
    output_facial_transformation_matrixes=False,
    num_faces=1,
    min_face_detection_confidence=0.5,
)
landmarker = vision.FaceLandmarker.create_from_options(options)
log.info("FaceLandmarker prêt")


class AnalyzeResult(BaseModel):
    width: int
    height: int
    face_detected: bool
    left_eye: Optional[dict] = None
    right_eye: Optional[dict] = None
    nose: Optional[dict] = None
    calibration: Optional[list] = None
    landmarks_count: int = 0
    interPupillaryPx: Optional[float] = None
    interPupillaryMm: Optional[float] = None


class CalibrationResult(BaseModel):
    width: int
    height: int
    markers: list = []  # 3 points [{x, y}, ...]
    scale_mm_per_px: float = 0.0
    spacing_px: float = 0.0
    detection_confidence: float = 0.0
    face_used: bool = False


class ProfileResult(BaseModel):
    width: int
    height: int
    lateral_markers: list  # 2 points [(x1,y1), (x2,y2)]
    scale_mm_per_px: float
    scale_from_markers_mm_per_px: Optional[float] = None  # échelle déduite des mires seules
    scale_consistent: bool = True  # cohérence échelle mires vs échelle frontale (±10%)
    pantoscopic_angle: Optional[float] = None  # degrés
    vertex_distance: Optional[float] = None  # mm
    face_detected: bool = False
    temple_angle: Optional[float] = None  # degrés, angle de la branche


def decode_image(data: bytes) -> np.ndarray:
    # Validation partagée (image_quality) — la MÊME que celle de la sauvegarde des
    # photos : signature réelle, jamais l'extension.
    validate_image_bytes(data)
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Format d'image invalide")
    return img


def to_px(pt, w, h):
    """Coordonnée relative [0,1] → pixel {x, y}."""
    return {"x": round(pt.x * w), "y": round(pt.y * h)}


# ── Détection des 3 repères de calibration (face-guided) ──

CALIB_MARKER_SPACING_MM = 50.0


def detect_calibration_markers(image: np.ndarray) -> dict:
    """
    Détecte les 3 mires de calibration (damier 2×2) sur le clip frontal.
    
    Approche 1D : corrélation directe du motif damier le long d'une bande horizontale.
    On connaît les dimensions exactes : Ø intérieur 10mm, offset quadrants 2.5mm, espacement 50mm.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # ── 0. MediaPipe → détection du visage ──
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_result = landmarker.detect(mp_img)
    face_detected = bool(face_result.face_landmarks)

    if not face_detected:
        log.info("Calibration: no face detected, falling back")
        return _fallback_hough(gray, h, w)

    landmarks = face_result.face_landmarks[0]
    count = len(landmarks)
    left_eye = landmarks[468] if count > 468 else landmarks[33]
    right_eye = landmarks[473] if count > 473 else landmarks[263]

    # ── 1. Correction d'inclinaison de la tête ──
    # L'inclinaison de la tête fausse le scan 1D horizontal.
    # On redresse l'image en alignant les yeux horizontalement.
    eye_angle_deg = 0.0
    if face_detected and count > 473:
        # Angle entre la ligne inter-pupillaire et l'horizontale
        dy = (right_eye.y - left_eye.y) * h
        dx = (right_eye.x - left_eye.x) * w
        eye_angle_deg = np.degrees(np.arctan2(dy, dx))

    log.info(f"Calibration: eye angle = {eye_angle_deg:.1f}°")

    inverse_rot_mat = None
    if abs(eye_angle_deg) > 0.5:
        # Redresser l'image pour la détection, puis reprojeter les résultats vers l'originale.
        center = (w // 2, h // 2)
        rot_mat = cv2.getRotationMatrix2D(center, eye_angle_deg, 1.0)
        inverse_rot_mat = cv2.invertAffineTransform(rot_mat)
        image = cv2.warpAffine(image, rot_mat, (w, h), flags=cv2.INTER_LINEAR)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        # Re-détecter les landmarks sur l'image redressée
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        face_result = landmarker.detect(mp_img)
        if face_result.face_landmarks:
            landmarks = face_result.face_landmarks[0]
            left_eye = landmarks[468] if count > 468 else landmarks[33]
            right_eye = landmarks[473] if count > 473 else landmarks[263]

    # ── 2. Échelle via IPD ──
    ipd_px = abs(right_eye.x - left_eye.x) * w
    mm_per_px = 63.0 / ipd_px if ipd_px > 20 else 0.3

    # Dimensions connues en pixels
    quadrant_offset = max(3, int(2.5 / mm_per_px))   # 2.5mm → px
    expected_spacing = int(50.0 / mm_per_px)           # 50mm → px

    # Position Y : niveau des sourcils
    brow_y = min(
        landmarks[105].y if count > 105 else landmarks[33].y,
        landmarks[334].y if count > 334 else landmarks[263].y,
    )
    clip_y = int(brow_y * h) - quadrant_offset

    # Plage X : entre les tempes
    temple_l = landmarks[234].x if count > 234 else landmarks[33].x
    temple_r = landmarks[454].x if count > 454 else landmarks[263].x
    x0 = max(0, int(temple_l * w))
    x1 = min(w, int(temple_r * w))

    # Marge : on élargit pour capturer les marqueurs extérieurs
    x0 = max(0, x0 - int(expected_spacing * 0.2))
    x1 = min(w, x1 + int(expected_spacing * 0.2))

    log.info(f"Calibration 1D: scale={mm_per_px:.4f}mm/px offset={quadrant_offset}px "
             f"spacing={expected_spacing}px strip_y={clip_y} x=[{x0},{x1}]")

    # ── 3. Corrélation 1D le long de la bande horizontale ──
    # On scanne chaque position X et on calcule le score damier
    strip_h = max(4, quadrant_offset)  # on moyenne sur une petite hauteur
    half_h = strip_h // 2
    scores = np.zeros(x1 - x0, dtype=np.float32)

    integral = cv2.integral(gray)
    def rect_mean(px, py, size):
        px0 = max(0, px - size)
        px1 = min(w, px + size + 1)
        py0 = max(0, py - size)
        py1 = min(h, py + size + 1)
        area = (px1 - px0) * (py1 - py0)
        if area <= 0:
            return 128.0
        total = (integral[py1, px1] - integral[py0, px1] -
                 integral[py1, px0] + integral[py0, px0])
        return total / area

    sample_size = max(2, quadrant_offset // 3)

    for i in range(len(scores)):
        cx = x0 + i
        cy_base = clip_y

        # Moyenner verticalement sur strip_h pixels
        score_sum = 0.0
        count_y = 0
        for dy in range(-half_h, half_h + 1):
            cy = cy_base + dy
            nw = rect_mean(cx - quadrant_offset, cy - quadrant_offset, sample_size)
            ne = rect_mean(cx + quadrant_offset, cy - quadrant_offset, sample_size)
            sw = rect_mean(cx - quadrant_offset, cy + quadrant_offset, sample_size)
            se = rect_mean(cx + quadrant_offset, cy + quadrant_offset, sample_size)

            # Motif : NW=noir, NE=blanc, SW=blanc, SE=noir
            # → NW≈SE (sombres), NE≈SW (claires), adjacents contrastés
            diag = abs(nw - se) + abs(ne - sw)
            adj  = abs(nw - ne) + abs(nw - sw) + abs(se - ne) + abs(se - sw)
            contrast = adj - diag * 0.5
            if contrast > 0:
                score_sum += contrast
                count_y += 1

        if count_y > 0:
            scores[i] = score_sum / count_y

    # ── 3. Trouver les 3 pics espacés de ~expected_spacing ──
    # Lissage de la courbe de score
    from scipy.ndimage import gaussian_filter1d
    smoothed = gaussian_filter1d(scores.astype(np.float64), sigma=quadrant_offset / 4)

    # Trouver tous les maxima locaux
    peaks = []
    for i in range(1, len(smoothed) - 1):
        if smoothed[i] > smoothed[i-1] and smoothed[i] >= smoothed[i+1]:
            if smoothed[i] > 5:  # seuil minimal
                peaks.append({"x": x0 + i, "score": float(smoothed[i])})

    if len(peaks) < 3:
        log.info(f"Calibration: only {len(peaks)} peaks, falling back")
        fallback = _fallback_hough(gray, h, w)
        if inverse_rot_mat is not None and fallback.get("markers"):
            restored = reproject_points(fallback["markers"], inverse_rot_mat)
            fallback["markers"] = [{"x": round(p["x"]), "y": round(p["y"])} for p in restored]
        return fallback

    # Trier par score décroissant
    peaks.sort(key=lambda p: p["score"], reverse=True)
    top_peaks = peaks[:15]

    # Chercher le meilleur triplet avec espacement ≈ expected_spacing
    best_triple = None
    best_score = 0
    for i in range(len(top_peaks)):
        for j in range(i + 1, len(top_peaks)):
            for k in range(j + 1, len(top_peaks)):
                a, b, c = sorted([top_peaks[i], top_peaks[j], top_peaks[k]], key=lambda p: p["x"])
                d1 = b["x"] - a["x"]
                d2 = c["x"] - b["x"]
                if d1 < 5 or d2 < 5:
                    continue
                # Pénaliser l'écart à l'espacement attendu
                spacing_err = abs(d1 - expected_spacing) + abs(d2 - expected_spacing)
                spacing_score = max(0, 200 - spacing_err)
                quality = a["score"] + b["score"] + c["score"]
                total = quality + spacing_score * 2
                if total > best_score:
                    best_score = total
                    best_triple = [a, b, c]

    if not best_triple:
        log.info("Calibration: no valid triple")
        fallback = _fallback_hough(gray, h, w)
        if inverse_rot_mat is not None and fallback.get("markers"):
            restored = reproject_points(fallback["markers"], inverse_rot_mat)
            fallback["markers"] = [{"x": round(p["x"]), "y": round(p["y"])} for p in restored]
        return fallback

    # ── 4. Résultat ──
    best_triple.sort(key=lambda p: p["x"])
    # Ajuster Y au niveau du pic pour chaque marqueur
    for m in best_triple:
        m["y"] = clip_y

    avg_spacing = ((best_triple[1]["x"] - best_triple[0]["x"]) +
                   (best_triple[2]["x"] - best_triple[1]["x"])) / 2
    total_px = best_triple[2]["x"] - best_triple[0]["x"]
    scale = (CALIB_MARKER_SPACING_MM * 2) / total_px if total_px > 0 else 0
    confidence = min(1.0, sum(m["score"] for m in best_triple) / 400)

    log.info(f"Calibration DONE: markers={[(m['x'],m['y']) for m in best_triple]} "
             f"span={total_px}px spacing={avg_spacing:.0f}px scale={scale:.4f}mm/px conf={confidence:.2f}")

    detected_markers = [{"x": float(m["x"]), "y": float(m["y"])} for m in best_triple]
    restored_markers = reproject_points(detected_markers, inverse_rot_mat)

    return {
        "markers": [{"x": round(m["x"]), "y": round(m["y"])} for m in restored_markers],
        "scale_mm_per_px": round(scale, 6),
        "spacing_px": round(avg_spacing, 1),
        "detection_confidence": round(confidence, 3),
        "face_used": True,
        "width": w,
        "height": h,
    }


def _find_best_triple(candidates: list, estimated=None) -> list:
    """Trouve le meilleur triplet de 3 marqueurs : alignés horizontalement, écartement uniforme."""
    if len(candidates) < 3:
        return []
    candidates.sort(key=lambda c: c["score"], reverse=True)
    top = candidates[:15]
    sorted_x = sorted(top, key=lambda c: c["x"])

    best_triple = None
    best_score = 0

    for i in range(len(sorted_x)):
        for j in range(i + 1, len(sorted_x)):
            for k in range(j + 1, len(sorted_x)):
                a, b, c = sorted_x[i], sorted_x[j], sorted_x[k]

                # Alignement vertical strict
                y_mean = (a["y"] + b["y"] + c["y"]) / 3
                y_dev = abs(a["y"] - y_mean) + abs(b["y"] - y_mean) + abs(c["y"] - y_mean)
                if y_dev > 25:
                    continue
                if not (a["x"] < b["x"] < c["x"]):
                    continue

                d1 = b["x"] - a["x"]   # gauche→centre
                d2 = c["x"] - b["x"]   # centre→droite
                if d1 < 8 or d2 < 8:
                    continue

                # Contrainte d'espacement uniforme (50mm entre chaque)
                d_avg = (d1 + d2) / 2
                spacing_ratio = max(d1, d2) / max(1, min(d1, d2)) if min(d1, d2) > 0 else 999
                if spacing_ratio > 1.6:  # trop déséquilibré
                    continue

                alignment_score = max(0, 50 - y_dev * 2)
                spacing_score = max(0, 150 - abs(d1 - d2) * 3)  # pénalise l'écart
                quality_score = a["score"] + b["score"] + c["score"]
                composite = quality_score + spacing_score * 2 + alignment_score

                if composite > best_score:
                    best_score = composite
                    best_triple = [a, b, c]

    if best_triple:
        best_triple.sort(key=lambda p: p["x"])
        return best_triple
    return []


def _fallback_hough(gray: np.ndarray, h: int, w: int) -> dict:
    """Fallback : HoughCircles sur toute l'image sans guidance faciale."""
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(16, 16))
    enhanced = clahe.apply(gray)

    min_dim = min(w, h)
    r_min = max(6, int(min_dim * 0.012))
    r_max = min(120, int(min_dim * 0.06))

    candidates = []
    for attempt in [(1.2, 80, 25), (1.0, 60, 20)]:
        dp, p1, p2 = attempt
        circles = cv2.HoughCircles(
            enhanced, cv2.HOUGH_GRADIENT, dp=dp, minDist=r_max,
            param1=p1, param2=p2,
            minRadius=r_min, maxRadius=r_max,
        )
        if circles is not None:
            for (cx, cy, r) in np.round(circles[0]).astype(int):
                if cx < 0 or cx >= w or cy < 0 or cy >= h:
                    continue
                inner_r = int(r * 0.55)
                score = _check_checkerboard(gray, cx, cy, inner_r)
                if score > 12:
                    candidates.append({"x": cx, "y": cy, "r": r, "score": score})

    if len(candidates) < 3:
        return {"markers": [], "scale_mm_per_px": 0.0, "spacing_px": 0.0,
                "detection_confidence": 0.0, "face_used": False}

    # Non-maximum suppression
    candidates.sort(key=lambda c: c["score"], reverse=True)
    merged = []
    for c in candidates:
        found = False
        for m in merged:
            if abs(c["x"] - m["x"]) < 20 and abs(c["y"] - m["y"]) < 20:
                m["x"] = (m["x"] + c["x"]) // 2
                m["y"] = (m["y"] + c["y"]) // 2
                m["score"] = max(m["score"], c["score"])
                found = True
                break
        if not found:
            merged.append(c)

    if len(merged) < 3:
        return {"markers": [], "scale_mm_per_px": 0.0, "spacing_px": 0.0,
                "detection_confidence": 0.0, "face_used": False}

    # Meilleur triplet horizontal
    merged.sort(key=lambda c: c["score"], reverse=True)
    sorted_x = sorted(merged[:15], key=lambda c: c["x"])
    best_triple = None
    best_score = 0

    for i in range(len(sorted_x)):
        for j in range(i + 1, len(sorted_x)):
            for k in range(j + 1, len(sorted_x)):
                a, b, c = sorted_x[i], sorted_x[j], sorted_x[k]
                y_mean = (a["y"] + b["y"] + c["y"]) / 3
                y_dev = abs(a["y"] - y_mean) + abs(b["y"] - y_mean) + abs(c["y"] - y_mean)
                if y_dev > 40: continue
                if not (a["x"] < b["x"] < c["x"]): continue
                d1, d2 = b["x"] - a["x"], c["x"] - b["x"]
                if d1 < 15 or d2 < 15: continue
                if max(d1, d2) / max(1, min(d1, d2)) > 1.8: continue
                spacing_score = 100 * min(d1, d2) / max(1, max(d1, d2))
                y_score = max(0, 40 - y_dev) * 2
                composite = a["score"] + b["score"] + c["score"] + spacing_score * 3 + y_score
                if composite > best_score:
                    best_score = composite
                    best_triple = [a, b, c]

    if not best_triple:
        return {"markers": [], "scale_mm_per_px": 0.0, "spacing_px": 0.0,
                "detection_confidence": 0.0, "face_used": False}

    best_triple.sort(key=lambda p: p["x"])
    avg_spacing = ((best_triple[1]["x"] - best_triple[0]["x"]) +
                   (best_triple[2]["x"] - best_triple[1]["x"])) / 2
    total_px = best_triple[2]["x"] - best_triple[0]["x"]
    scale = (CALIB_MARKER_SPACING_MM * 2) / total_px if total_px > 0 else 0
    confidence = min(1.0, best_score / 500)

    return {
        "markers": [{"x": int(p["x"]), "y": int(p["y"])} for p in best_triple],
        "scale_mm_per_px": round(scale, 6),
        "spacing_px": round(avg_spacing, 1),
        "detection_confidence": round(confidence, 3),
        "face_used": False,
    }


def _check_checkerboard(image_or_gray, cx: int, cy: int, inner_r: int) -> float:
    """Vérifie le motif damier 2×2 à l'intérieur du cercle. Retourne un score."""
    # image_or_gray peut être une image couleur (BGR) ou déjà un ndarray 2D (gray)
    if len(image_or_gray.shape) == 3:
        gray = cv2.cvtColor(image_or_gray, cv2.COLOR_BGR2GRAY)
    else:
        gray = image_or_gray
    h, w = gray.shape
    half = max(3, int(inner_r * 0.45))  # minimum 3px pour voir les quadrants

    def avg_quadrant(dx, dy):
        sx = cx + dx * half
        sy = cy + dy * half
        x0 = max(0, sx - 3)
        x1 = min(w, sx + 3)
        y0 = max(0, sy - 3)
        y1 = min(h, sy + 3)
        if x1 <= x0 or y1 <= y0:
            return 128
        patch = gray[y0:y1, x0:x1]
        return float(np.mean(patch))

    nw = avg_quadrant(-1, -1)
    ne = avg_quadrant(1, -1)
    sw = avg_quadrant(-1, 1)
    se = avg_quadrant(1, 1)

    diff_diag1 = abs(nw - se)
    diff_diag2 = abs(ne - sw)
    diff_adj1 = abs(nw - ne)
    diff_adj2 = abs(nw - sw)
    diff_adj3 = abs(se - ne)
    diff_adj4 = abs(se - sw)

    diag_score = min(diff_diag1, diff_diag2)
    adj_score = (diff_adj1 + diff_adj2 + diff_adj3 + diff_adj4) / 4

    vals = [nw, ne, sw, se]
    sorted_vals = sorted(vals)
    median = (sorted_vals[1] + sorted_vals[2]) / 2
    contrast_min = 15
    bright = sum(1 for v in vals if v > median + contrast_min)
    dark = sum(1 for v in vals if v < median - contrast_min)

    if bright + dark < 2:
        return 0

    return adj_score * 2 + diag_score + bright * 10 + dark * 10


def _detect_by_contours(image: np.ndarray, gray: np.ndarray) -> dict:
    """Fallback : détection par contours + circularité + checkerboard."""
    h, w = image.shape[:2]

    # OTSU
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Nettoyage morphologique
    kernel = np.ones((3, 3), np.uint8)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_dim = min(w, h)
    min_area = np.pi * (min_dim * 0.005) ** 2
    max_area = np.pi * (min_dim * 0.06) ** 2

    candidates = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue
        circularity = 4 * np.pi * area / (perimeter * perimeter)
        if circularity < 0.5:
            continue

        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])
        r = int(np.sqrt(area / np.pi))
        inner_r = int(r * 0.55)
        checker_score = _check_checkerboard(image, cx, cy, inner_r)

        if checker_score > 10:
            candidates.append({"x": cx, "y": cy, "r": r, "checker_score": checker_score})

    if len(candidates) < 3:
        return {}

    # Même logique de triplet que Hough
    candidates.sort(key=lambda c: c["checker_score"], reverse=True)
    sorted_by_x = sorted(candidates[:10], key=lambda c: c["x"])

    for i in range(len(sorted_by_x)):
        for j in range(i + 1, len(sorted_by_x)):
            for k in range(j + 1, len(sorted_by_x)):
                a, b, c = sorted_by_x[i], sorted_by_x[j], sorted_by_x[k]
                y_mean = (a["y"] + b["y"] + c["y"]) / 3
                y_dev = abs(a["y"] - y_mean) + abs(b["y"] - y_mean) + abs(c["y"] - y_mean)
                if y_dev > 40:
                    continue
                if not (a["x"] < b["x"] < c["x"]):
                    continue
                d1 = b["x"] - a["x"]
                d2 = c["x"] - b["x"]
                if d1 < 15 or d2 < 15:
                    continue
                if max(d1, d2) / max(1, min(d1, d2)) > 1.8:
                    continue

                avg_spacing = (d1 + d2) / 2
                total_px = c["x"] - a["x"]
                scale = (CALIB_MARKER_SPACING_MM * 2) / total_px if total_px > 0 else 0
                markers = [{"x": p["x"], "y": p["y"]} for p in (a, b, c)]

                return {
                    "markers": markers,
                    "scale_mm_per_px": round(scale, 6),
                    "spacing_px": round(avg_spacing, 1),
                    "detection_confidence": 0.5,
                    "face_used": False,
                }

    return {}


# ── Endpoints ──

@app.get("/health")
def health():
    return {"status": "ok", "service": "smart-optica-api"}


@app.post("/api/analyze-calibration", response_model=CalibrationResult)
async def analyze_calibration(file: UploadFile = File(...)):
    """
    Analyse une image pour détecter les 3 mires de calibration (cercles damier 2×2).
    Utilise HoughCircles + vérification du motif checkerboard.
    """
    contents = await file.read()
    img = decode_image(contents)
    h, w, _ = img.shape
    check_resolution(w, h, KIND_FACE)

    result = detect_calibration_markers(img)

    return CalibrationResult(
        width=w, height=h,
        markers=result["markers"],
        scale_mm_per_px=result["scale_mm_per_px"],
        spacing_px=result["spacing_px"],
        detection_confidence=result["detection_confidence"],
        face_used=result["face_used"],
    )


@app.post("/api/analyze", response_model=AnalyzeResult)
async def analyze(file: UploadFile = File(...)):
    """Analyse une photo de visage → retourne pupilles, nez, calibration estimée."""
    contents = await file.read()
    img = decode_image(contents)
    h, w, _ = img.shape
    check_resolution(w, h, KIND_FACE)

    # Conversion RGB pour MediaPipe Tasks
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_img)

    if not result.face_landmarks:
        return AnalyzeResult(width=w, height=h, face_detected=False, landmarks_count=0)

    landmarks = result.face_landmarks[0]
    count = len(landmarks)

    # ── Indices FaceLandmarker (478 landmarks avec iris) ──
    # Iris gauche = 468, Iris droit = 473
    # Arête nez = 6, Bout nez = 1, Front = 10
    left_eye = to_px(landmarks[468], w, h) if count > 468 else to_px(landmarks[33], w, h)
    right_eye = to_px(landmarks[473], w, h) if count > 473 else to_px(landmarks[263], w, h)
    nose = to_px(landmarks[6], w, h)  # arête du nez

    # ── Calibration estimée (3 mires dans la zone clip front) ──
    # Utiliser les tempes pour une largeur plus réaliste (le clip est au niveau des tempes)
    temple_l = landmarks[234] if count > 234 else landmarks[33]
    temple_r = landmarks[454] if count > 454 else landmarks[263]
    face_cx = (temple_l.x + temple_r.x) / 2
    face_w = max(0.001, temple_r.x - temple_l.x)
    face_top = min(lm.y for lm in landmarks)

    # Clip ~12% sous le haut du visage, largeur ~85% de la distance inter-tempes (x3)
    clip_y = face_top + face_w * 0.12
    spacing = min(face_w * 0.85, 0.45)  # clamp pour ne pas sortir de l'image
    calibration = [
        {"x": round((face_cx - spacing) * w), "y": round(clip_y * h)},
        {"x": round(face_cx * w), "y": round(clip_y * h)},
        {"x": round((face_cx + spacing) * w), "y": round(clip_y * h)},
    ]

    return AnalyzeResult(
        width=w, height=h,
        face_detected=True,
        left_eye=left_eye,
        right_eye=right_eye,
        nose=nose,
        calibration=calibration,
        landmarks_count=count,
        interPupillaryPx=round(abs(right_eye["x"] - left_eye["x"])),
        interPupillaryMm=None,  # non mesuré ici (valeur de référence 63mm retirée)
    )


def detect_temple_angle(image: np.ndarray, roi_x0: int, roi_x1: int, roi_y0: int, roi_y1: int) -> Optional[float]:
    """
    Détecte l'angle de la branche (temple) dans la photo de profil.
    
    La branche est une ligne quasi-horizontale allant de la charnière vers l'oreille.
    On utilise Canny + HoughLines dans la ROI de la tempe droite.
    
    Retourne l'angle en degrés par rapport à l'horizontale (0° = horizontale, >0 = descend vers la droite).
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    roi = gray[roi_y0:roi_y1, roi_x0:roi_x1]
    
    # Edge detection adaptatif
    blurred = cv2.GaussianBlur(roi, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 100)
    
    # HoughLines — chercher des lignes dans la ROI
    lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=40)
    
    if lines is None:
        return None
    
    # Filtrer les lignes quasi-horizontales (0° ± 25°)
    angles = []
    for line in lines:
        rho, theta = line[0]
        angle_deg = np.degrees(theta) - 90  # theta est l'angle normal, on veut l'angle de la ligne
        # Normaliser entre -90 et 90
        if angle_deg < -90:
            angle_deg += 180
        elif angle_deg > 90:
            angle_deg -= 180
        
        # Garder les lignes proches de l'horizontale
        if abs(angle_deg) < 25:
            angles.append(angle_deg)
    
    if not angles:
        return None
    
    # Médiane pour robustesse
    return float(np.median(angles))


def compute_pantoscopic_angle(markers_px: list, scale_known: Optional[float] = None, temple_angle_deg: Optional[float] = None) -> float:
    """
    Calcule l'angle pantoscopique par l'angle RELATIF entre :
    - La droite des 2 marqueurs latéraux (plan du verre)
    - La branche (temple)
    
    Cette méthode est insensible à l'angle de prise de vue.
    
    Si temple_angle_deg est None, utilise la méthode absolue (par rapport à la verticale).
    """
    if len(markers_px) < 2:
        return 0.0

    dx_px = markers_px[1][0] - markers_px[0][0]
    dy_px = markers_px[1][1] - markers_px[0][1]
    
    if dy_px == 0:
        return 0.0
    
    # Angle du plan du verre par rapport à l'HORIZONTALE
    # arctan2(dy, dx) → 90° si vertical pur, 0° si horizontal pur
    lens_angle_from_horiz = abs(np.degrees(np.arctan2(dy_px, dx_px)))
    
    if temple_angle_deg is not None:
        # Méthode relative : pantoscopic = 90° - |lens_horiz - temple_horiz|
        # Temple est quasi-horizontal (0°), lens est quasi-vertical (90°)
        # Si lens penche en avant, son angle horizontal diminue
        relative = 90.0 - abs(lens_angle_from_horiz - abs(temple_angle_deg))
        return round(max(0.0, min(relative, 30.0)), 1)
    else:
        # Méthode absolue : pantoscopic = 90° - lens_angle_from_horiz
        return round(max(0.0, 90.0 - lens_angle_from_horiz), 1)


def estimate_vertex_distance(image: np.ndarray, markers: list, scale_mm_per_px: float) -> Optional[float]:
    """
    Estime la distance vertex (D'L) à partir de la photo de profil
    et des landmarks MediaPipe.

    Retourne la distance en mm, ou None si le visage n'est pas détecté.
    """
    h, w, _ = image.shape

    # Essayer la détection faciale avec MediaPipe
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_img)

    if not result.face_landmarks:
        return None

    landmarks = result.face_landmarks[0]
    count = len(landmarks)

    # Position de la cornée (iris) en coordonnées relatives
    # 468 = iris gauche, 473 = iris droit
    # En photo de profil droit, on voit surtout l'œil droit
    if count > 473:
        cornea = landmarks[473]  # œil droit (visible de profil)
    elif count > 468:
        cornea = landmarks[468]  # œil gauche (peut-être partiellement visible)
    else:
        return None

    # Position de la tempe / bord du visage
    # 234 = tempe gauche, 454 = tempe droite
    temple_idx = 454 if count > 454 else 234
    temple = landmarks[temple_idx]

    # En photo de profil, on calcule la distance entre l'œil et le plan du clip
    # Le clip est sur la monture, au niveau de l'arête du nez
    # Approximation : la distance horizontale entre le centre de l'iris
    # et la ligne des marqueurs latéraux

    # Coordonnées en pixels
    cornea_x_px = cornea.x * w
    cornea_y_px = cornea.y * h

    # La ligne des marqueurs latéraux (verticale)
    # On prend le centre des 2 marqueurs
    marker_avg_x = (markers[0][0] + markers[1][0]) / 2
    marker_avg_y = (markers[0][1] + markers[1][1]) / 2

    # Distance horizontale entre la cornée et le plan du clip
    dx_px = abs(cornea_x_px - marker_avg_x)
    dy_px = abs(cornea_y_px - marker_avg_y)

    # Le clip est sur le côté TEMPLE de la monture (visible de profil)
    # La cornée est derrière le plan du verre
    # En photo de profil, la cornée est vers la gauche du clip (patient regardant vers la gauche)
    # ou vers la droite (patient regardant vers la droite)

    # Distance géométrique brute iris → plan des mires, sans correction empirique.
    # NB : l'iris MediaPipe approxime le plan cornée — c'est une estimation d'image,
    # pas une mesure optique corrigée.
    vertex_mm = dx_px * scale_mm_per_px

    return round(max(vertex_mm, 0.0), 1)


# ── Endpoints profil ──


class VertexRequest(BaseModel):
    cornea_x: float
    cornea_y: float
    lens_back_x: float
    lens_back_y: float
    scale_mm_per_px: float


@app.post("/api/compute-vertex")
async def compute_vertex(req: VertexRequest):
    """
    Calcule la distance vertex à partir des points placés manuellement.
    
    - cornea_x, cornea_y : point sur la cornée
    - lens_back_x, lens_back_y : point sur la face arrière du verre
    - scale_mm_per_px : échelle de calibration (mm/px)
    
    Retourne la distance cornée → verre en mm.
    """
    dx = req.cornea_x - req.lens_back_x
    dy = req.cornea_y - req.lens_back_y
    dist_px = (dx*dx + dy*dy) ** 0.5
    
    if dist_px < 1:
        raise HTTPException(422, detail="Points trop proches")
    
    # Distance mesurée pure — aucun facteur de correction
    vertex_mm = round(dist_px * req.scale_mm_per_px * 10) / 10
    
    log.info(f"Vertex: {dist_px:.1f}px × {req.scale_mm_per_px:.4f} = {vertex_mm}mm")
    return {"vertex_distance_mm": vertex_mm, "distance_px": round(dist_px, 1)}


@app.post("/api/analyze-profile", response_model=ProfileResult)
async def analyze_profile(file: UploadFile = File(...), scale_mm_per_px: Optional[float] = Form(None), spacing_mm: Optional[float] = Form(None)):
    """
    Analyse une photo de PROFIL DROIT du patient avec le clip de calibration.
    Détecte les 2 marqueurs latéraux (damier 2×2, 5 mm, 25 mm — clip v19.5) sur la face latérale du clip.
    Retourne l'angle pantoscopique et la distance vertex estimée.

    Si scale_mm_per_px est fourni (depuis la calibration frontale), il est utilisé
    pour guider la détection des marqueurs latéraux.
    """
    contents = await file.read()
    img = decode_image(contents)
    h, w, _ = img.shape
    check_resolution(w, h, KIND_PROFILE)

    log.info(f"[analyze-profile] 📥 image {w}×{h}, scale_in={scale_mm_per_px}")
    if scale_mm_per_px:
        log.info(f"[analyze-profile] 📏 calibration face scale = {scale_mm_per_px:.6f} mm/px")
    else:
        log.info(f"[analyze-profile] ⚠️ PAS d'échelle calibration frontale — détection sans contrainte")

    # 1. Détection des mires latérales — cercles noirs (principal) puis damier (secours)
    effective_spacing = spacing_mm if spacing_mm and spacing_mm > 0 else LATERAL_MARKER_SPACING_MM
    markers_px, lateral_diag = _detect_lateral(
        img, landmarker, known_scale=scale_mm_per_px, marker_spacing_mm=effective_spacing)
    log.info(f"  [analyze-profile] diag latéral: chemin={lateral_diag.path} "
             f"spacing_détecté={lateral_diag.spacing_mm_detected}mm "
             f"ROI={lateral_diag.roi_used}")
    
    log.info(f"[analyze-profile] 🎯 lateral_markers détectés: {markers_px}")

    if len(markers_px) < 2:
        raise HTTPException(422, detail="Impossible de détecter les 2 marqueurs latéraux. "
                                         "Vérifiez que le clip est bien visible sur la photo de profil.")

    # 2. Échelle — priorité à l'échelle calibration frontale
    d_px = np.linalg.norm(np.array(markers_px[0]) - np.array(markers_px[1]))
    scale_from_markers = effective_spacing / d_px

    # Le contrôle porte D'ABORD sur la géométrie, pas sur la comparaison avec une
    # autre échelle : un couple de mires qui implique un champ hors
    # [FIELD_MIN_MM, FIELD_MAX_MM] n'est pas le clip. Sans ce test,
    # scale_consistent restait True par défaut faute d'échelle frontale à
    # comparer — et a validé un champ de 2,7 m sur une vraie photo de profil.
    scale_plausible = pair_is_plausible(d_px, effective_spacing, w, h)
    scale_consistent = scale_plausible
    if not scale_plausible:
        log.warning(
            "[analyze-profile] ⛔ échelle des mires invraisemblable : "
            f"{d_px:.0f}px → champ de "
            f"{field_width_mm(d_px, LATERAL_MARKER_SPACING_MM, w, h):.0f}mm")

    if scale_mm_per_px:
        scale = scale_mm_per_px
        # Validation croisée : l'échelle des mires doit être cohérente avec la frontale
        dev = abs(scale_from_markers - scale) / scale
        scale_consistent = scale_plausible and dev <= 0.10
        log.info(f"[analyze-profile] échelle mires={scale_from_markers:.4f} vs frontale={scale:.4f} (écart {dev*100:.1f}%, cohérente={scale_consistent})")
    else:
        scale = scale_from_markers

    # 3. Détection de l'angle de la branche (temple)
    # La branche est dans la zone droite de l'image, autour du niveau des marqueurs
    temple_y0 = max(0, min(markers_px[0][1], markers_px[1][1]) - 60)
    temple_y1 = min(h, max(markers_px[0][1], markers_px[1][1]) + 60)
    temple_x0 = min(markers_px[0][0], markers_px[1][0]) - 40
    temple_x1 = min(w, max(markers_px[0][0], markers_px[1][0]) + 200)
    temple_angle = detect_temple_angle(img, temple_x0, temple_x1, temple_y0, temple_y1)
    log.info(f"  Branche: angle détecté = {temple_angle}° (ROI x=[{temple_x0},{temple_x1}] y=[{temple_y0},{temple_y1}])")

    # 4. Angle pantoscopique — méthode relative branche↔plan verre
    pantoscopic = compute_pantoscopic_angle(markers_px, scale, temple_angle)

    # 4. Distance vertex (D'L) — via MediaPipe
    vertex = estimate_vertex_distance(img, markers_px, scale)

    # 5. Détection faciale
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_result = landmarker.detect(mp_img)
    face_detected = bool(face_result.face_landmarks)

    log.info(f"Profil: scale={scale:.4f} mm/px, angle_pantoscopique={pantoscopic}°, vertex={vertex}mm, face={face_detected}")

    return ProfileResult(
        width=w,
        height=h,
        lateral_markers=markers_px,
        scale_mm_per_px=round(scale, 6),
        scale_from_markers_mm_per_px=round(scale_from_markers, 6),
        scale_consistent=scale_consistent,
        pantoscopic_angle=pantoscopic,
        vertex_distance=vertex,
        face_detected=face_detected,
        temple_angle=round(temple_angle, 1) if temple_angle is not None else None,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
