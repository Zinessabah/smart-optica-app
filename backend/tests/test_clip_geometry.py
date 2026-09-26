"""Tests de la géométrie de référence du clip v19.5.

Deux niveaux :
  1. cohérence interne des cotes (toujours exécuté) ;
  2. **revérification sur les STL exportés** (exécuté si les fichiers sont trouvables,
     sinon sauté) — c'est le test qui empêche la géométrie de diverger du clip réel.
"""
import math
import os
import pathlib

import pytest

import clip_geometry as cg

# ── Où chercher les STL du clip ──────────────────────────────────────────────
DOSSIERS_STL = [
    os.environ.get("CLIP_STL_DIR", ""),
    "/home/driss/Documents",
    "/home/driss/Documents/Clip_V19.5",
    str(pathlib.Path(__file__).resolve().parents[1] / "design"),
    str(pathlib.Path(__file__).resolve().parents[2]),
]


def _trouver_stl(nom: str):
    for d in DOSSIERS_STL:
        if d and (p := pathlib.Path(d) / nom).exists():
            return p
    return None


CORPS = _trouver_stl("clip_reference_v19_5_corps.stl")
MOTIF = _trouver_stl("clip_reference_v19_5_ins_damier_noir.stl")

besoin_stl = pytest.mark.skipif(
    CORPS is None or MOTIF is None,
    reason="STL du clip v19.5 absents (poser CLIP_STL_DIR pour les activer)")


# ════════════════════════════════════════════════════════════════════════════
# 1. Cohérence interne
# ════════════════════════════════════════════════════════════════════════════

def test_motif_damier_coherent():
    """L'offset de quadrant EST la moitié du carreau (contrainte du damier 2×2)."""
    assert cg.PATTERN_QUADRANT_MM == cg.PATTERN_SQUARE_MM / 2.0
    assert cg.PATTERN_QUADRANT_MM == 2.5
    assert cg.PATTERN_DIAMETER_MM == 10.0
    assert cg.MARKER_DISC_MM == 12.0


def test_paire_metrologique_est_celle_des_DEUX_BASSES():
    """La paire métrologique ne doit JAMAIS pouvoir être la surélevée."""
    proche, eloignee = cg.lateral_metrological_pair("+x")
    surelevee = cg.lateral_raised_marker("+x")

    assert proche["role"] == "laterale_proche"
    assert eloignee["role"] == "laterale_eloignee"
    assert proche["z"] == eloignee["z"] == cg.LATERAL_MARKER_Z_LOW_MM == 12.0
    assert surelevee["z"] == cg.LATERAL_MARKER_Z_RAISED_MM == 28.0

    ecart = math.dist((proche["y"], proche["z"]), (eloignee["y"], eloignee["z"]))
    assert ecart == pytest.approx(cg.LATERAL_SPACING_MM, abs=1e-9) == 25.0


def test_piege_de_la_surelevee_est_bien_a_20_30_mm():
    """Le piège : la surélevée est à 20,3042 mm (dite « 20,30 ») de CHACUNE des basses."""
    proche, eloignee = cg.lateral_metrological_pair("+x")
    surelevee = cg.lateral_raised_marker("+x")
    for basse in (proche, eloignee):
        d = math.dist((basse["y"], basse["z"]), (surelevee["y"], surelevee["z"]))
        assert d == pytest.approx(cg.LATERAL_RAISED_GAP_MM, abs=1e-9)
        assert d == pytest.approx(cg.LATERAL_RAISED_GAP_NOMINAL_MM, abs=0.01)


def test_triangle_lateral_isoceles_et_rapport_1232():
    """Le côté métrologique est le PLUS LONG du triangle latéral (critère sans échelle).

    C'est la règle que le détecteur applique : sur les 3 mires d'un côté, la paire
    métrologique est celle dont la distance vaut `isoceles_ratio()` fois les autres.
    """
    pts = {m["role"]: (m["y"], m["z"]) for m in cg.lateral_same_side_markers("+x")}
    d_proche_eloignee = math.dist(pts["laterale_proche"], pts["laterale_eloignee"])
    d_proche_surelevee = math.dist(pts["laterale_proche"], pts["laterale_surelevee"])
    d_eloignee_surelevee = math.dist(pts["laterale_eloignee"], pts["laterale_surelevee"])

    # isocèle : les deux côtés vers la surélevée sont égaux
    assert d_proche_surelevee == pytest.approx(d_eloignee_surelevee, abs=1e-9)

    # le côté métrologique est le plus long, dans le rapport attendu
    assert d_proche_eloignee > d_proche_surelevee
    assert cg.isoceles_ratio() == pytest.approx(25.0 / math.hypot(12.5, 16.0), abs=1e-12)
    assert cg.isoceles_ratio() == pytest.approx(1.2313, abs=1e-4)
    assert cg.LATERAL_RAISED_GAP_MM == pytest.approx(20.3039, abs=1e-4)
    assert d_proche_eloignee / d_proche_surelevee == pytest.approx(
        cg.isoceles_ratio(), abs=1e-12)
    assert cg.isoceles_ratio() > 1.2    # marge : la confusion est impossible à l'œil


def test_mires_faciales_et_ecartements():
    """4 mires faciales coplanaires, 100 mm entre les extrêmes, 50 mm avec le centre."""
    roles = {m["role"]: (m["x"], m["z"]) for m in cg.FACIAL_MARKERS}
    assert len(roles) == 4
    gauche, centre, droite, haute = (roles["facial_gauche"], roles["facial_centre"],
                                    roles["facial_droite"], roles["facial_haute"])

    assert math.dist(gauche, droite) == pytest.approx(cg.FACIAL_SPACING_EXTREME_MM)
    assert math.dist(gauche, centre) == pytest.approx(cg.FACIAL_SPACING_ADJACENT_MM)
    assert math.dist(centre, droite) == pytest.approx(cg.FACIAL_SPACING_ADJACENT_MM)
    assert gauche[1] == centre[1] == droite[1] == 3.0        # barre alignée
    assert haute[1] == 17.0 and haute[0] == 30.0             # 4e mire, surélevée


