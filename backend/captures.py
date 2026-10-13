"""
Smart Optica — Réception des captures de l'application Android.

L'application `ma.smartoptica.levelcam` (capture photo native + niveau à bulle) possède
déjà toute sa chaîne de transfert : file d'attente Room, rejeu WorkManager avec backoff,
idempotence par `clientCaptureId`, URL de serveur modifiable à chaud. Ce module lui
fournit le serveur qu'elle attend — sans modifier une ligne de son code réseau.

Contrat implémenté (chemins RELATIFS à l'URL de base saisie dans l'app) :

    POST /captures              multipart : `image` (JPEG) + `metadata` (JSON)
    GET  /captures              liste des captures de l'utilisateur
    GET  /captures/{id}         détail + URL de téléchargement
    GET  /captures/{id}/image   le fichier lui-même

`health` est déjà servi à la racine par `main.py` : l'application le trouve donc aussi,
sans préfixe `/api` — d'où des routes montées à la racine, comme lui.

Codes de réponse — la distinction est NORMATIVE côté application
--------------------------------------------------------------
    201  création d'un nouveau `clientCaptureId`
    200  doublon : ce `clientCaptureId` a déjà été reçu (idempotence)
    400  multipart illisible / métadonnées invalides   → DÉFINITIF, jamais rejoué
    401  jeton absent, invalide ou expiré              → DÉFINITIF, jamais rejoué
    403  capture appartenant à un autre utilisateur    → DÉFINITIF, jamais rejoué
    5xx  erreur interne                                → rejouable

Rejouer un 400 ne peut pas réussir : il masquerait une erreur de format derrière une
boucle d'envoi. C'est pourquoi `metadata` et `image` sont déclarés OPTIONNELS puis
validés à la main — c'est le seul moyen de rendre un 400 explicite plutôt que le 422
automatique de FastAPI sur un multipart incomplet.

Stocker ou mesurer ?
--------------------
Ce module **archive** : photo + métadonnées du niveau à bulle. Il ne lance PAS la
détection lourde (MediaPipe). Deux raisons : l'analyse est sérialisée par un verrou
global (`ANALYSIS_LOCK`, une à la fois) et la mesurer à la réception bloquerait l'envoi
d'une photo qui n'est peut-être pas encore celle qu'on veut ; et la MESURE se fait dans
l'interface, sur le pipeline v19.5 (`clip_geometry`). La capture est donc la matière
première, pas le résultat.

⚠️ Aucune cote de clip n'apparaît dans ce fichier : la règle de GEL est tenue.
"""
import io
import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import (APIRouter, Depends, File, Form, HTTPException, Response,
                     UploadFile, status)
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Integer, String,
                        Text, UniqueConstraint, func)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from auth import Base, SessionLocal, User, engine, get_current_user, get_db
from image_quality import detect_format, validate_image_bytes

captures_router = APIRouter(prefix="/captures", tags=["captures"])

# Racine de stockage des photos. Surchargeable par l'environnement pour deux raisons
# distinctes : les tests écrivent dans /tmp au lieu de polluer le dépôt, et un
# déploiement peut placer les photos sur un volume dédié sans toucher au code.
UPLOAD_ROOT = os.environ.get("CAPTURES_UPLOAD_ROOT") or os.path.join(
    os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)

# Au-delà, on refuse : une capture de niveau à bulle pèse quelques Mo. Sans plafond, un
# envoi mal formé (ou hostile) remplirait le disque avant même d'être analysé.
MAX_IMAGE_BYTES = 40 * 1024 * 1024

# Longueurs des champs issus du téléphone. Elles sont bornées parce qu'elles viennent du
# client : un `reference_mode` de 10 000 caractères est une anomalie, pas une donnée.
MAX_CLIENT_ID = 64
MAX_SHORT = 40


