"""
Smart Optica — Backend API
FastAPI + MediaPipe (Tasks API) + OpenCV pour la détection faciale et calibration.
POST /api/analyze  →  reçoit une image, retourne les coordonnées des repères
"""

import io
import logging
import math
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

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("smart-optica")

app = FastAPI(title="Smart Optica API", version="1.0.0")

# CORS — autorise le frontend Vite
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
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
    # Échelle de MESURE du profil : auto-calibrée sur les 2 mires latérales
    # (25.0 mm entre leurs centres). L'échelle frontale ne sert qu'à guider
    # la détection — les 2 photos peuvent avoir des échelles différentes.
    scale_source: str = "lateral_markers"
    frontal_scale_mm_per_px: Optional[float] = None  # échelle frontale reçue (guide détection)
    scale_delta_pct: Optional[float] = None          # écart % entre les 2 échelles
    lateral_spacing_mm: Optional[float] = None       # espacement réel des mires détectées (35/25)
    pantoscopic_angle: Optional[float] = None  # degrés
    vertex_distance: Optional[float] = None  # mm
    face_detected: bool = False
    temple_angle: Optional[float] = None  # degrés, angle de la branche
    temple_line: Optional[list] = None  # segment branche [(x1,y1),(x2,y2)] — placement auto UI
    lens_line: Optional[list] = None  # segment plan du verre (⊥ aux mires) — placement auto UI
    cornea: Optional[dict] = None  # position iris (pixels) — placement auto UI
    vertex_line: Optional[list] = None  # segment cornée→face arrière verre [(x1,y1),(x2,y2)]


def decode_image(data: bytes) -> np.ndarray:
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


def _checkerboard_score_at(integral, w, h, cx, cy, quadrant_offset, sample_size):
    """Score du motif damier 2×2 centré sur (cx, cy).

    Motif : NW=noir, NE=blanc, SW=blanc, SE=noir → NW≈SE sombres, NE≈SW claires.
    Retourne max(0, contraste_adjacent − contraste_diagonal/2), et 0 si le motif
    n'a pas 2 quadrants sombres + 2 clairs (rejette les bords de disques pleins).
    """
    def rect_mean(px, py, size):
        px0 = max(0, min(w, px - size))
        px1 = min(w, px + size + 1)
        py0 = max(0, min(h, py - size))
        py1 = min(h, py + size + 1)
        area = (px1 - px0) * (py1 - py0)
        if area <= 0:
            return 128.0
        total = (integral[py1, px1] - integral[py0, px1] -
                 integral[py1, px0] + integral[py0, px0])
        return total / area

    nw = rect_mean(cx - quadrant_offset, cy - quadrant_offset, sample_size)
    ne = rect_mean(cx + quadrant_offset, cy - quadrant_offset, sample_size)
    sw = rect_mean(cx - quadrant_offset, cy + quadrant_offset, sample_size)
    se = rect_mean(cx + quadrant_offset, cy + quadrant_offset, sample_size)

    # Un vrai damier est BIMODAL : 2 quadrants sombres + 2 clairs, bien séparés.
    vals = sorted([nw, ne, sw, se])
    median = (vals[1] + vals[2]) / 2
    dark = sum(1 for v in (nw, ne, sw, se) if v < median - 15)
    bright = sum(1 for v in (nw, ne, sw, se) if v > median + 15)
    if dark < 2 or bright < 2:
        return 0.0

    # Corrélation normalisée avec le motif damier (NW≈SE sombres, NE≈SW claires).
    # Un vrai damier → |corr| ≈ 1 ; un bord de disque ou un gradient (0,67,182,240)
    # → corr ≈ 0. Le signe tolère l'étiquette imprimée inversée.
    c = np.array([nw, ne, sw, se], dtype=np.float64) - (nw + ne + sw + se) / 4.0
    n = np.linalg.norm(c)
    if n == 0:
        return 0.0
    corr = float(np.dot(c, np.array([-1.0, 1.0, 1.0, -1.0]))) / (n * 2.0)
    if abs(corr) < 0.7:  # vrai damier ≈ 1 même flouté ; bord de disque ≤ ~0.5
        return 0.0

    diag1 = abs(nw - se)
    diag2 = abs(ne - sw)
    diag = diag1 + diag2
    adj = abs(nw - ne) + abs(nw - sw) + abs(se - ne) + abs(se - sw)
    return max(0.0, adj - diag * 0.5)


