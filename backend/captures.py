"""
Smart Optica — Réception des captures de l'application Android « Niveau Caméra ».

L'application `fr.niveaucamera.app` (niveau à bulle + capture photo native, version 1.2)
possède déjà toute sa chaîne de transfert : file d'attente Room, rejeu WorkManager avec
backoff exponentiel, idempotence par `clientCaptureId`, URL de serveur modifiable à chaud.
Ce module lui fournit le serveur qu'elle attend, **sans modifier une ligne de son code
réseau**.

Contrat implémenté — source de vérité : `openapi.yaml` de l'application (jalon P3)
-----------------------------------------------------------------------------------
    POST /captures/            multipart : `metadata` (JSON) + `photo` (JPEG)
    GET  /captures/            liste des captures de l'utilisateur
    GET  /captures/{id}        détail d'une capture
    GET  /captures/{id}/image  le fichier lui-même
    DELETE /captures/{id}      suppression

Le client concatène `/captures` à l'URL de base saisie dans ses paramètres
(`CaptureApiClient.normalizeEndpoint`) : une URL de base `http://hote:8000` produit donc
`POST http://hote:8000/captures`. C'est pourquoi `health` — déjà servi à la racine par
`main.py` — et ces routes cohabitent sans préfixe `/api`.

> `metadata` est le document `CaptureMetadata` de l'OpenAPI :

clientCaptureId             uuid     identifiant d'idempotence, stable
takenAtEpochMillis          int64    horodatage de la prise de vue
fileName                    texte    nom du fichier écrit par l'application
sizeBytes                   int64    taille RÉELLE du JPEG
kind                        texte?   `face` ou `profile`
rollDegrees                 float?   roulis dans le repère de l'ÉCRAN
pitchDegrees                float?   tangage, même règle
referenceIsCustom           bool     référence personnalisée active
exifOrientation             int?     orientation EXIF du fichier produit
angularSpeedDegreesPerSecond float?  vitesse angulaire (repère le flou de bougé)

`kind` dit ce que la photo MONTRE, et il est indispensable au centrage digital : celui-ci exige
la face ET le profil, sans quoi il n'a ni les pupilles ni l'angle pantoscopique. Aucun calcul ne
peut retrouver cette information — elle vient du geste de l'opticien. Une capture dont le genre
est absent ou inconnu reste donc `NULL` en base, et n'est jamais supposée « face ».

`rollDegrees` / `pitchDegrees` peuvent être `null` : l'application ne fabrique JAMAIS une
mesure quand le capteur est muet. On conserve donc la distinction « angle nul » (0,0°,
vraiment à l'aplomb) et « angle inconnu » (`null`), qui n'ont pas le même sens.

Réponses — la distinction est NORMATIVE côté application
--------------------------------------------------------
    201  création d'un nouveau `clientCaptureId`      → schéma `CaptureAccepted`
    200  doublon : déjà reçu (idempotence)            → schéma `CaptureAccepted`, status=duplicate
    400  requête malformée                            → DÉFINITIF, jamais rejoué
    401  jeton absent, invalide ou expiré              → DÉFINITIF, jamais rejoué
    403  capture appartenant à un autre utilisateur    → DÉFINITIF, jamais rejoué
    5xx  erreur interne                                → rejouable

`TransferRetryPolicy` côté application applique sa PROPRE règle (400/401/403 définitifs,
408/429/5xx rejouables) : le champ `retryable` de notre réponse est une indication, jamais
une autorité — un serveur ne peut pas rendre rejouable un 400. C'est écrit dans le contrat,
et c'est ce qui rend ces deux implémentations compatibles sans se faire confiance.

Rejouer un 400 ne peut pas réussir : cela masquerait une erreur de format derrière une
boucle d'envoi. C'est pourquoi `metadata` et `photo` sont déclarés OPTIONNELS dans la
signature puis validés à la main — seul moyen de rendre un 400 explicite plutôt que le 422
automatique de FastAPI sur un multipart incomplet.

Authentification
----------------
Le contrat OpenAPI prévoit le 401 mais l'application 1.2 n'envoie **aucun** en-tête
d'autorisation : elle a été écrite avant d'avoir un serveur. Le pont exige donc un jeton
Bearer (les captures sont rattachées à un utilisateur, comme les mesures), et l'application
reçoit la connexion au compte dans la même livraison.

Stocker ou mesurer ?
--------------------
Ce module **archive** : photo + métadonnées du niveau à bulle. Il ne lance PAS la détection
lourde (MediaPipe). Deux raisons : l'analyse est sérialisée par un verrou global
(`ANALYSIS_LOCK`, une à la fois) et la mesurer à la réception bloquerait l'envoi d'une photo
qui n'est peut-être pas encore celle qu'on veut ; et la MESURE se fait dans l'interface, sur
le pipeline v19.5 (`clip_geometry`). La capture est la matière première, pas le résultat.

⚠️ Aucune cote de clip n'apparaît dans ce fichier : la règle de GEL est tenue.
"""
import io
import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import (APIRouter, Depends, File, Form, Header, HTTPException,
                     Request, Response, UploadFile, status)
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import (BigInteger, Boolean, DateTime, Float, ForeignKey, Integer,
                        String, Text, UniqueConstraint)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from auth import Base, SessionLocal, User, engine, get_current_user, get_db
