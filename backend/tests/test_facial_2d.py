"""Tests du détecteur 2D des mires faciales.

Deux niveaux :
- un test unitaire qui colle un gabarit connu dans une image vierge et vérifie
  qu'il est retrouvé à la bonne position, à la bonne échelle et au bon angle ;
- un test de non-régression sur la photo réelle de référence, dont les trois
  mires sont connues (mesurées le 24/10) et où les deux pics de bruit doivent
  être écartés par le filtre de cohérence.
"""
import os

import cv2
import numpy as np
import pytest

import facial_2d
import lateral_checker as lc

PHOTO_REF = os.path.expanduser(
    "~/.hermes/profiles/smart-optica/cache/documents/native-inputs/"
    "16c4598ba02b17b20ea052a488e22c0c1c1849be83146ea8163169344965d0a0/"
    "dashboard_20261024_212345_d2b06c32_IMG_20261024_212206_105007.jpg"
)


def _image_avec_mire(qo=20, angle=0, taille=(600, 800), centre=(400, 300)):
    """Image vierge (gris moyen) avec UNE mire collée au centre demandé."""
    img = np.full(taille, 128.0, np.float32)
    g = lc._gabarit(qo, angle)
    gh, gw = g.shape[:2]
    x, y = centre
    img[y - gh // 2:y - gh // 2 + gh, x - gw // 2:x - gw // 2 + gw] = g
    return img.astype(np.uint8)


def test_une_mire_seule_est_retrouvee_a_sa_position():
    img = _image_avec_mire(qo=20, angle=0, centre=(400, 300))
    m = facial_2d.detect_markers_2d(img, qo_min=4, qo_max=12, qo_step=2, angle_step=15)
    assert m, "aucune mire trouvée"
    meilleure = m[0]
    assert abs(meilleure["x"] - 400) <= 6, f"x = {meilleure['x']}"
    assert abs(meilleure["y"] - 300) <= 6, f"y = {meilleure['y']}"
    # Plafond MESURÉ de la pyramide ÷3 : une mire collée EXACTEMENT dans
    # l'image ne corrèle qu'à 0,725, parce que la réduction de résolution lisse
    # les frontières du damier. Ce n'est pas un défaut de détection : sur la
    # photo réelle, la meilleure mire atteint la même valeur. Le plafond monte
    # avec un affinage à pleine résolution (étape suivante).
    assert meilleure["corr"] > 0.70, f"corr = {meilleure['corr']}"


def test_une_mire_tournee_est_retrouvee():
    img = _image_avec_mire(qo=20, angle=270, centre=(250, 420))
    m = facial_2d.detect_markers_2d(img, qo_min=4, qo_max=12, qo_step=2, angle_step=15)
    assert m
    assert abs(m[0]["x"] - 250) <= 6 and abs(m[0]["y"] - 420) <= 6


def test_deux_echelles_ne_sont_pas_declarees_coherentes():
    a = {"x": 0, "y": 0, "corr": 0.9, "qo_px": 30, "angle": 270}
    b = {"x": 0, "y": 0, "corr": 0.8, "qo_px": 12, "angle": 270}
    assert facial_2d.coherents([a, b]) == [a]


def test_deux_orientations_ne_sont_pas_declarees_coherentes():
    a = {"x": 0, "y": 0, "corr": 0.9, "qo_px": 30, "angle": 270}
    b = {"x": 0, "y": 0, "corr": 0.8, "qo_px": 30, "angle": 30}
    assert facial_2d.coherents([a, b]) == [a]


def test_une_rotation_de_180_deg_est_compatible():
    # un damier tourné de 180° est identique à lui-même
    a = {"x": 0, "y": 0, "corr": 0.9, "qo_px": 30, "angle": 10}
    b = {"x": 0, "y": 0, "corr": 0.8, "qo_px": 32, "angle": 190}
    assert len(facial_2d.coherents([a, b])) == 2


def test_rapports_du_triangle_du_clip():
    # triangle du clip facial : 50 / 40,5464 / 40,5464 mm → 1 / 0,8109 / 0,8109
    cote = 40.5464 / 50.0 * 1000.0
    m = [{"x": 0, "y": 0}, {"x": 1000, "y": 0}, {"x": 500, "y": 31.922 / 50.0 * 1000.0}]
    r = facial_2d.triangle_ratios(m)
    assert r is not None
    assert r["plus_long_px"] == pytest.approx(1000.0)
    # rapports = les trois côtés / le plus long → les deux petits sont les côtés
    assert sorted(r["rapports"])[:2] == pytest.approx([cote / 1000.0] * 2, abs=2e-3)


@pytest.mark.skipif(not os.path.exists(PHOTO_REF), reason="photo de référence absente")
def test_photo_reelle_trois_mires_coherentes():
    img = cv2.imdecode(np.frombuffer(open(PHOTO_REF, "rb").read(), np.uint8),
                       cv2.IMREAD_GRAYSCALE)
    m = facial_2d.detect_markers_2d(img)
    gardes = facial_2d.coherents(m)
    assert len(gardes) >= 3, f"{len(gardes)} mires cohérentes : {gardes}"
    for g in gardes[:3]:
        assert g["corr"] >= facial_2d.CORR_MIN
    # le bruit mesuré (qo 12 et 18 px, angles 30° et 230°) doit être écarté
    for g in gardes:
        assert 24 <= g["qo_px"] <= 45, f"échelle incohérente retenue : {g}"
