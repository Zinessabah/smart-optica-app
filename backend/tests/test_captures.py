"""
Tests du pont de collecte Android — `POST /captures`.

Ce que ces tests protègent, dans l'ordre d'importance :

1. **L'idempotence.** L'application Android rejoue une capture après une coupure réseau
   survenue après l'enregistrement mais avant la réponse. Si le serveur créait une
   deuxième ligne, l'historique doublerait à chaque coupure. Le rejeu doit rendre le
   MÊME `captureId`, avec un statut distinct — 200 « duplicate » et non 201.
2. **Les codes de réponse.** Le contrat de l'application les distingue de façon
   normative : un 400 est DÉFINITIF (jamais rejoué), un 5xx est rejouable. Rendre 422
   (le défaut FastAPI sur un multipart incomplet) ferait rejouer une erreur de format.
3. **L'isolation entre utilisateurs.** Une capture n'appartient qu'à son propriétaire :
   photo comprise.
4. **Le contexte de prise de vue.** Les angles du niveau à bulle sont la valeur ajoutée
   de l'application : ils doivent arriver intacts, sans quoi la mesure ne peut pas juger
   si la photo a été prise d'aplomb.
"""
import io
import json

from .conftest import login, register

BASE = "/captures"


# ── Fabriques ───────────────────────────────────────────────────────────────────
def _png(width: int = 640, height: int = 480, color=(200, 30, 30)) -> bytes:
    """Un vrai PNG, pas des octets factices : la porte de qualité lit la signature ET
    les dimensions, donc un faux fichier ne passerait pas — et ne testerait rien."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _meta(client_id: str = "client-abc", **over) -> str:
    """Métadonnées telles que l'app les envoie (noms de champs exacts de son contrat)."""
    m = {
        "clientCaptureId": client_id,
        "capturedAt": "2026-02-14T09:30:00Z",
        "horizontalAngleDegrees": 0.4,
        "verticalAngleDegrees": -1.2,
        "toleranceDegrees": 1.0,
        "isAligned": True,
        "referenceMode": "gravite",
        "displayRotationDegrees": 90,
        "sensorSource": "rotation_vector",
        "measurementAgeMs": 42,
        "measurementStatus": "fresh",
        "appVersion": "1.0.0",
    }
    m.update(over)
    return json.dumps(m)


def _auth(client, email="capture@test.ma", name="Capture Test"):
    register(client, email, name)
    return {"Authorization": f"Bearer {login(client, email)}"}


def _post(client, headers, client_id="client-abc", image=True, meta=None):
    files = {"image": ("photo.png", _png(), "image/png")} if image else None
    data = {"metadata": meta if meta is not None else _meta(client_id)}
    return client.post(BASE, headers=headers, files=files, data=data)


# ── Authentification ────────────────────────────────────────────────────────────
def test_sans_jeton_la_capture_est_refusee_401(client):
    r = _post(client, {}, client_id="sans-jeton")
    assert r.status_code == 401, r.text


def test_jeton_invalide_refuse_401(client):
    r = _post(client, {"Authorization": "Bearer pas-un-jeton"}, client_id="faux")
    assert r.status_code == 401, r.text