from image_quality import validate_image_bytes

captures_router = APIRouter(prefix="/captures", tags=["captures"])

# Racine de stockage des photos. Surchargeable par l'environnement pour deux raisons
# distinctes : les tests écrivent dans /tmp au lieu de polluer le dépôt, et un déploiement
# peut placer les photos sur un volume dédié sans toucher au code.
UPLOAD_ROOT = os.environ.get("CAPTURES_UPLOAD_ROOT") or os.path.join(
    os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)

# Au-delà, on refuse : une capture de niveau à bulle pèse quelques Mo. Sans plafond, un envoi
# mal formé (ou hostile) remplirait le disque avant même d'être examiné.
MAX_IMAGE_BYTES = 40 * 1024 * 1024

# Longueurs des champs issus du téléphone. Elles sont bornées parce qu'elles viennent du
# client : un `fileName` de 10 000 caractères est une anomalie, pas une donnée.
MAX_CLIENT_ID = 64
MAX_SHORT = 255


class CaptureError(Exception):
    """Erreur au format `ApiError` du contrat.

    On ne lève PAS `HTTPException` : FastAPI la rendrait en `{"detail": ...}`, que
    l'application ne saurait pas lire (elle attend `{code, message, retryable}`). Le
    gestionnaire enregistré dans `main.py` produit la bonne forme, y compris pour les
    erreurs de la dépendance d'authentification — qui, elles, restent en `detail` mais
    sont tolérées par le client (il retombe alors sur « HTTP 401 »).
    """

    def __init__(self, status_code: int, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable


async def capture_error_handler(request: Request, exc: CaptureError) -> JSONResponse:
    """Rend une erreur sous la forme exacte du schéma `ApiError`."""
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "message": exc.message, "retryable": exc.retryable},
    )


def _bad_request(code: str, message: str) -> CaptureError:
    """400 — DÉFINITIF. Le format est faux : rejouer à l'identique produira le même refus."""
    return CaptureError(status.HTTP_400_BAD_REQUEST, code, message, retryable=False)


