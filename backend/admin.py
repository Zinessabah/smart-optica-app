"""
Smart Optica — Administration des comptes (CRUD admin)
Endpoints réservés au rôle "admin".
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from auth import (
    router as auth_router,  # noqa: F401 (pour éviter import circulaire implicite)
    User,
    SessionLocal,
    get_db,
    get_current_user,
    require_admin,
    hash_password,
    verify_password,
    UserOut,
)

admin = APIRouter(prefix="/api/admin", tags=["admin"])


# ── Schemas ────────────────────────────────────────────────────
class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8)
    role: str = "user"  # user | admin


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    role: str | None = None  # user | admin
    is_active: bool | None = None


class PasswordReset(BaseModel):
    new_password: str = Field(min_length=8)


class UserListOut(BaseModel):
    data: list[UserOut]
    total: int
    page: int
    per_page: int


# ── Routes ─────────────────────────────────────────────────────
@admin.get("/users", response_model=UserListOut)
def list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = None,
    admin_only: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    q = db.query(User)
    if search:
        like = f"%{search.lower()}%"
        q = q.filter(or_(User.email.ilike(like), User.name.ilike(like)))
    if admin_only:
        q = q.filter(User.role == "admin")
    total = q.count()
    users = (
        q.order_by(User.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return UserListOut(
        data=[UserOut.model_validate(u) for u in users],
        total=total,
        page=page,
        per_page=per_page,
    )


@admin.post("/users", response_model=UserOut, status_code=201)
def create_user(
    data: UserCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if data.role not in ("user", "admin"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rôle invalide")
    existing = db.query(User).filter(User.email == data.email.lower()).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Un compte existe déjà avec cet email")
    user = User(
        email=data.email.lower(),
        name=data.name.strip(),
        password_hash=hash_password(data.password),
        role=data.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@admin.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    if data.name is not None:
        user.name = data.name.strip()
    if data.role is not None:
        if data.role not in ("user", "admin"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rôle invalide")
        # Un admin ne peut pas se rétrograder lui-même
        if user.id == current.id and data.role != "admin":
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Vous ne pouvez pas retirer votre propre rôle admin")
        user.role = data.role
    if data.is_active is not None:
        # Un admin ne peut pas se désactiver lui-même
        if user.id == current.id and not data.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Vous ne pouvez pas désactiver votre propre compte")
        user.is_active = data.is_active
    db.commit()
    db.refresh(user)
    return user


@admin.post("/users/{user_id}/reset-password", response_model=dict)
def reset_password(
    user_id: str,
    data: PasswordReset,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"ok": True}


@admin.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(require_admin),
):
    if user_id == current.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Vous ne pouvez pas supprimer votre propre compte")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    db.delete(user)
    db.commit()