class Capture(Base):
    """Une photo reçue du téléphone, avec le contexte de prise de vue qui l'accompagne."""
    __tablename__ = "captures"

    # L'unicité est ce qui rend l'idempotence VRAIE et non approximative : deux envois
    # simultanés du même `clientCaptureId` ne peuvent pas créer deux lignes, quelle que
    # soit l'issue de la lecture « existe déjà ? » faite juste avant (cf. IntegrityError).
    __table_args__ = (
        UniqueConstraint("user_id", "client_capture_id", name="uq_captures_user_client"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"),
                                         index=True, nullable=False)
    client_capture_id: Mapped[str] = mapped_column(String(MAX_CLIENT_ID), index=True,
                                                   nullable=False)

    image_path: Mapped[str] = mapped_column(String(512), default="")
    image_width: Mapped[int] = mapped_column(Integer, default=0)
    image_height: Mapped[int] = mapped_column(Integer, default=0)
    image_bytes: Mapped[int] = mapped_column(Integer, default=0)
    image_format: Mapped[str] = mapped_column(String(10), default="")

    # ── Contexte de prise de vue, tel que mesuré par le téléphone ────────────────
    # C'est la valeur ajoutée de l'app Android : elle sait si la photo a été prise
    # d'aplomb. Aucune donnée personnelle, aucun identifiant matériel.
    captured_at_client: Mapped[str] = mapped_column(String(MAX_SHORT), default="")
    roll_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    pitch_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    tolerance_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_aligned: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    reference_mode: Mapped[str] = mapped_column(String(MAX_SHORT), default="")
    display_rotation_deg: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sensor_source: Mapped[str] = mapped_column(String(MAX_SHORT), default="")
    measurement_age_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    measurement_status: Mapped[str] = mapped_column(String(MAX_SHORT), default="")
    app_version: Mapped[str] = mapped_column(String(MAX_SHORT), default="")

    # Métadonnées brutes conservées telles quelles : le contrat de l'application peut
    # gagner des champs sans qu'une migration soit nécessaire pour les retrouver.
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")

    status: Mapped[str] = mapped_column(String(20), default="received")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())


Base.metadata.create_all(engine)


# ── Schémas de réponse — la forme EXACTE attendue par l'application ──────────────
class UploadResponse(BaseModel):
    """Réponse de `POST /captures` : `UploadResponse` côté Kotlin."""
    captureId: str
    status: str
    message: str | None = None


class RemoteCapture(BaseModel):
    """`RemoteCapture` côté Kotlin."""
    id: str
    capturedAt: str
    status: str | None = None


class RemoteCaptureResponse(BaseModel):
    """`RemoteCaptureResponse` côté Kotlin."""
    capture: RemoteCapture
    downloadUrl: str | None = None


class CaptureSummary(BaseModel):
    id: str
    clientCaptureId: str
    capturedAt: str
    status: str
    width: int = 0
    height: int = 0
    imageBytes: int = 0
    rollDegrees: float | None = None
    pitchDegrees: float | None = None
    isAligned: bool | None = None
    toleranceDegrees: float | None = None
    appVersion: str = ""
    imageUrl: str | None = None