class Capture(Base):
    """Une photo reçue du téléphone, avec le contexte de prise de vue qui l'accompagne."""
    __tablename__ = "captures"

    # L'unicité est ce qui rend l'idempotence VRAIE et non approximative : deux envois
    # simultanés du même `clientCaptureId` ne peuvent pas créer deux lignes, quelle que soit
    # l'issue de la lecture « existe déjà ? » faite juste avant (cf. IntegrityError).
    __table_args__ = (
        UniqueConstraint("user_id", "client_capture_id", name="uq_captures_user_client"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"),
                                         index=True, nullable=False)
    client_capture_id: Mapped[str] = mapped_column(String(MAX_CLIENT_ID), index=True,
                                                   nullable=False)

    # ── Le fichier ───────────────────────────────────────────────────────────────
    image_path: Mapped[str] = mapped_column(String(512), default="")
    image_width: Mapped[int] = mapped_column(Integer, default=0)
    image_height: Mapped[int] = mapped_column(Integer, default=0)
    image_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    image_format: Mapped[str] = mapped_column(String(10), default="")
    file_name: Mapped[str] = mapped_column(String(MAX_SHORT), default="")

    # ── Métadonnées du contrat v1.2, telles que mesurées par le téléphone ────────
    # C'est la valeur ajoutée de l'app Android : elle sait si la photo a été prise
    # d'aplomb. Aucune donnée personnelle, aucun identifiant matériel.
    taken_at_millis: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    declared_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    roll_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    pitch_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    reference_is_custom: Mapped[bool] = mapped_column(Boolean, default=False)
    exif_orientation: Mapped[int | None] = mapped_column(Integer, nullable=True)
    angular_speed_dps: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Ce que la photo montre : `face` ou `profile`. Ajoute pour le centrage digital, qui a besoin
    # des DEUX photos et ne peut pas les distinguer autrement — le genre vient du geste de
    # l'opticien, aucun calcul ne peut le retrouver.
    # `NULL` = capture anterieure au champ, genre INCONNU. On ne le suppose pas : une capture
    # etiquetee « face » a tort serait utilisee comme telle par le centrage.
    kind: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)

    # Métadonnées brutes conservées telles quelles : le contrat de l'application peut gagner
    # des champs sans qu'une migration soit nécessaire pour les retrouver.
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")

    status: Mapped[str] = mapped_column(String(20), default="received")

    # Horodatage serveur, pose par PYTHON et non par la base.
    #
    # La resolution de `CURRENT_TIMESTAMP` varie selon le moteur — la seconde sur SQLite — et deux
    # captures envoyees dans la meme seconde recevaient alors le MEME horodatage. L'ordre de
    # l'historique devenait arbitraire, et « la derniere face » — ce que demande le centrage —
    # pouvait rendre une photo plus ancienne. Une fonction d'horloge dont la precision depend du
    # moteur ne convient pas a une donnee qui sert a ORDONNER.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )


Base.metadata.create_all(engine)


# ── Schémas de réponse — la forme EXACTE attendue par l'application ──────────────
class CaptureAccepted(BaseModel):
    """`CaptureAccepted` de l'OpenAPI : la réponse de `POST /captures`."""
    serverCaptureId: str
    clientCaptureId: str
    # `created` au premier envoi, `duplicate` si le serveur connaissait déjà l'identifiant.
    status: str
    receivedAtEpochMillis: int | None = None


class CaptureSummary(BaseModel):
    """Vue d'une capture pour l'interface embarquée (l'application, elle, ne la lit pas)."""
    id: str
    clientCaptureId: str
    fileName: str = ""
    kind: str | None = None
    receivedAtEpochMillis: int | None = None
    width: int = 0
    height: int = 0
    imageBytes: int = 0
    rollDegrees: float | None = None
    pitchDegrees: float | None = None
    referenceIsCustom: bool = False
    exifOrientation: int | None = None
    angularSpeedDegreesPerSecond: float | None = None
    imageUrl: str | None = None


def _epoch_millis(dt: datetime | None) -> int | None:
    """Millisecondes depuis l'époque Unix. `created_at` peut revenir naïf selon le moteur
    (SQLite) : on force le fuseau plutôt que de laisser le client interpréter l'heure locale.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _summary(c: Capture) -> CaptureSummary:
    return CaptureSummary(
        id=c.id,
        clientCaptureId=c.client_capture_id,
        fileName=c.file_name,
        kind=c.kind,
        receivedAtEpochMillis=_epoch_millis(c.created_at),
        width=c.image_width,
        height=c.image_height,
        imageBytes=c.image_bytes,
        rollDegrees=c.roll_deg,
        pitchDegrees=c.pitch_deg,
        referenceIsCustom=bool(c.reference_is_custom),
        exifOrientation=c.exif_orientation,
        angularSpeedDegreesPerSecond=c.angular_speed_dps,
        imageUrl=f"/captures/{c.id}/image" if c.image_path else None,
    )


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _num(value, cast=float):
    """Convertit une valeur du client en nombre, ou None. Ne lève jamais : une métadonnée
    illisible ne doit pas faire échouer la capture — elle est accessoire devant la photo,
    qui est la donnée utile.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


def _text(value, limit: int = MAX_SHORT) -> str:
    if value is None:
        return ""
    return str(value)[:limit]


# Genres admis. Volontairement une liste fermee : le contrat les enumere, et une valeur libre
# finirait par servir de filtre sans qu'on sache ce qu'elle designe.
KINDS = ("face", "profile")


