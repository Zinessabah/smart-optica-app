"""Détection FACIALE du clip v19.5 — 4 mires (3 alignées + 1 surélevée), multi-échelle, sans IPD.

Ce que ces tests verrouillent :
  1. l'échelle faciale vient de l'écartement CONNU des 2 mires extrêmes (100,00 mm),
     jamais d'un « IPD de 63 mm pour tout le monde » — le facteur empirique que le
     clip de référence existe précisément pour supprimer ;
  2. le triplet de base est ÉQUIDISTANT (−50/0/+50 mm), puis la 4ᵉ mire est validée
     à x = +30 mm du centre et à 14,00 mm AU-DESSUS de la rangée ;
  3. l'ÉCART vertical vaut 14,00 mm (z 17,00 − z 3,00) : « 17 » est une POSITION
     (`stem_top_z`), pas un décalage — confondre les deux le surestime de 21 % ;
  4. la NON-MAXIMUM SUPPRESSION ne laisse qu'UN pic par mire : sans elle, un triplet
     s'apparie sur des maxima secondaires du damier et l'échelle sort fausse de 18 % ;
  5. un damier de carreau inconnu est trouvé quand même (balayage multi-échelle) ;
  6. un champ physiquement invraisemblable est refusé.

⚠ CONVENTION : `_scan_facial_strip` attend le **QUADRANT** (PATTERN_QUADRANT_MM,
2,50 mm), pas le carreau (5,00 mm). Les tests ont longtemps passé le carreau : ils
ne reproduisaient donc pas l'appel de l'app (pitfall « reproduire l'appel exact »),
et toléraient des positions à ±35 px d'erreur.
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


def quadrant_px(scale=SCALE):
    """Décalage d'échantillonnage des quadrants, comme le fait l'app."""
    return int(round(clip.PATTERN_QUADRANT_MM / scale))


def _damiers_4_mires(scale=SCALE, dy_mm=None, x4_frac=0.6):
    """Les 4 mires faciales : −50 / 0 / +50 (rangée) + la surélevée.

    `dy_mm` = écart vertical de la 4ᵉ mire (défaut : la valeur du clip, 14,00 mm).
    `x4_frac` = position horizontale de la 4ᵉ mire, en fraction de l'écartement
    adjacent (30/50 = 0,6 dans le clip).

    Retourne (image niveaux de gris, [x des 3 mires de la rangée], (x, y) de la 4ᵉ).
    """
    if dy_mm is None:
        dy_mm = clip.FACIAL_RAISED_Z_GAP_MM
    img = np.full((H, W), 150, np.uint8)
    demi = int(round(clip.PATTERN_SQUARE_MM / scale))       # carreau de 5 mm
    ecart_px = int(round(clip.FACIAL_SPACING_ADJACENT_MM / scale))
    xs_rang = [300, 300 + ecart_px, 300 + 2 * ecart_px]
    x_4e = xs_rang[1] + int(round(x4_frac * ecart_px))
    y_4e = Y_CLIP - int(round(dy_mm / scale))

    for px in xs_rang:
        for (sx, sy) in ((-1, -1), (1, 1)):                 # carreaux NW et SE noirs
            x0 = px + (0 if sx > 0 else -demi)
            y0 = Y_CLIP + (0 if sy > 0 else -demi)
            img[y0:y0 + demi, x0:x0 + demi] = 30

    for (sx, sy) in ((-1, -1), (1, 1)):                     # 4ᵉ mire, même motif
        x0 = x_4e + (0 if sx > 0 else -demi)
        y0 = y_4e + (0 if sy > 0 else -demi)
        img[y0:y0 + demi, x0:x0 + demi] = 30

    return img, xs_rang, (x_4e, y_4e)


def _make_peaks(xs, score=50.0, y=Y_CLIP):
    return [{"x": x, "y": y, "score": score} for x in xs]


def _bande_reelle(scale=SCALE):
    """Le scan de la rangée sur l'image de référence (convention de l'app)."""
    gray, xs_rang, x4 = _damiers_4_mires(scale)
    q = quadrant_px(scale)
    peaks = main._scan_facial_strip(gray, cv2.integral(gray), 0, W, Y_CLIP, q, W, H)
    return gray, xs_rang, x4, q, peaks


def _call_quad(peaks, gray, integral, clip_y=Y_CLIP, quadrant=10, known_scale=None,
               x0=0, x1=W):
    """Wrapper sur la signature réelle de `_best_facial_quadruplet`."""
    return main._best_facial_quadruplet(peaks, gray, integral, W, H,
                                         clip_y, quadrant, x0, x1, known_scale)


def _gray_vide():
    g = np.full((H, W), 150, np.uint8)
    return g, cv2.integral(g)


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
# 2. L'écart vertical de la 4e mire : 14,00 mm (pas 17)
# ════════════════════════════════════════════════════════════════════════════

def test_le_14_mm_vient_de_la_geometrie_du_clip():
    """L'écart vertical est DÉRIVÉ des positions, jamais recopié."""
    assert clip.FACIAL_RAISED_Z_GAP_MM == pytest.approx(14.00)
    assert clip.FACIAL_BAR_Z_MM == 3.00
    assert clip.FACIAL_RAISED_Z_GAP_MM == (clip.facial_plan_pos("facial_haute")[1]
                                           - clip.FACIAL_BAR_Z_MM)
    # « 17 » reste la POSITION absolue, et ne doit jamais servir de décalage
    assert clip.facial_plan_pos("facial_haute")[1] == 17.0
    assert clip.FACIAL_RAISED_Z_GAP_MM != 17.0
    assert clip.FACIAL_RAISED_X_FROM_CENTRE_MM == pytest.approx(30.00)


