"""Tests de la géométrie de référence du clip v19.5.

Deux niveaux :
  1. cohérence interne des cotes (toujours exécuté) ;
  2. **revérification sur les STL exportés** (exécuté si les fichiers sont trouvables,
     sinon sauté) — c'est le test qui empêche la géométrie de diverger du clip réel.
"""
import math
import os
import pathlib
import sys

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
    """5 mires faciales coplanaires : 100 mm entre les extrêmes, 50 mm avec le centre,
    et depuis la v22.1 une mire haute à x = +30 **et son miroir** à x = −30.
    """
    roles = {m["role"]: (m["x"], m["z"]) for m in cg.FACIAL_MARKERS}
    assert len(roles) == 5
    gauche, centre, droite, haute = (roles["facial_gauche"], roles["facial_centre"],
                                     roles["facial_droite"], roles["facial_haute"])
    miroir = roles[cg.FACIAL_RAISED_MIRROR_ROLE]

    assert math.dist(gauche, droite) == pytest.approx(cg.FACIAL_SPACING_EXTREME_MM)
    assert math.dist(gauche, centre) == pytest.approx(cg.FACIAL_SPACING_ADJACENT_MM)
    assert math.dist(centre, droite) == pytest.approx(cg.FACIAL_SPACING_ADJACENT_MM)
    assert gauche[1] == centre[1] == droite[1] == 3.0        # barre alignée
    assert haute[1] == 17.0 and haute[0] == 30.0             # mire haute, surélevée

    # ── Le miroir (v22.1) ───────────────────────────────────────────────────
    assert miroir == (-30.0, 17.0)
    assert miroir[1] == haute[1]                   # même hauteur
    assert miroir[0] == -haute[0]                  # symétrique par rapport à l'axe
    assert math.dist(miroir, haute) == pytest.approx(60.00)   # l'étalon le plus long
    # Les deux distances au centre sont ÉGALES : c'est ce qui rend le contrôle de
    # symétrie possible, et la validation invariante au miroir.
    assert math.dist(miroir, centre) == pytest.approx(math.dist(haute, centre))
    assert set(cg.FACIAL_RAISED_ROLES) == {"facial_haute", cg.FACIAL_RAISED_MIRROR_ROLE}


def test_ecart_vertical_de_la_4e_mire_vaut_14_et_pas_17():
    """L'ÉCART vertical vaut 14,00 mm : « 17 » est une POSITION (stem_top_z).

    Confondre les deux (17 au lieu de 14) surestime le décalage de 21 % — sans
    conséquence tant que la tolérance de détection restait large, mais faux dès
    qu'on veut en tirer une inclinaison.
    """
    assert cg.FACIAL_RAISED_Z_GAP_MM == pytest.approx(14.00)
    assert cg.FACIAL_RAISED_Z_GAP_MM != 17.0
    # la position absolue reste bien 17, et la barre est à 3
    assert cg.facial_plan_pos("facial_haute")[1] == 17.0
    assert cg.FACIAL_BAR_Z_MM == 3.00
    assert cg.FACIAL_RAISED_Z_GAP_MM == 17.0 - 3.0
    # décalage horizontal de la 4e mire par rapport au centre
    assert cg.FACIAL_RAISED_X_FROM_CENTRE_MM == pytest.approx(30.00)


def test_quadrilatere_facial_distances_et_rapports():
    """Les écartements dérivés du quadrilatère, et leurs rapports invariants."""
    spans = cg.FACIAL_QUAD_SPANS_MM
    assert spans["extreme"] == pytest.approx(100.0000, abs=1e-6)
    assert spans["adjacente"] == pytest.approx(50.0000, abs=1e-6)
    assert spans["haute_centre"] == pytest.approx(math.hypot(30, 14), abs=1e-6)
    assert spans["haute_droite"] == pytest.approx(math.hypot(20, 14), abs=1e-6)
    assert spans["haute_gauche"] == pytest.approx(math.hypot(80, 14), abs=1e-6)
    assert spans["haute_centre"] == pytest.approx(33.1059, abs=1e-3)
    assert spans["haute_droite"] == pytest.approx(24.4131, abs=1e-3)
    assert spans["haute_gauche"] == pytest.approx(81.2158, abs=1e-3)

    # rapports invariants d'échelle : vérifiables sans connaître les mm/px
    ratios = cg.FACIAL_QUAD_RATIOS
    assert ratios["extreme"] == pytest.approx(1.0)
    assert ratios["adjacente"] == pytest.approx(0.5)
    assert ratios["haute_centre"] == pytest.approx(33.1059 / 100.0, abs=1e-5)
    assert ratios["haute_droite"] == pytest.approx(24.4131 / 100.0, abs=1e-5)
    assert ratios["haute_centre"] / ratios["adjacente"] == pytest.approx(0.66212, abs=1e-4)


