"""
Smart Optica — Authentification multi-utilisateurs
SQLAlchemy 2.0 + PostgreSQL, JWT (python-jose), bcrypt (passlib).
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Chargement du .env du backend s'il existe
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
import bcrypt
import time
from collections import defaultdict
from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from sqlalchemy import String, Boolean, DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# ── Configuration ──────────────────────────────────────────────
# Production: exporter DATABASE_URL=postgresql://smartoptica:MOT_DE_PASSE@localhost:5432/smartoptica
# Défaut (sans PostgreSQL): SQLite fichier local, persistant.
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "sqlite:///" + os.path.join(os.path.dirname(__file__), "smartoptica.db"),
)
JWT_SECRET = os.environ.get("JWT_SECRET")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = int(os.environ.get("JWT_EXPIRE_HOURS", "72"))
ENV = os.environ.get("APP_ENV", "development").lower()

# En production, le secret JWT doit être explicite — jamais la valeur par défaut.
IS_RELAXED_DEFAULT = os.environ.get("ALLOW_INSECURE_JWT", "0") == "1"
if JWT_SECRET in (None, "", "CHANGE_ME_IN_ENV"):
    if ENV == "production" and not IS_RELAXED_DEFAULT:
        raise RuntimeError(
            "JWT_SECRET n'est pas défini. En production, définissez JWT_SECRET "
            "(var d'env) — ne jamais utiliser la valeur par défaut. "
            "Pour un dev non-prod uniquement, lancez avec APP_ENV=development."
        )
    JWT_SECRET = JWT_SECRET or "CHANGE_ME_IN_ENV"

_engine_kwargs = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs = {"connect_args": {"check_same_thread": False}}
engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


security = HTTPBearer(auto_error=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True,
                                       nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="user")  # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())


Base.metadata.create_all(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Schemas ────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    role: str

    class Config:
        from_attributes = True


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ── Helpers ────────────────────────────────────────────────────
def create_token(user: User) -> str:
    payload = {
        "sub": user.id,
        "email": user.email,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token manquant")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET,
                             algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalide ou expiré")
    user = db.get(User, payload.get("sub"))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Compte introuvable ou désactivé")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Droits administrateur requis")
    return user


# ── Routes ─────────────────────────────────────────────────────
router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── Rate limiter simple (fenêtre glissante en mémoire) ──────────
# Limite le brute-force sur login/register. Parse l'IP réelle (derrière un proxy
# on devrait regarder X-Forwarded-For, mais on reste simple : client.host).
_LOGIN_LIMIT = int(os.environ.get("LOGIN_RATE_LIMIT", "10"))     # tentatives max
_LOGIN_WINDOW = int(os.environ.get("LOGIN_RATE_WINDOW", "300"))  # fenêtre en secondes
_hits: dict[str, list[float]] = defaultdict(list)


def _rate_limited(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    # Retirer les entrées hors fenêtre
    cutoff = now - _LOGIN_WINDOW
    _hits[ip] = [t for t in _hits[ip] if t > cutoff]
    if len(_hits[ip]) >= _LOGIN_LIMIT:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "Trop de tentatives — réessayez plus tard.")
    _hits[ip].append(now)


@router.post("/register", response_model=UserOut, status_code=201)
def register(request: Request, data: RegisterIn, db: Session = Depends(get_db)):
    _rate_limited(request)
    existing = db.query(User).filter(User.email == data.email.lower()).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Un compte existe déjà avec cet email")
    user = User(
        email=data.email.lower(),
        name=data.name.strip(),
        password_hash=hash_password(data.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenOut)
def login(request: Request, data: LoginIn, db: Session = Depends(get_db)):
    _rate_limited(request)
    user = db.query(User).filter(User.email == data.email.lower()).first()
    # Message générique pour ne pas révéler si l'email existe
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email ou mot de passe incorrect")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Compte désactivé")
    return TokenOut(access_token=create_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user