def test_une_4e_mire_a_17_mm_est_refusee():
    """Preuve que la correction est active : la mire construite à 17 mm est REJETÉE.

    Avec l'ancien décalage (17 mm), ce cas passait pour valide — c'est exactement
    l'erreur corrigée.
    """
    gray, _, _, q, peaks = _bande_reelle()
    quad, _ = _call_quad(peaks, gray, cv2.integral(gray), Y_CLIP, q, SCALE)
    assert quad, "la bande de référence doit d'abord être reconnue"

    gray17, _, _ = _damiers_4_mires(SCALE, dy_mm=17.0)
    quad17, _ = _call_quad(peaks, gray17, cv2.integral(gray17), Y_CLIP, q, SCALE)
    assert not quad17 or quad17 == [], "une 4e mire à 17 mm ne doit plus être validée"


# ════════════════════════════════════════════════════════════════════════════
# 3. Balayage multi-échelle des décalages quadrant
# ════════════════════════════════════════════════════════════════════════════

def test_offsets_quadrant_multi_echelle():
    """Sans échelle: balayage. Avec échelle: le quadrant du clip d'abord."""
    offsets = main._facial_quadrant_offsets(None)
    assert offsets == list(main.FACIAL_QUADRANT_SWEEP)
    assert main.FACIAL_QUADRANT_MM == clip.PATTERN_QUADRANT_MM == 2.5

    connus = main._facial_quadrant_offsets(SCALE)
    assert connus[0] == quadrant_px(SCALE)             # 10 px = quadrant à 0,25 mm/px
    assert len(connus) == len(set(connus)), "pas de doublon dans le balayage"


# ════════════════════════════════════════════════════════════════════════════
# 4. Non-maximum suppression : UN pic par mire
# ════════════════════════════════════════════════════════════════════════════

def test_nms_laisse_un_seul_pic_par_mire():
    """Sans NMS, un damier donne ~4 maxima et le triplet s'apparie de travers."""
    _, _, _, _, peaks = _bande_reelle()
    assert len(peaks) == 3, f"3 mires de rangée ⇒ 3 pics, {len(peaks)} trouvés"
    ecarts = [peaks[i + 1]["x"] - peaks[i]["x"] for i in range(len(peaks) - 1)]
    assert max(ecarts) - min(ecarts) <= 4, f"rangée irrégulière : {ecarts}"


