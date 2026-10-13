"""
Tests du pont de collecte Android — `POST /captures`, contrat « Niveau Caméra » v1.2.

Source de vérité du contrat : `openapi.yaml` de l'application Android. La forme exacte
compte ici : l'application désérialise avec `ignoreUnknownKeys`, donc un champ RENOMMÉ
côté serveur ne lève rien chez elle — il disparaît silencieusement. C'est précisément
pourquoi ces tests vérifient les noms.

Ce que ces tests protègent, dans l'ordre d'importance :

1. **L'idempotence.** L'application rejoue une capture après une coupure réseau survenue
   après l'enregistrement mais avant la réponse (WorkManager, backoff exponentiel). Si le
   serveur créait une deuxième ligne, l'historique doublerait à chaque coupure. Le rejeu
   doit rendre le MÊME `serverCaptureId`, avec un statut distinct — 200 et non 201.
2. **Les codes de réponse et leur forme.** Un 400 est DÉFINITIF (jamais rejoué), un 5xx est
   rejouable : rendre 422 (le défaut FastAPI sur un multipart incomplet) ferait rejouer une
   erreur de format. Et l'erreur doit sortir au format `ApiError` (`code`/`message`/
   `retryable`), pas en `detail` — l'application ne lit que le premier.
3. **La taille annoncée.** `sizeBytes` est vérifié contre ce qui est réellement arrivé :
   accepter une divergence archiverait une photo corrompue en la présentant comme intacte,
   et on ne s'en apercevrait qu'au moment de mesurer.
4. **L'isolation entre utilisateurs.** Une capture n'appartient qu'à son propriétaire,
   photo comprise.
5. **Le contexte de prise de vue.** Les angles du niveau à bulle sont la valeur ajoutée de
   l'application. En particulier : `null` (capteur muet) et `0.0` (vraiment à l'aplomb) sont
   deux informations DIFFÉRENTES, qui ne doivent jamais être confondues.
"""
import io
import json
import os

from .conftest import login, register

BASE = "/captures"


# ── Fabriques ───────────────────────────────────────────────────────────────────
def _png(width: int = 640, height: int = 480, color=(200, 30, 30)) -> bytes:
    """Un vrai PNG, pas des octets factices : la porte de qualité lit la signature ET les
    dimensions, donc un faux fichier ne passerait pas — et ne testerait rien."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _meta(client_id: str = "client-abc", **over) -> dict:
    """Métadonnées au format exact du contrat v1.2 — `CaptureMetadata` de l'OpenAPI."""
    m = {
        "clientCaptureId": client_id,
        "takenAtEpochMillis": 1_770_000_000_000,
        "fileName": "capture-20260214-093000.jpg",
        "sizeBytes": 0,                     # remplacé par _post (taille réelle)
        "rollDegrees": 0.4,
        "pitchDegrees": -1.2,
        "referenceIsCustom": False,
        "exifOrientation": 6,
        "angularSpeedDegreesPerSecond": 0.7,
    }
    m.update(over)
    return m


def _auth(client, email="capture@test.ma", name="Capture Test"):
    register(client, email, name)
    return {"Authorization": f"Bearer {login(client, email)}"}


def _post_bytes(client, headers, photo_bytes, meta):
    """Envoi brut : contrôle total des octets, pour les cas « taille » et « fichier »."""
    return client.post(BASE, headers=headers,
                       files={"photo": ("capture.png", photo_bytes, "image/png")},
                       data={"metadata": json.dumps(meta) if isinstance(meta, dict) else meta})


def _post(client, headers, client_id="client-abc", photo_bytes=None, meta=None,
          idem_key=None, part="photo"):
    """Un envoi tel que le produit `CaptureApiClient` : parties `metadata` + `photo`.

    `sizeBytes` est calculé sur les octets réellement envoyés — sinon l'envoi serait refusé
    par la vérification de taille, et le test mesurerait autre chose que ce qu'il croit
    mesurer.
    """
    data = _png() if photo_bytes is None else photo_bytes
    if meta is None:
        meta = _meta(client_id, sizeBytes=len(data))
    elif isinstance(meta, dict) and meta.get("sizeBytes") == 0:
        meta = {**meta, "sizeBytes": len(data)}

    payload = json.dumps(meta) if isinstance(meta, dict) else meta
    files = {part: ("capture.png", data, "image/png")} if data is not None else None
    if idem_key is not None:
        headers = {**headers, "Idempotency-Key": idem_key}
    return client.post(BASE, headers=headers, files=files, data={"metadata": payload})


