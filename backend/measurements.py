"""
Smart Optica — Historique des mesures par utilisateur
Table `measurements` liée à `users`. Photos stockées sur disque (uploads/{user_id}/).
"""
import os
import uuid
import shutil
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Query, Form
from image_quality import validate_image_bytes
from pydantic import BaseModel
from sqlalchemy import String, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from auth import (
    Base, engine, SessionLocal, get_db,
    User, get_current_user, require_admin,
)

measurements_router = APIRouter(prefix="/api/measurements", tags=["measurements"])

UPLOAD_ROOT = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


class Measurement(Base):
    __tablename__ = "measurements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"),
                                          index=True, nullable=False)
    # ── Coordonnées client ──
    patient_name: Mapped[str] = mapped_column(String(160), default="")
    patient_phone: Mapped[str] = mapped_column(String(40), default="")
    patient_email: Mapped[str] = mapped_column(String(160), default="")
    frame_ref: Mapped[str] = mapped_column(String(120), default="")  # monture / référence
    notes: Mapped[str] = mapped_column(Text, default="")
    # Résultats complets (JSON sérialisé)
    results_json: Mapped[str] = mapped_column(Text, nullable=False)
    # Chemins relatifs vers les photos (stockées sur disque)
    face_image_path: Mapped[str] = mapped_column(String(512), default="")
    profile_image_path: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())


Base.metadata.create_all(engine)


# ── Schemas de réponse ─────────────────────────────────────────
class MeasurementSummary(BaseModel):
    id: str
    user_id: str | None = None
    user_name: str | None = None
    user_email: str | None = None
    patient_name: str
    patient_phone: str = ""
    patient_email: str = ""
    frame_ref: str = ""
    created_at: datetime
    pd: float | None = None
    pont: float | None = None
    pantoscopic_angle: float | None = None
    vertex_distance: float | None = None
    has_face_image: bool = False
    has_profile_image: bool = False
    face_image_url: str | None = None
    profile_image_url: str | None = None

    class Config:
        from_attributes = True


class MeasurementDetail(MeasurementSummary):
    results: dict
    notes: str = ""
    # (face_image_url / profile_image_url hérités du summary)


def _summary(m: Measurement, user: User | None = None) -> MeasurementSummary:
    try:
        import json
        r = json.loads(m.results_json)
    except Exception:
        r = {}
    return MeasurementSummary(
        id=m.id,
        user_id=m.user_id,
        user_name=user.name if user else None,
        user_email=user.email if user else None,
        patient_name=m.patient_name or "",
        patient_phone=m.patient_phone or "",
        patient_email=m.patient_email or "",
        frame_ref=m.frame_ref or "",
        created_at=m.created_at,
        pd=r.get("pd"),
        pont=r.get("pont"),
        pantoscopic_angle=r.get("pantoscopicAngle"),
        vertex_distance=r.get("vertexDistance"),
        has_face_image=bool(m.face_image_path),
        has_profile_image=bool(m.profile_image_path),
        face_image_url=f"/api/measurements/{m.id}/face-image" if m.face_image_path else None,
        profile_image_url=f"/api/measurements/{m.id}/profile-image" if m.profile_image_path else None,
    )


def _detail(m: Measurement) -> MeasurementDetail:
    import json
    try:
        r = json.loads(m.results_json)
    except Exception:
        r = {}
    s = _summary(m)
    return MeasurementDetail(
        **s.model_dump(),
        results=r,
        notes=m.notes or "",
    )


# ── Helpers disque ─────────────────────────────────────────────
def _save_upload(user_id: str, measurement_id: str, file: UploadFile, kind: str) -> str:
    """Sauvegarde un fichier uploadé, retourne le chemin relatif."""
    ext = os.path.splitext(file.filename or "")[1] or ".png"
    if ext.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        ext = ".png"
    user_dir = os.path.join(UPLOAD_ROOT, str(user_id))
    os.makedirs(user_dir, exist_ok=True)
    fname = f"{measurement_id}_{kind}{ext}"
    dest = os.path.join(user_dir, fname)
    # MÊME porte de qualité que les endpoints d'analyse. Sans elle, un envoi vide
    # était écrit tel quel : origine des fichiers de 0 octet trouvés dans les
    # uploads (2 sur 6 photos distinctes).
    try:
        file.file.seek(0)
    except Exception:
        pass
    data = file.file.read()
    validate_image_bytes(data)
    with open(dest, "wb") as f:
        f.write(data)
    return os.path.relpath(dest, UPLOAD_ROOT)  # ex: {user_id}/{id}_face.png