def _kind(value) -> str | None:
    """Genre de la capture, ou `None` s'il est absent ou inconnu.

    On ne retombe PAS sur « face » : une capture dont le genre est inconnu doit rester inconnue,
    sinon le centrage l'utiliserait comme une face et produirait une mesure fausse — sans que
    rien ne le signale.
    """
    if not isinstance(value, str):
        return None
    candidate = value.strip().lower()
    return candidate if candidate in KINDS else None


def _image_size(data: bytes) -> tuple[int, int]:
    """Dimensions de l'image, lues depuis l'en-tête (pas de décodage complet).

    PIL lit paresseusement : `Image.open` ne consomme que l'en-tête. On évite ainsi de
    décoder une photo de 40 Mo juste pour connaître sa taille.
    """
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            return int(im.width), int(im.height)
    except Exception:
        raise _bad_request(
            "image_illisible",
            "Image illisible : l'en-tête ne peut pas être interprété (le format annoncé "
            "par la signature est incohérent avec le contenu).",
        )


def _abs_path(rel: str) -> str | None:
    if not rel:
        return None
    p = os.path.join(UPLOAD_ROOT, rel)
    return p if os.path.exists(p) else None


def _owned(capture_id: str, user: User, db) -> Capture:
    """Capture de CET utilisateur, ou 403/404. Un admin peut tout lire (comme pour les
    mesures) — c'est la même règle d'isolation, appliquée au même endroit.
    """
    c = db.get(Capture, capture_id)
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Capture introuvable")
    if c.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    return c


def _accepted(c: Capture, client_id: str, status_: str,
              response: Response | None = None, force_200: bool = False) -> CaptureAccepted:
    if force_200 and response is not None:
        response.status_code = 200          # 200 = doublon (201 = création)
    return CaptureAccepted(
        serverCaptureId=c.id,
        clientCaptureId=client_id,
        status=status_,
        receivedAtEpochMillis=_epoch_millis(c.created_at),
    )


# ── Routes ──────────────────────────────────────────────────────────────────────
@captures_router.post("", response_model=CaptureAccepted, status_code=201)
@captures_router.post("/", response_model=CaptureAccepted, status_code=201,
                      include_in_schema=False)
