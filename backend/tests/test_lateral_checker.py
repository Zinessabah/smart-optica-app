"""Détection latérale du clip v15 (mires DAMIER unifiées) — variante « choix B ».

La v15 porte le même motif damier 2×2 (carreaux de 5 mm) sur les 10 mires.
`lateral.py` cherchant des disques Ø4 en chemin principal, il lit un damier
comme des disques : mauvais modèle, et il se trompe sur la position.

Ces tests SYNTHÉTISENT l'image du clip (aucune photo externe nécessaire) à une
échelle connue, et vérifient :
  1. la variante B trouve la paire, au bon endroit (erreur < 0,5 mm) ;
  2. elle étiquette bien le chemin « checkerboard » ;
  3. le décalage quadrant suit le carreau de 5 mm (±2,5 mm) ;
  4. `lateral.py` d'origine, lui, étiquette « dark_circles » (le défaut à corriger) ;
  5. un fond vide ne produit AUCUNE fausse mire.
"""
import math

import cv2
import numpy as np

import lateral as lateral_orig
from lateral_checker import (
    LATERAL_CHECKER_QUADRANT_MM,
    LATERAL_CHECKER_SQUARE_MM,
    checker_quadrant_offsets,
    detect_lateral_markers,
    select_metrological_pair,
)
import clip_geometry as clip

SCALE = 0.25          # mm/px → champ de ~350 mm (dans les bornes 150-1000)
W, H = 1200, 1400


def _damier(img, px, py, half, dark=30):
    """Peint un damier 2×2 (carreaux NW + SE noirs) centré sur (px, py)."""
    for (sx, sy) in ((-1, -1), (1, 1)):
        x0 = px + (0 if sx > 0 else -half)
        y0 = py + (0 if sy > 0 else -half)
        img[y0:y0 + half, x0:x0 + half] = dark


def _scene_laterale_v195(scale=SCALE, dark=30, bg=150):
    """Le VRAI triangle latéral du v19.5, à l'échelle `scale`.

    Les 3 mires d'un côté : deux BASSES à 25,00 mm l'une de l'autre, plus la
    SURÉLEVÉE à 20,3039 mm de chacune (décalée de 12,5 mm en profondeur et de
    16 mm en hauteur — cotes du clip).

    Dans une photo de profil : la profondeur du clip (y) va le long de l'axe
    horizontal de l'image, la hauteur (z) vers le haut.

    Retourne (image BGR, proche, eloignee, surelevee) en pixels.
    """
    img = np.full((H, W), bg, np.uint8)
    half = int(round(LATERAL_CHECKER_SQUARE_MM / scale))
    px_mm = 25.0 / scale          # 25 mm → px
    dx_mm = 12.5 / scale          # 12,5 mm → px (demi-écartement en profondeur)
    dz_mm = 16.0 / scale          # 16 mm → px (hauteur de la surélevée)

    proche = (int(0.72 * W), int(0.32 * H))
    eloignee = (proche[0] - int(round(px_mm)), proche[1])
    surelevee = (proche[0] - int(round(dx_mm)), proche[1] - int(round(dz_mm)))  # vers le HAUT

    for centre in (proche, eloignee, surelevee):
        _damier(img, centre[0], centre[1], half, dark)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), proche, eloignee, surelevee


def _cand(x, y, score=100.0):
    return {"x": int(x), "y": int(y), "score": score}


def _scene(scale=SCALE, square_mm=LATERAL_CHECKER_SQUARE_MM, spacing_mm=25.0,
           dark=30, bg=150):
    """Image synthétique : 2 damiers 2×2 (carreaux NW+SE noirs) à spacing_mm.

    Retourne (image BGR, centre vrai A, centre vrai B).
    """
    img = np.full((H, W), bg, np.uint8)
    half = int(round(square_mm / scale))
    d_px = spacing_mm / scale
    cx = int(0.72 * W)
    y_a = int(0.25 * H)
    y_b = int(y_a + d_px)
    for (px, py) in ((cx, y_a), (cx, y_b)):
        _damier(img, px, py, half, dark)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), (cx, y_a), (cx, y_b)


class TestDamierV15:
    """La variante B doit lire le damier du clip v15."""

    def test_trouve_les_2_mires_a_25mm(self):
        bgr, a, b = _scene()
        markers, diag = detect_lateral_markers(bgr, known_scale=SCALE)
        assert diag.path == "checkerboard"
        assert len(markers) == 2
        assert diag.spacing_mm_detected == 25.0
        for truth in (a, b):
            err_px = min(math.hypot(m[0] - truth[0], m[1] - truth[1])
                         for m in markers)
            assert err_px * SCALE < 0.5, f"erreur {err_px * SCALE:.2f} mm"

    def test_quadrant_suit_le_carreau_de_5mm(self):
        """Les 4 quadrants doivent être échantillonnés à ±2,5 mm (centre du carreau)."""
        assert LATERAL_CHECKER_QUADRANT_MM == 2.5
        assert checker_quadrant_offsets(SCALE)[0] == round(2.5 / SCALE)

    def test_espacement_derive_de_la_mesure(self):
        """Sans échelle fournie : balayage multi-échelle, pas de plantage."""
        bgr, _, _ = _scene()
        markers, diag = detect_lateral_markers(bgr)   # known_scale=None
        assert diag.path == "checkerboard"
        assert len(markers) == 2