def _abs_path(rel: str) -> str | None:
    if not rel:
        return None
    p = os.path.join(UPLOAD_ROOT, rel)
    return p if os.path.exists(p) else None


# ── Routes ─────────────────────────────────────────────────────
@measurements_router.post("", response_model=MeasurementDetail, status_code=201)
async def create_measurement(
    results: str = Form(..., description="JSON des mesures"),
    patient_name: str = Form(""),
    patient_phone: str = Form(""),
    patient_email: str = Form(""),
    frame_ref: str = Form(""),
    notes: str = Form(""),
    face_image: UploadFile | None = File(None),
    profile_image: UploadFile | None = File(None),
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    import json
    try:
        results_obj = json.loads(results)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "results doit être un JSON valide")

    m = Measurement(
        user_id=user.id,
        patient_name=patient_name or "",
        patient_phone=patient_phone or "",
        patient_email=patient_email or "",
        frame_ref=frame_ref or "",
        notes=notes or "",
        results_json=json.dumps(results_obj, ensure_ascii=False),
    )
    db.add(m)
    db.commit()
    db.refresh(m)

    # Sauvegarde des images (liées au user)
    if face_image and face_image.filename:
        m.face_image_path = _save_upload(user.id, m.id, face_image, "face")
    if profile_image and profile_image.filename:
        m.profile_image_path = _save_upload(user.id, m.id, profile_image, "profile")
    if face_image or profile_image:
        db.commit()
        db.refresh(m)

    return _detail(m)


@measurements_router.get("", response_model=list[MeasurementSummary])
def list_my_measurements(
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    rows = (
        db.query(Measurement)
        .filter(Measurement.user_id == user.id)
        .order_by(Measurement.created_at.desc())
        .offset(offset).limit(limit).all()
    )
    return [_summary(r) for r in rows]


@measurements_router.get("/{measurement_id}", response_model=MeasurementDetail)
def get_measurement(
    measurement_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    m = db.get(Measurement, measurement_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mesure introuvable")
    if m.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    return _detail(m)


@measurements_router.delete("/{measurement_id}", status_code=204)
def delete_measurement(
    measurement_id: str,
    db: SessionLocal = Depends(get_db),
    user: User = Depends(get_current_user),
):
    m = db.get(Measurement, measurement_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mesure introuvable")
    if m.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    # Supprimer fichiers disque
    for rel in (m.face_image_path, m.profile_image_path):
        p = _abs_path(rel)
        if p:
            try:
                os.remove(p)
            except OSError:
                pass
    db.delete(m)
    db.commit()


@measurements_router.get("/{measurement_id}/face-image")
def face_image(measurement_id: str, db: SessionLocal = Depends(get_db), user: User = Depends(get_current_user)):
    from fastapi.responses import FileResponse
    m = db.get(Measurement, measurement_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mesure introuvable")
    if m.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    p = _abs_path(m.face_image_path)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image absente")
    return FileResponse(p)


@measurements_router.get("/{measurement_id}/profile-image")
def profile_image(measurement_id: str, db: SessionLocal = Depends(get_db), user: User = Depends(get_current_user)):
    from fastapi.responses import FileResponse
    m = db.get(Measurement, measurement_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mesure introuvable")
    if m.user_id != user.id and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès refusé")
    p = _abs_path(m.profile_image_path)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image absente")
    return FileResponse(p)


# ── Routes admin (toutes les mesures) ─────────────────────────
@measurements_router.get("/admin/all", response_model=list[MeasurementSummary], tags=["admin"])
def admin_list_measurements(
    user_id: str | None = Query(None),
    db: SessionLocal = Depends(get_db),
    _: User = Depends(require_admin),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    q = db.query(Measurement)
    if user_id:
        q = q.filter(Measurement.user_id == user_id)
    rows = q.order_by(Measurement.created_at.desc()).offset(offset).limit(limit).all()
    # Preload des users (évite N+1) — on joint les noms/emails de chaque propriétaire
    uids = {r.user_id for r in rows if r.user_id}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(uids)).all()} if uids else {}
    return [_summary(r, users.get(r.user_id)) for r in rows]
