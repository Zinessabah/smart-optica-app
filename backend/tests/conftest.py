"""
Fixture pytest pour les tests d'isolation Smart Optica.

Point CLÉ : on pointe DATABASE_URL vers un SQLite jetable AVANT tout import
des modules backend (auth.py lit os.environ au moment de l'import, et
load_dotenv(.env) n'écrase PAS une variable déjà définie car override=False).
=> Les tests ne touchent JAMAIS PostgreSQL de production.
"""
import os
import sys

# SQLite jetable — pointé AVANT les imports backend
_TEST_DB = "/tmp/so_isolation_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ["APP_ENV"] = "test"

# Nettoyer une éventuelle DB de test résiduelle
for suffix in ("", "-wal", "-shm"):
    p = _TEST_DB + suffix
    if os.path.exists(p):
        os.remove(p)

import pytest
from fastapi.testclient import TestClient


def _reset_db():
    """Vide les tables measurements/users entre les tests (DB jetable)."""
    from measurements import Measurement, SessionLocal
    from auth import User, _hits
    db = SessionLocal()
    try:
        db.query(Measurement).delete()
        db.query(User).delete()
        db.commit()
        # Réinitialiser le rate-limiter EN MÉMOIRE (dict partagé au niveau module).
        # TestClient utilise toujours la même IP 'testclient' → sans reset, les
        # logins s'accumulent et dépassent LOGIN_RATE_LIMIT (429) → tokens vides.
        _hits.clear()
    finally:
        db.close()


@pytest.fixture()
def client():
    """Un TestClient FRAIS par test (évite toute contamination d'état entre tests).
    Import après var d'env → pointe sur le SQLite jetable, jamais PostgreSQL."""
    import main
    _reset_db()
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _clean_db():
    """Vide la DB jetable avant CHAQUE test (isolation entre tests)."""
    _reset_db()
    yield


def register(client, email, name, pw="Secure12345"):
    return client.post("/api/auth/register",
                       json={"email": email, "name": name, "password": pw})


def login(client, email, pw="Secure12345"):
    r = client.post("/api/auth/login", json={"email": email, "password": pw})
    return r.json().get("access_token", "")


def create_measurement(client, token, pd=64.5):
    return client.post(
        "/api/measurements",
        headers={"Authorization": f"Bearer {token}"},
        data={"results": f'{{"pd": {pd}, "pont": 22}}'},
    )


# Exposer les helpers comme importables des tests
sys.modules[__name__].register = register
sys.modules[__name__].login = login
sys.modules[__name__].create_measurement = create_measurement