def test_directions_du_quadrilatere_sont_les_references_de_roll():
    """La 4e mire sort de la rangée : ses directions sont la référence du roll."""
    refs = cg.FACIAL_ROLL_REFS_DEG
    # atan2(14, 30) et atan2(14, 80) — mesurés depuis le centre et depuis la gauche
    assert refs["haute_centre"] == pytest.approx(math.degrees(math.atan2(14, 30)), abs=1e-9)
    assert refs["haute_centre"] == pytest.approx(25.0169, abs=1e-3)
    assert refs["haute_gauche"] == pytest.approx(9.9262, abs=1e-3)
    # les deux références sont franchement distinctes : contrôle croisé utile
    assert abs(refs["haute_centre"] - refs["haute_gauche"]) > 10.0
    # la 4e mire est bien HORS de la rangée (sinon pas de référence de roll)
    assert refs["haute_centre"] > 5.0


def test_triangle_centre_droite_haute_angles():
    """Le triangle C-D-H est scalène : 25,00° / 34,99° / 120,0°."""
    def angle_at(sommet, p1, p2):
        a, b = cg.facial_plan_pos(p1), cg.facial_plan_pos(p2)
        s = cg.facial_plan_pos(sommet)
        v1 = (a[0] - s[0], a[1] - s[1])
        v2 = (b[0] - s[0], b[1] - s[1])
        cosv = ((v1[0] * v2[0] + v1[1] * v2[1])
                / (math.hypot(*v1) * math.hypot(*v2)))
        return math.degrees(math.acos(max(-1.0, min(1.0, cosv))))

    assert angle_at("facial_centre", "facial_droite", "facial_haute") == pytest.approx(25.0169, abs=1e-3)
    assert angle_at("facial_droite", "facial_centre", "facial_haute") == pytest.approx(34.9920, abs=1e-3)
    assert angle_at("facial_haute", "facial_centre", "facial_droite") == pytest.approx(120.0, abs=0.02)


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
    """Les 4 mires faciales du STL v19.5, et l'ABSENCE du miroir sur ce clip-là.

    ⚠️ Le sens du contrôle a changé avec la v22.1 : ce n'est plus « toute mire
    déclarée doit exister sur le STL » (le v19.5 n'a qu'une mire haute), mais
    « toute position trouvée sur le STL doit correspondre à une mire déclarée ».
    Un STL est la vérité de ce qu'il contient ; le code doit savoir lire les deux.
    """
    plans = [(round(m["plan"][0], 1), round(m["plan"][1], 1)) for m in mesure["faciales"]]

    for x, z in plans:
        assert any(abs(m["x"] - x) <= 0.1 and abs(m["z"] - z) <= 0.1
                   for m in cg.FACIAL_MARKERS), \
            f"position ({x}, {z}) trouvée sur le STL mais absente de FACIAL_MARKERS"

    assert len(plans) == 4, "le clip v19.5 porte QUATRE mires faciales"
    assert not any(abs(x + 30.0) <= 0.1 and abs(z - 17.0) <= 0.1 for x, z in plans), \
        "le v19.5 n'a pas de mire haute gauche : le miroir est une addition de la v22.1"

    ecarts = [v for v in mesure["ecartements_faciaux"].values() if v > 1]
    assert min(ecarts, key=lambda v: abs(v - 100)) == pytest.approx(100.0, abs=0.06)
    assert sum(1 for v in ecarts if abs(v - 50.0) < 0.06) == 2


