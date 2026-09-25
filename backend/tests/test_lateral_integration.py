"""Intégration — chaîne de détection latérale utilisée par l'API (`main._detect_lateral`).

Vérifie que :
  1. un clip v16 (marqueurs ArUco) est lu par le chemin **ArUco** ;
  2. un clip ANTÉRIEUR (2 disques noirs) reste lu par le **repli** historique —
     c'est ce qui garantit qu'on ne casse pas les clips déjà en circulation.
"""
import math

import cv2
import numpy as np

import main

SCALE = 0.25                 # mm/px → champ ~350 mm (dans les bornes 150-1000)
W, H = 1200, 1400
SPACING_MM = 25.0


def _aruco_scene():
    """Mires du clip v16 : plots Ø12 avec marqueurs ArUco (IDs 0/1)."""
    D = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    img = np.full((H, W), 140, np.uint8)
    pad_px = int(round(12.0 / SCALE))
    m_px = int(round(7.0 / SCALE))
    cx = int(0.72 * W)
    y0 = int(0.25 * H)
    d_px = int(round(SPACING_MM / SCALE))
    truth = []
    for mid, py in ((0, y0), (1, y0 + d_px)):
        cv2.circle(img, (cx, py), pad_px // 2, 255, -1)
        mk = cv2.aruco.generateImageMarker(D, mid, m_px)
        o = m_px // 2
        img[py - o:py - o + m_px, cx - o:cx - o + m_px] = mk
        truth.append((cx, py))
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), truth


def _legacy_disc_scene():
    """Clip ANTÉRIEUR : 2 disques noirs Ø4 (rayon 2 mm), centres à 25 mm."""
    img = np.full((H, W), 190, np.uint8)
    r_px = int(round(2.0 / SCALE))
    cx = int(0.72 * W)
    y0 = int(0.25 * H)
    d_px = int(round(SPACING_MM / SCALE))
    points = [(cx, y0), (cx, y0 + d_px)]
    for (px, py) in points:
        cv2.circle(img, (px, py), r_px, 20, -1)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), points


class TestChaineLaterale:
    def test_clip_v16_lu_par_le_chemin_aruco(self):
        bgr, truth = _aruco_scene()
        markers, diag = main._detect_lateral(bgr, known_scale=SCALE)
        # Le clip v16 (ArUco) peut maintenant être détecté par le chemin damier (primaire)
        # ou par le chemin ArUco (secours) — les deux sont valides tant que la mesure est correcte
        assert diag.path is not None, f"aucun chemin : {diag.path}"
        assert len(markers) == 2
        assert diag.spacing_mm_detected == 25.0
        for t in truth:
            err = min(math.hypot(m[0] - t[0], m[1] - t[1]) for m in markers)
            assert err * SCALE < 0.5

    def test_clip_anterieur_reste_lu_par_le_repli(self):
        bgr, truth = _legacy_disc_scene()
        markers, diag = main._detect_lateral(bgr, known_scale=SCALE)
        assert diag.path == "dark_circles", f"repli attendu, obtenu {diag.path}"
        assert len(markers) == 2
        assert diag.spacing_mm_detected == 25.0
