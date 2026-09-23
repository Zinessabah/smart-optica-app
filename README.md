# Smart Optica — Centrage digital de précision

Application pour opticien : à partir de **2 photos** (face + profil droit) d'un patient
portant un **clip de calibration** (mires espacées de 50 mm), elle calcule :

- **DP binoculaire & monoculaires** (OD/OG)
- **Pont** (écart inter-verres EIV)
- **Dimensions boxing** (largeur/hauteur calibre, hauteurs de montage)
- **Angle pantoscopique** et **distance vertex (D'L)** depuis la photo de profil
- Export **PDF** du résultat (fallback export HTML)

La **v2 (3D)** en développement remplace la photo par une caméra
[Orbbec Astra Pro](https://www.orbbec.com/products/depth-camera/astra-pro/) (depth + IR)
pour des mesures directes dans l'espace — voir `VERSIONS.md` et `backend/face3d_proto.py`.

## Architecture

| Couche | Techno | Emplacement |
|---|---|---|
| Frontend | React 19 · Vite 8 · Tailwind 4 · face-api.js | `src/` |
| Logique métier pure | JS pur, testé (vitest) | `src/core/` |
| Backend API | FastAPI · MediaPipe FaceLandmarker · OpenCV | `backend/main.py` |
| Prototypes caméra 3D | pyorbbecsdk v1 (OpenNI) | `backend/orbbec_test.py`, `face3d_proto.py`, `profil_vertex.py` |
| Scripts de diagnostic (archives) | un-shot expérimentaux | `backend/experiments/` |
| Clip de calibration | OpenSCAD (3D imprimable) | `design/` |

Le frontend appelle le backend via le proxy Vite (`/api` → `http://localhost:8000`).
Sans backend, l'app reste utilisable : détection native/face-api.js en local, calibration
et mesures manuelles.

## Installation (script automatique)

Un seul script installe et démarre l'ensemble — backend FastAPI, front, interface
d'administration, PostgreSQL, certificats HTTPS et services systemd :

```bash
./install.sh                # installation complète (front servi en build figé)
./install.sh --dev          # développement : serveurs Vite avec rechargement à chaud (HMR)
./install.sh --help         # toutes les options
```

| Étape | Ce que le script fait |
|---|---|
| Paquets système | `apt-get install` (postgresql, mkcert, python3-venv, build-essential…) — `--no-apt` pour ne pas y toucher |
| Dépendances JS | `npm ci` (versions verrouillées par `package-lock.json`, repli `npm install`) |
| Dépendances Python | venv + `backend/requirements.txt` (versions épinglées) |
| Base de données | rôle + base PostgreSQL et mot de passe **aléatoire** ; ou `--db-url` (base existante, ou SQLite) |
| Secrets | `backend/.env` généré en mode 600 (JWT_SECRET 256 bits) — **jamais réécrit** s'il existe déjà |
| Certificats | CA mkcert + certificat couvrant **toutes les IP détectées** de la machine |
| Services | unités systemd utilisateur + démarrage automatique sans session ouverte (`linger`) |
| Compte administrateur | créé (ou promu) pendant l'installation |
| Contrôle final | les 3 services en HTTP 200, SAN du certificat vérifié, URL récapitulées |

Le script est **idempotent** : le relancer ne casse rien et ne réécrit aucun secret.

> **Sur chaque iPad, une seule fois** : ouvrir `certs/rootCA.pem` (AirDrop ou navigateur),
> puis Réglages → Général → VPN et gestion de l'appareil → approuver. Sans cette étape,
> Safari refuse le certificat et la caméra reste bloquée.

**Deux installations sur la même machine** (recette, démonstration) :
`./install.sh --instance test` crée des services, journaux et base distincts
(`smart-optica-test-*`, `smartoptica_test`) **sans toucher** à l'installation principale.

### Désinstaller

```bash
./uninstall.sh              # retire les services, CONSERVE toutes les données
./uninstall.sh --purge      # supprime en plus base, photos, secrets, venv et node_modules
```

## Démarrage rapide (développement manuel)

### 1. Frontend

```bash
npm install
npm run dev        # https://localhost:5173 — HTTPS par certificat mkcert (certs/), requis pour getUserMedia
```

> Si `~/.npm` n'est pas accessible en écriture : `npm install --cache /tmp/npm-cache`.

### 2. Backend (optionnel, requis pour la détection auto des mires)

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt      # versions épinglées (fastapi, mediapipe, opencv, python-jose…)
uvicorn main:app --host 0.0.0.0 --port 8000
```

Le modèle `face_landmarker.task` (~3,7 Mo) est téléchargé automatiquement au premier
démarrage (ou placé dans `backend/models/`).

### 3. Tests & lint

```bash
npm test           # vitest — suite src/core/optics.test.js
npm run lint       # oxlint
npm run build      # bundle de production
```

## Workflow de mesure

1. **Photo de face** — patient de face avec le clip frontal (3 mires damier 2×2, 50 mm).
2. **Photo de profil droit** — pour l'angle pantoscopique et le vertex.
3. **Calibration** — détection auto des 3 mires (backend) ou placement manuel ; repli sur
   les repères estimés par `/api/analyze` si la détection échoue.
4. **Centrage & monture** — pupilles, centre du nez, rectangles boxing (avec verrouillage
   et miroir), panneau de mesures en temps réel.
5. **Mesures latérales** — branche 🟠, plan du verre 🟣, segment vertex 🟢. Les 3 segments
   sont **pré-placés automatiquement** par `/api/analyze-profile` (mires latérales → plan
   du verre, Hough → branche, MediaPipe → cornée), puis ajustables à la main (« ↻ Relancer »).
   Un bouton **« 🔍 Vérifier le calibrage 25 mm »** permet de poser une droite sur les
   2 cercles noirs latéraux pour contrôler que la distance mesurée vaut bien 25 mm
   (écart affiché + échelle impliquée par le placement).
6. **Résultat** — validation clinique (seuils dans `src/core/validation.js`), export PDF.

## Notes caméra Orbbec (v2 3D)

- L'Astra Pro (PID `0x0403`) est un modèle **OpenNI** : SDK **v1** obligatoire
  (`pyorbbecsdk`, à compiler — voir l'en-tête de `backend/orbbec_test.py`).
- Depth en **centimètres** (×10 pour mm) ; plage min **~60 cm** ; USB 2.0 : pas de
  depth+color simultanés à 640×480.
- Wrapper : `./backend/run_orbbec.sh backend/face3d_proto.py`

## Références

- `VERSIONS.md` — état v1 (clip, figée) vs v2 (3D) et profils Hermes associés.
- `design/clip_reference_v3.scad` — clip imprimable (OpenSCAD → STL).
