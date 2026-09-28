"""
Smart Optica — Backend API
FastAPI + MediaPipe (Tasks API) + OpenCV pour la détection faciale et calibration.
POST /api/analyze  →  reçoit une image, retourne les coordonnées des repères
"""

import io
import logging
import threading
import numpy as np
import cv2
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import Dict, Optional
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import urllib.request
import os
from itertools import combinations

# Géométrie MESURÉE du clip v19.5 (revérifiée sur les STL par
# tests/test_clip_geometry.py) — source unique des cotes.
import clip_geometry as clip

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

# ── Exécution des analyses LOURDES ───────────────────────────────────────────────
# Incident réel : le serveur entier est devenu muet (même `/health`, 27 connexions
# en attente, 3 threads de calcul à 100 % CPU) parce que ces analyses tournaient
# DANS la boucle d'événements. Deux corrections, indissociables :
#   1. `run_in_threadpool` — le calcul Python pur (OpenCV/MediaPipe) sort de l'event
#      loop : `/health` et les autres requêtes restent servis pendant l'analyse ;
#   2. un VERROU — une analyse à la fois. MediaPipe n'est pas documenté comme
#      réentrant, et 4 cœurs ne font pas 40 analyses : sans verrou, plusieurs
#      requêtes simultanées saturent la machine. Les suivantes attendent dans leur
#      thread, ce qui ne bloque PAS la boucle d'événements.
ANALYSIS_LOCK = threading.Lock()


def _heavy(fn, *args, **kwargs):
    """Exécute une analyse lourde en série, hors de la boucle d'événements."""
    with ANALYSIS_LOCK:
        return fn(*args, **kwargs)


# Version de clip déclarée côté backend (doit matcher le clip et l'app)
CLIP_VERSION = "clip-v19.5-all-checkerboard"


def _detect_lateral(image, landmarker=None, known_scale=None, marker_spacing_mm=None):
    """Damier unifié d'abord (clip v19.5) ; ArUco (clip v16) en secours ; legacy en dernier.

    ⚠️ GARDE-FOU — toutes les mires du clip v19.5 sont des damiers IDENTIQUES. Si le chemin
    damier a VU au moins une mire du clip (`n_candidates >= 1`) sans produire de paire
    métrologique valide, et qu'aucun marqueur ArUco réel n'est présent, on s'arrête là :
    laisser les « disques noirs » chercher sur des damiers rend une paire FAUSSE — mesuré
    sur une scène du clip dont une mire basse manque : **27,69 mm au lieu de 25,00 mm**
    (10,8 % d'erreur d'échelle, qui contaminerait toutes les mesures). Mieux vaut un échec
    explicite : l'app laisse alors les poignées à poser à la main.
    """
    markers, diag = _detect_lateral_checker(
        image, landmarker, known_scale=known_scale, marker_spacing_mm=marker_spacing_mm)
    if markers:
        return markers, diag
    damiers_vus = getattr(diag, "n_candidates", 0) or 0

    markers_aruco, diag_aruco = _detect_lateral_aruco(
        image, landmarker, known_scale=known_scale, marker_spacing_mm=marker_spacing_mm)
    if markers_aruco:
        return markers_aruco, diag_aruco

    if damiers_vus >= 1:
        _logging.getLogger("smart-optica").warning(
            "  [lateral] ⛔ %d damier(s) du clip v19.5 vu(s) mais paire métrologique "
            "incomplète, et aucun ArUco → PAS de repli sur les disques noirs (ils "
            "rendraient une paire fausse sur des damiers). Échec explicite.", damiers_vus)
        return [], diag

    _logging.getLogger("smart-optica").info(
        "  [lateral] Ni damier ni ArUco → repli sur les variantes antérieures")
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
    markers: list = []  # 3 points [{x, y}, ...] — 4 si la 4ᵉ mire est validée
    scale_mm_per_px: float = 0.0
    spacing_px: float = 0.0
    detection_confidence: float = 0.0
    face_used: bool = False
    # A+B+C : diagnostic du quadrilatère facial — auto-contrôle des étalons, rapports
    # invariants d'échelle, et ROLL du clip.
    # ⚠️ Un champ absent d'ici est FILTRÉ SILENCIEUSEMENT par Pydantic : la réponse
    # HTTP ne le contenait pas, donc le front ne pouvait afficher ni le roll ni la
    # non-validation de la 4ᵉ mire. Le contrat de réponse se déclare ICI en entier.
    facial_quad_check: Optional[dict] = None
    # ORIENTATION de la prise de vue, lue sur la signature des damiers du clip :
    # `selfie` = image RETOURNÉE (l'œil « gauche » de l'image est l'œil droit du
    # porteur), `normale` = caméra arrière. `None` = signature illisible, on ne
    # conclut pas. Sans cela, une mesure monoculaire inverse gauche et droite.
    image_mirrored: bool = False
    orientation_prise_de_vue: Optional[str] = None


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
    # ── Exigences du profil Clip : rôles + diagnostic latéral ────────────────
    lateral_diag: Optional[dict] = None


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
# L'échelle faciale se prend sur les DEUX MIRES EXTRÊMES de la barre, distantes de
# 100,00 mm (mesuré sur le STL — clip_geometry.FACIAL_SPACING_EXTREME_MM). Un span
# deux fois plus long qu'une paire adjacente divise par deux l'erreur relative due
# au bruit de pixel.
CALIB_MARKER_SPAN_MM = clip.FACIAL_SPACING_EXTREME_MM