def test_positions_exactes_sur_la_bande_reelle():
    """Le détecteur doit tomber sur les mires à ±2 px (convention correcte)."""
    gray, xs_rang, x4, q, peaks = _bande_reelle()
    quad, info = _call_quad(peaks, gray, cv2.integral(gray), Y_CLIP, q, SCALE)
    assert quad, "aucun quadruplet retenu"
    xs = [p["x"] for p in quad]
    for i in range(3):
        assert abs(xs[i] - xs_rang[i]) <= 2, f"mire {i} : {xs[i]} vs {xs_rang[i]}"
    assert abs(xs[3] - x4[0]) <= 2, f"4e mire : {xs[3]} vs {x4[0]}"
    assert math.isclose(info["scale"], SCALE, rel_tol=0.01)


# ════════════════════════════════════════════════════════════════════════════
# 5. Sélection du quadruplet (3 équidistantes + 4e validée)
# ════════════════════════════════════════════════════════════════════════════

def test_quadruplet_valide_est_retenu():
    """4 mires valides : 3 équidistantes + 4e au bon x et au bon Δy."""
    gray, xs_rang, (x4, y4), q, peaks = _bande_reelle()
    carreau = int(round(clip.PATTERN_SQUARE_MM / SCALE))

    quad, info = _call_quad(peaks, gray, cv2.integral(gray), Y_CLIP, q, SCALE)
    assert quad, "aucun quadruplet valide retenu"
    xs = [p["x"] for p in quad]
    assert xs[:3] == pytest.approx(xs_rang, abs=2)
    assert xs[3] == pytest.approx(x4, abs=2)
    # Δy : 14,00 mm au-dessus de la rangée (ÉCART, pas position absolue)
    dy = abs(quad[3]["y"] - quad[0]["y"])
    expected_dy = int(round(clip.FACIAL_RAISED_Z_GAP_MM / SCALE))
    assert expected_dy == 56, "14,00 mm à 0,25 mm/px = 56 px"
    assert dy == pytest.approx(expected_dy, abs=carreau)
    # l'échelle se déduit des 100,00 mm connus, sans aucun IPD supposé
    span = xs[2] - xs[0]
    assert info["scale"] == pytest.approx(clip.FACIAL_SPACING_EXTREME_MM / span)
    assert math.isclose(info["scale"], SCALE, rel_tol=0.01)


def test_4e_mire_hors_x_refusee():
    """La 4e mire trop à droite (fraction 1,6 au lieu de 0,6) est refusée."""
    gray, _, _, q, peaks = _bande_reelle()
    gray_hx, _, _ = _damiers_4_mires(SCALE, x4_frac=1.6)
    quad, _ = _call_quad(peaks, gray_hx, cv2.integral(gray_hx), Y_CLIP, q, SCALE)
    assert quad == []


def test_4e_mire_sur_la_rangee_refusee():
    """Une 4e mire au même niveau que la rangée (Δy = 0) est refusée."""
    gray, _, _, q, peaks = _bande_reelle()
    gray_0, _, _ = _damiers_4_mires(SCALE, dy_mm=0.0)
    quad, _ = _call_quad(peaks, gray_0, cv2.integral(gray_0), Y_CLIP, q, SCALE)
    assert quad == []


def test_4e_mire_bien_trop_haute_refusee():
    """Une 4e mire à 30 mm au-dessus (au lieu de 14) est refusée."""
    gray, _, _, q, peaks = _bande_reelle()
    gray_h, _, _ = _damiers_4_mires(SCALE, dy_mm=30.0)
    quad, _ = _call_quad(peaks, gray_h, cv2.integral(gray_h), Y_CLIP, q, SCALE)
    assert quad == []


def test_triplet_non_equidistant_refuse():
    """Des pics irréguliers ne sont pas les mires de la barre."""
    gray, integral = _gray_vide()
    peaks = _make_peaks([300, 400, 700], 90.0) + [{"x": 620, "y": Y_CLIP, "score": 80.0}]
    quad, _ = _call_quad(peaks, gray, integral, Y_CLIP, 10)
    assert quad == []


def test_champ_invraisemblable_refuse():
    """Un span qui implique un champ hors bornes n'est pas le clip."""
    gray, integral = _gray_vide()
    peaks = _make_peaks([10, 12, 14], 90.0) + [{"x": 17, "y": Y_CLIP, "score": 80.0}]
    quad, _ = _call_quad(peaks, gray, integral, Y_CLIP, 10)
    assert quad == []