def _iso(dt: datetime) -> str:
    """ISO-8601 UTC. `created_at` peut revenir naïf selon le moteur (SQLite) : on force
    le fuseau plutôt que de laisser l'application interpréter l'heure locale."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _summary(c: Capture) -> CaptureSummary:
    return CaptureSummary(
        id=c.id,
        clientCaptureId=c.client_capture_id,
        capturedAt=_iso(c.created_at),
        status=c.status,
        width=c.image_width,
        height=c.image_height,
        imageBytes=c.image_bytes,
        rollDegrees=c.roll_deg,
        pitchDegrees=c.pitch_deg,
        isAligned=c.is_aligned,
        toleranceDegrees=c.tolerance_deg,
        appVersion=c.app_version,
        imageUrl=f"/captures/{c.id}/image" if c.image_path else None,
    )


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _num(value, cast=float):
    """Convertit une valeur du client en nombre, ou None. Ne lève jamais : une
    métadonnée illisible ne doit pas faire échouer la capture — elle est accessoire
    devant la photo, qui est la donnée utile."""
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
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Image illisible : l'en-tête ne peut pas être interprété "
            "(le format annoncé par la signature est incohérent avec le contenu).",
        )


def _abs_path(rel: str) -> str | None:
    if not rel:
        return None
    p = os.path.join(UPLOAD_ROOT, rel)
    return p if os.path.exists(p) else None


def _owned(capture_id: str, user: User, db) -> Capture:
    """Capture de CET utilisateur, ou 403/404. Un admin peut tout lire (comme pour les
    mesures) — c'est la même règle d'isolation, appliquée au même endroit."""
    c = db.get(Capture, capture_id)
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Capture introuvable")
    if c.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    return c


# ── Routes ──────────────────────────────────────────────────────────────────────
@captures_router.post("", response_model=UploadResponse, status_code=201)
async def create_capture(
    response: Response,
    image: UploadFile | None = File(None),
    metadata: str | None = Form(None),
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Reçoit une capture. Idempotent sur `clientCaptureId` pour cet utilisateur.

    `status_code=201` déclaré, mais un rejeu rend **200** : le contrat impose cette
    distinction (201 = création, 200 = doublon), et l'application peut ainsi savoir si
    son envoi a créé quelque chose sans comparer les corps de réponse.
    """
    # ── Validation du multipart ── 400 explicite (jamais 422) : le contrat impose la
    # distinction, et un 400 dit à l'application « ne réessaie pas, le format est faux ».
    if metadata is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Partie 'metadata' absente du multipart.")
    try:
        meta = json.loads(metadata)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"metadata : JSON invalide ({exc}).")
    if not isinstance(meta, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "metadata : un objet JSON est attendu.")

    client_id = meta.get("clientCaptureId")
    if not client_id or not isinstance(client_id, str):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "metadata.clientCaptureId manquant ou non textuel.")
    client_id = client_id[:MAX_CLIENT_ID]

    if image is None:
        # Toléré à l'envoi d'un doublon : l'application peut rejouer une requête dont
        # la photo a déjà été acceptée. On ne refuse donc PAS ici — l'idempotence est
        # examinée d'abord, plus bas.
        pass

    # ── Idempotence AVANT tout traitement lourd : rejouer ne doit rien réécrire ──
    existing = (db.query(Capture)
                  .filter(Capture.user_id == user.id,
                          Capture.client_capture_id == client_id)
                  .first())
    if existing is not None:
        response.status_code = 200          # 200 = doublon (201 = création)
        return UploadResponse(
            captureId=existing.id,
            status="duplicate",
            message="Capture déjà reçue — aucun nouvel enregistrement.",
        )

    if image is None or not image.filename:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Partie 'image' absente du multipart.")

    data = await image.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Fichier image vide.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Image trop volumineuse : {len(data)} octets, maximum {MAX_IMAGE_BYTES}.",
        )

    # MÊME porte de qualité que tous les autres chemins qui reçoivent une image
    # (signature réelle, jamais l'extension) : sinon des fichiers vides ou renommés
    # entraient en base.
    fmt = validate_image_bytes(data)
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
        captured_at_client=_text(meta.get("capturedAt")),
        roll_deg=_num(meta.get("horizontalAngleDegrees")),
        pitch_deg=_num(meta.get("verticalAngleDegrees")),
        tolerance_deg=_num(meta.get("toleranceDegrees")),
        is_aligned=meta.get("isAligned") if isinstance(meta.get("isAligned"), bool) else None,
        reference_mode=_text(meta.get("referenceMode")),
        display_rotation_deg=_num(meta.get("displayRotationDegrees"), int),
        sensor_source=_text(meta.get("sensorSource")),
        measurement_age_ms=_num(meta.get("measurementAgeMs"), int),
        measurement_status=_text(meta.get("measurementStatus")),
        app_version=_text(meta.get("appVersion")),
        metadata_json=json.dumps(meta, ensure_ascii=False),
    )

    dest = os.path.join(UPLOAD_ROOT, rel)
    with open(dest, "wb") as f:
        f.write(data)

    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Deux envois du même `clientCaptureId` ont passé la lecture « existe déjà ? »
        # en même temps : la contrainte d'unicité a tranché. Le fichier qu'on vient
        # d'écrire est un doublon strict — on le supprime et on répond comme pour un
        # rejeu, au lieu de renvoyer une erreur 500 que l'application rejouerait.
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
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                                "Conflit d'enregistrement, réessayez.")
        response.status_code = 200
        return UploadResponse(captureId=winner.id, status="duplicate",
                              message="Capture déjà reçue (envoi concurrent).")

    db.refresh(row)
    return UploadResponse(
        captureId=row.id,
        status="created",
        message=(f"Capture enregistrée ({width}×{height}, {len(data)} octets)."),
    )


@captures_router.get("", response_model=list[CaptureSummary])
def list_my_captures(
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = 50,
    offset: int = 0,
):
    """Liste des captures de l'utilisateur, la plus récente d'abord.

    Sert l'interface embarquée (WebView) : elle choisit la photo à mesurer dans cet
    historique plutôt que de renvoyer le fichier par un autre canal.
    """
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    rows = (db.query(Capture)
              .filter(Capture.user_id == user.id)
              .order_by(Capture.created_at.desc())
              .offset(offset).limit(limit).all())
    return [_summary(r) for r in rows]


@captures_router.get("/{capture_id}", response_model=RemoteCaptureResponse)
def get_capture(
    capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = _owned(capture_id, user, db)
    return RemoteCaptureResponse(
        capture=RemoteCapture(id=c.id, capturedAt=_iso(c.created_at), status=c.status),
        downloadUrl=f"/captures/{c.id}/image" if c.image_path else None,
    )


@captures_router.get("/{capture_id}/image")
def get_capture_image(
    capture_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Le fichier lui-même. Même porte d'isolation que le détail : on ne sert pas la
    photo d'un autre utilisateur."""
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
    """Supprime la ligne **et** le fichier : laisser l'un sans l'autre crée un orphelin
    sur le disque, exactement comme pour les mesures."""
    c = _owned(capture_id, user, db)
    p = _abs_path(c.image_path)
    if p:
        try:
            os.remove(p)
        except OSError:
            pass
    db.delete(c)
    db.commit()
