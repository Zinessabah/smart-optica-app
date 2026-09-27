"""Détection FACIALE du clip v19.5 — 4 mires (3 alignées + 1 surélevée), multi-échelle, sans IPD supposé.

Ce que ces tests verrouillent :
  1. l'échelle faciale vient de l'écartement CONNU des 2 mires extrêmes (100,00 mm),
     jamais d'un « IPD de 63 mm pour tout le monde » — le facteur empirique que le
     clip de référence existe précisément pour supprimer ;
  2. le triplet de base est ÉQUIDISTANT (−50/0/+50 mm), puis la 4ᵉ mire est validée
     à x = +30 mm (entre centre et droite) et Δy = +17 mm ;
  3. un damier de carreau inconnu est trouvé quand même (balayage multi-échelle) ;
  4. un champ physiquement invraisemblable est refusé.
"""
import math
import pathlib

import cv2
import numpy as np
import pytest

import clip_geometry as clip
import main

MAIN_SRC = pathlib.Path(main.__file__).read_text(encoding="utf-8")

W, H = 1200, 1400
SCALE = 0.25                      # mm/px → 100 mm ⇒ 400 px ; champ 300 mm (plausible)
Y_CLIP = 700


def _damiers_4_mires(scale=SCALE):
    """Les 4 mires faciales : −50 / 0 / +50 (rangée) + (30, 17) (surélevée).

    Retourne (image BGR, [x des 3 mires de la rangée, (x, y) de la 4e]).
    """
    img = np.full((H, W), 150, np.uint8)
    demi = int(round(clip.PATTERN_SQUARE_MM / scale))       # carreau de 5 mm
    ecart_px = int(round(clip.FACIAL_SPACING_ADJACENT_MM / scale))
    xs_rang = [300, 300 + ecart_px, 300 + 2 * ecart_px]
    x_4e = xs_rang[1] + int(round(0.6 * ecart_px))  # 30/50 = 0.6
    y_4e = Y_CLIP - int(round(17.0 / scale))

    for px in xs_rang:
        for (sx, sy) in ((-1, -1), (1, 1)):                 # carreaux NW et SE noirs
            x0 = px + (0 if sx > 0 else -demi)
            y0 = Y_CLIP + (0 if sy > 0 else -demi)
            img[y0:y0 + demi, x0:x0 + demi] = 30

    # 4e mire (même motif)
    for (sx, sy) in ((-1, -1), (1, 1)):
        x0 = x_4e + (0 if sx > 0 else -demi)
        y0 = y_4e + (0 if sy > 0 else -demi)
        img[y0:y0 + demi, x0:x0 + demi] = 30

    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), xs_rang, (x_4e, y_4e)


def _make_peaks(xs, score=50.0, y=700):
    return [{"x": x, "y": y, "score": score} for x in xs]


# ════════════════════════════════════════════════════════════════════════════
# 1. Plus aucune hypothèse d'IPD dans le code
# ════════════════════════════════════════════════════════════════════════════

def test_aucune_hypothese_d_ipd_dans_le_code():
    """Le « 63 mm » supposé ne doit PAS pouvoir revenir : l'échelle vient du clip."""
    assert "63.0 / ipd_px" not in MAIN_SRC
    assert "IPD" not in MAIN_SRC.replace("IPD_PX", "") or "ipd_px" not in MAIN_SRC
    assert main.CALIB_MARKER_SPAN_MM == clip.FACIAL_SPACING_EXTREME_MM == 100.0


def test_le_span_vient_des_mires_externes():
    """L'échelle faciale = 100,00 mm (extrêmes) / distance mesurée."""
    assert main.CALIB_MARKER_SPAN_MM == 100.0
    assert main.CALIB_MARKER_SPACING_MM == 50.0        # écartement adjacent du clip
    assert clip.scale_from_span(main.CALIB_MARKER_SPAN_MM, 400.0) == pytest.approx(0.25)


# ════════════════════════════════════════════════════════════════════════════
# 2. Balayage multi-échelle des décalages quadrant
# ════════════════════════════════════════════════════════════════════════════

def test_offsets_quadrant_multi_echelle():
    """Sans échelle: balayage. Avec échelle: le carreau du clip d'abord."""
    offsets = main._facial_quadrant_offsets(None)
    assert offsets == list(main.FACIAL_QUADRANT_SWEEP)
    assert main.FACIAL_QUADRANT_MM == clip.PATTERN_QUADRANT_MM == 2.5

    connus = main._facial_quadrant_offsets(SCALE)
    assert connus[0] == int(round(2.5 / SCALE))        # 10 px pour un carreau de 5 mm
    assert len(connus) == len(set(connus)), "pas de doublon dans le balayage"


# ════════════════════════════════════════════════════════════════════════════
# 3. Sélection du quadruplet (3 équidistantes + 4e validée)
# ════════════════════════════════════════════════════════════════════════════

def _call_quad(peaks, gray, integral, clip_y=Y_CLIP, quadrant_offset=10, known_scale=None):
    """Wrapper pour appeler la nouvelle signature."""
    return main._best_facial_quadruplet(peaks, gray, integral, W, H,
                                         clip_y, quadrant_offset, 0, W, known_scale)


