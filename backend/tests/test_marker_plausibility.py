"""Garde-fou de vraisemblance des mires latérales.

Historique : le détecteur a renvoyé deux taches sombres distantes de 37 px en les
présentant comme les mires du clip (25 mm), soit un champ photographié de 2,7 m sur
une photo de profil — physiquement impossible. `scale_consistent` restait `True`
faute d'échelle frontale à comparer, donc rien ne rejetait cette mesure.

Les cas ci-dessous sont des mesures réelles faites sur les photos de Driss
(iPad, 4032x3024).
"""
from lateral import (
    LATERAL_MARKER_SPACING_MM,
    LATERAL_MARKER_SPACING_MM_NEW,
    field_width_mm,
    pair_is_plausible,
    spacing_px_bounds,
)

SPACINGS = (LATERAL_MARKER_SPACING_MM, LATERAL_MARKER_SPACING_MM_NEW)
W, H = 3024, 4032


class TestRejets:
    """Ce qui n'est PAS le clip doit être rejeté, sans exception."""

    def test_37_px_cas_reel_2_7_metres(self):
        """La mesure qui a motivé ce garde-fou : 37 px pour 25 mm → 2,7 m."""
        assert field_width_mm(37, 25, W, H) > 2000
        assert not pair_is_plausible(37, SPACINGS, W, H)

    def test_13_px_trois_fois_le_meme_detail(self):
        assert not pair_is_plausible(13, SPACINGS, W, H)

    def test_un_ecart_nul_ou_negatif(self):
        assert not pair_is_plausible(0, SPACINGS, W, H)
        assert not pair_is_plausible(None, SPACINGS, W, H)

    def test_un_ecart_astronomique_est_rejete(self):
        """Un couple trop écarté implique un champ trop serré pour être la branche."""
        assert not pair_is_plausible(3000, SPACINGS, W, H)


class TestAcceptations:
    """Un cadrage légitime ne doit JAMAIS être rejeté."""

    def test_ecart_reel_du_clip_212_px(self):
        """~212 px pour 25 mm → 0,118 mm/px → champ de 357 mm : le cadrage courant."""
        assert pair_is_plausible(212, SPACINGS, W, H)

    def test_cadrage_large_124_px(self):
        """124 px pour 25 mm → champ de 610 mm. Volontairement ACCEPTÉ : les cadrages
        réels de Driss vont jusqu'à 682 mm (mesuré sur les mires faciales). Rejeter ce
        cas reviendrait à refuser des photos valides."""
        assert pair_is_plausible(124, SPACINGS, W, H)

    def test_mires_faciales_tres_ecartees(self):
        """415 px : écart mesuré sur une vraie photo faciale (confiance 1,000)."""
        assert pair_is_plausible(415, SPACINGS, W, H)


    def test_732_px_avec_25_mm_est_rejete(self):
        """Le trou de la première version : un couple de 732 px jugé « plausible pour
        35 mm », alors que l'échelle REELLEMENT retenue prenait 25 mm — soit un champ
        de 138 mm, tout aussi impossible qu'un champ de 2,7 m. Le contrôle doit porter
        sur l'espacement effectivement utilisé, jamais sur « l'un ou l'autre »."""
        assert field_width_mm(732, 25, W, H) < 150          # 138 mm : absurde
        assert not pair_is_plausible(732, 25, W, H)
        # En revanche, le même couple est crédible s'il s'agit vraiment du clip à 35 mm
        assert pair_is_plausible(732, 35, W, H)


class TestIndependanceDeLaResolution:
    """Le contrôle est relatif à la taille de l'image, donc valable sur tout appareil."""

    def test_meme_cadrage_physique_sur_une_photo_de_telephone(self):
        # 212 px sur 4032 de long, c'est 140 px sur 2667 de long : même champ réel
        assert pair_is_plausible(212, SPACINGS, 3024, 4032)
        assert pair_is_plausible(140, SPACINGS, 2000, 2667)

    def test_un_ecart_absurde_reste_absurde_sur_petite_image(self):
        assert not pair_is_plausible(24, SPACINGS, 2000, 2667)

    def test_les_bornes_sont_coherentes(self):
        lo, hi = spacing_px_bounds(SPACINGS, W, H)
        assert lo < hi
        assert 37 < lo          # le cas réel rejeté est bien sous la borne
        assert hi > 415         # un cadrage très serré reste dans les bornes