# ── Clip v22 : la 5ᵉ mire, mesurée sur le kit réellement imprimé ─────────────
# ⚠️ LE dossier de référence est `clip_v22_impression/clip_v22_a_imprimer` (11 inserts :
# 5 faciaux + 6 latéraux). Un autre exemplaire traîne dans « Documents » sous le nom
# `clip_v221_a_imprimer` — c'est une variante à damiers PAPIER, dont le STL facial
# diffère (287 484 octets contre 285 684, md5 différent). Mesurer le mauvais dossier
# donnerait des cotes plausibles mais fausses : c'est arrivé.
DOSSIER_V22 = "/home/driss/Documents/clip_v22_impression/clip_v22_a_imprimer"
STL_V22_FACIAL = os.path.join(DOSSIER_V22, "01_facial_2bras.stl")
STL_V22_BRAS = (("+x", os.path.join(DOSSIER_V22, "03_bras_droit_x1.stl")),
                ("-x", os.path.join(DOSSIER_V22, "04_bras_gauche_x1.stl")))
besoin_v22 = pytest.mark.skipif(
    not os.path.exists(STL_V22_FACIAL),
    reason=f"kit v22 absent ({DOSSIER_V22})")


@besoin_v22
def test_stl_v22_porte_les_cinq_mires_faciales():
    """Les 5 mires faciales du kit v22, à leur place — mesurées, pas recopiées.

    ⚠️ **Tolérance de 0,10 mm pour les mires hautes**, et non 0,06 comme pour la
    barre. Mesuré sur le kit réel :
        barre  : −50,000 / 0,000 / +50,000 à z = 3,000 — EXACT (les trois)
        hautes : ±30,000 à z = **16,921** (alésage) et 16,912 (collier)
    Les deux lèvres concordent à 0,01 mm : la hauteur mesurée est 16,92, soit
    0,08 mm sous les 17,000 du SCAD. **On garde 17,000**, parce qu'un écart de
    0,08 mm est inférieur à ce qu'une impression FDM peut tenir : la couche fait
    0,20 mm. Ce n'est pas une approximation commode, c'est la résolution de la
    pièce. L'effet de cet écart, s'il était réel, serait de 0,17° sur la référence
    de roll et de 0,27 % sur les étalons — tous deux très en deçà des tolérances.
    """
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
    from mesure_clip_v22_1 import mesurer

    mires = mesurer(STL_V22_FACIAL)
    assert len(mires) == 5, f"5 mires attendues sur le v22, mesuré {len(mires)}"

    for m in cg.FACIAL_MARKERS:
        trouvee = min(mires, key=lambda q: math.hypot(q["x"] - m["x"], q["z"] - m["z"]))
        ecart = math.hypot(trouvee["x"] - m["x"], trouvee["z"] - m["z"])
        tol = 0.02 if m["z"] < 10 else 0.10          # barre exacte, hautes au dixième
        assert ecart <= tol, (f"mire {m['role']} déclarée ({m['x']}, {m['z']}) "
                              f"mesurée ({trouvee['x']:.3f}, {trouvee['z']:.3f}) — "
                              f"écart {ecart:.3f} mm > {tol} mm")

    barre = sorted(m["x"] for m in mires if m["z"] < 10)
    hautes = sorted(m["x"] for m in mires if m["z"] >= 10)
    assert len(barre) == 3 and len(hautes) == 2
    assert (barre[-1] - barre[0]) == pytest.approx(cg.FACIAL_SPACING_EXTREME_MM, abs=0.02)
    assert (hautes[-1] - hautes[0]) == pytest.approx(60.00, abs=0.02)
    # symétrie des hautes autour du centre mesuré — c'est ce que le code exploite
    centre = min(barre, key=abs)
    assert (hautes[0] + hautes[1]) / 2 == pytest.approx(centre, abs=0.02)


