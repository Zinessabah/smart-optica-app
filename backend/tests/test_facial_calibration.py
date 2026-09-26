"""Détection FACIALE du clip v19.5 — multi-échelle et sans hypothèse d'IPD.

Ce que ces tests verrouillent :
  1. l'échelle faciale vient de l'écartement CONNU des 2 mires extrêmes (100,00 mm),
     jamais d'un « IPD de 63 mm pour tout le monde » — le facteur empirique que le
     clip de référence existe précisément pour supprimer ;
  2. le triplet retenu est celui des 3 mires ÉQUIDISTANTES de la barre (−50/0/+50 mm),
     critère intrinsèque du clip, donc indépendant des mm/px ;
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


def _damiers_equidistants(scale=SCALE, decalage=100.0):
    """Les 3 mires de la barre : −50 / 0 / +50 mm (donc équidistantes).

    Retourne (image BGR, [x des 3 centres]).
    """
    img = np.full((H, W), 150, np.uint8)
    demi = int(round(clip.PATTERN_SQUARE_MM / scale))       # carreau de 5 mm
    ecart_px = int(round(clip.FACIAL_SPACING_ADJACENT_MM / scale))
    xs = [300, 300 + ecart_px, 300 + 2 * ecart_px]
    for px in xs:
        for (sx, sy) in ((-1, -1), (1, 1)):                 # carreaux NW et SE noirs
            x0 = px + (0 if sx > 0 else -demi)
            y0 = Y_CLIP + (0 if sy > 0 else -demi)
            img[y0:y0 + demi, x0:x0 + demi] = 30
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), xs


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
# 3. Sélection du triplet équidistant
# ════════════════════════════════════════════════════════════════════════════

def test_triplet_equidistant_est_retenu():
    peaks = [{"x": 300, "score": 50.0}, {"x": 500, "score": 60.0},
             {"x": 700, "score": 55.0}]
    triplet, info = main._best_facial_triplet(peaks, W, H)
    assert [p["x"] for p in triplet] == [300, 500, 700]
    assert info["equi"] == pytest.approx(0.0, abs=1e-9)
    # span 400 px pour 100,00 mm connus → 0,25 mm/px
    assert info["scale"] == pytest.approx(main.CALIB_MARKER_SPAN_MM / 400.0)


def test_triplet_non_equidistant_refuse():
    """Des pics irréguliers ne sont pas les mires de la barre."""
    peaks = [{"x": 300, "score": 90.0}, {"x": 400, "score": 90.0},
             {"x": 700, "score": 90.0}]                 # 100 px puis 300 px
    triplet, _ = main._best_facial_triplet(peaks, W, H)
    assert triplet == []


def test_champ_invraisemblable_refuse():
    """Un span qui implique un champ hors bornes n'est pas le clip."""
    peaks = [{"x": 10, "score": 90.0}, {"x": 12, "score": 90.0}, {"x": 14, "score": 90.0}]
    triplet, _ = main._best_facial_triplet(peaks, W, H)
    assert triplet == []


def test_deux_pics_ne_suffisent_pas():
    triplet, info = main._best_facial_triplet([{"x": 300, "score": 9.0},
                                               {"x": 500, "score": 9.0}], W, H)
    assert triplet == []
    assert info["score"] < 0


# ════════════════════════════════════════════════════════════════════════════
# 4. Bout en bout : détection du damier facial sur une image synthétique
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("carreau_px", [10, 14])     # carreau de 5 mm à 0,5 puis 0,36 mm/px
def test_scan_trouve_les_3_mires_sans_echelle(carreau_px):
    """Le motif est trouvé même quand l'échelle de la photo n'est pas connue."""
    bgr, xs = _damiers_equidistants(scale=clip.PATTERN_SQUARE_MM / carreau_px)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    integral = cv2.integral(gray)

    peaks = main._scan_facial_strip(gray, integral, 0, W, Y_CLIP, carreau_px, W, H)
    assert len(peaks) >= 3, f"3 mires attendues, {len(peaks)} pics trouvés"

    triplet, info = main._best_facial_triplet(peaks, W, H)
    assert triplet, "aucun triplet équidistant retenu"
    for obtenu, attendu in zip([p["x"] for p in triplet], xs):
        assert abs(obtenu - attendu) <= carreau_px, \
            f"mire trouvée en {obtenu}, attendue en {attendu}"

    # l'échelle se déduit des 100,00 mm connus, sans aucun IPD supposé
    span = triplet[2]["x"] - triplet[0]["x"]
    assert info["scale"] == pytest.approx(clip.FACIAL_SPACING_EXTREME_MM / span)
    assert math.isclose(info["scale"], clip.PATTERN_SQUARE_MM / carreau_px, rel_tol=0.10)


def test_bande_vide_aucun_triplet():
    gray = np.full((H, W), 150, np.uint8)
    peaks = main._scan_facial_strip(gray, cv2.integral(gray), 0, W, Y_CLIP, 10, W, H)
    triplet, _ = main._best_facial_triplet(peaks, W, H)
    assert triplet == []
