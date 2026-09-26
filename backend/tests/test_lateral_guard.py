"""Garde-fou de la chaîne latérale — toutes les mires du clip v19.5 sont des DAMIERS.

Contexte mesuré (scène synthétique du clip, une mire basse manquante) : le chemin damier
refusait correctement, MAIS la chaîne retombait sur les « disques noirs », qui rendaient
une paire FAUSSE — **27,69 mm au lieu de 25,00 mm**, soit 10,8 % d'erreur d'échelle, qui
aurait contaminé toutes les mesures du profil.

Règle verrouillée ici : dès qu'un damier du clip est VU (`n_candidates >= 1`) sans paire
métrologique valide, et qu'aucun marqueur ArUco réel n'est présent, on rend un **échec
explicite** — jamais un repli sur des chemins qui ne savent pas lire des damiers.
"""
import cv2
import numpy as np
import pytest

import main

SCALE = 0.25                      # mm/px
W, H = 1200, 1400

# Géométrie latérale MESURÉE sur le STL : 2 mires basses à 25,00 mm, la 3e à (−12,5 ; +16)
BASSE_1 = (0.0, 0.0)
BASSE_2 = (-25.0, 0.0)
SURELEVEE = (-12.5, 16.0)


def _mire(img, cx, cy, scale=SCALE):
    """Un damier du clip : 2 carreaux NOIRS de 5 mm en diagonale, coins intérieurs à l'axe."""
    demi = int(round(5.0 / scale))
    img[cy - demi:cy, cx - demi:cx] = 30
    img[cy:cy + demi, cx:cx + demi] = 30


def _scene(positions, scale=SCALE):
    """Scène BGR avec les mires demandées, en mm autour de la position de la 1re."""
    img = np.full((H, W), 150, np.uint8)
    for (mm_x, mm_y) in positions:
        _mire(img, 800 + int(round(mm_x / scale)), 450 - int(round(mm_y / scale)), scale)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def _detect(positions, scale=SCALE):
    return main._detect_lateral(_scene(positions, scale), known_scale=scale)


class TestGardeFouDamiers:
    def test_clip_complet_donne_la_paire_de_25mm(self):
        markers, diag = _detect([BASSE_1, BASSE_2, SURELEVEE])
        assert diag.path == "checkerboard"
        assert len(markers) == 2
        # la paire métrologique est la basse paire, pas un côté vers la surélevée
        assert diag.spacing_mm_detected == pytest.approx(25.0)
        assert getattr(diag, "raised_rejected", False) or getattr(diag, "triangle_isoceles", False)

    def test_deux_mires_basses_suffisent(self):
        markers, diag = _detect([BASSE_1, BASSE_2])
        assert diag.path == "checkerboard"
        assert diag.spacing_mm_detected == pytest.approx(25.0)

    def test_paire_incomplete_REFUSE_au_lieu_d_inventer(self):
        """1 mire basse + la surélevée : le clip est là, mais la paire métrologique non.

        Avant le garde-fou, les « disques noirs » rendaient 27,69 mm (10,8 % d'erreur).
        """
        markers, diag = _detect([BASSE_1, SURELEVEE])
        assert markers == [], "une paire fausse a été inventée sur des damiers"
        assert diag.path is None
        assert getattr(diag, "n_candidates", 0) >= 1, \
            "le damier vu doit rester compté (c'est ce qui déclenche le garde-fou)"

    def test_fond_vide_refuse_sans_mensonge(self):
        markers, diag = _detect([])
        assert markers == []
        assert diag.path is None
        assert getattr(diag, "n_candidates", 0) == 0

    def test_le_garde_fou_ne_bloque_pas_les_anciens_clips(self):
        """Sans aucun damier, la chaîne garde le droit d'essayer les variantes antérieures."""
        img = np.full((H, W), 150, np.uint8)
        for cy in (400, 520):                       # deux disques NOIRS pleins (ancien clip)
            cv2.circle(img, (760, cy), 8, 20, -1)
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        markers, diag = main._detect_lateral(bgr, known_scale=SCALE)
        assert getattr(diag, "n_candidates", 0) == 0, "aucun damier ne doit être vu ici"
        assert diag.path == "dark_circles", \
            "les anciens clips doivent rester détectables (le garde-fou ne doit pas sur-bloquer)"
        assert len(markers) == 2