@besoin_v22
def test_stl_v22_conserve_la_metrologie_laterale():
    """Les 6 mires latérales sont des INSERTS, et leurs cotes n'ont pas bougé.

    Les bras v22 ont perdu les crochets, mais leur métrologie est annoncée
    inchangée. Mesuré sur les deux bras (plan des faces |x| = 76,75) :
        y = −39,000 / −26,485 / −14,038   (référence −39 / −26,5 / −14)
        écartement des deux basses = 24,962 mm  (référence 25,000)

    ⚠️ On ne teste PAS le z ici : la lèvre du collier latéral est dissymétrique
    en z (elle donne 12,55 pour une cote de 12,00), alors que son y est exact.
    Un contrôle qui échouerait sur un biais connu de l'outil serait un faux
    signal. Le z reste couvert par les tests dédiés sur les STL du v19.5, dont
    les bras ont servi de référence.
    """
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
    from mesure_clip_v22_1 import mesurer_laterales

    for side, chemin in STL_V22_BRAS:
        lat = mesurer_laterales(chemin)
        assert len(lat) == 3, f"{side} : 3 mires latérales attendues, {len(lat)} mesurées"

        attendus = sorted(m["y"] for m in cg.lateral_same_side_markers(side))
        mesures = sorted(m["y"] for m in lat)
        for a, b in zip(attendus, mesures):
            assert abs(a - b) <= 0.10, f"{side} : y attendu {a}, mesuré {b:.3f}"

        basses = sorted(m["y"] for m in lat if m["z"] < 20)
        assert len(basses) == 2
        assert abs(basses[-1] - basses[0]) == pytest.approx(cg.LATERAL_SPACING_MM, abs=0.10)

        # plan des faces : |x| = 76,75 (le CENTRE du disque est à 76,00)
        assert all(abs(m["x"] - 76.75) <= 0.05 for m in lat)


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


# ════════════════════════════════════════════════════════════════════════════
# 3. Quadrilatère facial — auto-contrôle des étalons (A), ratios sans échelle
#    (B), et roll mécanique (C). Fonctions PURES : testables sans image.
# ════════════════════════════════════════════════════════════════════════════

ROLES_FACIAUX = ("facial_gauche", "facial_centre", "facial_droite", "facial_haute")


def _points_du_clip(scale=0.25, ox=400.0, oy=900.0, rot_deg=0.0):
    """Les 4 mires faciales projetées comme sur une photo, puis pivotées.

    Repère image : x vers la droite, y vers le BAS (d'où le signe de z).
    """
    th = math.radians(rot_deg)
    pts = {}
    for role in ROLES_FACIAUX:
        x, z = cg.facial_plan_pos(role)
        px, py = x / scale, -z / scale
        pts[role] = (ox + px * math.cos(th) - py * math.sin(th),
                     oy + px * math.sin(th) + py * math.cos(th))
    return pts


def test_A_auto_controle_des_etalons_sur_un_quadruplet_juste():
    """Un quadruplet correct : les 3 étalons donnent LA MÊME échelle."""
    pts = _points_du_clip(scale=0.25)
    chk = cg.facial_quad_check(pts)

    assert chk["n_points"] == 4
    assert chk["scale_mm_per_px"] == pytest.approx(0.25, rel=1e-6)
    assert chk["scale_spread"] == pytest.approx(0.0, abs=1e-9)
    assert chk["scale_consistent"] is True
    assert chk["ratios_consistent"] is True
    # les 4 étalons sont bien exploités (extrême, adjacente, 2 inclinés)
    assert set(chk["scale_by_span"]) == {"extreme", "adjacente",
                                         "haute_centre", "haute_droite",
                                         "haute_gauche"}


def test_A_une_mire_decalee_fait_diverger_les_etalons():
    """Une mire prise pour une autre ⇒ échelles incompatibles ⇒ contrôle négatif."""
    pts = _points_du_clip(scale=0.25)
    pts["facial_haute"] = (pts["facial_haute"][0] + 30.0, pts["facial_haute"][1])
    chk = cg.facial_quad_check(pts)

    assert chk["scale_consistent"] is False
    assert chk["scale_spread"] > cg.FACIAL_SCALE_TOL