def test_echelle_vient_des_ecartements_connus():
    """L'échelle se déduit d'un écartement CONNU — jamais d'un IPD supposé."""
    # 100 mm faciaux sur 959 px
    assert cg.scale_from_span(cg.FACIAL_SPACING_EXTREME_MM, 959.0) == pytest.approx(100.0 / 959.0)
    # 25 mm latéraux sur 500 px
    assert cg.scale_from_span(cg.LATERAL_SPACING_MM, 500.0) == pytest.approx(0.05)
    with pytest.raises(ValueError):
        cg.scale_from_span(25.0, 0.0)


def test_expected_spacing_px():
    assert cg.expected_spacing_px(cg.LATERAL_SPACING_MM, 0.05) == pytest.approx(500.0)
    assert cg.expected_spacing_px(cg.FACIAL_SPACING_EXTREME_MM, 0.1) == pytest.approx(1000.0)
    with pytest.raises(ValueError):
        cg.expected_spacing_px(25.0, 0.0)


def test_les_deux_cotes_sont_symetriques():
    """Les 6 latérales forment 3 paires symétriques en ±x."""
    for role in ("laterale_proche", "laterale_eloignee", "laterale_surelevee"):
        m = next(x for x in cg.LATERAL_MARKERS if x["role"] == role and x["side"] == "+x")
        n = next(x for x in cg.LATERAL_MARKERS if x["role"] == role and x["side"] == "-x")
        assert (m["y"], m["z"]) == (n["y"], n["z"])
    assert len(cg.LATERAL_MARKERS) == 6


# ════════════════════════════════════════════════════════════════════════════
# 2. Revérification sur les STL du clip (le test qui ancre la géométrie)
# ════════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def mesure():
    from tools import mesure_clip_v19_5 as m
    return m.mesurer(str(CORPS), str(MOTIF))


@besoin_stl
def test_stl_ecartements_lateraux(mesure):
    """Les STL donnent bien 25,00 mm (paire basse) et 20,30 mm (surélevée)."""
    for cote in ("+x", "-x"):
        mires = mesure["laterales"][cote]
        assert len(mires) == 3, f"3 mires latérales attendues côté {cote}"

        # on apparie par position : les 2 basses partagent z ≈ 12
        basses = [m for m in mires if abs(m["plan"][1] - cg.LATERAL_MARKER_Z_LOW_MM) < 0.5]
        hautes = [m for m in mires if abs(m["plan"][1] - cg.LATERAL_MARKER_Z_RAISED_MM) < 0.5]
        assert len(basses) == 2 and len(hautes) == 1

        d_basses = math.dist(basses[0]["plan"], basses[1]["plan"])
        assert d_basses == pytest.approx(cg.LATERAL_SPACING_MM, abs=cg.MEASUREMENT["tolerance_mm"])

        for b in basses:
            d = math.dist(b["plan"], hautes[0]["plan"])
            assert d == pytest.approx(cg.LATERAL_RAISED_GAP_MM,
                                      abs=cg.MEASUREMENT["tolerance_mm"])


@besoin_stl
def test_stl_positions_laterales(mesure):
    """Les axes mesurés sur le maillage tombent sur les positions nominales (±0,15 mm)."""
    for cote in ("+x", "-x"):
        positions = [m["plan"] for m in mesure["laterales"][cote]]
        for m in cg.lateral_same_side_markers(cote):
            assert any(abs(m["y"] - py) <= 0.15 and abs(m["z"] - pz) <= 0.15
                       for py, pz in positions), \
                f"mire (y={m['y']}, z={m['z']}) absente côté {cote} (trouvé {positions})"


@besoin_stl
def test_stl_positions_et_ecartements_faciaux(mesure):
    plans = [(round(m["plan"][0], 1), round(m["plan"][1], 1)) for m in mesure["faciales"]]
    assert len(plans) == 4
    for m in cg.FACIAL_MARKERS:
        assert any(abs(m["x"] - x) <= 0.1 and abs(m["z"] - z) <= 0.1 for x, z in plans), \
            f"mire faciale {m['x']},{m['z']} absente (trouvé {plans})"

    ecarts = [v for v in mesure["ecartements_faciaux"].values() if v > 1]
    assert min(ecarts, key=lambda v: abs(v - 100)) == pytest.approx(100.0, abs=0.06)
    assert sum(1 for v in ecarts if abs(v - 50.0) < 0.06) == 2


@besoin_stl
def test_stl_motif_damier(mesure):
    mo = mesure["motif"]
    assert mo["damiers"] == 10, "les 10 mires portent le même damier"
    assert mo["carreaux"] == 20, "2 carreaux noirs par damier"
    tol = cg.MEASUREMENT["tolerance_mm"]
    assert mo["carreau_mm"] == pytest.approx(cg.PATTERN_SQUARE_MM, abs=0.02)
    assert mo["carreau_par_coin_mm"] == pytest.approx(cg.PATTERN_SQUARE_MM, abs=0.02)
    assert mo["offset_mm"] == pytest.approx(cg.PATTERN_QUADRANT_MM, abs=tol)
    assert mo["diametre_mm"] == pytest.approx(cg.PATTERN_DIAMETER_MM, abs=0.02)


@besoin_stl
def test_stl_encombrement(mesure):
    for axe, valeur in cg.BODY_BBOX_MM.items():
        assert mesure["bbox"][axe] == pytest.approx(valeur, abs=0.06)
