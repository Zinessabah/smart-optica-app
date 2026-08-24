# 🗂️ Versions de Smart Optica

## 🥽 Branche `main` — APPLICATION CLIP (focus actuel)
- **Contenu** : app React/Vite v1 clip — 2 photos (face → profil) → calibration 3 mires → PupilMarker → ProfileMeasure → ResultCard
- **Profil Hermes** : `smart-optica` (gateway Telegram)
- Dernier commit : fix cercle Ø verre (renderLensCircles SVG)

## 🧊 Branche `v2-3d` — VERSION 3D (en pause)
- **Contenu** : état du dev 3D au moment de la séparation (prototype Astra Pro opérationnel, clip v8 SCAD, expériences backend)
- **Profil Hermes** : `smart-optica-3d`
- **Caméra** : ORBBEC Astra Pro 3D (SDK v1 OpenNI)
- Reprendre : `git checkout v2-3d` (⚠️ OrbbecViewer v1.10.27 seul compatible, ouvert = caméras BUSY)

## 📌 Règles
- Les 2 branches sont STRICTEMENT indépendantes — pas de merge entre elles
- Le focus est 100% sur `main` (app clip) ; toute évolution 3D se fait sur `v2-3d` via le profil smart-optica-3d