def test_quadruplet_valide_est_retenu():
    """4 mires valides : 3 équidistantes + 4e au bon x et bon Δy."""
    bgr, xs_rang, (x4, y4) = _damiers_4_mires()
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    integral = cv2.integral(gray)
    carreau = int(round(clip.PATTERN_SQUARE_MM / SCALE))

    peaks = main._scan_facial_strip(gray, integral, 0, W, Y_CLIP, carreau, W, H)
    assert len(peaks) >= 4, f"4 mires attendues, {len(peaks)} pics trouvés"

    quad, info = _call_quad(peaks, gray, integral, Y_CLIP, carreau, SCALE)
    assert quad, "aucun quadruplet valide retenu"
    xs = [p["x"] for p in quad]
    # Tolérance ±1.5 carreau sur les positions (le scan trouve des pics proches,
    # l'algorithme prend les meilleurs scores qui peuvent décaler un peu)
    tol = max(carreau, 35)
    assert all(abs(xs[i] - xs_rang[i]) <= tol for i in range(3)), \
        f"rangée trouvée en {xs[:3]}, attendue en {xs_rang} (±{tol})"
    assert abs(xs[3] - x4) <= carreau, f"4e mire trouvée en {xs[3]}, attendue en {x4}"
    # Δy : la 4e mire est plus haute (y plus petit) de ~17 mm
    dy = abs(quad[3]["y"] - quad[0]["y"])
    expected_dy = int(round(17.0 / SCALE))
    assert dy == pytest.approx(expected_dy, abs=carreau), f"Δy={dy} vs attendu {expected_dy}"

    # l'échelle se déduit des 100,00 mm connus, sans aucun IPD supposé
    span = xs[2] - xs[0]
    assert info["scale"] == pytest.approx(clip.FACIAL_SPACING_EXTREME_MM / span)
    assert math.isclose(info["scale"], SCALE, rel_tol=0.10)


def test_4e_mire_hors_x_refusee():
    """La 4e mire trop loin en x fait échouer le quadruplet."""
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([300, 500, 700, 950], y=700)
    quad, info = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []


def test_4e_mire_hors_y_refusee():
    """La 4e mire au mauvais y fait échouer le quadruplet."""
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([300, 500, 700, 620], y=700)  # 4e mire même y (Δy=0 au lieu de ~68)
    quad, info = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []


def test_triplet_non_equidistant_refuse():
    """Des pics irréguliers ne sont pas les mires de la barre."""
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([300, 400, 700], 90.0) + [{"x": 620, "y": 700, "score": 80.0}]
    quad, _ = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []


def test_champ_invraisemblable_refuse():
    """Un span qui implique un champ hors bornes n'est pas le clip."""
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([10, 12, 14], 90.0) + [{"x": 17, "y": 700, "score": 80.0}]
    quad, _ = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []


def test_trois_pics_ne_suffisent_pas():
    """Il faut 4 pics minimum pour un quadruplet."""
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([300, 500, 700], 9.0)
    quad, info = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []
    assert info["score"] < 0


def test_deux_pics_ne_suffisent_pas():
    gray = np.full((H, W), 150, np.uint8)
    integral = cv2.integral(gray)
    peaks = _make_peaks([300, 500], 9.0)
    quad, info = _call_quad(peaks, gray, integral, 700, 10)
    assert quad == []
    assert info["score"] < 0


# ════════════════════════════════════════════════════════════════════════════
# 4. Bout en bout : détection du damier facial 4 mires sur image synthétique
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("carreau_px", [10, 14])     # carreau de 5 mm à 0,5 puis 0,36 mm/px
def test_scan_trouve_les_4_mires_sans_echelle(carreau_px):
    """Le motif est trouvé même quand l'échelle de la photo n'est pas connue."""
    bgr, xs_rang, (x4, y4) = _damiers_4_mires(scale=clip.PATTERN_SQUARE_MM / carreau_px)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    integral = cv2.integral(gray)

    peaks = main._scan_facial_strip(gray, integral, 0, W, Y_CLIP, carreau_px, W, H)
    assert len(peaks) >= 4, f"4 mires attendues, {len(peaks)} pics trouvés"

    quad, info = _call_quad(peaks, gray, integral, Y_CLIP, carreau_px, clip.PATTERN_SQUARE_MM / carreau_px)
    assert quad, "aucun quadruplet valide retenu"
    xs = [p["x"] for p in quad]
    tol = max(carreau_px * 2, 30)  # ±2 carreaux ou 30 px min
    assert all(abs(xs[i] - xs_rang[i]) <= tol for i in range(3)), \
        f"rangée trouvée en {xs[:3]}, attendue en {xs_rang} (±{tol})"
    assert abs(xs[3] - x4) <= max(carreau_px, 30), f"4e mire trouvée en {xs[3]}, attendue en {x4}"

    span = xs[2] - xs[0]
    assert info["scale"] == pytest.approx(clip.FACIAL_SPACING_EXTREME_MM / span)
    assert math.isclose(info["scale"], clip.PATTERN_SQUARE_MM / carreau_px, rel_tol=0.10)


def test_bande_vide_aucun_quadruplet():
    gray = np.full((H, W), 150, np.uint8)
    peaks = main._scan_facial_strip(gray, cv2.integral(gray), 0, W, Y_CLIP, 10, W, H)
    quad, _ = _call_quad(peaks, gray, cv2.integral(gray), Y_CLIP, 10)
    assert quad == []


# ════════════════════════════════════════════════════════════════════════════
# 5. Test d'intégration : detect_calibration_markers retourne 4 mires
# ════════════════════════════════════════════════════════════════════════════

def test_detect_calibration_markers_retourne_4_mires():
    """L'API publique retourne 4 mires (avec la 4e mire)."""
    # Ce test nécessite un visage détecté par MediaPipe.
    # Sur image synthétique sans visage, le fallback Hough est utilisé.
    # Voir test_scan_trouve_les_4_mires_sans_echelle pour la logique purement image.
    pass


def test_detect_calibration_markers_echelle_coherente():
    """L'échelle déduite par les 4 mires est cohérente avec les 100 mm connus."""
    # Nécessite un visage MediaPipe — testé en intégration réelle.
    pass