def test_trois_pics_ne_suffisent_pas():
    """Trois pics alignés ne suffisent pas : la 4e mire doit exister."""
    gray, integral = _gray_vide()
    quad, info = _call_quad(_make_peaks([300, 500, 700], 9.0), gray, integral, Y_CLIP, 10)
    assert quad == []
    assert info["score"] < 0


def test_deux_pics_ne_suffisent_pas():
    gray, integral = _gray_vide()
    quad, info = _call_quad(_make_peaks([300, 500], 9.0), gray, integral, Y_CLIP, 10)
    assert quad == []
    assert info["score"] < 0


# ════════════════════════════════════════════════════════════════════════════
# 6. Bout en bout : damier facial trouvé sans échelle connue
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("carreau_px", [10, 14])   # carreau de 5 mm à 0,50 puis 0,357 mm/px
def test_scan_trouve_le_quadruplet_sans_echelle(carreau_px):
    """Le motif est trouvé même quand l'échelle de la photo n'est pas connue."""
    scale = clip.PATTERN_SQUARE_MM / carreau_px
    gray, xs_rang, (x4, y4) = _damiers_4_mires(scale)
    q = quadrant_px(scale)
    integral = cv2.integral(gray)

    peaks = main._scan_facial_strip(gray, integral, 0, W, Y_CLIP, q, W, H)
    assert len(peaks) == 3, f"3 mires de rangée ⇒ 3 pics, {len(peaks)} trouvés"

    quad, info = _call_quad(peaks, gray, integral, Y_CLIP, q, scale)
    assert quad, "aucun quadruplet valide retenu"
    xs = [p["x"] for p in quad]
    assert xs[:3] == pytest.approx(xs_rang, abs=2)
    assert xs[3] == pytest.approx(x4, abs=2)

    span = xs[2] - xs[0]
    assert info["scale"] == pytest.approx(clip.FACIAL_SPACING_EXTREME_MM / span)
    assert math.isclose(info["scale"], scale, rel_tol=0.01)


def test_bande_vide_aucun_quadruplet():
    gray, integral = _gray_vide()
    peaks = main._scan_facial_strip(gray, integral, 0, W, Y_CLIP, 10, W, H)
    assert peaks == []
    quad, _ = _call_quad(peaks, gray, integral, Y_CLIP, 10)
    assert quad == []


# ════════════════════════════════════════════════════════════════════════════
# 7. Chemin RÉEL de bout en bout — `detect_facial_quadruplet`
#    (extrait de `detect_calibration_markers` pour être exerçable sans MediaPipe :
#     le guidage facial est fourni en arguments). Ces tests remplaçaient un `pass`
#     qui laissait le chemin le plus critique de l'app non testé.
# ════════════════════════════════════════════════════════════════════════════

Y_BARRE = 700


def _image_clip(dy_mm=None, y_barre=Y_BARRE, scale=SCALE, avec_4e=True, cote_4e=1):
    """Image synthétique du clip : 3 mires alignées + (option) la 4ᵉ surélevée.

    `avec_4e=False` reproduit un clip à **3 mires faciales seulement** — le cas des
    photos réelles disponibles (3 damiers alignés, aucune mire surélevée).
    `cote_4e=-1` place la 4ᵉ mire à GAUCHE du centre : c'est la topologie d'une photo
    prise en MIROIR (selfie iOS), où le clip apparaît retourné.
    """
    if dy_mm is None:
        dy_mm = clip.FACIAL_RAISED_Z_GAP_MM
    img = np.full((H, W), 150, np.uint8)
    demi = int(round(clip.PATTERN_SQUARE_MM / scale))
    ecart = int(round(clip.FACIAL_SPACING_ADJACENT_MM / scale))
    xs = [300, 300 + ecart, 300 + 2 * ecart]
    x4 = xs[1] + cote_4e * int(round(0.6 * ecart))
    y4 = y_barre - int(round(dy_mm / scale))
    for px in xs:
        for (sx, sy) in ((-1, -1), (1, 1)):
            img[y_barre + (0 if sy > 0 else -demi):y_barre + (demi if sy > 0 else 0),
                px + (0 if sx > 0 else -demi):px + (demi if sx > 0 else 0)] = 30
    if avec_4e:
        for (sx, sy) in ((-1, -1), (1, 1)):
            img[y4 + (0 if sy > 0 else -demi):y4 + (demi if sy > 0 else 0),
                x4 + (0 if sx > 0 else -demi):x4 + (demi if sx > 0 else 0)] = 30
    return img, xs, (x4, y4)


