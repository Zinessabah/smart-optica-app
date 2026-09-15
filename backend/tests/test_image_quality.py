"""Porte de qualité des images : intégrité et résolution.

Deux défauts réels ont motivé ces tests :
  · des fichiers de 0 octet enregistrés dans les uploads (la sauvegarde n'avait
    aucune validation, contrairement aux endpoints d'analyse) ;
  · aucune vérification de résolution, alors que la précision cible de ±0,5 mm
    impose un minimum de pixels.
"""
import pytest
from fastapi import HTTPException

from image_quality import (
    KIND_FACE,
    KIND_PROFILE,
    MIN_LONG_SIDE_FACE,
    MIN_LONG_SIDE_PROFILE,
    check_resolution,
    detect_format,
    resolution_error,
    validate_image_bytes,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF" + b"\x00" * 4 + b"WEBP" + b"\x00" * 64


class TestIntegrite:
    """Le contrôle qui manquait à la sauvegarde des photos."""

    def test_refuse_un_fichier_vide(self):
        with pytest.raises(HTTPException) as e:
            validate_image_bytes(b"")
        assert e.value.status_code == 400
        assert "vide" in e.value.detail.lower()

    def test_refuse_un_fichier_trop_court(self):
        with pytest.raises(HTTPException) as e:
            validate_image_bytes(b"\x89PNG")
        assert e.value.status_code == 400

    def test_refuse_un_format_inconnu(self):
        with pytest.raises(HTTPException) as e:
            validate_image_bytes(b"GIF89a" + b"\x00" * 64)
        assert e.value.status_code == 400
        assert "autorisé" in e.value.detail

    def test_accepte_les_trois_formats(self):
        assert validate_image_bytes(PNG) == "png"
        assert validate_image_bytes(JPEG) == "jpeg"
        assert validate_image_bytes(WEBP) == "webp"

    def test_identifie_par_signature_pas_par_extension(self):
        """Un PNG renommé .jpg doit être reconnu comme PNG."""
        assert detect_format(PNG) == "png"
        assert detect_format(b"pas une image") is None


class TestResolution:
    def test_accepte_les_photos_reelles_de_l_ipad(self):
        # 4032x3024, la résolution réellement utilisée par Driss
        assert resolution_error(4032, 3024, KIND_FACE) is None
        assert resolution_error(4032, 3024, KIND_PROFILE) is None

    def test_refuse_juste_sous_le_seuil(self):
        assert resolution_error(MIN_LONG_SIDE_FACE, 1500, KIND_FACE) is None
        assert resolution_error(MIN_LONG_SIDE_FACE - 1, 1500, KIND_FACE) is not None

    def test_insensible_a_l_orientation(self):
        """Le grand côté est identique en portrait comme en paysage — donc le
        verdict ne dépend pas de la rotation EXIF."""
        assert resolution_error(3024, 4032, KIND_PROFILE) is None
        assert resolution_error(4032, 3024, KIND_PROFILE) is None
        assert resolution_error(1000, 1500, KIND_PROFILE) is not None

    def test_refuse_la_resolution_de_la_voie_video(self):
        """La voie getUserMedia demande 1920x1080 : insuffisant pour ±0,5 mm."""
        assert resolution_error(1920, 1080, KIND_FACE) is not None
        assert resolution_error(1920, 1080, KIND_PROFILE) is not None

    def test_le_lateral_est_plus_exigeant(self):
        assert MIN_LONG_SIDE_PROFILE > MIN_LONG_SIDE_FACE
        # une photo acceptable en facial peut ne pas l'être en latéral
        assert resolution_error(2200, 1600, KIND_FACE) is None
        assert resolution_error(2200, 1600, KIND_PROFILE) is not None

    def test_check_resolution_leve_une_422_explicite(self):
        with pytest.raises(HTTPException) as e:
            check_resolution(1280, 960, KIND_PROFILE)
        assert e.value.status_code == 422
        assert "1280×960" in e.value.detail
        assert str(MIN_LONG_SIDE_PROFILE) in e.value.detail

    def test_dimensions_illisibles(self):
        assert resolution_error(0, 0, KIND_FACE) is not None
        assert resolution_error(None, None, KIND_FACE) is not None