def _files() -> int:
    """Nombre de fichiers de capture sur le disque — pour vérifier que rejouer (ou
    supprimer) agit vraiment, et pas seulement sur la base."""
    import captures as cap
    n = 0
    for _root, _dirs, names in os.walk(cap.UPLOAD_ROOT):
        n += len(names)
    return n


# ── Authentification ────────────────────────────────────────────────────────────
def test_sans_jeton_la_capture_est_refusee_401(client):
    r = _post(client, {}, client_id="sans-jeton")
    assert r.status_code == 401, r.text


def test_jeton_invalide_refuse_401(client):
    r = _post(client, {"Authorization": "Bearer pas-un-jeton"}, client_id="faux")
    assert r.status_code == 401, r.text


# ── Création et forme de la réponse ─────────────────────────────────────────────
def test_une_capture_valide_est_creee_201_au_format_du_contrat(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-1")
    assert r.status_code == 201, r.text
    body = r.json()

    # Les QUATRE champs de `CaptureAccepted`, nommés exactement comme dans l'OpenAPI.
    assert set(body) == {"serverCaptureId", "clientCaptureId", "status",
                         "receivedAtEpochMillis"}, body
    assert body["status"] == "created"
    assert body["clientCaptureId"] == "c-1"
    assert isinstance(body["serverCaptureId"], str) and body["serverCaptureId"]
    assert isinstance(body["receivedAtEpochMillis"], int)


def test_la_route_accepte_aussi_une_barre_finale(client):
    """Le client concatène `/captures` à l'URL saisie ; une URL terminée par `/` produit
    `/captures/`. Refuser pour une barre serait une panne gratuite."""
    h = _auth(client)
    data = _png()
    meta = _meta("c-slash", sizeBytes=len(data))
    r = client.post(BASE + "/", headers=h,
                    files={"photo": ("capture.png", data, "image/png")},
                    data={"metadata": json.dumps(meta)})
    assert r.status_code == 201, r.text
    assert r.json()["clientCaptureId"] == "c-slash"


# ── Idempotence ─────────────────────────────────────────────────────────────────
def test_rejeu_du_meme_client_id_est_idempotent_200(client):
    """Le cas réel : le téléphone n'a pas vu la réponse et rejoue."""
    h = _auth(client)
    first = _post(client, h, client_id="rejeu")
    assert first.status_code == 201, first.text

    again = _post(client, h, client_id="rejeu")
    assert again.status_code == 200, again.text        # 200 = doublon, pas 201
    assert again.json()["status"] == "duplicate"
    assert again.json()["serverCaptureId"] == first.json()["serverCaptureId"]


def test_le_rejeu_ne_cree_pas_de_photo_supplementaire(client):
    """Rejouer ne doit rien réécrire, ni en base ni sur le disque."""
    h = _auth(client)
    _post(client, h, client_id="rejeu-disque")
    avant = _files()
    _post(client, h, client_id="rejeu-disque")
    assert _files() == avant


def test_un_client_id_different_cree_une_capture_de_plus(client):
    h = _auth(client)
    a = _post(client, h, client_id="c-a")
    b = _post(client, h, client_id="c-b")
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["serverCaptureId"] != b.json()["serverCaptureId"]


def test_le_meme_client_id_chez_deux_utilisateurs_est_independant(client):
    """`clientCaptureId` est idempotent PAR UTILISATEUR : deux téléphones peuvent générer le
    même identifiant sans que leurs captures se confondent."""
    ha = _auth(client, "iso1@test.ma", "Aline")
    hb = _auth(client, "iso2@test.ma", "Bruno")
    a = _post(client, ha, client_id="meme-id")
    b = _post(client, hb, client_id="meme-id")
    assert a.status_code == 201 and b.status_code == 201, (a.text, b.text)
    assert a.json()["serverCaptureId"] != b.json()["serverCaptureId"]


# ── Métadonnées du niveau à bulle ───────────────────────────────────────────────
def test_les_metadonnees_de_niveau_sont_conservees(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-meta")
    cid = r.json()["serverCaptureId"]

    c = client.get(f"{BASE}/{cid}", headers=h).json()
    assert c["rollDegrees"] == 0.4
    assert c["pitchDegrees"] == -1.2
    assert c["referenceIsCustom"] is False
    assert c["exifOrientation"] == 6
    assert c["angularSpeedDegreesPerSecond"] == 0.7
    assert c["fileName"] == "capture-20260214-093000.jpg"
    assert c["width"] == 640 and c["height"] == 480
    assert c["imageBytes"] > 0


def test_angles_nuls_et_angles_absents_ne_sont_pas_confondus(client):
    """`null` = capteur muet (l'application n'invente jamais une mesure) ; `0.0` = photo
    prise d'aplomb. Les fusionner détruirait la distinction, donc l'information."""
    h = _auth(client)

    nul = _post(client, h, client_id="angles-aplomb",
                meta=_meta("angles-aplomb", rollDegrees=0.0, pitchDegrees=0.0))
    muet = _post(client, h, client_id="angles-muets",
                 meta=_meta("angles-muets", rollDegrees=None, pitchDegrees=None))
    assert nul.status_code == 201 and muet.status_code == 201, (nul.text, muet.text)

    a = client.get(f"{BASE}/{nul.json()['serverCaptureId']}", headers=h).json()
    b = client.get(f"{BASE}/{muet.json()['serverCaptureId']}", headers=h).json()

    assert a["rollDegrees"] == 0.0 and a["pitchDegrees"] == 0.0
    assert b["rollDegrees"] is None and b["pitchDegrees"] is None


def test_une_reference_personnalisee_est_enregistree(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-ref", meta=_meta("c-ref", referenceIsCustom=True))
    c = client.get(f"{BASE}/{r.json()['serverCaptureId']}", headers=h).json()
    assert c["referenceIsCustom"] is True


# ── Vérification de la taille annoncée ──────────────────────────────────────────
def test_une_taille_annoncee_divergente_est_refusee_400(client):
    """Troncature ou bug client : accepter sans rien dire archiverait une photo corrompue en
    la présentant comme intacte."""
    h = _auth(client)
    data = _png()
    r = _post_bytes(client, h, data, _meta("c-taille", sizeBytes=len(data) + 1234))
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "size_bytes_divergent"
    assert r.json()["retryable"] is False       # DÉFINITIF : rejouer ne changera rien


def test_size_bytes_manquant_est_refuse_400(client):
    h = _auth(client)
    meta = _meta("c-sans-taille")
    meta.pop("sizeBytes")
    r = _post_bytes(client, h, _png(), meta)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "size_bytes_manquant"


# ── En-tête Idempotency-Key ─────────────────────────────────────────────────────
def test_un_en_tete_idempotency_key_coherent_est_accepte(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-idem", idem_key="c-idem")
    assert r.status_code == 201, r.text


def test_un_en_tete_idempotency_key_divergent_est_refuse_400(client):
    """Deux identifiants contradictoires signalent un bug client : mieux vaut le voir tout
    de suite que d'archiver une capture sous la mauvaise clé."""
    h = _auth(client)
    r = _post(client, h, client_id="c-idem-div", idem_key="autre-chose")
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "idempotency_key_divergente"


def test_l_en_tete_idempotency_key_est_facultatif(client):
    """Le contrat le documente, mais la clé d'idempotence fait autorité dans les
    métadonnées : son absence ne doit pas faire échouer un envoi valide."""
    h = _auth(client)
    r = _post(client, h, client_id="c-sans-idem")
    assert r.status_code == 201, r.text


# ── Multipart malformé : 400 explicite, jamais 422 ──────────────────────────────
def test_une_partie_metadata_absente_est_refusee_400(client):
    h = _auth(client)
    r = client.post(BASE, headers=h, files={"photo": ("capture.png", _png(), "image/png")})
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "metadata_absente"


def test_des_metadonnees_non_json_sont_refusees_400(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-json", meta="{pas du json")
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "metadata_json_invalide"


def test_des_metadonnees_qui_ne_sont_pas_un_objet_sont_refusees_400(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-liste", meta="[1,2,3]")
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "metadata_non_objet"


def test_un_client_capture_id_manquant_est_refuse_400(client):
    h = _auth(client)
    meta = _meta("x")
    meta.pop("clientCaptureId")
    r = _post_bytes(client, h, _png(), meta)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "client_capture_id_manquant"


def test_une_partie_photo_absente_est_refusee_400(client):
    h = _auth(client)
    data = _png()
    meta = _meta("c-sans-photo", sizeBytes=len(data))
    r = client.post(BASE, headers=h, data={"metadata": json.dumps(meta)})
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "photo_absente"


def test_une_partie_nommee_image_est_refusee_400(client):
    """Garde-fou de contrat : c'est `photo`, pas `image`. Une application réécrite sur une
    mauvaise hypothèse doit échouer franchement plutôt que d'archiver des captures muettes."""
    h = _auth(client)
    r = _post(client, h, client_id="c-mauvais-nom", part="image")
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "photo_absente"


def test_une_photo_vide_est_refusee_400(client):
    h = _auth(client)
    r = _post(client, h, client_id="c-vide", photo_bytes=b"",
              meta=_meta("c-vide", sizeBytes=0))
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "photo_vide"


def test_des_octets_qui_ne_sont_pas_une_image_sont_refuses_400(client):
    """La porte de qualité lit la signature réelle, jamais l'extension annoncée."""
    h = _auth(client)
    r = _post(client, h, client_id="c-faux", photo_bytes=b"ceci n'est pas une image" * 10)
    assert r.status_code == 400, r.text
    assert r.json()["retryable"] is False


def test_une_photo_trop_volumineuse_est_refusee_400(client, monkeypatch):
    """Le plafond est abaissé pour le test : envoyer 40 Mo réels ne mesurerait rien de plus
    et ralentirait toute la suite."""
    import captures as cap
    monkeypatch.setattr(cap, "MAX_IMAGE_BYTES", 64)
    h = _auth(client)
    r = _post(client, h, client_id="c-gros", photo_bytes=_png(64, 64))
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "photo_trop_volumineuse"


# ── Isolation entre utilisateurs ────────────────────────────────────────────────
def test_un_autre_utilisateur_ne_voit_ni_la_capture_ni_la_photo(client):
    ha = _auth(client, "priv1@test.ma", "Isabelle")
    hb = _auth(client, "priv2@test.ma", "Bruno")
    cid = _post(client, ha, client_id="c-priv").json()["serverCaptureId"]

    assert client.get(f"{BASE}/{cid}", headers=hb).status_code == 403
    assert client.get(f"{BASE}/{cid}/image", headers=hb).status_code == 403
    assert client.delete(f"{BASE}/{cid}", headers=hb).status_code == 403


def test_l_historique_ne_contient_que_ses_propres_captures(client):
    ha = _auth(client, "h1@test.ma", "Hanna")
    hb = _auth(client, "h2@test.ma", "Boris")
    _post(client, ha, client_id="hist-a-1")
    _post(client, hb, client_id="hist-b-1")

    ids_a = {c["clientCaptureId"] for c in client.get(BASE, headers=ha).json()}
    ids_b = {c["clientCaptureId"] for c in client.get(BASE, headers=hb).json()}
    assert ids_a == {"hist-a-1"}, ids_a
    assert ids_b == {"hist-b-1"}, ids_b


def test_sans_jeton_l_historique_est_refuse_401(client):
    assert client.get(BASE).status_code == 401


# ── Le fichier ──────────────────────────────────────────────────────────────────
def test_l_image_est_servie_octet_pour_octet(client):
    """« Identique », pas « ressemblant » : c'est une photo de mesure, pas une vignette."""
    h = _auth(client)
    data = _png(320, 240)
    cid = _post(client, h, client_id="c-octets",
                photo_bytes=data).json()["serverCaptureId"]

    img = client.get(f"{BASE}/{cid}/image", headers=h)
    assert img.status_code == 200
    assert img.content == data
    assert img.headers["content-type"].startswith("image/png")


def test_la_suppression_retire_la_ligne_et_le_fichier(client):
    """Laisser l'un sans l'autre crée un orphelin sur le disque."""
    h = _auth(client)
    cid = _post(client, h, client_id="c-suppr").json()["serverCaptureId"]
    avant = _files()

    assert client.delete(f"{BASE}/{cid}", headers=h).status_code == 204
    assert client.get(f"{BASE}/{cid}", headers=h).status_code == 404
    assert _files() == avant - 1


def test_une_capture_inconnue_rend_404(client):
    h = _auth(client)
    assert client.get(f"{BASE}/00000000-0000-0000-0000-000000000000",
                      headers=h).status_code == 404