def _detecte(dy_mm=None, y_barre=Y_BARRE, known_scale=SCALE, avec_4e=True, cote_4e=1):
    return main.detect_facial_quadruplet(
        _image_clip(dy_mm, y_barre, avec_4e=avec_4e, cote_4e=cote_4e)[0],
        Y_BARRE, 100, 1100, known_scale)


def test_bout_en_bout_une_photo_en_miroir_est_acceptee():
    """4ᵉ mire à GAUCHE du centre = photo en MIROIR (selfie iOS) — doit être acceptée.

    Constaté sur les vraies photos du clip v19.5 : les quadrants sombres du damier y
    sont en NE+SO alors que le clip les a en NO+SE, donc l'image est retournée, et la
    4ᵉ mire — qui est à +30 mm du centre sur le clip — apparaît à GAUCHE. Sa position
    en x n'a aucune importance métrologique (seuls comptent les écartements et la
    hauteur) : le détecteur doit donc simplement la trouver. Sans ce traitement il
    cherchait du mauvais côté, retenait un pic SANS AUCUN motif damier (contraste
    mesuré : nul) et rejetait un clip parfaitement valide.
    """
    _, _, (x4, y4) = _image_clip(cote_4e=-1)
    r = _detecte(cote_4e=-1)

    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.01)
    assert len(r["markers"]) == 4
    mx = [m["x"] for m in r["markers"]]
    assert abs(mx[3] - x4) <= 3, f"4e mire : {mx[3]} vs {x4}"
    q = r["facial_quad_check"]
    assert q["quad_valid"] is True
    # le roll est rendu dans le repère de l'IMAGE (signe rétabli après réflexion)
    assert q["roll_deg"] is not None


def test_bout_en_bout_le_clip_est_trouve_et_l_echelle_est_juste():
    """Le chemin réel rend les 4 mires, à la bonne place, avec la bonne échelle."""
    _, xs, (x4, y4) = _image_clip()
    r = _detecte()

    assert r["face_used"] is True
    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.01)
    assert len(r["markers"]) == 4

    mx = [m["x"] for m in r["markers"]]
    for i in range(3):
        assert abs(mx[i] - xs[i]) <= 2, f"mire {i} : {mx[i]} vs {xs[i]}"
    assert abs(mx[3] - x4) <= 2
    assert abs(r["markers"][3]["y"] - y4) <= 2, "hauteur de la 4ᵉ mire"
    for m in r["markers"][:3]:
        assert abs(m["y"] - Y_BARRE) <= 2, "hauteur réelle de la rangée"


def test_bout_en_bout_le_diagnostic_du_quadrilatere_est_expose():
    """A+B+C sont rendus par l'API et concordent sur un clip net."""
    q = _detecte()["facial_quad_check"]
    assert q is not None and q["n_points"] == 4
    assert q["scale_consistent"] is True, f"étalons dispersés : {q['scale_spread']}"
    assert q["ratios_consistent"] is True
    assert q["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.01)
    # les 5 étalons du quadrilatère servent à l'auto-contrôle
    assert len(q["scale_by_span"]) == 5


def test_bout_en_bout_le_roll_d_un_clip_droit_est_nul():
    """Un clip bien posé ⇒ roll ≈ 0 et les 2 références concordent.

    Le seuil n'est pas nul : la mesure vaut ±1 px, soit ~0,2°. Un roll de
    plusieurs degrés trahirait une hauteur mal mesurée.
    """
    q = _detecte()["facial_quad_check"]
    assert abs(q["roll_deg"]) < 1.0, f"roll {q['roll_deg']} sur un clip droit"
    assert q["roll_consistent"] is True


def test_bout_en_bout_le_clip_est_trouve_sans_echelle_connue():
    """Aucune échelle supposée : le balayage multi-échelle suffit."""
    r = _detecte(known_scale=None)
    assert r["face_used"] is True
    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.01)
    assert len(r["markers"]) == 4


