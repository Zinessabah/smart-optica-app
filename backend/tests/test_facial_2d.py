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

import clip_geometry as clip
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
    """Le filtre d'angle existe encore, mais il n'est PLUS actif par défaut.

    Il rejetait trois mires réelles sur la photo du clip à mires modifiées
    (corr 0,733 / 0,678 / 0,625, même échelle, orientations 100/260/280°) parce
    que les quadrants sombres n'y sont pas tous orientés pareil. C'est la pose
    qui valide désormais. On teste donc le filtre en le demandant explicitement.
    """
    a = {"x": 0, "y": 0, "corr": 0.9, "qo_px": 30, "angle": 270}
    b = {"x": 0, "y": 0, "corr": 0.8, "qo_px": 30, "angle": 30}
    assert facial_2d.coherents([a, b], angle_tol=25.0) == [a]
    # sans filtre d'angle, les deux sont compatibles (même échelle)
    assert len(facial_2d.coherents([a, b])) == 2


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


# ── affinage à pleine résolution ────────────────────────────────────────────

def _mire_sous_pixel(qo=20, angle=0, centre=(400.35, 300.68), taille=(600, 800)):
    """Mire collée à une position FRACTIONNAIRE, sans interpolation du gabarit."""
    img = np.full(taille, 128.0, np.float32)
    g = lc._gabarit(qo, angle)
    gh, gw = g.shape[:2]
    x, y = centre
    # centre d'un gabarit de taille impaire : (n-1)/2, comme dans le module
    x0, y0 = int(round(x - (gw - 1) / 2)), int(round(y - (gh - 1) / 2))
    img[y0:y0 + gh, x0:x0 + gw] = g
    dx, dy = x - (x0 + (gw - 1) / 2), y - (y0 + (gh - 1) / 2)
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    out = cv2.warpAffine(img, M, (taille[1], taille[0]),
                         flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return out.astype(np.uint8)


def test_affinage_remonte_la_correlation():
    """Le plafond de 0,725 est celui de la pyramide, pas celui de la détection."""
    img = _image_avec_mire(qo=20, angle=0, centre=(400, 300))
    grossier = facial_2d.detect_markers_2d(img, qo_min=4, qo_max=12, qo_step=2,
                                           angle_step=15)
    assert grossier
    g0 = grossier[0]
    fin = facial_2d.affiner_mire(img, g0)
    assert fin["affine"] is True
    assert fin["corr"] > g0["corr"], f"{fin['corr']} <= {g0['corr']}"
    assert fin["corr"] > 0.95, f"corr affinée = {fin['corr']}"


def test_affinage_position_sous_pixel():
    vrai = (400.35, 300.68)
    img = _mire_sous_pixel(qo=20, centre=vrai)
    grossier = facial_2d.detect_markers_2d(img, qo_min=4, qo_max=12, qo_step=2,
                                           angle_step=15)
    assert grossier
    fin = facial_2d.affiner_mire(img, grossier[0])
    # tolérance MESURÉE : biais nul, écart-type 1,02 px, max observé 1,50 px
    # sur une grille de décalages connus. Voir l'en-tête de la section
    # « Affinage à pleine résolution » dans facial_2d.py.
    assert abs(fin["x"] - vrai[0]) <= 1.5, f"x = {fin['x']}"
    assert abs(fin["y"] - vrai[1]) <= 1.5, f"y = {fin['y']}"
    assert fin["affine"] is True


def test_affinage_d_un_angle_decale():
    img = _image_avec_mire(qo=20, angle=7, centre=(300, 250))
    grossier = facial_2d.detect_markers_2d(img, qo_min=4, qo_max=12, qo_step=2,
                                           angle_step=15)
    assert grossier
    fin = facial_2d.affiner_mire(img, grossier[0])
    assert fin["corr"] > 0.95
    assert abs(fin["x"] - 300) <= 1.0 and abs(fin["y"] - 250) <= 1.0


def test_affinage_bord_d_image_ne_plante_pas():
    # mire annoncée près du bord : la fenêtre sort de l'image, l'affinage doit
    # rendre la détection grossière marquée `affine: False`, pas lever
    img = np.full((200, 200), 128, np.uint8)
    m = {"x": 30.0, "y": 30.0, "corr": 0.6, "qo_px": 20.0, "angle": 0.0}
    out = facial_2d.affiner_mire(img, m)
    assert "affine" in out and isinstance(out["corr"], float)


# ── appariement aux rôles du clip (v23.5 : deux triangles partageant le centre) ──

# cotes MESURÉES sur le STL du v23.5 imprimé, pas lues dans une doc
def mires_du_clip():
    """Les mires faciales DU MODÈLE, en (x, z) — aucune cote recopiée.

    Coder la v22 ou la v23.5 en dur ici ferait échouer ces tests à chaque
    changement de géométrie, pour une raison qui n'a rien à voir avec
    l'appariement. On interroge `clip_geometry`, source unique.
    """
    return {m["role"]: (float(m["x"]), float(m["z"])) for m in clip.FACIAL_MARKERS}


def _cinq_mires_projetees(scale_mm_per_px=0.05, perspective=0.0, angle_deg=0.0):
    """Les 5 mires du clip projetées, avec une perspective contrôlée."""
    mires = mires_du_clip()
    noms = list(mires)
    pts = np.array([[mires[n][0] / scale_mm_per_px + 900.0,
                     mires[n][1] / scale_mm_per_px + 500.0] for n in noms],
                   dtype=np.float32)
    if perspective:
        # homographie qui étire un côté : raccourcissement perspectif réaliste
        src = np.array([[0, 0], [1800, 0], [1800, 1000], [0, 1000]], np.float32)
        d = perspective
        dst = np.array([[0, 0], [1800 * (1 - d), 40], [1800, 1000], [0, 1000]], np.float32)
        H = cv2.getPerspectiveTransform(src, dst)
        pts = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), H).reshape(-1, 2)
    if angle_deg:
        M = cv2.getRotationMatrix2D((900, 500), angle_deg, 1.0)
        pts = cv2.transform(pts.reshape(-1, 1, 2), M).reshape(-1, 2)
    return [{"x": float(p[0]), "y": float(p[1]), "corr": 0.7, "qo_px": 25.0,
             "angle": 0.0, "role_vrai": n} for p, n in zip(pts, noms)]