def _scan_calibration_scores(gray, integral, w, h, x0, x1, clip_y,
                             quadrant_offset, y_margin=0):
    """Corrélation damier le long d'une bande horizontale.

    Pour chaque X, on retient le MAX vertical sur la fenêtre
    [clip_y − y_margin, clip_y + y_margin] : robuste au placement vertical
    du clip (le niveau des sourcils n'est qu'une approximation).
    """
    sample_size = max(2, quadrant_offset // 3)
    strip_h = max(3, quadrant_offset)
    half_h = strip_h // 2
    n = x1 - x0
    scores = np.zeros(n, dtype=np.float32)
    step = max(1, quadrant_offset // 2)
    y_offsets = list(range(-y_margin, y_margin + 1, step))
    if not y_offsets:
        y_offsets = [0]

    for i in range(n):
        cx = x0 + i
        best = 0.0
        for off in y_offsets:
            cy = clip_y + off
            s, cnt = 0.0, 0
            for dy in range(-half_h, half_h + 1):
                v = _checkerboard_score_at(integral, w, h, cx, cy + dy,
                                           quadrant_offset, sample_size)
                if v > 0:
                    s += v
                    cnt += 1
            if cnt:
                v = s / cnt
                if v > best:
                    best = v
        scores[i] = best
    return scores


def _find_calibration_triple(peaks, expected_spacing, max_peaks=15):
    """Meilleur triplet de 3 pics espacés de ≈ expected_spacing."""
    if len(peaks) < 3:
        return None
    top = sorted(peaks, key=lambda p: p["score"], reverse=True)[:max_peaks]
    best, best_total = None, 0
    for i in range(len(top)):
        for j in range(i + 1, len(top)):
            for k in range(j + 1, len(top)):
                a, b, c = sorted([top[i], top[j], top[k]], key=lambda p: p["x"])
                d1 = b["x"] - a["x"]
                d2 = c["x"] - b["x"]
                if d1 < 5 or d2 < 5:
                    continue
                spacing_err = abs(d1 - expected_spacing) + abs(d2 - expected_spacing)
                spacing_score = max(0, 200 - spacing_err)
                total = a["score"] + b["score"] + c["score"] + spacing_score * 2
                if total > best_total:
                    best_total = total
                    best = [a, b, c]
    return best


def _refine_marker_y(integral, w, h, x, y0, quadrant_offset, sample_size, search):
    """Y donnant le meilleur score damier autour de y0 (placement vertical précis)."""
    best_y, best_v = y0, -1.0
    for cy in range(max(0, y0 - search), min(h - 1, y0 + search) + 1):
        v = _checkerboard_score_at(integral, w, h, x, cy, quadrant_offset, sample_size)
        if v > best_v:
            best_v, best_y = v, cy
    return best_y


def _find_calibration_triple_2d(cands: list, exp_px):
    """Triplet de 3 candidats COLINÉAIRES et ÉQUIDISTANTS (≈ exp_px entre chacun)."""
    best, best_score = None, float("inf")
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            for k in range(j + 1, len(cands)):
                a, b, c = sorted([cands[i], cands[j], cands[k]], key=lambda p: p["x"])
                d1 = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
                d2 = math.hypot(c["x"] - b["x"], c["y"] - b["y"])
                # Espacement plausible (50 mm à une échelle réaliste) + équidistance
                if d1 < 60 or d2 < 60 or d1 > 500 or d2 > 500:
                    continue
                if abs(d1 - d2) > max(d1, d2) * 0.15:
                    continue
                # Colinéarité : distance perpendiculaire du point central à la
                # droite (a,c) < 8% de l'envergure (tolère une légère courbure)
                cross = ((c["x"] - a["x"]) * (b["y"] - a["y"]) -
                         (c["y"] - a["y"]) * (b["x"] - a["x"]))
                span = math.hypot(c["x"] - a["x"], c["y"] - a["y"])
                if span > 0 and abs(cross) / span > span * 0.08:
                    continue
                score = abs(d1 - d2)
                score -= (a["score"] + b["score"] + c["score"]) / 300.0
                if score < best_score:
                    best_score = score
                    best = [a, b, c]
    return best


def _detect_calibration_checkerboards(gray: np.ndarray, integral, w: int, h: int):
    """Scan damier 2D complet → triplet de 3 mires faciales (sans visage requis).

    Les 3 mires faciales (damier 2×2, 50 mm entre chacune) sont cherchées sur
    toute l'image, à plusieurs tailles de motif. Retourne [(x,y)×3] triés par X
    ou [] si aucun triplet colinéaire n'est trouvé.
    """
    best = None  # (markers, score_total)
    for qo in (6, 8, 10, 12):
        step = max(3, qo // 2)
        pts = _scan_checkerboard_grid(gray, integral, w, h, 0, 0, w, h, qo, step)
        if len(pts) < 3:
            continue
        merge_r = qo + step
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
        if len(cands) < 3:
            continue
        triple = _find_calibration_triple_2d(cands, None)
        if triple:
            total = sum(c["score"] for c in triple)
            if best is None or total > best[1]:
                best = (sorted(triple, key=lambda p: p["x"]), total)
    if not best:
        return []
    return best[0]  # [{"x","y","score"} ×3], triés par X


def _finalize_calibration(markers: list, w: int, h: int, face_used: bool = True) -> dict:
    """Construit la réponse standard à partir de 3 marqueurs (envergure 100 mm)."""
    total_px = math.hypot(markers[2]["x"] - markers[0]["x"],
                          markers[2]["y"] - markers[0]["y"])
    scale = (CALIB_MARKER_SPACING_MM * 2) / total_px if total_px > 0 else 0
    avg_spacing = total_px / 2
    conf_sum = sum(m.get("score", 0) for m in markers)
    confidence = min(1.0, conf_sum / 1800.0) if conf_sum else 0.7
    return {
        "markers": [{"x": int(m["x"]), "y": int(m["y"])} for m in markers],
        "scale_mm_per_px": round(scale, 6),
        "spacing_px": round(avg_spacing, 1),
        "detection_confidence": round(confidence, 3),
        "face_used": face_used,
        "width": w,
        "height": h,
    }


def detect_calibration_markers(image: np.ndarray) -> dict:
    """
    Détecte les 3 mires de calibration (damier 2×2) sur le clip frontal.
    
    Approche 1D : corrélation directe du motif damier le long d'une bande horizontale
    (guidée par le visage si présent). Sans visage : scan damier 2D complet, puis
    fallback Hough/contours. Dimensions connues : Ø intérieur 10mm, espacement 50mm.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # ── 0. MediaPipe → détection du visage ──
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_result = landmarker.detect(mp_img)
    face_detected = bool(face_result.face_landmarks)

    if not face_detected:
        log.info("Calibration: pas de visage — scan damier 2D, puis Hough")
        markers = _detect_calibration_checkerboards(gray, cv2.integral(gray), w, h)
        if len(markers) == 3:
            return _finalize_calibration(markers, w, h, face_used=False)
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

    if abs(eye_angle_deg) > 0.5:
        # Redresser l'image
        center = (w // 2, h // 2)
        rot_mat = cv2.getRotationMatrix2D(center, eye_angle_deg, 1.0)
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

    # ── 2. Échelle via IPD — multi-hypothèses (56–70 mm, DP adulte) ──
    # La DP réelle varie (50–75 mm) : au lieu de supposer 63 mm fixes, on teste
    # plusieurs échelles et on garde le meilleur triplet obtenu.
    ipd_px = abs(right_eye.x - left_eye.x) * w
    if ipd_px > 20:
        ipd_candidates = [56.0, 60.0, 63.0, 66.0, 70.0]
    else:
        ipd_candidates = [None]  # IPD illisible → échelle par défaut

    # Position Y : niveau des sourcils
    brow_y = min(
        landmarks[105].y if count > 105 else landmarks[33].y,
        landmarks[334].y if count > 334 else landmarks[263].y,
    )

    # Plage X : entre les tempes (élargie pour capturer les marqueurs extérieurs)
    temple_l = landmarks[234].x if count > 234 else landmarks[33].x
    temple_r = landmarks[454].x if count > 454 else landmarks[263].x

    integral = cv2.integral(gray)
    best_result = None
    best_conf = 0.0

    for ipd_mm in ipd_candidates:
        mm_per_px = (ipd_mm / ipd_px) if ipd_mm else 0.3
        quadrant_offset = max(3, int(2.5 / mm_per_px))   # 2.5mm → px
        expected_spacing = int(50.0 / mm_per_px)          # 50mm → px
        clip_y = int(brow_y * h) - quadrant_offset
        y_margin = max(8, quadrant_offset * 2)            # bande verticale de recherche

        x0 = max(0, int(temple_l * w) - int(expected_spacing * 0.2))
        x1 = min(w, int(temple_r * w) + int(expected_spacing * 0.2))

        log.info(f"Calibration 1D (IPD {ipd_mm or 63.0:.0f}mm): scale={mm_per_px:.4f}mm/px "
                 f"offset={quadrant_offset}px spacing={expected_spacing}px "
                 f"strip_y={clip_y}±{y_margin} x=[{x0},{x1}]")

        scores = _scan_calibration_scores(gray, integral, w, h, x0, x1,
                                          clip_y, quadrant_offset, y_margin)
        # Lissage 1D (cv2 — évite la dépendance scipy)
        smoothed = cv2.GaussianBlur(scores.reshape(1, -1), (0, 0),
                                    quadrant_offset / 4)[0]

        peaks = []
        for i in range(1, len(smoothed) - 1):
            if smoothed[i] > smoothed[i - 1] and smoothed[i] >= smoothed[i + 1]:
                if smoothed[i] > 5:  # seuil minimal
                    peaks.append({"x": x0 + i, "score": float(smoothed[i])})

        triple = _find_calibration_triple(peaks, expected_spacing)
        if not triple:
            log.info(f"  IPD {ipd_mm or 63.0:.0f}mm: pas de triplet valide")
            continue

        triple.sort(key=lambda p: p["x"])
        avg_spacing = ((triple[1]["x"] - triple[0]["x"]) +
                       (triple[2]["x"] - triple[1]["x"])) / 2
        total_px = triple[2]["x"] - triple[0]["x"]
        scale = (CALIB_MARKER_SPACING_MM * 2) / total_px if total_px > 0 else 0
        confidence = min(1.0, sum(m["score"] for m in triple) / 400)

        if confidence > best_conf:
            best_conf = confidence
            best_result = {
                "markers": [{"x": int(m["x"]), "y": clip_y, "score": m["score"]}
                            for m in triple],
                "avg_spacing": avg_spacing,
                "total_px": total_px,
                "scale": scale,
                "confidence": confidence,
                "quadrant_offset": quadrant_offset,
            }

        if confidence >= 0.8:  # bonne détection → on s'arrête là
            break

    if best_result is None:
        log.info("Calibration: aucun triplet valide (multi-IPD) — scan damier 2D, puis Hough")
        markers2d = _detect_calibration_checkerboards(gray, integral, w, h)
        if len(markers2d) == 3:
            return _finalize_calibration(markers2d, w, h, face_used=True)
        return _fallback_hough(gray, h, w)

    # ── 4. Résultat ──
    # Placement Y précis : recherche locale du meilleur score damier par mire
    qo = best_result["quadrant_offset"]
    sample_size = max(2, qo // 3)
    for m in best_result["markers"]:
        m["y"] = _refine_marker_y(integral, w, h, m["x"], m["y"], qo,
                                  sample_size, search=qo * 2)

    log.info(f"Calibration DONE: markers={[(m['x'], m['y']) for m in best_result['markers']]} "
             f"span={best_result['total_px']}px spacing={best_result['avg_spacing']:.0f}px "
             f"scale={best_result['scale']:.4f}mm/px conf={best_result['confidence']:.2f}")

    return {
        "markers": [{"x": m["x"], "y": m["y"]} for m in best_result["markers"]],
        "scale_mm_per_px": round(best_result["scale"], 6),
        "spacing_px": round(best_result["avg_spacing"], 1),
        "detection_confidence": round(best_result["confidence"], 3),
        "face_used": True,
        "width": w,
        "height": h,
    }


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
        interPupillaryMm=63.0,  # valeur de référence
    )


# ── Détection des mires latérales du clip ──
# Clip ACTUEL (celui utilisé) : 3 mires faciales (damier, 50 mm) + 2 mires
# latérales = 2 CERCLES NOIRS OPAQUES, Ø 4 mm, distance entre centres = 25 mm.
# Chemin de détection PRINCIPAL : cercles noirs (BlobDetector + contours/Otsu).
# Nouveau design (design/clip_reference_v3/v4.scad) : mires latérales damier 2×2
# à 35 mm le long du bras — conservé en secours.
LATERAL_MARKER_DIAMETER_MM = 4.0
LATERAL_MARKER_SPACING_MM = 25.0      # clip actuel : 2 cercles noirs, centres à 25 mm
LATERAL_MARKER_SPACING_MM_NEW = 35.0  # nouveau design v3/v4 : 35 mm le long du bras
# Règle métrologique : si l'échelle auto (mires latérales) s'écarte de plus de ce
# % par rapport à l'échelle manuelle (calibration frontale cliquée), la détection
# latérale est jugée non fiable → on mesure avec l'ÉCHELLE MANUELLE.
SCALE_MISMATCH_THRESHOLD_PCT = 15.0


def _scan_checkerboard_grid(gray, integral, w, h, x0, y0, x1, y1,
                            quadrant_offset, step):
    """Score damier 2×2 sur une grille 2D dans une ROI.

    Retourne une liste de (cx, cy, score) pour les points au-dessus du seuil.
    """
    sample_size = max(2, quadrant_offset // 3)
    pts = []
    for cy in range(y0, y1, step):
        for cx in range(x0, x1, step):
            v = _checkerboard_score_at(integral, w, h, cx, cy,
                                       quadrant_offset, sample_size)
            if v > 8:
                pts.append((cx, cy, float(v)))
    return pts


def _find_best_checkerboard_pair(cands: list, exp_px):
    """Meilleure paire de mires damier : distance ≈ attendue, scores élevés."""
    best_pair, best_score = None, float("inf")
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            d = math.hypot(cands[i]["x"] - cands[j]["x"],
                           cands[i]["y"] - cands[j]["y"])
            if exp_px:
                if abs(d - exp_px) > exp_px * 0.35:  # tolérance ±35%
                    continue
                score = abs(d - exp_px) / exp_px
            else:
                if d < 15:
                    continue
                score = 0.0
            # Bonus pour des scores damier élevés (normalisé)
            score -= (cands[i]["score"] + cands[j]["score"]) / 400.0
            if score < best_score:
                best_score = score
                best_pair = (cands[i], cands[j])
    return best_pair


def _detect_lateral_checkerboard_pair(gray, integral, w, h, roi, scale,
                                      spacings=None):
    """Détecte une paire de mires DAMIER 2×2 dans la ROI (segment du bras).

    Essaie plusieurs tailles de motif (quadrant_offset) et plusieurs espacements
    (35 mm design actuel, 25 mm legacy). Retourne (markers, spacing_mm) ou (None, None).
    """
    x0, y0, x1, y1 = roi
    if scale and scale > 0:
        # Motif latéral Ø 4 mm → quadrants de 2 mm → décalage d'échantillonnage
        # = 1 mm (demi-quadrant), comme pour les mires faciales (2.5 mm).
        qo_list = [max(3, int(1.0 / scale))]
    else:
        qo_list = [3, 4, 6, 8, 10]             # taille inconnue → scan multi-échelle
    if spacings is None:
        spacings = [LATERAL_MARKER_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW]  # 25, 35

    best = None  # (markers, spacing_mm, score_total)
    for qo in qo_list:
        step = max(2, qo // 2)
        pts = _scan_checkerboard_grid(gray, integral, w, h, x0, y0, x1, y1, qo, step)
        if len(pts) < 2:
            continue
        # NMS local : ne garder que le meilleur score par cellule. Le rayon couvre
        # la période du motif (2×qo) pour fusionner les « sous-centres » des coins.
        merge_r = qo + step
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
    # Espacement réel : le plus proche de la distance mesurée (anti-aliasing)
    markers = best[0]
    d = math.hypot(markers[1][0] - markers[0][0], markers[1][1] - markers[0][1])
    if scale and scale > 0:
        est_mm = round(d * scale, 2)
        # Privilégie le clip actuel (25 mm) en cas d'égalité
        spacing_mm = min((LATERAL_MARKER_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW),
                         key=lambda s: (abs(s - est_mm),
                                        s != LATERAL_MARKER_SPACING_MM))
    else:
        spacing_mm = best[1]
    return markers, spacing_mm


def _perpendicular_lens_line(markers: list, w: int, h: int, half_len: int = 90):
    """Ligne du PLAN DU VERRE : perpendiculaire au segment des 2 mires, au milieu.

    Les mires latérales sont le long du bras (≈ parallèle à la branche) : le plan
    du verre, vu de profil, est perpendiculaire à ce segment.
    Retourne [(x1,y1),(x2,y2)] clampé à l'image.
    """
    mx = (markers[0][0] + markers[1][0]) / 2
    my = (markers[0][1] + markers[1][1]) / 2
    dx = markers[1][0] - markers[0][0]
    dy = markers[1][1] - markers[0][1]
    norm = math.hypot(dx, dy) or 1.0
    px, py = -dy / norm, dx / norm  # direction perpendiculaire
    p1 = (int(max(0, min(w - 1, mx - px * half_len))),
          int(max(0, min(h - 1, my - py * half_len))))
    p2 = (int(max(0, min(w - 1, mx + px * half_len))),
          int(max(0, min(h - 1, my + py * half_len))))
    return [p1, p2]


def _detect_dark_circle_candidates(gray: np.ndarray, roi: tuple,
                                   expected_radius=None, min_contrast: float = 25.0):
    """Filtre adapté : cercles sombres sur fond plus clair (robuste aux textures).

    Pour chaque rayon, on calcule le contraste (moyenne anneau − moyenne disque) par
    convolution ; les maxima locaux forts sont les candidats. Retourne
    [{x, y, radius, score}] avec x/y dans l'image (ROI décalée), NMS appliqué.
    """
    x0, y0, x1, y1 = roi
    g = gray[y0:y1, x0:x1].astype(np.float32)
    rh, rw = g.shape
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

    # NMS par distance ≥ somme des rayons
    cands.sort(key=lambda c: c["score"], reverse=True)
    out = []
    for c in cands:
        if all((c["x"] - o["x"]) ** 2 + (c["y"] - o["y"]) ** 2 >
               (c["radius"] + o["radius"] + 3) ** 2 for o in out):
            out.append(c)
    return out


def _find_best_lateral_pair(candidates: list, expected_spacing, expected_radius):
    """Meilleure paire de mires latérales.

    Contraintes : alignées verticalement, espacement ≈ attendu (si échelle connue),
    rayons cohérents entre eux (les 2 mires ont le même Ø 4 mm) et proches de la
    taille attendue quand l'échelle frontale est connue. Les candidats issus du
    filtre adapté portent un `score` (contraste) qui départage les paires.
    """
    if len(candidates) < 2:
        return None
    candidates.sort(key=lambda c: c["y"])
    best_pair, best_score = None, float("inf")
    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            dy = candidates[j]["y"] - candidates[i]["y"]
            dx = abs(candidates[j]["x"] - candidates[i]["x"])

            # Alignement : la paire doit être PLUS VERTICALE qu'horizontale.
            # Le plan latéral (13 mm) peut être légèrement incliné dans la photo,
            # d'où un dx non nul toléré (ex. mires à 25 mm → dy~50, dx≤50).
            if dx > dy:
                continue

            d = math.hypot(dx, dy)

            # Contrainte d'espacement si échelle connue (distance euclidienne)
            if expected_spacing:
                spacing_err = abs(d - expected_spacing)
                if spacing_err > expected_spacing * 0.40:  # max ±40% d'erreur
                    continue
                score = spacing_err / expected_spacing
            else:
                # Fallback : ratio diamètre/espacement (Ø 4mm, espacement 25mm)
                avg_radius = (candidates[i]["radius"] + candidates[j]["radius"]) / 2
                if avg_radius == 0:
                    continue
                spacing_ratio = d / (2 * avg_radius)
                score = abs(spacing_ratio - 6.25)

            # Cohérence de taille entre les 2 mires (même Ø physique)
            rmin = min(candidates[i]["radius"], candidates[j]["radius"])
            rmax = max(candidates[i]["radius"], candidates[j]["radius"])
            if rmax > 0:
                score += (rmax - rmin) / rmax * 2.0

            # Taille attendue quand l'échelle frontale est connue
            if expected_radius:
                avg_radius = (candidates[i]["radius"] + candidates[j]["radius"]) / 2
                score += abs(avg_radius - expected_radius) / max(1.0, expected_radius)

            # Bonus : contraste des candidats (vraies mires > bruit de texture)
            score -= (candidates[i].get("score", 0) + candidates[j].get("score", 0)) / 200.0

            if score < best_score:
                best_score = score
                best_pair = (candidates[i], candidates[j])

    if best_pair is None or best_score > 4:
        return None
    return best_pair


def _detect_marker_pair_in_roi(gray: np.ndarray, roi: tuple, expected_radius,
                               expected_spacing, w: int, h: int) -> list:
    """Détecte une paire de mires latérales dans une ROI.

    BlobDetector calibré si l'échelle est connue, sinon contours avec seuils
    fixes + Otsu (robuste à l'éclairage). Retourne [(x1,y1),(x2,y2)] ou [].
    """
    x0, y0, x1, y1 = roi
    gray_roi = gray[y0:y1, x0:x1]
    blurred = cv2.GaussianBlur(gray_roi, (3, 3), 0)

    # Nettoyage morphologique léger
    kernel_close = np.ones((3, 3), np.uint8)
    kernel_open = np.ones((2, 2), np.uint8)

    candidates = []

    # ── 1. Filtre adapté : cercles sombres sur fond clair (robuste aux textures) ──
    for c in _detect_dark_circle_candidates(gray, roi, expected_radius, min_contrast=25):
        candidates.append({"x": c["x"], "y": c["y"], "radius": c["radius"],
                           "score": c["score"], "area": np.pi * c["radius"] ** 2,
                           "circularity": 0.9})

    if expected_radius and expected_radius >= 2:
        # ── SimpleBlobDetector calibré pour cercles NOIRS de 4mm ──
        params = cv2.SimpleBlobDetector_Params()
        params.filterByColor = True
        params.blobColor = 0  # 0 = dark blobs
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
            cx = int(kp.pt[0]) + x0
            cy = int(kp.pt[1]) + y0
            r = int(kp.size / 2)
            candidates.append({"x": cx, "y": cy, "radius": r, "score": 40.0,
                               "area": np.pi * r * r, "circularity": 0.8})

    if len(candidates) < 2:
        # ── Fallback contour : seuils fixes + Otsu ──
        min_area = max(2, int((expected_radius ** 2) * 0.3) if expected_radius else 3)
        max_area = min(300, int((expected_radius ** 2) * 6) if expected_radius else 500)

        thresholds = [35, 50, 70]
        if blurred.size:
            _, otsu_val = cv2.threshold(blurred, 0, 255,
                                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            if np.ndim(otsu_val) > 0:  # certaines versions d'OpenCV renvoient un array
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
                dup = False
                for existing in candidates:
                    if abs(existing["x"] - cx) < 4 and abs(existing["y"] - cy) < 4:
                        dup = True
                        break
                if not dup:
                    candidates.append({"x": cx, "y": cy, "radius": radius,
                                       "area": area, "circularity": circularity,
                                       "score": 30.0 + circularity * 20.0})

    if len(candidates) < 2:
        return []

    pair = _find_best_lateral_pair(candidates, expected_spacing, expected_radius)

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


def detect_lateral_markers(image: np.ndarray, known_scale: Optional[float] = None) -> tuple:
    """
    Détecte les 2 mires latérales du clip.

    Clip ACTUEL (celui utilisé) : 2 CERCLES NOIRS OPAQUES, Ø 4 mm, centres à
    25 mm — chemin de détection principal (BlobDetector + contours/Otsu).
    Nouveau design (clip_reference_v3/v4.scad) : étiquettes damier 2×2 à 35 mm
    le long du bras — conservé en secours (scan 2D, espacements 25/35 mm).

    Si known_scale est fourni (mm/px frontal), il guide la taille attendue.

    Retourne (markers, spacing_mm) avec markers = [(x1,y1),(x2,y2)] en pixels,
    ou ([], None) si la détection échoue.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Dimensions attendues si l'échelle est connue (cercles noirs : Ø 4mm, 25mm)
    if known_scale and known_scale > 0:
        expected_spacing = int(LATERAL_MARKER_SPACING_MM / known_scale)
        expected_radius = int(2.0 / known_scale)   # rayon = 2mm
        log.info(f"  Marqueurs latéraux: scale={known_scale:.4f}mm/px "
                 f"spacing={expected_spacing}px r={expected_radius}px")
    else:
        expected_spacing = None
        expected_radius = None

    # ── ROIs progressives (cadrage nominal → élargi → quasi complet) ──
    rois = [
        (int(w * 0.55), int(h * 0.20), int(w * 0.90), int(h * 0.65)),  # cadrage nominal
        (int(w * 0.30), int(h * 0.10), int(w * 0.95), int(h * 0.75)),  # élargi
        (max(0, int(w * 0.03)), max(0, int(h * 0.05)),
         min(w, int(w * 0.98)), min(h, int(h * 0.90))),                # quasi complet
    ]

    # ── 1. Clip actuel : 2 cercles noirs opaques (Ø 4mm, centres à 25mm) ──
    for roi in rois:
        markers = _detect_marker_pair_in_roi(gray, roi, expected_radius,
                                             expected_spacing, w, h)
        if markers:
            # Espacement réel dérivé de la distance mesurée (25 mm clip actuel,
            # 35 mm nouveau design) — jamais codé en dur
            d_px = math.hypot(markers[1][0] - markers[0][0],
                              markers[1][1] - markers[0][1])
            if known_scale and known_scale > 0:
                est_mm = round(d_px * known_scale, 2)
                # Privilégie le clip actuel (25 mm) en cas d'égalité
                spacing_mm = min((LATERAL_MARKER_SPACING_MM,
                                  LATERAL_MARKER_SPACING_MM_NEW),
                                 key=lambda s: (abs(s - est_mm),
                                                s != LATERAL_MARKER_SPACING_MM))
            else:
                spacing_mm = LATERAL_MARKER_SPACING_MM
            log.info(f"  Mires latérales (cercles noirs {spacing_mm:.0f}mm) trouvées "
                     f"(ROI {roi}): {markers}")
            return markers, spacing_mm

    # ── 2. Secours : mires damier 2×2 (nouveau design v3/v4, 35mm) ──
    integral = cv2.integral(gray)
    for roi in rois:
        markers, spacing_mm = _detect_lateral_checkerboard_pair(
            gray, integral, w, h, roi, known_scale)
        if markers:
            log.info(f"  Mires latérales (damier {spacing_mm:.0f}mm) trouvées "
                     f"(ROI {roi}): {markers}")
            return markers, spacing_mm

    log.info("  Marqueurs latéraux: aucune paire trouvée")
    return [], None


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


def estimate_vertex_distance(image: np.ndarray, markers: list, scale_mm_per_px: float) -> tuple:
    """
    Estime la distance vertex (D'L) à partir de la photo de profil
    et des landmarks MediaPipe.

    Retourne (vertex_mm, cornea_px) où cornea_px = {"x", "y"} en pixels,
    ou (None, None) si le visage n'est pas détecté.
    """
    h, w, _ = image.shape

    # Essayer la détection faciale avec MediaPipe
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_img)

    if not result.face_landmarks:
        return None, None

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
        return None, None

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

    # La distance horizontale (en mm) = distance vertex
    vertex_mm = dx_px * scale_mm_per_px

    # Ajustement : la distance entre le bord du clip et le centre de la cornée
    # surestime légèrement le vertex (le clip est sur le côté, pas au centre du verre)
    # On applique un facteur de correction empirique
    vertex_mm *= 0.85  # correction : le clip est déporté sur le côté

    cornea_px = {"x": round(cornea_x_px), "y": round(cornea_y_px)}
    return round(max(vertex_mm, 5.0), 1), cornea_px  # minimum 5mm


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
    
    vertex_mm = round(dist_px * req.scale_mm_per_px * 10) / 10
    vertex_mm = max(round(vertex_mm * 0.85 * 10) / 10, 5.0)
    
    log.info(f"Vertex: {dist_px:.1f}px × {req.scale_mm_per_px:.4f} = {vertex_mm}mm")
    return {"vertex_distance_mm": vertex_mm, "distance_px": round(dist_px, 1)}


@app.post("/api/analyze-profile", response_model=ProfileResult)
async def analyze_profile(file: UploadFile = File(...), scale_mm_per_px: Optional[float] = Form(None)):
    """
    Analyse une photo de PROFIL DROIT du patient avec le clip de calibration.
    Détecte les 2 marqueurs latéraux (4mm, 25mm verticaux) sur la face latérale du clip.
    Retourne l'angle pantoscopique et la distance vertex estimée.
    
    Si scale_mm_per_px est fourni (depuis la calibration frontale), il est utilisé
    pour guider la détection des marqueurs latéraux.
    """
    contents = await file.read()
    img = decode_image(contents)
    h, w, _ = img.shape

    if scale_mm_per_px:
        log.info(f"Analyse profil: échelle calibration frontale = {scale_mm_per_px:.4f} mm/px")
    else:
        log.info(f"Analyse profil: image {w}×{h} (sans échelle calibration)")

    # 1. Détection des 2 mires latérales (cercles noirs Ø4mm/25mm → damier en secours)
    markers_px, lateral_spacing_mm = detect_lateral_markers(img, known_scale=scale_mm_per_px)

    if len(markers_px) < 2:
        raise HTTPException(422, detail="Impossible de détecter les 2 mires latérales. "
                                         "Vérifiez que le clip est bien visible sur la photo de profil.")

    # 2. Échelle de MESURE — auto-calibrée sur le segment des 2 mires latérales :
    #    distance réelle entre les CENTRES = espacement du clip détecté
    #    (35 mm design actuel, 25 mm legacy). L'échelle frontale ne sert qu'à
    #    guider la DÉTECTION — les 2 photos peuvent avoir des échelles différentes.
    spacing_mm = lateral_spacing_mm or LATERAL_MARKER_SPACING_MM
    d_px = float(np.linalg.norm(np.array(markers_px[0]) - np.array(markers_px[1])))
    scale = spacing_mm / d_px if d_px > 0 else 0.0
    scale_source = "lateral_markers"  # défaut : échelle auto-calibrée sur les mires latérales

    # Contrôle de cohérence : l'échelle profil doit être proche de l'échelle frontale
    # (même distance de prise de vue). Un écart important signale soit des photos à
    # des distances différentes, soit une mauvaise paire de mires.
    # RÈGLE MÉTROLOGIQUE (Driss) : si l'échelle auto (latérale) n'est PAS en accord
    # avec l'échelle manuelle (frontale), on utilise l'ÉCHELLE MANUELLE — la
    # calibration frontale cliquée par l'opticien est la référence de confiance.
    scale_delta_pct = None
    if scale_mm_per_px and scale > 0:
        scale_delta_pct = round(abs(scale - scale_mm_per_px) / scale_mm_per_px * 100, 1)
        if scale_delta_pct > SCALE_MISMATCH_THRESHOLD_PCT:
            log.warning(f"  Échelle auto latérale ({scale:.4f} mm/px) ≠ échelle manuelle "
                        f"frontale ({scale_mm_per_px:.4f} mm/px) → écart {scale_delta_pct}% "
                        f"> seuil {SCALE_MISMATCH_THRESHOLD_PCT}% → utilisation de l'échelle "
                        f"MANUELLE (détection latérale non fiable)")
            scale = scale_mm_per_px
            scale_source = "manual"
        else:
            log.info(f"  Échelles auto/manuelle en accord (écart {scale_delta_pct}%) "
                     f"→ échelle auto latérale conservée")

    # 3. Détection de l'angle de la branche (temple)
    # La branche est dans la zone droite de l'image, autour du niveau des marqueurs
    temple_y0 = max(0, min(markers_px[0][1], markers_px[1][1]) - 60)
    temple_y1 = min(h, max(markers_px[0][1], markers_px[1][1]) + 60)
    temple_x0 = min(markers_px[0][0], markers_px[1][0]) - 40
    temple_x1 = min(w, max(markers_px[0][0], markers_px[1][0]) + 200)
    temple_angle = detect_temple_angle(img, temple_x0, temple_x1, temple_y0, temple_y1)
    log.info(f"  Branche: angle détecté = {temple_angle}° (ROI x=[{temple_x0},{temple_x1}] y=[{temple_y0},{temple_y1}])")

    # ── Segments prêts pour le placement auto dans l'UI (ProfileMeasure) ──
    # Plan du verre vu de profil :
    #  - segment des mires ≈ VERTICAL → le segment est le plan du verre (ancien clip) ;
    #  - segment ≈ HORIZONTAL (mires le long du bras, nouveau design) → le plan du verre
    #    est PERPENDICULAIRE au segment.
    dx_m = markers_px[1][0] - markers_px[0][0]
    dy_m = markers_px[1][1] - markers_px[0][1]
    if abs(dy_m) >= abs(dx_m):
        lens_line = [list(markers_px[0]), list(markers_px[1])]
    else:
        lens_line = _perpendicular_lens_line(markers_px, w, h)

    # 4. Angle pantoscopique — méthode relative branche↔plan du verre
    pantoscopic = compute_pantoscopic_angle(lens_line, scale, temple_angle)

    # 4. Distance vertex (D'L) — via MediaPipe
    vertex, cornea_px = estimate_vertex_distance(img, markers_px, scale)

    # Branche : à partir de la charnière (juste à gauche du clip), le long de l'angle détecté
    temple_line = None
    if temple_angle is not None and len(markers_px) >= 2:
        rad = math.radians(temple_angle)
        dirx, diry = math.cos(rad), math.sin(rad)
        mid_y = (markers_px[0][1] + markers_px[1][1]) / 2
        hinge_x = min(markers_px[0][0], markers_px[1][0]) - 8
        p1 = (int(hinge_x - dirx * 50), int(mid_y - diry * 50))
        p2 = (int(hinge_x + dirx * 170), int(mid_y + diry * 170))
        p1 = (max(0, min(w, p1[0])), max(0, min(h, p1[1])))
        p2 = (max(0, min(w, p2[0])), max(0, min(h, p2[1])))
        temple_line = [p1, p2]

    # Vertex : cornée (iris) → projection sur la ligne du plan du verre (face arrière)
    vertex_line = None
    if cornea_px is not None and lens_line is not None:
        lens_x = int((lens_line[0][0] + lens_line[1][0]) / 2)
        vertex_line = [(cornea_px["x"], cornea_px["y"]), (lens_x, cornea_px["y"])]

    # 5. Détection faciale
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_result = landmarker.detect(mp_img)
    face_detected = bool(face_result.face_landmarks)

    log.info(f"Profil: scale={scale:.4f} mm/px (source={scale_source}), angle_pantoscopique={pantoscopic}°, vertex={vertex}mm, face={face_detected}")

    return ProfileResult(
        width=w,
        height=h,
        lateral_markers=markers_px,
        scale_mm_per_px=round(scale, 6),
        scale_source=scale_source,
        frontal_scale_mm_per_px=round(scale_mm_per_px, 6) if scale_mm_per_px else None,
        scale_delta_pct=scale_delta_pct,
        lateral_spacing_mm=spacing_mm,
        pantoscopic_angle=pantoscopic,
        vertex_distance=vertex,
        face_detected=face_detected,
        temple_angle=round(temple_angle, 1) if temple_angle is not None else None,
        temple_line=temple_line,
        lens_line=lens_line,
        cornea=cornea_px,
        vertex_line=vertex_line,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
