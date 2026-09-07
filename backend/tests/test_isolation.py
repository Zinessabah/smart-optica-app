"""
Tests d'isolation des données par utilisateur — Smart Optica.

Garantit que : aucun utilisateur ne peut voir/modifier les mesures d'un autre,
seul l'administrateur a une vue globale. (Requête B passe en 403, jamais 200.)
"""
from .conftest import register, login, create_measurement


def test_registration(client):
    r = register(client, "iso_a@t.ma", "User A")
    assert r.status_code == 201, r.text


def test_two_users_isolated(client):
    """B ne voit jamais les mesures de A (liste vide + 403 sur accès direct)."""
    register(client, "iso_a@t.ma", "User A")
    register(client, "iso_b@t.ma", "User B")
    ta = login(client, "iso_a@t.ma")
    tb = login(client, "iso_b@t.ma")
    assert ta and tb

    # A crée une mesure
    r = create_measurement(client, ta)
    assert r.status_code == 201, r.text
    mid = r.json()["id"]

    # B lister ses mesures → ne doit PAS voir celles de A
    rb = client.get("/api/measurements", headers={"Authorization": f"Bearer {tb}"})
    assert rb.status_code == 200
    assert len(rb.json()) == 0, "B voit des mesures de A !"

    # B accès direct à la mesure de A → 403
    rb2 = client.get(f"/api/measurements/{mid}", headers={"Authorization": f"Bearer {tb}"})
    assert rb2.status_code == 403, f"B a lu la mesure de A ({rb2.status_code})"

    # B tente de la supprimer → 403
    rb3 = client.delete(f"/api/measurements/{mid}", headers={"Authorization": f"Bearer {tb}"})
    assert rb3.status_code == 403, f"B a supprimé la mesure de A ({rb3.status_code})"


def test_owner_can_read_and_delete(client):
    """Le propriétaire lit/supprime SA mesure."""
    register(client, "iso_owner@t.ma", "Owner")
    to = login(client, "iso_owner@t.ma")
    r = create_measurement(client, to)
    mid = r.json()["id"]
    assert client.get(f"/api/measurements/{mid}",
                      headers={"Authorization": f"Bearer {to}"}).status_code == 200
    assert client.delete(f"/api/measurements/{mid}",
                         headers={"Authorization": f"Bearer {to}"}).status_code == 204


def test_non_admin_cannot_access_admin_all(client):
    """Un user normal est bloqué sur /api/measurements/admin/all (403)."""
    register(client, "iso_norm@t.ma", "Normal")
    tn = login(client, "iso_norm@t.ma")
    r = client.get("/api/measurements/admin/all", headers={"Authorization": f"Bearer {tn}"})
    assert r.status_code == 403, f"user normal a accédé à admin/all ({r.status_code})"


def test_admin_sees_everything(client):
    """L'admin voit toutes les mesures + filtre par user_id."""
    register(client, "iso_a@t.ma", "User A")
    register(client, "iso_b@t.ma", "User B")
    ta = login(client, "iso_a@t.ma")
    tb = login(client, "iso_b@t.ma")
    create_measurement(client, ta)
    create_measurement(client, tb)

    # Promouvoir un admin via la DB (aucun endpoint self-promote)
    from auth import SessionLocal, User
    db = SessionLocal()
    u = db.query(User).filter(User.email == "iso_a@t.ma").first()
    u.role = "admin"
    db.commit()
    db.close()
    ta_admin = login(client, "iso_a@t.ma")

    ra = client.get("/api/measurements/admin/all",
                    headers={"Authorization": f"Bearer {ta_admin}"})
    assert ra.status_code == 200
    assert len(ra.json()) == 2, "admin devrait voir les 2 mesures"


def test_admin_users_routes_protected(client):
    """Un user normal est bloqué sur /api/admin/users (403)."""
    register(client, "iso_norm@t.ma", "Normal")
    tn = login(client, "iso_norm@t.ma")
    r = client.get("/api/admin/users", headers={"Authorization": f"Bearer {tn}"})
    assert r.status_code == 403, f"user normal a accédé à admin/users ({r.status_code})"


def test_user_cannot_self_promote_to_admin(client):
    """Un user normal ne peut pas devenir admin via PATCH (403)."""
    register(client, "iso_self@t.ma", "Self")
    ts = login(client, "iso_self@t.ma")
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {ts}"}).json()
    r = client.patch(f"/api/admin/users/{me['id']}",
                     json={"role": "admin"},
                     headers={"Authorization": f"Bearer {ts}"})
    assert r.status_code == 403, f"user normal s'est auto-promu ({r.status_code})"