async def create_capture(
    response: Response,
    photo: UploadFile | None = File(None),
    metadata: str | None = Form(None),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Reçoit une capture. Idempotent sur `clientCaptureId` pour cet utilisateur.

    `status_code=201` déclaré, mais un rejeu rend **200** : le contrat impose cette
    distinction (201 = création, 200 = doublon), et l'application peut ainsi savoir si son
    envoi a créé quelque chose sans comparer les corps de réponse.

    Les deux chemins `""` et `"/"` sont acceptés : le client concatène `/captures` à l'URL
    de base, mais un utilisateur qui saisit l'URL avec une barre finale produit
    `/captures/`. Refuser pour une barre serait une panne gratuite.
    """
    # ── Validation du multipart ── 400 explicite (jamais 422) : le contrat impose la
    # distinction, et un 400 dit à l'application « ne réessaie pas, le format est faux ».
    if metadata is None:
        raise _bad_request("metadata_absente", "Partie 'metadata' absente du multipart.")
    try:
        meta = json.loads(metadata)
    except (ValueError, TypeError) as exc:
        raise _bad_request("metadata_json_invalide", f"metadata : JSON invalide ({exc}).")
    if not isinstance(meta, dict):
        raise _bad_request("metadata_non_objet", "metadata : un objet JSON est attendu.")

    client_id = meta.get("clientCaptureId")
    if not client_id or not isinstance(client_id, str):
        raise _bad_request("client_capture_id_manquant",
                           "metadata.clientCaptureId manquant ou non textuel.")
    client_id = client_id[:MAX_CLIENT_ID]

    # L'en-tête `Idempotency-Key` est FACULTATIF (le contrat OpenAPI le documente, mais la
    # clé d'idempotence fait autorité dans les métadonnées). S'il est présent, il doit
    # désigner la même capture : deux identifiants contradictoires signalent un bug client,
    # qu'il vaut mieux voir tout de suite que d'archiver une capture sous la mauvaise clé.
    if idempotency_key and idempotency_key.strip() != client_id:
        raise _bad_request(
            "idempotency_key_divergente",
            "L'en-tête 'Idempotency-Key' ne correspond pas à metadata.clientCaptureId.",
        )

    # ── Idempotence AVANT tout traitement lourd : rejouer ne doit rien réécrire ──
    existing = (db.query(Capture)
                  .filter(Capture.user_id == user.id,
                          Capture.client_capture_id == client_id)
                  .first())
    if existing is not None:
        # La photo d'un rejeu n'est jamais examinée : le doublon est établi sur la clé, et
        # revalider l'image ferait échouer un rejeu légitime dont le fichier a vieilli.
        return _accepted(existing, client_id, "duplicate", response, force_200=True)

    if photo is None or not photo.filename:
        raise _bad_request("photo_absente", "Partie 'photo' absente du multipart.")

    data = await photo.read()
    if not data:
        raise _bad_request("photo_vide", "Fichier photo vide.")
    if len(data) > MAX_IMAGE_BYTES:
        raise _bad_request(
            "photo_trop_volumineuse",
            f"Photo trop volumineuse : {len(data)} octets, maximum {MAX_IMAGE_BYTES}.",
        )

    # ── `sizeBytes` est vérifié, pas cru ─────────────────────────────────────────
    # L'application annonce la taille du fichier qu'elle a écrit. Un écart signifie que ce
    # qui est arrivé n'est pas ce qui est parti : troncature, ou bug client. L'accepter
    # sans rien dire archiverait une photo corrompue en la présentant comme intacte — et
    # c'est précisément le genre de défaut qu'on ne découvre qu'au moment de mesurer.
    declared = meta.get("sizeBytes")
    if isinstance(declared, bool) or not isinstance(declared, (int, float)):
        raise _bad_request("size_bytes_manquant",
                           "metadata.sizeBytes manquant ou non numérique.")
    if int(declared) != len(data):
        raise _bad_request(
            "size_bytes_divergent",
            f"Taille annoncée ({int(declared)} octets) différente de la taille reçue "
            f"({len(data)} octets) : l'envoi est incomplet ou corrompu.",
        )

    # MÊME porte de qualité que tous les autres chemins qui reçoivent une image (signature
    # réelle, jamais l'extension) : sinon des fichiers vides ou renommés entraient en base.
    try:
        fmt = validate_image_bytes(data)
    except HTTPException as exc:
        # Cette porte lève une `HTTPException`, que FastAPI rendrait en `{"detail": ...}` et
        # parfois en 422. Le contrat promet un 400 au format `ApiError` : on traduit, sans
        # quoi l'application afficherait « HTTP 422 » au lieu d'un code exploitable.
        raise _bad_request("image_invalide", str(exc.detail))
    width, height = _image_size(data)

    capture_id = str(uuid.uuid4())
    user_dir = os.path.join(UPLOAD_ROOT, str(user.id))
    os.makedirs(user_dir, exist_ok=True)
    ext = {"jpeg": ".jpg", "png": ".png", "webp": ".webp"}.get(fmt, ".bin")
    rel = os.path.join(str(user.id), f"{capture_id}{ext}")

    row = Capture(
        id=capture_id,
        user_id=user.id,
        client_capture_id=client_id,
        image_path=rel,
        image_width=width,
        image_height=height,
        image_bytes=len(data),
        image_format=fmt,
        file_name=_text(meta.get("fileName")),
        taken_at_millis=_num(meta.get("takenAtEpochMillis"), int),
        declared_size_bytes=int(declared),
        roll_deg=_num(meta.get("rollDegrees")),
        pitch_deg=_num(meta.get("pitchDegrees")),
        reference_is_custom=bool(meta.get("referenceIsCustom")) if
        isinstance(meta.get("referenceIsCustom"), bool) else False,
        exif_orientation=_num(meta.get("exifOrientation"), int),
        angular_speed_dps=_num(meta.get("angularSpeedDegreesPerSecond")),
        # Genre borne a ce que le contrat connait : une valeur libre venue du client finirait par
        # servir de filtre sans qu'on sache ce qu'elle contient. `None` reste `None` — inconnu.
        kind=_kind(meta.get("kind")),
        metadata_json=json.dumps(meta, ensure_ascii=False),
    )

    dest = os.path.join(UPLOAD_ROOT, rel)
    with open(dest, "wb") as f:
        f.write(data)

    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Deux envois du même `clientCaptureId` ont passé la lecture « existe déjà ? » en
        # même temps : la contrainte d'unicité a tranché. Le fichier qu'on vient d'écrire
        # est un doublon strict — on le supprime et on répond comme pour un rejeu, au lieu
        # de renvoyer une erreur 500 que l'application rejouerait.
        db.rollback()
        try:
            os.remove(dest)
        except OSError:
            pass
        winner = (db.query(Capture)
                    .filter(Capture.user_id == user.id,
                            Capture.client_capture_id == client_id)
                    .first())
        if winner is None:          # course perdue puis ligne disparue : cas limite
            raise CaptureError(
                status.HTTP_503_SERVICE_UNAVAILABLE, "conflit_enregistrement",
                "Conflit d'enregistrement, réessayez.", retryable=True)
        return _accepted(winner, client_id, "duplicate", response, force_200=True)

    db.refresh(row)
    return _accepted(row, client_id, "created")


@captures_router.get("", response_model=list[CaptureSummary])
def list_my_captures(
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = 50,
    offset: int = 0,
    kind: str | None = None,
):
    """Liste des captures de l'utilisateur, la plus récente d'abord.

    N'appartient pas au contrat de l'application (elle n'émet que des POST) : cette route sert
    l'interface embarquée, qui choisit les photos à centrer dans cet historique.

    `kind` permet de demander directement « la dernière face » ou « le dernier profil » : c'est
    exactement ce dont le centrage a besoin, et le faire ici évite au client de trier lui-même
    une liste qui peut être longue.
    """
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    query = db.query(Capture).filter(Capture.user_id == user.id)
    if kind is not None:
        query = query.filter(Capture.kind == _kind(kind))
    rows = (query.order_by(Capture.created_at.desc())
                 .offset(offset).limit(limit).all())
    return [_summary(r) for r in rows]


@captures_router.get("/by-client/{client_capture_id}", response_model=CaptureSummary)
def get_capture_by_client_id(
    client_capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Retrouve une capture par l'identifiant que l'APPAREIL lui a donné.

    L'application Android connaît ses captures par leur `clientCaptureId` — c'est elle qui le
    génère — tandis que le serveur les désigne par son propre identifiant. Quand l'application
    ouvre l'interface de centrage, elle ne peut donc transmettre que le premier.

    Cette route est le pont entre les deux. Elle sert aussi de sonde : tant qu'un envoi n'a pas
    abouti, la capture n'existe pas ici, et la réponse 404 dit à l'interface « attends encore »,
    ce qui est exact plutôt que de faire croire à une capture disparue.
    """
    wanted = client_capture_id.strip()[:MAX_CLIENT_ID]
    if not wanted:
        raise _bad_request("client_capture_id_manquant", "Identifiant vide.")

    row = (db.query(Capture)
             .filter(Capture.user_id == user.id, Capture.client_capture_id == wanted)
             .first())
    if row is None:
        # 404 et non 403 : la capture n'est pas FORBIDDEN, elle n'est pas encore ARRIVEE. Le
        # message doit le dire, sinon l'interface afficherait « acces refuse » sur un envoi en
        # cours et l'utilisateur croirait a un probleme de droits.
        raise CaptureError(
            status.HTTP_404_NOT_FOUND, "capture_inconnue",
            "Capture pas encore recue pour cet identifiant.", retryable=True)
    return _summary(row)


@captures_router.get("/{capture_id}", response_model=CaptureSummary)
def get_capture(
    capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _summary(_owned(capture_id, user, db))


@captures_router.get("/{capture_id}/image")
def get_capture_image(
    capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Le fichier lui-même. Même porte d'isolation que le détail : on ne sert pas la photo
    d'un autre utilisateur.
    """
    c = _owned(capture_id, user, db)
    p = _abs_path(c.image_path)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image absente du disque")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
             "png": "image/png", "webp": "image/webp"}.get(
                 os.path.splitext(p)[1].lstrip(".").lower(), "application/octet-stream")
    return FileResponse(p, media_type=media)


@captures_router.delete("/{capture_id}", status_code=204)
def delete_capture(
    capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Supprime la ligne **et** le fichier : laisser l'un sans l'autre crée un orphelin sur
    le disque, exactement comme pour les mesures.
    """
    c = _owned(capture_id, user, db)
    p = _abs_path(c.image_path)
    if p:
        try:
            os.remove(p)
        except OSError:
            pass
    db.delete(c)
    db.commit()
