"""Intégration du chemin 2D + pose dans main.py.

Le damier est RENDU, pas simulé par des points : c'est la chaîne complète
(corrélation 2D → affinage → pose) qui est exercée, pas seulement la géométrie.
"""
import numpy as np
import cv2
import pytest

import main
import facial_2d
import lateral_checker as lc


def _image_avec_clip(tilt_deg=30.0, dist_mm=450.0, f_px=4800.0,
                     largeur=4032, hauteur=3024):
    """Une image où les cinq damiers du clip sont RÉELLEMENT dessinés."""
    noms, obj = facial_2d._modele_3d()
    K = np.array([[f_px, 0, largeur / 2], [0, f_px, hauteur / 2], [0, 0, 1]], float)
    rvec = np.array([np.radians(tilt_deg), np.radians(6.0), np.radians(-10.0)])
    R, _ = cv2.Rodrigues(rvec)
    # Le clip est CENTRÉ sur l'image. Sans cela, à 20° et 30° des mires sortent
    # du cadre et le rendu les saute en silence : il n'en reste que quatre, et
    # la pose en exige cinq. C'est ce qui faisait échouer ce test, pas la pose.
    tvec = np.array([-(R @ obj[0])[0], -(R @ obj[0])[1], dist_mm])
    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
    proj = proj.reshape(-1, 2)
    profondeurs = [float((R @ p + tvec)[2]) for p in obj]
    echelle_vraie = profondeurs[0] / f_px

    img = np.full((hauteur, largeur), 128.0, np.float32)
    for (x, y), prof in zip(proj, profondeurs):
        # chaque mire à sa taille APPARENTE : un clip incliné présente ses mires
        # à des profondeurs différentes, donc à des échelles différentes
        qo = int(round(2.5 / (prof / f_px)))
        g = lc._gabarit(qo, 0)
        gh, gw = g.shape[:2]
        x0, y0 = int(round(x - (gw - 1) / 2)), int(round(y - (gh - 1) / 2))
        assert 0 <= x0 and 0 <= y0 and x0 + gw <= largeur and y0 + gh <= hauteur, \
            f"mire hors cadre à {tilt_deg}° : ({x:.0f}, {y:.0f})"
        img[y0:y0 + gh, x0:x0 + gw] = g
    return img.astype(np.uint8), echelle_vraie, proj


@pytest.mark.parametrize("tilt", [0.0, 30.0])
def test_main_etablit_le_clip_sous_inclinaison(tilt):
    gray, echelle_vraie, proj = _image_avec_clip(tilt_deg=tilt)
    res = main.detect_facial_par_pose(gray)
    assert res is not None, f"chemin 2D muet à {tilt}°"
    assert res["methode"] == "pose_2d"
    assert len(res["markers"]) == 5
    assert res["scale_mm_per_px"] == pytest.approx(echelle_vraie, rel=0.02)
    # les mires rendues doivent être retrouvées à leur position
    rendues = np.array([[m["x"], m["y"]] for m in res["markers"]])
    ecarts = [np.min(np.linalg.norm(proj - r, axis=1)) for r in rendues]
    assert max(ecarts) < 4.0, f"écart max {max(ecarts):.1f} px"


def test_main_rend_none_quand_le_clip_est_absent():
    """Une image sans damier ne doit RIEN inventer."""
    rng = np.random.default_rng(3)
    bruit = (rng.normal(128, 25, (600, 800))).clip(0, 255).astype(np.uint8)
    assert main.detect_facial_par_pose(bruit) is None