@pytest.mark.parametrize("decalage", [-10, 10])
def test_bout_en_bout_le_clip_est_trouve_meme_si_la_barre_est_mal_situee(decalage):
    """`clip_y` n'est qu'une position de RECHERCHE : ±10 px d'erreur et ça tient.

    La vraie hauteur est retrouvée par affinage, donc l'échelle et le roll restent
    justes — c'est ce qui autorise à se fier au niveau des sourcils.
    """
    y_true = Y_BARRE + decalage
    r = main.detect_facial_quadruplet(_image_clip(y_barre=y_true)[0],
                                      Y_BARRE, 100, 1100, SCALE)
    assert len(r["markers"]) == 4
    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.01)
    for m in r["markers"][:3]:
        assert abs(m["y"] - y_true) <= 3, "la hauteur réelle doit être mesurée"
    assert abs(r["markers"][3]["y"] - (y_true - int(round(14.0 / SCALE)))) <= 3


def test_bout_en_bout_une_4e_mire_a_17_mm_est_refusee():
    """4ᵉ mire à 17 mm : NON validée — mais la rangée reste mesurable.

    L'ancienne cote (17 mm) est franchement incohérente avec la géométrie du clip.
    On ne l'accepte donc pas : `quad_valid` est False, le roll n'est pas exposé.
    ⚠️ Pour autant l'analyse ne doit PAS échouer : un clip dont la 4ᵉ mire n'est pas
    exploitable (absent, ou mal vu) reste un clip utilisable — c'est le cas réel des
    photos du clip à 3 mires faciales. D'où la DÉGRADATION GRACIEUSE : les 3 mires
    de la rangée sont rendues, avec l'échelle du span des extrêmes.
    """
    r = _detecte(dy_mm=17.0)
    q = r["facial_quad_check"]
    assert q is not None and q["ratios_consistent"] is False
    # Deux modes de rejet, tous deux honnêtes :
    #  • la 4ᵉ mire est écartée dès la RECHERCHE — 17 mm s'écartent de 21 % de la cote
    #    réelle (14 mm), au-delà de FACIAL_RAISED_TOL (15 %) : aucune référence hors
    #    rangée n'existe alors et `ratio_spread` reste None ;
    #  • ou elle est trouvée puis rejetée par l'incohérence des rapports invariants
    #    (cas d'un écart plus fin, où seule la géométrie départage).
    assert q["ratio_spread"] is None or q["ratio_spread"] > clip.FACIAL_SCALE_TOL
    # la 4ᵉ mire n'est pas validée…
    assert q["quad_valid"] is False
    # …donc aucune inclinaison n'est publiée (pas de référence fiable)
    assert q["roll_deg"] is None
    assert q["roll_consistent"] is None
    # …mais les 3 mires de la rangée sont bien rendues, échelle honnête
    assert len(r["markers"]) == 3
    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.02)
    assert r["markers"][:3] == sorted(r["markers"][:3], key=lambda m: m["x"])


def test_bout_en_bout_un_clip_a_3_mires_reste_mesurable():
    """Cas RÉEL (les photos disponibles) : 3 damiers alignés, aucune mire surélevée.

    Le détecteur ne doit ni échouer ni inventer une 4ᵉ mire : il rend les 3 mires de
    la rangée avec l'échelle du span des extrêmes, et signale la 4ᵉ comme non validée
    (`quad_valid` False, pas de roll publié). C'est ce qui évite de refuser un clip
    parfaitement utilisable — et de déclencher le repli Hough, qui gelait le serveur.
    """
    _, xs, _ = _image_clip(avec_4e=False)
    r = _detecte(avec_4e=False)
    assert len(r["markers"]) == 3, "les 3 mires de la rangée doivent être rendues"
    assert r["scale_mm_per_px"] == pytest.approx(SCALE, rel=0.02)
    q = r["facial_quad_check"]
    assert q is None or q["quad_valid"] is False
    if q is not None:
        assert q["roll_deg"] is None, "aucune inclinaison sans 4ᵉ mire validée"