def test_appariement_sans_perspective_retrouve_les_roles():
    cands = _cinq_mires_projetees(scale_mm_per_px=0.05)
    res = facial_2d.identifier_mires(cands)
    assert res is not None, "aucun appariement"
    assert res["residual"] < 0.02, f"résidu {res['residual']}"
    assert res["scale_mm_per_px"] == pytest.approx(0.05, rel=0.02)
    # Les rôles rendus doivent correspondre aux vrais. Le clip est symétrique :
    # échanger gauche et droite (et les deux pointes) donne un appariement tout
    # aussi valable, et la même échelle. On accepte donc les deux.
    miroir = {"facial_centre": "facial_centre", "facial_droite": "facial_gauche",
              "facial_gauche": "facial_droite", "facial_haute": "facial_haute_gauche",
              "facial_haute_gauche": "facial_haute"}
    identite = {r: r for r in mires_du_clip()}
    rendus = {r: cands[i]["role_vrai"] for r, i in res["roles"].items()}
    attendu_miroir = {r: miroir[v] for r, v in identite.items()}
    assert rendus in (identite, attendu_miroir), rendus


@pytest.mark.xfail(strict=True, reason=(
    "LIMITE MESURÉE : l'appariement par la forme échoue dès 5 % de "
    "raccourcissement perspectif (balayé 0,05 à 0,40 : échec partout, seul 0 % "
    "passe). Les rapports de côtés sont indépendants de l'ÉCHELLE mais PAS de la "
    "PERSPECTIVE. Conséquence d'architecture : il faut POSER pour identifier, "
    "pas identifier puis poser. Ce test devra être retourné en test de succès "
    "quand l'appariement sera résolu par la pose (étape 3)."))
def test_appariement_sous_perspective_ECHOUE_mesure():
    cands = _cinq_mires_projetees(scale_mm_per_px=0.05, perspective=0.10)
    res = facial_2d.identifier_mires(cands)
    assert res is not None, "la perspective fait échouer l'appariement"
    assert res["n_sides"] if "n_sides" in res else True


def test_appariement_avec_rotation():
    cands = _cinq_mires_projetees(scale_mm_per_px=0.05, angle_deg=23.0)
    res = facial_2d.identifier_mires(cands)
    assert res is not None
    assert res["scale_mm_per_px"] == pytest.approx(0.05, rel=0.02)


def test_appariement_refuse_une_geometrie_etrangere():
    # cinq points au hasard : aucun ne doit être promu en clip
    rng = np.random.default_rng(7)
    cands = [{"x": float(x), "y": float(y), "corr": 0.7, "qo_px": 25.0, "angle": 0.0}
             for x, y in rng.uniform(0, 2000, size=(5, 2))]
    assert facial_2d.identifier_mires(cands) is None


