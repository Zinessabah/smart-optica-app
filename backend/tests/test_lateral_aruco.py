"""Détection latérale ArUco 4×4 (clip v16) — tests sur image synthétique.

On synthétise les mires latérales du clip v16 (plots Ø12 blancs portant un
marqueur ArUco 4×4, IDs 0/1/2) à une échelle connue, puis on vérifie :
  1. la paire métrologique (IDs 0 et 1) est trouvée à 25 mm ;
  2. la position est précise (coins sub-pixel) ;
  3. un fond vide ne produit rien ;
  4. un marqueur MIROITÉ est refusé (chiralité) — le piège du bras gauche.
"""
import math

import cv2
import numpy as np

from lateral_aruco import detect_lateral_markers, LATERAL_ARUCO_MARKER_MM

DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
SCALE = 0.25                    # mm/px
W, H = 1200, 1400
SPACING_MM = 25.0


def _scene(scale=SCALE, marker_mm=LATERAL_ARUCO_MARKER_MM, spacing_mm=SPACING_MM,
           mirror_ids=False, bg=140):
    """3 plots Ø12 (mires proche/surélevée/éloignée) portant les ArUco 0/1/2."""
    img = np.full((H, W), bg, np.uint8)
    pad_px = 12.0 / scale
    m_px = int(round(marker_mm / scale))
    cx = int(0.72 * W)
    y0 = int(0.20 * H)
    d = spacing_mm / scale
    # (id, y) — comme le clip : proche, surélevée (entre les deux), éloignée
    layout = [(0, y0), (2, int(round(y0 + d / 2))), (1, int(round(y0 + d)))]
    truth = {}
    for mid, py in layout:
        px = cx
        cv2.circle(img, (px, py), int(round(pad_px / 2)), 255, -1)
        mk = cv2.aruco.generateImageMarker(DICT, mid, m_px)
        if mirror_ids:
            mk = cv2.flip(mk, 1)
        o = m_px // 2
        img[py - o:py - o + m_px, px - o:px - o + m_px] = mk
        truth[mid] = (px, py)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), truth


class TestArUcoV16:
    def test_trouve_la_paire_metrologique_a_25mm(self):
        bgr, truth = _scene()
        markers, diag = detect_lateral_markers(bgr, known_scale=SCALE)
        assert diag.path == "aruco_4x4"
        assert len(markers) == 2
        assert diag.spacing_mm_detected == 25.0
        for truth_pt in (truth[0], truth[1]):
            err_px = min(math.hypot(m[0] - truth_pt[0], m[1] - truth_pt[1])
                         for m in markers)
            assert err_px * SCALE < 0.5, f"erreur {err_px * SCALE:.2f} mm"

    def test_precision_meilleure_que_le_damier(self):
        """Les coins sub-pixel doivent donner une erreur < 0,5 mm."""
        bgr, truth = _scene()
        markers, _ = detect_lateral_markers(bgr, known_scale=SCALE)
        errs = [min(math.hypot(m[0] - t[0], m[1] - t[1]) for m in markers) * SCALE
                for t in (truth[0], truth[1])]
        assert max(errs) < 0.5

    def test_fond_vide_aucun_marqueur(self):
        blank = np.full((H, W, 3), 140, np.uint8)
        markers, diag = detect_lateral_markers(blank, known_scale=SCALE)
        assert markers == []
        assert diag.path is None


class TestChiralite:
    """Un marqueur miroité ne décode pas : c'est pourquoi le clip tourne le motif."""

    def test_marqueur_miroite_non_detecte(self):
        bgr, _ = _scene(mirror_ids=True)
        markers, diag = detect_lateral_markers(bgr, known_scale=SCALE)
        assert markers == [], "un marqueur mirroité ne doit PAS décoder"
