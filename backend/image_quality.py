"""Porte de qualité des images — un seul endroit pour toutes les règles.

Deux niveaux, volontairement séparés :

1. INTÉGRITÉ (toujours) — le fichier n'est pas vide et son format est reconnu par
   signature (magic bytes), pas par son extension. Sans ce contrôle,
   `_save_upload` écrivait des fichiers de 0 octet dans les uploads.

2. RÉSOLUTION (seuils dérivés) — assez de pixels pour tenir la précision cible.
   Le seuil n'est PAS arbitraire, il vient de la chaîne métrologique.

Origine des seuils (précision cible ±0,5 mm, fixée par Driss) :

    L'erreur relative d'échelle vaut  pointé_mire / écartement_px.

    Avec un pointé de mire à 1 px et un budget d'échelle de 0,3 mm sur une DP de
    65 mm (soit 0,46 %), il faut environ 217 px entre les deux mires.

    · Mires FACIALES  50 mm · champ typique 400 mm → 12,5 % de la largeur
                        → 217 / 0,125 ≈ 1740 px → seuil 2000 px
    · Mires LATÉRALES 25 mm · champ typique 300 mm →  8,3 % de la largeur
                        → 217 / 0,083 ≈ 2600 px → seuil 2600 px

    Le champ typique est une hypothèse EXPLICITE : c'est le cadrage courant. Un
    cadrage plus large reste accepté par le contrôle géométrique des mires, qui
    juge sur les pixels réellement trouvés, pas sur une hypothèse.

On mesure le GRAND côté de l'image : indépendant de l'orientation, donc insensible
à la rotation EXIF (le navigateur et OpenCV ne la présentent pas de la même façon,
mais le grand côté est le même).
"""

from fastapi import HTTPException

# ── Seuils de résolution, en pixels sur le grand côté ────────────────────────
MIN_LONG_SIDE_FACE = 2000      # photo faciale : calibrage sur les 3 mires à 50 mm
MIN_LONG_SIDE_PROFILE = 2600   # photo de profil : échelle sur les 2 mires à 25 mm
                               #   (25 mm occupent moins de largeur : plus exigeant)

KIND_FACE = "faciale"
KIND_PROFILE = "latérale"

# Formats acceptés, identifiés par leur signature et non par leur extension
JPEG_SIG = b"\xff\xd8\xff"
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def detect_format(data: bytes) -> str | None:
    """Retourne 'jpeg', 'png', 'webp' ou None. Signature réelle, jamais l'extension."""
    if data[:3] == JPEG_SIG:
        return "jpeg"
    if data[:8] == PNG_SIG:
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def validate_image_bytes(data: bytes) -> str:
    """Intégrité minimale. Lève une 400 explicite, retourne le format sinon.

    Utilisé par TOUT chemin qui reçoit une image — analyse comme sauvegarde.
    """
    if not data or len(data) < 12:
        raise HTTPException(400, "Fichier vide ou trop court")
    fmt = detect_format(data)
    if fmt is None:
        raise HTTPException(
            400, "Type de fichier non autorisé (JPEG/PNG/WebP uniquement)")
    return fmt


def resolution_error(width: int, height: int, kind: str) -> str | None:
    """Message d'erreur si la résolution est insuffisante, None sinon."""
    if not width or not height:
        return "Dimensions de l'image illisibles"
    seuil = MIN_LONG_SIDE_FACE if kind == KIND_FACE else MIN_LONG_SIDE_PROFILE
    grand = max(width, height)
    if grand >= seuil:
        return None
    return (f"Résolution insuffisante pour la photo {kind} : {width}×{height}. "
            f"Le grand côté doit atteindre {seuil} px pour garantir la précision "
            f"de ±0,5 mm — il en fait {grand}.")


def check_resolution(width: int, height: int, kind: str) -> None:
    """Lève une 422 si la résolution ne permet pas la précision cible."""
    message = resolution_error(width, height, kind)
    if message:
        raise HTTPException(422, message)