def test_B_les_ratios_valident_sans_connaitre_l_echelle():
    """Les rapports d'écartements sont invariants d'échelle (aucun mm/px requis)."""
    petit = cg.facial_quad_check(_points_du_clip(scale=0.10))
    grand = cg.facial_quad_check(_points_du_clip(scale=0.60))

    # échelles très différentes…
    assert petit["scale_mm_per_px"] == pytest.approx(0.10, rel=1e-6)
    assert grand["scale_mm_per_px"] == pytest.approx(0.60, rel=1e-6)
    # …mais MÊMES rapports, donc même verdict
    assert petit["ratio_by_span"] == pytest.approx(grand["ratio_by_span"], rel=1e-9)
    assert petit["ratios_consistent"] and grand["ratios_consistent"]
    # Chaque écartement mesuré est proportionnel à son écartement théorique :
    # les rapports normalisés valent donc 1,0, sans qu'aucun mm/px n'intervienne.
    assert all(v == pytest.approx(1.0) for v in petit["ratio_by_span"].values())
    assert petit["ratio_spread"] == pytest.approx(0.0, abs=1e-9)


def test_B_les_rapports_du_quadrilatere_sont_ceux_du_clip():
    """Contrôle indépendant : les rapports MESURÉS valent ceux du clip."""
    pts = _points_du_clip(scale=0.25)
    spans = {"extreme": cg._dist2(pts["facial_gauche"], pts["facial_droite"]),
             "adjacente": cg._dist2(pts["facial_centre"], pts["facial_droite"]),
             "haute_centre": cg._dist2(pts["facial_centre"], pts["facial_haute"])}
    # 100 / 50 / 33,106 mm ⇒ mêmes proportions en pixels
    assert spans["adjacente"] / spans["extreme"] == pytest.approx(0.5, rel=1e-9)
    assert (spans["haute_centre"] / spans["extreme"]
            == pytest.approx(cg.FACIAL_QUAD_RATIOS["haute_centre"], rel=1e-9))
    assert (spans["haute_centre"] / spans["adjacente"]
            == pytest.approx(0.66212, rel=1e-4))


def test_B_un_quadruplet_faux_est_rejete_sans_echelle():
    """Sans aucune échelle, des rapports faux suffisent à écarter le candidat."""
    pts = _points_du_clip(scale=0.25)
    pts["facial_droite"] = (pts["facial_droite"][0] * 0.5, pts["facial_droite"][1])
    chk = cg.facial_quad_check(pts)
    assert chk["ratios_consistent"] is False
    assert chk["ratio_spread"] > cg.FACIAL_SCALE_TOL


def test_C_roll_nul_quand_le_clip_est_droit():
    """Clip droit sur la photo ⇒ roll 0°, et les 2 références concordent."""
    chk = cg.facial_quad_check(_points_du_clip(scale=0.25))
    assert chk["roll_deg"] == pytest.approx(0.0, abs=1e-6)
    assert chk["roll_by_ref"]["haute_centre"] == pytest.approx(0.0, abs=1e-6)
    assert chk["roll_by_ref"]["haute_gauche"] == pytest.approx(0.0, abs=1e-6)
    assert chk["roll_disagreement_deg"] == pytest.approx(0.0, abs=1e-6)
    assert chk["roll_consistent"] is True


@pytest.mark.parametrize("angle", [-12.0, -3.5, 4.0, 11.0])
def test_C_le_roll_mesure_l_inclinaison_du_clip(angle):
    """Le clip pivoté de θ donne un roll de −θ (repère image, y vers le bas)."""
    chk = cg.facial_quad_check(_points_du_clip(scale=0.25, rot_deg=angle))
    assert chk["roll_deg"] == pytest.approx(-angle, abs=1e-6)
    assert chk["roll_disagreement_deg"] == pytest.approx(0.0, abs=1e-6)


def test_C_le_roll_ne_depend_ni_de_l_echelle_ni_de_la_position():
    """Le roll est une pure rotation : ni l'échelle ni la translation n'y entrent."""
    ref = cg.facial_quad_check(_points_du_clip(scale=0.25, rot_deg=7.0))["roll_deg"]
    for kwargs in ({"scale": 0.5}, {"scale": 0.12}, {"ox": 120.0, "oy": 240.0},
                   {"ox": 1800.0, "oy": 1500.0}):
        chk = cg.facial_quad_check(_points_du_clip(rot_deg=7.0, **kwargs))
        assert chk["roll_deg"] == pytest.approx(ref, abs=1e-6)