def test_bout_en_bout_un_champ_sans_mire_ne_fabrique_rien():
    """Pas de mires ⇒ aucun marker inventé, et un diagnostic honnête."""
    r = main.detect_facial_quadruplet(np.full((H, W), 150, np.uint8),
                                      Y_BARRE, 100, 1100, SCALE)
    assert r["markers"] == []
    assert r["scale_mm_per_px"] == 0.0


def test_le_response_model_transporte_le_diagnostic_du_quadrilatere():
    """⚠️ Pydantic FILTRE silencieusement tout champ absent du `response_model`.

    `facial_quad_check` ne figurait pas dans `CalibrationResult` : la réponse HTTP
    le perdait, donc le front ne pouvait afficher ni le roll ni la non-validation de
    la 4ᵉ mire — tout en recevant 200. Un mock d'API côté front ne peut pas voir ce
    genre de perte : le contrat se vérifie ici, sur le modèle de réponse lui-même.
    """
    from main import CalibrationResult

    diag = {"n_points": 4, "roll_deg": 0.11, "roll_consistent": True, "quad_valid": True}
    r = CalibrationResult(width=10, height=10, markers=[{"x": 1, "y": 2}],
                          facial_quad_check=diag)
    assert r.model_dump()["facial_quad_check"] == diag
    # et le champ reste optionnel : un repli sans diagnostic ne casse rien
    assert CalibrationResult(width=1, height=1).model_dump()["facial_quad_check"] is None


def test_detect_calibration_markers_sans_visage_ne_plante_pas():
    """L'API publique reste utilisable sans visage : repli, sans rien fabriquer."""
    gray, _, _ = _image_clip()
    r = main.detect_calibration_markers(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
    assert "markers" in r
    assert r["face_used"] is False, "aucun visage sur une image synthétique"
    assert "facial_quad_check" in r, "contrat de réponse stable"

# ════════════════════════════════════════════════════════════════════════════
# 8. Le contrat de `_scan_facial_strip` : hauteur mesurée, pas hauteur cherchée
# ════════════════════════════════════════════════════════════════════════════

def test_scan_renvoie_le_y_de_recherche_pas_la_hauteur():
    """Documente le piège : le y rendu est celui du scan, d'où l'affinage."""
    gray, _, _ = _image_clip()
    integral = cv2.integral(gray)
    q = quadrant_px()
    for y_essai in (690, 700, 710):
        peaks = main._scan_facial_strip(gray, integral, 100, 1100, y_essai, q, W, H)
        assert peaks, "les mires de la rangée sont visibles"
        assert all(p["y"] == y_essai for p in peaks)


def test_refine_marker_2d_rend_le_centre_reel_du_damier():
    """Le barycentre du plateau de contraste = centre de la mire (symétrie).

    ⚠️ Le x est rendu TEL QUEL — c'est celui du balayage 1D. Le déplacer dégradait les
    ÉCARTEMENTS, qui sont la grandeur métrologique (mesuré sur la vraie photo :
    52,4 / 47,7 mm au lieu de 50 / 50). Seule la hauteur est affinée ici.
    """
    gray, xs, (x4, y4) = _image_clip()
    q = quadrant_px()

    for cx, y_vrai in ((xs[1], Y_BARRE), (x4, y4)):
        r = main._refine_marker_2d(gray, cx, y_vrai + 30, 40, q, W, H)
        assert r is not None
        # ±3 px : le milieu du plateau peut être décalé de 2 px par la fenêtre 6×6 px
        # des échantillons de `_check_checkerboard`. À 0,25 mm/px cela vaut 0,75 mm,
        # et 0,2 mm à l'échelle réelle d'une photo (0,084 mm/px) — sans effet sur les
        # seuils, qui portent sur l'écart vertical de 14 mm à 15 % près.
        assert abs(r["y"] - y_vrai) <= 3, f"y {r['y']} vs {y_vrai}"
        assert r["x"] == cx