# ── Damier facial : paramètres pris dans la GÉOMÉTRIE du clip ────────────────
# Carreau de 5,00 mm → quadrants échantillonnés à ±2,50 mm (mesuré sur le STL).
# Sans échelle connue, on balaie les tailles de carreau plausibles : AUCUNE hypothèse
# d'IPD (le « 63 mm pour tout le monde » que le clip existe pour supprimer).
FACIAL_QUADRANT_MM = clip.PATTERN_QUADRANT_MM
# Demi-largeurs de motif essayées (en px), du plus fin au plus large. ⚠️ La borne
# haute compte : sur une photo où le visage est proche, un quadrant fait 31 px
# (0,0816 mm/px) — la sweep s'arrêtait à 20, le détecteur travaillait alors sur un
# motif DEUX FOIS TROP PETIT et l'incohérence des étalons montait à 23 %, donc un
# rejet à tort. Couvre 0,83 → 0,046 mm/px, soit du visage lointain au très proche.
FACIAL_QUADRANT_SWEEP = (3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 31, 39, 49)
FACIAL_EQUIDISTANCE_TOL = 0.15
# Tolérance sur l'ÉCART VERTICAL de la 4ᵉ mire (14,00 mm). Il faut la serrer :
# l'ancienne cote erronée (17 mm) n'est qu'à 21 % de la bonne, et c'est le seul
# critère qui distingue les deux. À 15 %, 14 mm passe et 17 mm est refusé.
FACIAL_RAISED_TOL = 0.15
# Demi-plage (en fraction du décalage vertical de la 4ᵉ mire) balayée pour
# retrouver la HAUTEUR RÉELLE d'une mire. `clip_y` n'est qu'une position de
# recherche : si la plage est trop étroite, le plateau de corrélation est tronqué
# et son barycentre se décale de plusieurs pixels (constaté : 697 au lieu de 700,
# soit 0,75 mm, assez pour fausser le roll et la dispersion des étalons).
FACIAL_ROW_PLAGE_FRAC = 0.5
# Rejet du quadruplet : au-delà de cette incohérence entre étalons du clip, on ne
# prétend plus avoir trouvé le clip (les rapports sont invariants d'échelle, donc
# un écart franc ne peut pas venir de la photo). Volontairement plus large que la
# tolérance « consistent » (2 %) : on écarte le manifestement faux, pas le bruit.
FACIAL_QUAD_REJECT_TOL = 0.05
# Score minimal d'un pic, en fraction du meilleur pic du scan. Un damier COMPLET
# (2 carrés noirs) corrèle ~2× mieux qu'un demi-carreau : ce seuil RELATIF écarte
# les pics fantômes des bords du motif. Nécessaire en plus de la NMS, car celle-ci
# est proportionnelle à l'offset TESTÉ : avec un offset trop petit (3–6 px au lieu
# de 10), son rayon (9–18 px) ne couvre plus les fantômes espacés de ~20 px, et il
# restait 9 pics au lieu de 3 → span 419 px au lieu de 400 (4,5 % d'erreur
# d'échelle, et un faux quadruplet qui gagnait au score). Les mires du clip sont
# identiques et de même orientation : leurs scores pleins sont comparables.
FACIAL_PEAK_MIN_RATIO = 0.7
# Nombre de triplets candidats dont on va jusqu'à chercher la 4ᵉ mire (scan + quatre
# affinages de hauteur). Les triplets sont essayés par score décroissant : les vraies
# mires étant les pics les plus forts, le bon triplet est dans les premiers. Sans ce
# plafond, 15 pics produisent 455 combinaisons et l'analyse d'une photo iPad montait
# à 35,6 s — sans jamais changer le résultat.
FACIAL_MAX_TRIPLET_TRIALS = 12


def _facial_quadrant_offsets(known_scale: Optional[float] = None) -> list:
    """Décalages quadrant (px) à essayer, du plus probable au balayage complet."""
    offsets = []
    if known_scale and known_scale > 0:
        offsets.append(max(3, int(round(FACIAL_QUADRANT_MM / known_scale))))
    offsets.extend(q for q in FACIAL_QUADRANT_SWEEP if q not in offsets)
    return offsets