def test_C_les_deux_references_divergent_si_une_mire_est_fausse():
    """Un désaccord entre les 2 références trahit une détection douteuse."""
    pts = _points_du_clip(scale=0.25)
    pts["facial_haute"] = (pts["facial_haute"][0], pts["facial_haute"][1] + 25.0)
    chk = cg.facial_quad_check(pts)
    assert chk["roll_disagreement_deg"] > cg.FACIAL_ROLL_TOL_DEG
    assert chk["roll_consistent"] is False


def test_facial_points_from_markers_respecte_l_ordre_du_clip():
    """L'ordre est celui du clip — pas un tri par x (la 4e mire est au milieu)."""
    markers = [{"x": 100, "y": 700}, {"x": 200, "y": 700},
               {"x": 300, "y": 700}, {"x": 260, "y": 644}]  # la 4e entre 200 et 300
    pts = cg.facial_points_from_markers(markers)
    assert set(pts) == set(ROLES_FACIAUX)
    assert pts["facial_gauche"][0] == 100
    assert pts["facial_haute"][0] == 260
    # moins de 4 mires : pas de diagnostic plutôt qu'un diagnostic faux
    assert cg.facial_points_from_markers(markers[:3]) == {}


def test_le_diagnostic_est_serialisable_meme_incomplet():
    """`facial_quad_check` doit rester sûr avec des points manquants."""
    partiel = cg.facial_quad_check({"facial_centre": (10.0, 10.0),
                                    "facial_haute": (40.0, -5.0)})
    assert partiel["n_points"] == 2
    assert partiel["scale_consistent"] is False
    assert partiel["roll_deg"] == pytest.approx(
        math.degrees(math.atan2(15.0, 30.0)) - cg.FACIAL_ROLL_REFS_DEG["haute_centre"],
        abs=1e-9)
    assert partiel["roll_disagreement_deg"] is None
    assert partiel["roll_consistent"] is False
    # sérialisable : aucun objet exotique
    import json
    json.dumps(partiel)


# ── Orientation de la prise de vue (selfie miroir / caméra arrière) ──────────

def test_l_orientation_se_lit_sur_la_signature_des_quadrants():
    """Le damier dit lui-même si l'image est retournée, ou non.

    Les 10 damiers du clip portent la MÊME signature : quadrants NO et SE sombres
    (relevé sur les STL). Une image retournée par un selfie l'INVERSE.
    ⚠️ Une rotation de 180° ne la change PAS (elle échange NO↔SE et NE↔SO) : le test
    est donc spécifique au MIROIR, pas à l'orientation de l'image — indispensable,
    puisque se tromper inverse l'œil droit et l'œil gauche sur une mesure monoculaire.
    """
    normale = {"NO": 40.0, "NE": 160.0, "SO": 165.0, "SE": 45.0}
    assert cg.orientation_depuis_quadrants(normale) == cg.ORIENTATION_NORMALE

    miroir = {"NO": normale["NE"], "NE": normale["NO"],
              "SO": normale["SE"], "SE": normale["SO"]}
    assert cg.orientation_depuis_quadrants(miroir) == cg.ORIENTATION_MIROIR

    demi_tour = {"NO": normale["SE"], "NE": normale["SO"],
                 "SO": normale["NE"], "SE": normale["NO"]}
    assert cg.orientation_depuis_quadrants(demi_tour) == cg.ORIENTATION_NORMALE


def test_aucune_conclusion_quand_le_damier_est_illisible():
    """Mieux vaut ne RIEN affirmer que d'inverser gauche et droite.

    Un damier illisible (flou, ombre, reflet) ne doit produire aucune orientation :
    une conclusion fausse est pire qu'une absence de conclusion, puisque le front
    s'en servirait pour nommer l'œil droit et l'œil gauche.
    """
    plat = {"NO": 120.0, "NE": 124.0, "SO": 118.0, "SE": 122.0}   # contraste 6 < 8
    assert cg.orientation_depuis_quadrants(plat) == cg.ORIENTATION_INDETERMINEE
    assert cg.orientation_depuis_quadrants({}) == cg.ORIENTATION_INDETERMINEE
    incomplet = {"NO": 40.0, "NE": 160.0}
    assert cg.orientation_depuis_quadrants(incomplet) == cg.ORIENTATION_INDETERMINEE