class TestAncienComportement:
    """Documente le défaut que le choix B corrige (non-régression du constat)."""

    def test_lateral_py_origine_lit_le_damier_comme_des_disques(self):
        bgr, a, _ = _scene()
        markers, diag = lateral_orig.detect_lateral_markers(bgr, known_scale=SCALE)
        assert diag.path == "dark_circles", (
            "lateral.py d'origine est censé se tromper de modèle sur un clip damier")
        # …et se trompe de position (mesuré ~3,9 mm contre 0,0 mm pour la variante B)
        err_px = min(math.hypot(m[0] - a[0], m[1] - a[1]) for m in markers)
        assert err_px * SCALE > 1.0


class TestRejets:
    def test_fond_vide_aucune_mire(self):
        blank = np.full((H, W, 3), 140, np.uint8)
        markers, diag = detect_lateral_markers(blank, known_scale=SCALE)
        assert markers == []
        assert diag.path is None
        assert diag.spacing_mm_detected is None


class TestPairageMetrologique:
    """Le clip v19.5 a 3 mires latérales par côté : le pairage ne doit jamais se tromper.

    Deux basses à 25,00 mm (métrologiques) + une surélevée à 20,3039 mm de chacune.
    Apparier la surélevée donne 19 % d'erreur d'échelle — et autant sur le vertex.
    """

    def test_triangle_reel_apparie_les_deux_basses(self):
        """Triangle exact du clip → la paire = les 2 basses, jamais la surélevée."""
        s = 0.25
        proche = _cand(864, 450)
        eloignee = _cand(864 - 25.0 / s, 450)                 # 100 px → 25,00 mm
        surelevee = _cand(864 - 12.5 / s, 450 - 16.0 / s)     # 20,3039 mm de chacune

        paire, info = select_metrological_pair([proche, eloignee, surelevee], s)

        assert paire is not None
        assert info["isoceles"] is True, "pairage attendu par le triangle isocèle"
        assert info["raised_rejected"] is True
        assert info["spacing_mm"] == clip.LATERAL_SPACING_MM
        assert surelevee not in paire
        assert {id(p) for p in paire} == {id(proche), id(eloignee)}

    def test_triangle_reel_sans_echelle(self):
        """Le critère isocèle doit marcher AVANT de connaître les mm/px."""
        proche = _cand(864, 450)
        eloignee = _cand(764, 450)
        surelevee = _cand(814, 386)          # 50 px en x, 64 px en haut
        paire, info = select_metrological_pair([proche, eloignee, surelevee], None)
        assert paire is not None
        assert info["isoceles"] is True
        assert surelevee not in paire

    def test_surelevee_seule_est_REFUSEE(self):
        """Seulement (basse, surélevée) : 20,30 mm → refus, aucune mesure inventée."""
        s = 0.25
        basse = _cand(800, 400)
        surelevee = _cand(800 - 12.5 / s, 400 - 16.0 / s)
        paire, info = select_metrological_pair([basse, surelevee], s)
        assert paire is None
        assert info["trap_rejected"] is True, "le piège doit être reconnu et signalé"

    def test_paire_25mm_avec_echelle_acceptee(self):
        s = 0.25
        paire, info = select_metrological_pair([_cand(800, 400), _cand(700, 400)], s)
        assert paire is not None
        assert info["spacing_mm"] == clip.LATERAL_SPACING_MM
        assert info["pair_is_metrological"] is True

    def test_espacement_inconnu_du_clip_refuse(self):
        """10 mm à l'échelle fournie n'est AUCUN écartement du clip → refus explicite."""
        s = 0.25
        paire, info = select_metrological_pair([_cand(800, 400), _cand(840, 400)], s)
        assert paire is None

    def test_triangle_quelconque_ne_paire_pas_au_hasard(self):
        """Un triangle franchement scalène n'est pas le clip → pas de pairage isocèle.

        Sans échelle ni triangle conforme, on retombe sur « le côté le plus long »
        (jamais sur un appariement inventé), et la plausibilité du champ reste à
        vérifier par l'appelant.
        """
        c1, c2, c3 = _cand(400, 400), _cand(700, 400), _cand(450, 470)
        paire, info = select_metrological_pair([c1, c2, c3], None)
        assert info["isoceles"] is False
        assert paire is not None
        assert {id(p) for p in paire} == {id(c1), id(c2)}   # les 300 px, sans ambiguïté


class TestSceneLateraleComplete:
    """Bout en bout sur une image synthétique du VRAI triangle latéral."""

    def test_detecte_la_paire_des_deux_basses(self):
        bgr, proche, eloignee, surelevee = _scene_laterale_v195()
        markers, diag = detect_lateral_markers(bgr, known_scale=SCALE)

        assert diag.path == "checkerboard"
        assert len(markers) == 2
        assert diag.spacing_mm_detected == clip.LATERAL_SPACING_MM
        assert diag.raised_rejected is True, "la mire surélevée doit être écartée du pairage"

        # les 2 mires rendues sont les BASSES, à moins de 1 mm de leur position vraie
        for truth in (proche, eloignee):
            err_px = min(math.hypot(m[0] - truth[0], m[1] - truth[1]) for m in markers)
            assert err_px * SCALE < 1.0, f"erreur {err_px * SCALE:.2f} mm"
        # …et AUCUNE ne tombe sur la surélevée
        for m in markers:
            assert math.hypot(m[0] - surelevee[0], m[1] - surelevee[1]) * SCALE > 3.0