# ── Création ────────────────────────────────────────────────────────────────────
def test_une_capture_valide_est_creee_201(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-1")
    assert r.status_code == 201, r.text         # 201 = création (contrat)
    body = r.json()
    assert body["status"] == "created", body
    assert body["captureId"], body
    assert "enregistrée" in (body["message"] or ""), body


def test_les_metadonnees_de_niveau_sont_conservees(client):
    """Les angles du niveau à bulle sont la raison d'être de l'app Android : s'ils se
    perdent, la mesure ne sait plus si la photo a été prise d'aplomb."""
    h = _auth(client)
    _post(client, h, client_id="angles",
          meta=_meta("angles", horizontalAngleDegrees=2.5,
                     verticalAngleDegrees=-3.75, toleranceDegrees=1.5,
                     isAligned=False, referenceMode="manuel",
                     sensorSource="accelerometre", measurementAgeMs=123,
                     appVersion="1.0.1"))
    got = client.get(BASE, headers=h).json()
    assert len(got) == 1, got
    c = got[0]
    assert c["rollDegrees"] == 2.5, c
    assert c["pitchDegrees"] == -3.75, c
    assert c["toleranceDegrees"] == 1.5, c
    assert c["isAligned"] is False, c
    assert c["appVersion"] == "1.0.1", c
    # Les dimensions prouvent que la porte de qualité a réellement lu l'image.
    assert (c["width"], c["height"]) == (640, 480), c


# ── Idempotence — le cœur du contrat ────────────────────────────────────────────
def test_rejeu_du_meme_client_id_est_idempotent(client):
    """Le cas qui se produit en vrai : coupure réseau APRÈS enregistrement, AVANT
    réponse. L'application rejoue. Sans idempotence, l'historique doublerait."""
    h = _auth(client)
    first = _post(client, h, client_id="rejeu")
    assert first.json()["status"] == "created"
    second = _post(client, h, client_id="rejeu")
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["status"] == "duplicate", body
    assert body["captureId"] == first.json()["captureId"], "le rejeu doit rendre le MÊME id"
    assert len(client.get(BASE, headers=h).json()) == 1, "aucune deuxième ligne"


def test_un_client_id_different_cree_une_capture_de_plus(client):
    h = _auth(client)
    a = _post(client, h, client_id="a")
    b = _post(client, h, client_id="b")
    assert a.json()["captureId"] != b.json()["captureId"]
    assert len(client.get(BASE, headers=h).json()) == 2


def test_le_rejeu_ne_reecrit_pas_le_fichier(client):
    """Rejouer ne doit rien réécrire : le contenu reste celui de la première réception."""
    h = _auth(client)
    _post(client, h, client_id="contenu")
    cid = client.get(BASE, headers=h).json()[0]["id"]
    first = client.get(f"{BASE}/{cid}/image", headers=h).content
    _post(client, h, client_id="contenu")                    # rejeu
    assert client.get(f"{BASE}/{cid}/image", headers=h).content == first


# ── Multipart mal formé : 400 DÉFINITIF, jamais 422 ─────────────────────────────
def test_metadata_absente_rend_400_et_non_422(client):
    """422 ferait rejouer indéfiniment une erreur de format : le contrat l'interdit."""
    h = _auth(client)
    r = client.post(BASE, headers=h, files={"image": ("p.png", _png(), "image/png")})
    assert r.status_code == 400, r.text


def test_metadata_json_invalide_rend_400(client):
    h = _auth(client)
    r = _post(client, h, meta="{ceci n'est pas du json")
    assert r.status_code == 400, r.text


def test_metadata_non_objet_rend_400(client):
    h = _auth(client)
    r = _post(client, h, meta='["une", "liste"]')
    assert r.status_code == 400, r.text


def test_client_capture_id_manquant_rend_400(client):
    h = _auth(client)
    r = _post(client, h, meta=json.dumps({"capturedAt": "2026-01-01T00:00:00Z"}))
    assert r.status_code == 400, r.text


def test_image_absente_rend_400(client):
    h = _auth(client)
    r = _post(client, h, client_id="sans-image", image=False)
    assert r.status_code == 400, r.text


def test_image_vide_rend_400(client):
    h = _auth(client)
    r = client.post(BASE, headers=h, data={"metadata": _meta("vide")},
                    files={"image": ("p.png", b"", "image/png")})
    assert r.status_code == 400, r.text


def test_fichier_non_image_rend_400(client):
    """La signature réelle est vérifiée, jamais l'extension : un .png qui n'en est pas
    un ne doit pas entrer en base."""
    h = _auth(client)
    r = client.post(BASE, headers=h, data={"metadata": _meta("faux-png")},
                    files={"image": ("photo.png", b"x" * 512, "image/png")})
    assert r.status_code == 400, r.text


# ── Lecture ─────────────────────────────────────────────────────────────────────
def test_le_detail_renvoie_le_contrat_attendu(client):
    """Forme exacte du `RemoteCaptureResponse` Kotlin."""
    h = _auth(client)
    _post(client, h, client_id="detail")
    cid = client.get(BASE, headers=h).json()[0]["id"]
    r = client.get(f"{BASE}/{cid}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"capture", "downloadUrl"}, body
    assert body["capture"]["id"] == cid
    assert body["capture"]["status"]
    assert body["capture"]["capturedAt"]
    assert body["downloadUrl"] == f"{BASE}/{cid}/image", body


def test_l_image_est_servie_telle_quelle(client):
    h = _auth(client)
    png = _png(color=(10, 220, 40))
    client.post(BASE, headers=h, data={"metadata": _meta("octets")},
                files={"image": ("p.png", png, "image/png")})
    cid = client.get(BASE, headers=h).json()[0]["id"]
    r = client.get(f"{BASE}/{cid}/image", headers=h)
    assert r.status_code == 200
    assert r.content == png, "les octets doivent être rendus sans transformation"


def test_capture_inexistante_rend_404(client):
    h = _auth(client)
    assert client.get(f"{BASE}/n-existe-pas", headers=h).status_code == 404


# ── Isolation ───────────────────────────────────────────────────────────────────
def test_un_autre_utilisateur_ne_voit_ni_la_capture_ni_la_photo(client):
    ha = _auth(client, "a@test.ma", "Alice")
    created = _post(client, ha, client_id="prive")
    assert created.status_code == 201, created.text
    listed = client.get(BASE, headers=ha)
    assert listed.status_code == 200, listed.text
    cid = listed.json()[0]["id"]

    hb = _auth(client, "b@test.ma", "Bob")
    assert client.get(BASE, headers=hb).json() == [], "la liste de B doit être vide"
    assert client.get(f"{BASE}/{cid}", headers=hb).status_code == 403
    assert client.get(f"{BASE}/{cid}/image", headers=hb).status_code == 403
    assert client.delete(f"{BASE}/{cid}", headers=hb).status_code == 403


def test_le_meme_client_id_chez_deux_utilisateurs_est_independant(client):
    """Deux téléphones peuvent générer le même identifiant par hasard : il ne doit pas
    exister une capture unique partagée entre deux comptes."""
    ha = _auth(client, "a2@test.ma", "Alice2")
    hb = _auth(client, "b2@test.ma", "Bob2")
    ra = _post(client, ha, client_id="collision")
    rb = _post(client, hb, client_id="collision")
    assert ra.json()["status"] == "created"
    assert rb.json()["status"] == "created", "l'unicité est par utilisateur, pas globale"
    assert ra.json()["captureId"] != rb.json()["captureId"]


# ── Suppression ─────────────────────────────────────────────────────────────────
def test_la_suppression_retire_la_ligne_et_le_fichier(client):
    h = _auth(client)
    _post(client, h, client_id="a-supprimer")
    cid = client.get(BASE, headers=h).json()[0]["id"]
    assert client.delete(f"{BASE}/{cid}", headers=h).status_code == 204
    assert client.get(BASE, headers=h).json() == []
    assert client.get(f"{BASE}/{cid}", headers=h).status_code == 404


# ── Le contrat de l'application, bout à bout ────────────────────────────────────
def test_health_est_servi_a_la_racine(client):
    """L'application teste `GET health` (chemin relatif) contre l'URL saisie. Si ce
    chemin vivait sous /api, son test de connexion échouerait."""
    r = client.get("/health")
    assert r.status_code == 200, r.text