def test_appariement_refuse_des_echelles_incoherentes():
    cands = _cinq_mires_projetees()
    for i, m in enumerate(cands):
        m["qo_px"] = 25.0 if i < 4 else 60.0     # une mire à une autre échelle
    assert facial_2d.identifier_mires(cands) is None


# ── pose : POSER POUR IDENTIFIER ─────────────────────────────────────────────
#
# L'appariement par la forme seule échoue dès 5 % de raccourcissement (mesuré).
# La pose, elle, doit tenir à forte inclinaison. C'est le test qui compte.

def _projection_exacte(tilt_deg, dist_mm, f_px, yaw_deg=8.0, roll_deg=-12.0,
                       largeur=4032, hauteur=3024):
    """Projette les 5 mires du modèle par une pose CONNUE, sans aucun bruit."""
    noms, obj = facial_2d._modele_3d()
    K = np.array([[f_px, 0, largeur / 2], [0, f_px, hauteur / 2], [0, 0, 1]], float)
    rvec = np.array([np.radians(tilt_deg), np.radians(yaw_deg), np.radians(roll_deg)])
    tvec = np.array([-15.0, 20.0, dist_mm])
    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
    R, _ = cv2.Rodrigues(rvec)
    prof_vraie = float((R @ obj[0] + tvec)[2])
    return noms, obj, proj.reshape(-1, 2), prof_vraie / f_px, largeur


MIROIR_FACIAL = {"facial_centre": "facial_centre",
                 "facial_gauche": "facial_droite",
                 "facial_droite": "facial_gauche",
                 "facial_haute": "facial_haute_gauche",
                 "facial_haute_gauche": "facial_haute"}


def _roles_justes_ou_miroir(res, cands, noms):
    """L'affectation trouvée est-elle la bonne, au miroir près (clip symétrique) ?"""
    trouve = {role: cands.index(c) for role, c in res["roles"].items()}
    verite = {noms[i]: i for i in range(len(noms))}
    return trouve == verite or trouve == {r: verite[MIROIR_FACIAL[r]] for r in verite}


@pytest.mark.parametrize("tilt", [0.0, 15.0, 25.0, 35.0])
def test_pose_identifie_a_toute_inclinaison(tilt):
    noms, obj, proj, echelle_vraie, largeur = _projection_exacte(tilt, 700.0, 4800.0)
    candidats = list(range(5))
    cands = [{"x": float(proj[i][0]), "y": float(proj[i][1]), "corr": 0.7,
              "qo_px": 20.0, "angle": 0.0} for i in candidats]
    res = facial_2d.poser_et_identifier(cands, image_width=largeur)
    assert res is not None, f"aucune pose à {tilt}°"
    assert res["rms_px"] < 0.5, f"rms {res['rms_px']}"
    # l'échelle est la grandeur métrologique : mesurée à 0,03 % sur pose exacte
    assert res["scale_mm_per_px"] == pytest.approx(echelle_vraie, rel=0.005)
    assert _roles_justes_ou_miroir(res, cands, noms), res["roles"]


def test_pose_identifie_meme_a_courte_distance():
    noms, obj, proj, echelle_vraie, largeur = _projection_exacte(35.0, 450.0, 4800.0)
    cands = [{"x": float(p[0]), "y": float(p[1]), "corr": 0.7,
              "qo_px": 20.0, "angle": 0.0} for p in proj]
    res = facial_2d.poser_et_identifier(cands, image_width=largeur)
    assert res is not None
    assert res["scale_mm_per_px"] == pytest.approx(echelle_vraie, rel=0.005)


def test_pose_refuse_un_point_aberrant():
    noms, obj, proj, _, largeur = _projection_exacte(20.0, 700.0, 4800.0)
    cands = [{"x": float(p[0]), "y": float(p[1]), "corr": 0.7,
              "qo_px": 20.0, "angle": 0.0} for p in proj]
    cands[3]["x"] += 60.0            # une mire déplacée de 60 px
    res = facial_2d.poser_et_identifier(cands, image_width=largeur)
    assert res is None or res["rms_px"] > 1.0


def test_pose_refuse_moins_de_cinq_mires():
    cands = [{"x": float(i * 100), "y": 500.0, "corr": 0.7,
              "qo_px": 20.0, "angle": 0.0} for i in range(4)]
    assert facial_2d.poser_et_identifier(cands, image_width=4032) is None