def _scan_facial_strip(gray: np.ndarray, integral: np.ndarray,
                       x0: int, x1: int, clip_y: int,
                       quadrant_offset: int, w: int, h: int,
                       half_h_override: Optional[int] = None,
                       smooth: bool = True) -> list:
    """Pics de corrélation du motif damier le long de la bande horizontale du clip.

    `half_h_override` : demi-hauteur de la bande verticale explorée autour de
    `clip_y`. Par défaut le score est MOYENNÉ sur ±quadrant/2 — ce qui est voulu
    quand `clip_y` n'est qu'approximatif, mais LISSE le profil vertical : deux
    hauteurs très différentes rendent alors le même score, et le pic ne peut plus
    être localisé en y. Les mesures de HAUTEUR (affinage de la 4ᵉ mire, écart
    vertical) passent donc une valeur faible pour retrouver un profil net.

    `smooth=False` : saute le lissage gaussien. Inutile — et coûteux — sur les
    bandes étroites de l'affinage, où l'on cherche un maximum sur quelques pixels.
    """
    from scipy.ndimage import gaussian_filter1d

    strip_h = max(4, quadrant_offset) if half_h_override is None \
        else max(1, 2 * half_h_override + 1)
    half_h = strip_h // 2
    sample_size = max(2, quadrant_offset // 3)
    scores = np.zeros(x1 - x0, dtype=np.float32)

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

    for i in range(len(scores)):
        cx = x0 + i
        score_sum = 0.0
        count_y = 0
        for dy in range(-half_h, half_h + 1):
            cy = clip_y + dy
            nw = rect_mean(cx - quadrant_offset, cy - quadrant_offset, sample_size)
            ne = rect_mean(cx + quadrant_offset, cy - quadrant_offset, sample_size)
            sw = rect_mean(cx - quadrant_offset, cy + quadrant_offset, sample_size)
            se = rect_mean(cx + quadrant_offset, cy + quadrant_offset, sample_size)
            # Motif : NW=noir, NE=blanc, SW=blanc, SE=noir
            diag = abs(nw - se) + abs(ne - sw)
            adj = abs(nw - ne) + abs(nw - sw) + abs(se - ne) + abs(se - sw)
            contrast = adj - diag * 0.5
            if contrast > 0:
                score_sum += contrast
                count_y += 1
        if count_y > 0:
            scores[i] = score_sum / count_y

    smoothed = gaussian_filter1d(scores.astype(np.float64),
                                 sigma=max(0.5, quadrant_offset / 4.0)) if smooth \
        else scores.astype(np.float64)
    # Tous les maxima locaux au-dessus du plancher de bruit
    bruts = []
    for i in range(1, len(smoothed) - 1):
        if smoothed[i] > smoothed[i - 1] and smoothed[i] >= smoothed[i + 1]:
            if smoothed[i] > 5:
                bruts.append((x0 + i, float(smoothed[i])))

    # ── NON-MAXIMUM SUPPRESSION du MOTIF (Ø10 mm) ────────────────────────────
    # Un damier produit PLUSIEURS maxima autour de son centre (aux abords des
    # carreaux), jusqu'à ~2 carreaux du centre. Sans ce filtre, un triplet
    # s'apparie sur des maxima DÉCALÉS et retient une échelle fausse — constaté :
    # span 339 px au lieu de 400, soit 18 % d'erreur d'échelle, donc 18 % sur
    # TOUTES les mesures. On ne garde qu'UN pic par mire : le plus fort.
    # ⚠️ Le rayon doit dépasser UN CARREAU (2 × quadrant_offset), pas l'égaler :
    # le pic fantôme d'un seul carré noir tombe à 2 × quadrant_offset + 1 px
    # (mesuré : 279 vs 300 à 0,25 mm/px) et survivait à `abs(...) > rayon`.
    # Il ne gagnait que par accident, quand le vrai pic restait dans la recherche.
    # Marge : la plus petite distance entre deux mires du clip est 24,41 mm
    # (droite ↔ haute) ; avec 3 × quadrant_offset le rapport reste ≥ 3,2 sur
    # toute la plage d'échelles — aucune fusion de deux vraies mires.
    rayon = max(4, 3 * quadrant_offset)
    bruts.sort(key=lambda t: -t[1])
    peaks = []
    for x, sc in bruts:
        if all(abs(x - p["x"]) > rayon for p in peaks):
            peaks.append({"x": x, "y": clip_y, "score": sc})

    # ── Filtre RELATIF : un demi-carreau n'est pas une mire ──────────────────
    # La NMS ci-dessus est proportionnelle à l'offset testé ; quand l'offset est
    # trop petit (3–6 px au lieu de 10), les pics fantômes sont plus éloignés que
    # son rayon et survivent. On les écarte par leur SCORE : un damier complet
    # corrèle ~2× mieux qu'un demi-carreau. On ne l'applique que si 3 pics y
    # survivent, pour ne jamais perdre une mire légitimement plus faible (mire en
    # bord de champ, éclairage inégal).
    if len(peaks) > 3:
        smax = max(p["score"] for p in peaks)
        gardes = [p for p in peaks if p["score"] >= FACIAL_PEAK_MIN_RATIO * smax]
        if len(gardes) >= 3:
            peaks = gardes

    peaks.sort(key=lambda p: p["x"])
    return peaks


def _refine_marker_2d(gray: np.ndarray, cx: int, y_centre: int, plage_px: int,
                      quadrant_offset: int, w: int, h: int) -> Optional[dict]:
    """Hauteur (y) de la mire : maximum du contraste damier 2D le long de la colonne.

    ⚠️ Pourquoi pas `_refine_marker` (corrélation de motif le long d'une ligne) : son
    score mesure surtout le contraste EN X et reste élevé sur toute la hauteur de la
    zone contrastée. Profil mesuré sur une vraie photo du clip v19.5 : score plat
    (250–340) sur 144 px pour un damier de 61 px de haut — aucune information de
    hauteur exploitable. Conséquence : la rangée ressortait avec deux pentes
    différentes (705 / 636 / 591), impossible pour un clip rigide, et l'écart vertical
    de la 4ᵉ mire variait de 92 à 193 px selon la taille de motif essayée.

    Ici on cherche le maximum du contraste entre les 4 QUADRANTS autour de (x, y) :
    sélectif dans les deux directions, donc la hauteur est réellement mesurée. Le x
    reste celui du balayage 1D (voir la note plus bas).
    """
    inner_r = max(4, int(quadrant_offset * 1.11))
    y0, y1 = max(0, y_centre - max(1, int(plage_px))), min(h - 1, y_centre + max(1, int(plage_px)))
    if y1 <= y0:
        return None

    def score(x: int, y: int) -> float:
        if x < inner_r or y < inner_r or x >= w - inner_r or y >= h - inner_r:
            return -1.0
        return _check_checkerboard(gray, x, y, inner_r)

    pts = [(cx, y, score(cx, y)) for y in range(y0, y1 + 1)]
    pts = [p for p in pts if p[2] > 0]
    if not pts:
        return None

    # ⚠️ Prendre le PREMIER maximum ne marche pas : le score de damier est PLAT sur
    # toute une zone (les quatre échantillons restent dans les mêmes carrés) et le
    # balayage commençant en haut, la mire ressortait décalée d'un demi-carreau
    # (mesuré : −12 px, soit 3 mm à cette échelle).
    # ⚠️ Le barycentre pondéré biaise aussi (mesuré : +3 px sur un damier synthétique
    # dont le centre est connu) : dès que le profil du plateau n'est pas parfaitement
    # plat, il tire du côté des scores les plus forts. On prend donc le MILIEU de
    # l'intervalle du plateau — exact par symétrie pour un damier, et insensible aux
    # petites variations de score à l'intérieur du plateau.
    #
    # ⚠️ On n'affine PAS le x ici : le déplacer dégradait les ÉCARTEMENTS, qui sont la
    # grandeur métrologique (mesuré sur la vraie photo : 52,4 / 47,7 mm au lieu de
    # 50 / 50 en affinant aussi le x, contre 50,2 / 50,2 en gardant le x du balayage).
    smax = max(p[2] for p in pts)
    plateau = [p[1] for p in pts if p[2] >= 0.98 * smax]
    y_b = (min(plateau) + max(plateau)) / 2
    # Hauteur ENTIÈRE : le barycentre est sub-pixel, mais ces coordonnées servent
    # ensuite à découper l'image (index de tranches) — un flottant lève un TypeError.
    # L'arrondi à 1 px vaut 0,09 mm à cette échelle, négligeable devant les seuils.
    return {"x": cx, "y": int(round(y_b)), "score": float(smax)}


def _lire_quadrants(gray: np.ndarray, cx: int, cy: int, quadrant_px: int,
                    w: int, h: int) -> Optional[Dict[str, float]]:
    """Moyennes de gris des 4 quadrants d'un damier, autour de son centre.

    Sert à deux choses : dire l'ORIENTATION de la prise de vue (selfie miroir ou
    caméra arrière) et vérifier que le motif est bien un damier. On échantillonne au
    MILIEU de chaque quadrant — à ±quadrant/2 du centre — avec une fenêtre plus
    petite que le quadrant, pour ne pas mordre sur le carreau voisin.
    """
    d = max(2, int(round(quadrant_px / 2)))
    t = max(2, d // 2)
    quads: Dict[str, float] = {}
    for nom, sx, sy in (("NO", -1, -1), ("NE", 1, -1), ("SO", -1, 1), ("SE", 1, 1)):
        x0, x1 = max(0, cx + sx * d - t), min(w, cx + sx * d + t)
        y0, y1 = max(0, cy + sy * d - t), min(h, cy + sy * d + t)
        if x1 <= x0 or y1 <= y0:
            return None
        quads[nom] = float(gray[y0:y1, x0:x1].mean())
    return quads


def _orientation_prise_de_vue(gray: np.ndarray, markers: list, quadrant_px: int,
                              w: int, h: int) -> str:
    """Orientation de la prise de vue, lue sur les damiers de la rangée.

    On moyenne les quadrants des 3 mires de la rangée : elles sont vues de face, alors
    que la 4ᵉ peut être plus oblique. Le damier portant la même signature partout,
    moyenner réduit le bruit d'une mire isolée (reflet, ombre).
    """
    lectures = [_lire_quadrants(gray, int(m["x"]), int(m["y"]), quadrant_px, w, h)
                for m in markers[:3]]
    lectures = [q for q in lectures if q]
    if not lectures:
        return clip.ORIENTATION_INDETERMINEE
    moyennes = {k: sum(q[k] for q in lectures) / len(lectures)
                for k in ("NO", "NE", "SO", "SE")}
    return clip.orientation_depuis_quadrants(moyennes)


def _best_facial_quadruplet(peaks: list, gray: np.ndarray, integral: np.ndarray,
                            w: int, h: int,
                            clip_y: int, quadrant_offset: int,
                            x0: int, x1: int,
                            known_scale: Optional[float] = None) -> tuple:
    """Meilleur QUADRUPLET de mires faciales : 3 alignées (−50/0/+50) + 1 hors rangée (30, 17).

    Critères (indépendants de l'échelle) :
      1. Les 3 mires de la barre sont ÉQUIDISTANTES (±15 %) — propriété intrinsèque.
      2. La 4ᵉ mire est à x = +30 mm (entre centre et droite) et **14,00 mm
         au-dessus** de la rangée (z 17,00 − z 3,00) → sur l'image, y_4e = clip_y
         − 14/scale. ⚠ L'écart vaut 14, PAS 17 : « 17 » est une POSITION
         (`stem_top_z`), pas un décalage. Source : `clip_geometry`.
      3. L'écartement extrêmes (100 mm) implique un champ plausible.
    Sans échelle connue, on accepte ±25 % sur z pour absorber l'incertitude de clip_y.

    Retourne (quadruplet, info) ; quadruplet vide si rien de crédible.
    """
    if len(peaks) < 3:
        return [], {"score": -1.0}
    top = sorted(peaks, key=lambda p: -p["score"])[:15]
    sorted_x = sorted(top, key=lambda p: p["x"])

    # ── Étape 1 : présélection des triplets — critères PAS chers ─────────────
    # 15 pics donnent 455 combinaisons ; or valider un triplet coûte un scan de la
    # zone de la 4ᵉ mire PLUS quatre affinages de hauteur. Mesuré sur une photo iPad
    # (bande de 1114 px) : 35,6 s d'analyse, dont la quasi-totalité ici — alors que
    # décodage (0,12 s) et MediaPipe (0,04 s) sont négligeables. On ne garde donc
    # que les meilleurs candidats : les vraies mires sont les pics les plus forts,
    # donc le bon triplet fait partie des premiers.
    candidats = []
    for a, b, c in combinations(sorted_x, 3):
        d1, d2 = b["x"] - a["x"], c["x"] - a["x"]  # a<b<c
        # triplet ordonné : gauche=a, centre=b, droite=c
        if not (d1 > 0 and d2 > d1):
            continue
        equi = abs(d1 - (d2 - d1)) / max(d1, d2 - d1)
        if equi > FACIAL_EQUIDISTANCE_TOL:
            continue
        span_px = c["x"] - a["x"]
        if not pair_is_plausible(span_px, clip.FACIAL_SPACING_EXTREME_MM, w, h):
            continue
        candidats.append((a["score"] + b["score"] + c["score"] - equi * 200.0,
                          equi, a, b, c))
    candidats.sort(key=lambda t: -t[0])

    meilleur, info = [], {"score": -1.0}

    # ── Étape 2 : la 4ᵉ mire, pour les meilleurs candidats seulement ─────────
    for _, equi, a, b, c in candidats[:FACIAL_MAX_TRIPLET_TRIALS]:
        d1 = b["x"] - a["x"]
        span_px = c["x"] - a["x"]

        # échelle provisoire pour convertir l'ÉCART VERTICAL (14,00 mm) en pixels
        scale_prov = clip.scale_from_span(clip.FACIAL_SPACING_EXTREME_MM, span_px)
        dy_raised = int(round(clip.FACIAL_RAISED_Z_GAP_MM / scale_prov)) if scale_prov > 0 else 0
        if dy_raised == 0:
            continue

        # La 4ᵉ mire est à 30 mm du centre, soit la fraction 30/50 = 0,6 de
        # l'écartement adjacent (grandeur dérivée, pas recopiée).
        # ⚠️ DE QUEL CÔTÉ : une photo prise en selfie est en MIROIR — constaté sur les
        # photos du clip v19.5, où les quadrants sombres du damier passent de NO+SE à
        # NE+SO. La 4ᵉ mire apparaît alors du côté OPPOSÉ à celui du clip. On teste donc
        # LES DEUX côtés et on garde le mieux corrélé : la position en x n'a aucune
        # importance métrologique (seuls comptent les écartements et la hauteur), donc
        # les accepter tous les deux ne coûte rien en précision et rend le détecteur
        # insensible au miroir. Sans cela, il cherchait la mire du mauvais côté et
        # retenait un pic SANS AUCUN MOTIF DAMIER (contraste mesuré : nul).
        x_centre = a["x"] + d1
        frac = clip.FACIAL_RAISED_X_FROM_CENTRE_MM / clip.FACIAL_SPACING_ADJACENT_MM
        tol_x = max(8, int(0.15 * d1))  # ±15 % de l'écart adjacent

        # ── La 4ᵉ mire : position attendue, puis position MESURÉE ────────────
        # y attendu = clip_y − 14 mm convertis. Mais `clip_y` n'est qu'une
        # position de RECHERCHE (bande posée au niveau des sourcils) : on balaie
        # autour, et c'est le score qui désigne le vrai centre du damier.
        y_4e = clip_y - dy_raised
        if y_4e < 0 or y_4e >= h:
            continue

        p4, x_4e_attendu, cote_4e = None, None, None
        for cote in (1, -1):        # +1 : entre centre et droite · −1 : miroir
            x_att = x_centre + cote * int(round(frac * d1))
            x_search_min = max(x0, x_att - tol_x)
            x_search_max = min(x1, x_att + tol_x)
            if x_search_max <= x_search_min:
                continue
            candidats = [p for p in
                         sorted(_scan_facial_strip(gray, integral, x_search_min,
                                                   x_search_max, y_4e,
                                                   quadrant_offset, w, h),
                                key=lambda p: -p["score"])
                         if abs(p["x"] - x_att) <= tol_x]
            # Hauteur RÉELLE (le meilleur des 3 premiers candidats en x)
            for cand in candidats[:3]:
                r = _refine_marker_2d(gray, cand["x"], y_4e,
                                   0.6 * dy_raised, quadrant_offset, w, h)
                if r and abs(r["x"] - x_att) <= tol_x \
                        and (p4 is None or r["score"] > p4["score"]):
                    p4, x_4e_attendu, cote_4e = r, x_att, cote
        if p4 is None:
            continue

        # Hauteur RÉELLE du niveau de la barre, mesurée sur la mire du CENTRE.
        ref_rangee = _refine_marker_2d(gray, x_centre, clip_y,
                                    max(quadrant_offset,
                                        int(FACIAL_ROW_PLAGE_FRAC * dy_raised)),
                                    quadrant_offset, w, h)
        if ref_rangee is None:
            continue
        dy_mesure = ref_rangee["y"] - p4["y"]      # > 0 : la 4ᵉ mire est plus HAUTE
        if abs(dy_mesure - dy_raised) > FACIAL_RAISED_TOL * dy_raised:
            continue                               # hauteur incompatible avec le clip

        # Quadruplet valide
        score = (a["score"] + b["score"] + c["score"] + p4["score"]) \
                - equi * 200.0 - abs(dy_mesure - dy_raised) * 5.0
        if score > info["score"]:
            meilleur = [a, b, c, p4]
            info = {"score": score, "equi": equi, "span_px": span_px,
                    "scale": scale_prov, "dy_raised_px": dy_mesure,
                    "quadrant_offset": quadrant_offset, "clip_y": clip_y,
                    "cote_4e": cote_4e}
    return meilleur, info


def _best_facial_triplet(peaks: list, w: int, h: int, clip_y: int,
                         quadrant_offset: int) -> tuple:
    """Meilleur TRIPLET de mires faciales : 3 damiers alignés et équidistants.

    Repli quand le QUADRUPLET n'est pas identifiable — cas réel des photos
    disponibles : un clip à **3 mires faciales** (aucune mire surélevée), ou une 4ᵉ
    mire invisible sous l'angle/la lumière. Sans ce repli, `_best_facial_quadruplet`
    ne rend rien, le détecteur partait dans `_fallback_hough` (lent, et incapable de
    trouver des damiers) et **l'app échouait sur un clip parfaitement utilisable**.

    Critère unique, intrinsèque au clip et donc indépendant de l'échelle : les 3 mires
    de la barre sont ÉQUIDISTANTES à ±15 %, et le span des extrêmes (100 mm) implique
    un champ plausible. Ce que ce repli NE peut PAS donner : le roll, faute de
    référence hors rangée — l'appelant le signale (`roll_deg = None`).

    Retourne (triplet, info) ; triplet vide si rien de crédible.
    """
    if len(peaks) < 3:
        return [], {"score": -1.0}
    top = sorted(peaks, key=lambda p: -p["score"])[:15]
    sorted_x = sorted(top, key=lambda p: p["x"])
    meilleur, info = [], {"score": -1.0}

    for a, b, c in combinations(sorted_x, 3):
        d1, d2 = b["x"] - a["x"], c["x"] - a["x"]      # a < b < c
        if not (d1 > 0 and d2 > d1):
            continue
        equi = abs(d1 - (d2 - d1)) / max(d1, d2 - d1)
        if equi > FACIAL_EQUIDISTANCE_TOL:
            continue
        span_px = c["x"] - a["x"]
        if not pair_is_plausible(span_px, clip.FACIAL_SPACING_EXTREME_MM, w, h):
            continue
        # La hauteur réelle des 3 mires est affinée par l'appelant : on ne note ici
        # que la qualité de l'appariement horizontal.
        score = (a["score"] + b["score"] + c["score"]) - equi * 200.0
        if score > info["score"]:
            meilleur = [a, b, c]
            info = {"score": score, "equi": equi, "span_px": span_px,
                    "scale": clip.scale_from_span(clip.FACIAL_SPACING_EXTREME_MM, span_px),
                    # pas de 4ᵉ mire : la plage d'affinage se rabat sur le motif
                    "dy_raised_px": 2 * quadrant_offset,
                    "quadrant_offset": quadrant_offset, "clip_y": clip_y,
                    "n_points": 3}
    return meilleur, info


def detect_calibration_markers(image: np.ndarray,
                             known_scale: Optional[float] = None) -> dict:
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
    face_result = landmarker.detect(mp_img)   # fonction sync : déjà dans le threadpool
    face_detected = bool(face_result.face_landmarks)

    if not face_detected:
        log.info("Calibration: no face detected, falling back")
        fallback = _fallback_hough(gray, h, w)
        fallback.setdefault("facial_quad_check", None)   # contrat de réponse stable
        fallback.setdefault("image_mirrored", False)
        fallback.setdefault("orientation_prise_de_vue", None)
        return fallback

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
        face_result = landmarker.detect(mp_img)   # fonction sync : déjà dans le threadpool
        if face_result.face_landmarks:
            landmarks = face_result.face_landmarks[0]
            left_eye = landmarks[468] if count > 468 else landmarks[33]
            right_eye = landmarks[473] if count > 473 else landmarks[263]

    # ── 2. Damier facial : recherche MULTI-ÉCHELLE, sans hypothèse d'IPD ──
    # Le carreau du clip fait 5,00 mm, donc les quadrants sont échantillonnés à
    # ±2,50 mm — mais l'échelle de la photo n'est PAS supposée (fini le « 63 mm
    # pour tout le monde » : c'est le facteur empirique que le clip supprime).
    # On retient le triplet de mires ÉQUIDISTANT, propriété intrinsèque du clip.

    # Position de la barre : niveau des sourcils, bande X entre les tempes.
    # Les marges sont RELATIVES (largeur inter-tempes mesurée), donc sans échelle.
    brow_y = min(
        landmarks[105].y if count > 105 else landmarks[33].y,
        landmarks[334].y if count > 334 else landmarks[263].y,
    )
    temple_l = landmarks[234].x if count > 234 else landmarks[33].x
    temple_r = landmarks[454].x if count > 454 else landmarks[263].x
    clip_y_base = int(brow_y * h)
    x0 = max(0, int(temple_l * w))
    x1 = min(w, int(temple_r * w))
    marge = int(0.05 * max(1, x1 - x0))          # 5 % de la largeur inter-tempes
    x0 = max(0, x0 - marge)
    x1 = min(w, x1 + marge)

    log.info(f"Calibration 1D multi-échelle : bande y≈{clip_y_base}px "
             f"x=[{x0},{x1}] (marge {marge}px, aucun IPD supposé)")

    # Guidage facial acquis : le reste du travail est indépendant de MediaPipe.
    return detect_facial_quadruplet(gray, clip_y_base, x0, x1,
                                    known_scale, inverse_rot_mat)


def detect_facial_quadruplet(gray: np.ndarray, clip_y_base: int, x0: int, x1: int,
                             known_scale: Optional[float] = None,
                             inverse_rot_mat: Optional[np.ndarray] = None) -> dict:
    """Détecte le quadruplet facial du clip (3 mires alignées + la surélevée).

    Extrait de `detect_calibration_markers` pour être exerçable SANS MediaPipe :
    le guidage facial (niveau de la barre, largeur inter-tempes) est fourni en
    arguments, et tout le reste — balayage multi-échelle, sélection du quadruplet,
    auto-contrôle des étalons (A), validation par les rapports (B), mesure du roll
    (C) — vit ici. Les tests appellent donc ce chemin RÉEL sur une image
    synthétique, au lieu de le neutraliser faute de visage détectable.

    `x0`, `x1` : bornes horizontales de recherche (largeur inter-tempes + marge).
    `gray` : image à UN canal (niveaux de gris) — `cv2.integral` y est appliqué.
    Retourne le même contrat que `detect_calibration_markers`.
    """
    h, w = gray.shape[:2]

    integral = cv2.integral(gray)
    meilleur = None
    meilleur_triplet = None     # repli quand la 4ᵉ mire faciale n'est pas identifiable
    for quadrant_offset in _facial_quadrant_offsets(known_scale):
        if 2 * quadrant_offset >= max(6, min(w, h) // 4):
            continue
        clip_y = clip_y_base - quadrant_offset
        if clip_y <= 0 or clip_y >= h:
            continue
        peaks = _scan_facial_strip(gray, integral, x0, x1, clip_y,
                                   quadrant_offset, w, h)
        # Si on a un triplet, chercher la 4ᵉ mire plus haut (14 mm au-dessus)
        quadruplet, info = _best_facial_quadruplet(peaks, gray, integral, w, h,
                                                   clip_y, quadrant_offset,
                                                   x0, x1, known_scale)
        if quadruplet and (meilleur is None or info["score"] > meilleur[2]["score"]):
            meilleur = (quadruplet, quadrant_offset, info)
            # ── Arrêt anticipé par l'auto-contrôle des étalons (A) ────────────
            # Les écartements du clip sont des étalons : quand ils concordent, le
            # quadruplet est identifié et balayer les autres échelles ne peut plus
            # l'améliorer. Sans cette sortie, les 9 offsets étaient tous explorés
            # avec leurs affinages — 5 s au lieu de ~1 s.
            # Les hauteurs réelles ne sont pas encore mesurées (l'affinage final
            # vient après la boucle) : on les affine ici, sinon le contrôle
            # porterait sur le y de RECHERCHE et conclurait à tort.
            for m in quadruplet[:3]:
                ref = _refine_marker_2d(gray, m["x"], info["clip_y"],
                                     max(quadrant_offset,
                                         int(FACIAL_ROW_PLAGE_FRAC
                                             * info["dy_raised_px"])),
                                     quadrant_offset, w, h)
                if ref:
                    m["x"], m["y"] = ref["x"], ref["y"]
            diag = clip.facial_quad_check(clip.facial_points_from_markers(
                [{"x": float(m["x"]), "y": float(m["y"])} for m in quadruplet]))
            if diag["n_points"] == 4 and diag["scale_consistent"] \
                    and diag["ratios_consistent"]:
                break
        elif meilleur is None:
            # ── Repli TRIPLET (dégradation gracieuse) ─────────────────────────
            # Un clip dont la 4ᵉ mire est absente ou invisible garde 3 mires
            # parfaitement mesurables. Sans ce repli, on tombait dans
            # `_fallback_hough` : lent, incapable de trouver des damiers, et l'app
            # échouait sur un clip utilisable. On continue à balayer les échelles
            # (le score choisit) tant qu'aucun quadruplet n'a été trouvé.
            triplet, info_t = _best_facial_triplet(peaks, w, h, clip_y, quadrant_offset)
            if triplet and (meilleur_triplet is None
                            or info_t["score"] > meilleur_triplet[2]["score"]):
                meilleur_triplet = (triplet, quadrant_offset, info_t)

    # ── PAS de « seconde passe » de recalage d'échelle ─────────────────────────
    # Une tentative a été faite : déduire la taille du damier du span mesuré (100 mm,
    # étalon du clip) puis refaire une passe à cette taille. Le raisonnement est juste,
    # mais le balayage 1D à la taille « idéale » (62 px) plaçait les mires SUR LA BARRE
    # BLANCHE et sur la peau, à côté des damiers — vérifié en dessinant les positions
    # sur l'image. Le défaut restait INVISIBLE aux seuils internes : un décalage
    # presque uniforme préserve l'équidistance, alors qu'il fausse l'échelle de 2,4 %,
    # donc TOUTES les mesures. Le correctif doit porter sur la LOCALISATION elle-même,
    # pas sur un recalage qui déplace les pics après coup.
    if meilleur is None:
        meilleur = meilleur_triplet
        if meilleur is not None:
            log.info("Calibration : 4e mire faciale absente ou invisible → "
                     "3 mires de la rangée (pas de roll, échelle sur les extrêmes)")

    if meilleur is None:
        log.info("Calibration: aucun damier du clip crédible → repli Hough")
        fallback = _fallback_hough(gray, h, w)
        if inverse_rot_mat is not None and fallback.get("markers"):
            restored = reproject_points(fallback["markers"], inverse_rot_mat)
            fallback["markers"] = [{"x": round(p["x"]), "y": round(p["y"])}
                                   for p in restored]
        fallback.setdefault("facial_quad_check", None)   # contrat de réponse stable
        fallback.setdefault("image_mirrored", False)
        fallback.setdefault("orientation_prise_de_vue", None)
        return fallback

    best_quad, quadrant_offset, info = meilleur
    # Ordre [gauche, centre, droite, 4ᵉ mire] — pas trié par x (la 4ᵉ mire est
    # entre le centre et la droite) ; le span se lit sur [0] et [2].
    # ── Hauteur RÉELLE des 3 mires de la rangée ──────────────────────────────
    # `_scan_facial_strip` ne renvoie que le `clip_y` où il a été appelé, et ce
    # `clip_y` vaut `clip_y_base − quadrant_offset` : ce n'est PAS la hauteur des
    # mires, seulement la position de recherche. Laisser ce y aux 3 mires faussait
    # tout ce qui dépend de la verticale — le roll sortait à −6° sur un clip droit.
    # On mesure donc leur hauteur comme celle de la 4ᵉ mire.
    for m in best_quad[:3]:
        ref = _refine_marker_2d(gray, m["x"], info["clip_y"],
                             max(quadrant_offset,
                                 int(FACIAL_ROW_PLAGE_FRAC * info["dy_raised_px"])),
                             quadrant_offset, w, h)
        if ref:
            m["x"], m["y"] = ref["x"], ref["y"]
        else:
            m["y"] = info["clip_y"]

    # ── Orientation de la prise de vue, LUE SUR le damier ──────────────────────
    # Selfie (image retournée) ou caméra arrière : c'est le clip qui le dit, par la
    # signature de ses quadrants (voir `clip_geometry.orientation_depuis_quadrants`).
    # Indispensable : sur une mesure monoculaire, se tromper de miroir inverse l'œil
    # droit et l'œil gauche. On ne se fie donc PAS au `facingMode` déclaré par le
    # client (le navigateur ne retourne pas toujours la capture, et un fichier peut
    # venir d'ailleurs) — on le MESURE. Le client sert au plus à confirmer.
    orientation_prise = _orientation_prise_de_vue(gray, best_quad, quadrant_offset, w, h)
    image_mirrored = (orientation_prise == clip.ORIENTATION_MIROIR)
    if orientation_prise != clip.ORIENTATION_INDETERMINEE and len(best_quad) == 4:
        # Cohérence avec le côté où la 4ᵉ mire a été trouvée : elle est à +30 mm du
        # centre SUR LE CLIP, donc à gauche de l'image si celle-ci est retournée.
        attendu = -1 if image_mirrored else 1
        if info.get("cote_4e") not in (None, attendu):
            log.warning("Calibration : signature du damier = %s mais 4e mire trouvée du "
                        "côté %s (attendu %s) — clip monté à l'envers, ou mire douteuse",
                        orientation_prise, info.get("cote_4e"), attendu)
    elif orientation_prise != clip.ORIENTATION_INDETERMINEE and len(best_quad) == 3:
        log.info("Calibration : prise de vue %s (lue sur la signature des damiers)",
                 "EN MIROIR" if image_mirrored else "normale")

    total_px = best_quad[2]["x"] - best_quad[0]["x"]  # span de la rangée (gauche→droite)
    avg_spacing = ((best_quad[1]["x"] - best_quad[0]["x"]) +
                   (best_quad[2]["x"] - best_quad[1]["x"])) / 2

    detected_markers = [{"x": float(m["x"]), "y": float(m["y"])} for m in best_quad]

    # ── MIROIR : refléter AVANT de vérifier la géométrie ─────────────────────
    # Si la 4ᵉ mire est du côté GAUCHE du centre sur l'image, la prise de vue est en
    # miroir (selfie iOS) — ou le clip est monté à l'envers. La géométrie du clip est
    # symétrique : refléter les abscisses autour du centre ramène le cas à celui du
    # clip « normal », et les écartements comme l'écart vertical sont conservés.
    # ⚠️ Les marqueurs PUBLIÉS restent aux positions réelles : on ne reflète que pour
    # la vérification. Sans ce traitement, un clip vu en miroir était rejeté alors que
    # sa géométrie est parfaitement valide.
    miroir = info.get("cote_4e") == -1 and len(detected_markers) == 4
    if miroir:
        x_centre_img = detected_markers[1]["x"]
        # ⚠️ Refléter ne suffit pas : la réflexion ÉCHANGE gauche et droite, alors que
        # `facial_points_from_markers` assigne les rôles PAR POSITION dans la liste.
        # Sans réordonner, « facial_gauche » recevait le point de droite (et
        # réciproquement) et les rapports invariants sortaient à 91 % d'incohérence sur
        # une géométrie pourtant parfaite (mesuré sur image synthétique). On remet donc
        # la rangée dans l'ordre [gauche, centre, droite] après réflexion.
        rangee = [{"x": 2 * x_centre_img - p["x"], "y": p["y"]}
                  for p in detected_markers[:3]]
        rangee.sort(key=lambda p: p["x"])
        h4 = detected_markers[3]
        markers_geo = rangee + [{"x": 2 * x_centre_img - h4["x"], "y": h4["y"]}]
        log.info("Calibration : prise de vue EN MIROIR (4e mire à gauche du centre) → "
                 "géométrie vérifiée après réflexion")
    else:
        markers_geo = detected_markers

    # ── A+B+C : contrôle croisé du quadrilatère ──────────────────────────────
    # A. l'échelle est prise en MÉDIANE des étalons du clip (extrême, adjacente,
    #    et les deux INCLINÉS vers la 4ᵉ mire) au lieu du seul span des extrêmes :
    #    bruit divisé, et l'échelle devient insensible à une rotation du clip ;
    # B. les rapports d'écartements, invariants d'échelle, valident le quadruplet
    #    sans rien supposer — incohérence franche ⇒ on ne prétend pas avoir le clip ;
    # C. le roll est mesuré sur une référence MÉCANIQUE (deux directions
    #    indépendantes), donc sans dépendre d'un visage détecté.
    quad_diag = clip.facial_quad_check(clip.facial_points_from_markers(markers_geo))
    if miroir:
        # Le roll est l'inclinaison du clip telle qu'elle apparaît sur l'IMAGE : la
        # réflexion inverse son signe, on le rétablit. (|roll| inchangé, et le
        # désaccord entre les deux références est un écart absolu : inchangé aussi.)
        quad_diag = dict(quad_diag)
        if quad_diag.get("roll_deg") is not None:
            quad_diag["roll_deg"] = -quad_diag["roll_deg"]

    quad_ok = (quad_diag["n_points"] == 4 and quad_diag["ratios_consistent"]
               and quad_diag["ratio_spread"] <= FACIAL_QUAD_REJECT_TOL)
    if not quad_ok:
        # DÉGRADATION GRACIEUSE, jamais l'échec — et surtout PAS `_fallback_hough`.
        # Des damiers du clip SONT visibles mais leur géométrie n'est pas celle du
        # quadruplet v19.5 : c'est le cas normal d'un clip à 3 mires faciales
        # (vérifié sur photo réelle : 3 damiers alignés, aucune mire surélevée), ou
        # d'une 4ᵉ mire mal vue. Les 3 mires de la rangée restent parfaitement
        # mesurables — l'échelle se prend alors sur le span des extrêmes (100 mm) et
        # le roll n'est pas exposé, faute de référence. Faire échouer tout le
        # calibrage reviendrait à refuser un clip parfaitement utilisable.
        # ⚠️ `_fallback_hough` est ICI le mauvais repli : il ne peut rien trouver de
        # juste sur des damiers, et il balaie l'image entière (HoughCircles sur
        # 12 Mpx : > 60 s mesurées) — cause du serveur entièrement gelé.
        ecart = quad_diag.get("ratio_spread")
        log.warning("Calibration : 4e mire NON VALIDÉE (%s) → étalons de la rangée "
                    "seuls (span des extrêmes), roll non exposé",
                    f"{ecart * 100:.1f} % d'écart sur des rapports invariants d'échelle"
                    if ecart is not None else "aucune référence hors rangée")
        quad_diag = dict(quad_diag)
        quad_diag["quad_valid"] = False
        quad_diag["roll_deg"] = None          # pas de référence fiable
        quad_diag["roll_consistent"] = None
        # Une mire non validée ne se publie pas : la laisser dans la sortie ferait
        # entrer un point FAUX dans la géométrie de l'app (vérifié : à 17 mm, la
        # 4ᵉ mire sortait à y=632 alors que la rangée est à 699).
        detected_markers = detected_markers[:3]
    else:
        quad_diag = dict(quad_diag)
        quad_diag["quad_valid"] = True

    # Échelle : médiane des étalons quand ils concordent, sinon span des extrêmes
    # (la mesure d'alors reste honnête, mais elle est signalée dans le diagnostic).
    if quad_diag["scale_consistent"] and quad_diag["scale_mm_per_px"]:
        scale = quad_diag["scale_mm_per_px"]
    else:
        scale = clip.scale_from_span(clip.FACIAL_SPACING_EXTREME_MM, total_px) \
            if total_px > 0 else 0.0
    confidence = min(1.0, sum(m["score"] for m in best_quad) / 500)

    log.info(f"Calibration DONE: markers={[(m['x'], m['y']) for m in best_quad]} "
             f"span={total_px}px (carreau {2 * quadrant_offset}px, équidistance "
             f"{info['equi'] * 100:.1f}%, 4e mire Δy={info.get('dy_raised_px', '?')}px) "
             f"spacing={avg_spacing:.0f}px scale={scale:.4f}mm/px conf={confidence:.2f}")
    if quad_diag['roll_deg'] is not None:
        log.info(f"Quadrilatère facial : étalons concordants={quad_diag['scale_consistent']} "
                 f"(dispersion {100 * (quad_diag['scale_spread'] or 0):.2f} %), rapports "
                 f"cohérents={quad_diag['ratios_consistent']}, "
                 f"roll={quad_diag['roll_deg']:.2f}° (désaccord "
                 f"{quad_diag['roll_disagreement_deg']:.2f}°)")
    else:
        log.info(f"Quadrilatère facial : 4e mire NON validée → étalons de la rangée "
                 f"seuls ; roll indisponible (dispersion des rapports "
                 f"{100 * (quad_diag['ratio_spread'] or 0):.1f} %)")

    restored_markers = reproject_points(detected_markers, inverse_rot_mat)

    return {
        "markers": [{"x": round(m["x"]), "y": round(m["y"])} for m in restored_markers],
        "scale_mm_per_px": round(scale, 6),
        "spacing_px": round(avg_spacing, 1),
        "detection_confidence": round(confidence, 3),
        "face_used": True,
        "width": w,
        "height": h,
        # A+B+C : de quoi auditer l'échelle, valider les rapports sans échelle,
        # et connaître l'inclinaison du clip sur une référence mécanique.
        "facial_quad_check": quad_diag,
        # Orientation de la prise de vue : selfie (image retournée) ou caméra arrière.
        "image_mirrored": image_mirrored,
        "orientation_prise_de_vue": orientation_prise,
    }


FALLBACK_HOUGH_MAX_SIDE = 1200  # HoughCircles coûte ~quadratique en surface : au-delà
                                # de ce côté, le repli dépasse la MINUTE et gèle la
                                # boucle d'événements (donc /health aussi).


def _fallback_hough(gray: np.ndarray, h: int, w: int) -> dict:
    """Fallback : HoughCircles sur toute l'image sans guidance faciale.

    ⚠️ Traite une image RÉDUITE dès que la photo est grande. Mesuré : 3 s sur
    0,76 Mpx mais **> 60 s sur 4032×3024** (photo iPad) — et comme ce calcul est
    synchrone dans l'event loop, il bloque TOUT le serveur (`/health` compris).
    À 1200 px de côté le même travail prend une fraction de seconde, et les
    cercles cherchés (r = 1,2 % à 6 % du petit côté) restent très au-dessus du
    bruit de sous-échantillonnage. Les coordonnées sont remises à l'échelle de
    l'image d'origine avant de sortir : les appelants ne voient aucune différence.
    """
    cote = max(w, h)
    echelle = 1.0
    if cote > FALLBACK_HOUGH_MAX_SIDE:
        echelle = FALLBACK_HOUGH_MAX_SIDE / float(cote)
        gray = cv2.resize(gray,
                          (max(1, int(round(w * echelle))), max(1, int(round(h * echelle)))),
                          interpolation=cv2.INTER_AREA)
        h, w = gray.shape[:2]
    px = lambda v: max(1, int(round(v * echelle)))  # seuil d'origine → taille réduite

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
            if abs(c["x"] - m["x"]) < px(20) and abs(c["y"] - m["y"]) < px(20):
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
                if y_dev > px(40): continue
                if not (a["x"] < b["x"] < c["x"]): continue
                d1, d2 = b["x"] - a["x"], c["x"] - b["x"]
                if d1 < px(15) or d2 < px(15): continue
                if max(d1, d2) / max(1, min(d1, d2)) > 1.8: continue
                spacing_score = 100 * min(d1, d2) / max(1, max(d1, d2))
                y_score = max(0, px(40) - y_dev) * 2
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
    scale = (CALIB_MARKER_SPAN_MM) / total_px if total_px > 0 else 0
    confidence = min(1.0, best_score / 500)

    # Remise à l'échelle de l'IMAGE D'ORIGINE (le calcul a été fait sur la réduite) :
    # positions et distances en px sont DIVISÉES par `echelle`, tandis que l'échelle
    # mm/px (un rapport mm par pixel) est MULTIPLIÉE. Sans ce retour, une photo
    # réduite de moitié donnerait des mires à demi-coordonnées — donc deux fois trop
    # petites, et un mm/px deux fois trop grand.
    return {
        "markers": [{"x": int(round(p["x"] / echelle)), "y": int(round(p["y"] / echelle))}
                    for p in best_triple],
        "scale_mm_per_px": round(scale * echelle, 6),
        "spacing_px": round(avg_spacing / echelle, 1),
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
                scale = (CALIB_MARKER_SPAN_MM) / total_px if total_px > 0 else 0
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

    # Hors de la boucle d'événements : cette analyse peut durer plusieurs secondes
    # et, exécutée ici, gelait TOUT le serveur (cf. ANALYSIS_LOCK).
    result = await run_in_threadpool(_heavy, detect_calibration_markers, img)

    return CalibrationResult(
        width=w, height=h,
        markers=result["markers"],
        scale_mm_per_px=result["scale_mm_per_px"],
        spacing_px=result["spacing_px"],
        detection_confidence=result["detection_confidence"],
        face_used=result["face_used"],
        facial_quad_check=result.get("facial_quad_check"),
        image_mirrored=result.get("image_mirrored", False),
        orientation_prise_de_vue=result.get("orientation_prise_de_vue"),
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
    result = await run_in_threadpool(_heavy, landmarker.detect, mp_img)

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
    markers_px, lateral_diag = await run_in_threadpool(
        _heavy, _detect_lateral,
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
    vertex = await run_in_threadpool(_heavy, estimate_vertex_distance, img, markers_px, scale)

    # 5. Détection faciale
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_result = await run_in_threadpool(_heavy, landmarker.detect, mp_img)
    face_detected = bool(face_result.face_landmarks)

    log.info(f"Profil: scale={scale:.4f} mm/px, angle_pantoscopique={pantoscopic}°, vertex={vertex}mm, face={face_detected}")

    # Construire le diagnostic latéral complet (rôles + chemin + candidats + ROI)
    ld = lateral_diag
    lateral_diag_out = {
        "path": getattr(ld, "path", None),
        "roi_used": getattr(ld, "roi_used", None),
        "spacing_mm_detected": getattr(ld, "spacing_mm_detected", None),
        "n_candidates": getattr(ld, "n_candidates", 0),
        "candidates": getattr(ld, "candidates", []),
        "pair_is_metrological": getattr(ld, "pair_is_metrological", None),
        "pair_roles": getattr(ld, "pair_roles", None),
        "raised_rejected": getattr(ld, "raised_rejected", False),
        "trap_spacing_rejected": getattr(ld, "trap_spacing_rejected", False),
        "triangle_isoceles": getattr(ld, "triangle_isoceles", False),
    }

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
        lateral_diag=lateral_diag_out,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
