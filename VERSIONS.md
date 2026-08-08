# 🗂️ Versions de Smart Optica

## 🧊 Version 2 (3D) — EN DÉVELOPPEMENT
- **Profil Hermes** : `smart-optica-3d` (isolé : skills, mémoire, sessions, cron)
- **Branche git** : `main`
- **Caméra** : ORBBEC Astra Pro 3D (depth map, SDK v1 OpenNI)
- **Tests** : `backend/orbbec_test.py` (--probe/--depth/--color/--range/--save)
- **Objectif** : nuage de points du visage → mesures 3D directes (vertex, angle pantoscopique, DP, hauteur pupillaire)

### Utiliser le profil 3D
```bash
# CLI (depuis n'importe où)
hermes -p smart-optica-3d

# Workspace web : sélectionner le profil dans l'interface
# (dashboard 9119, workspace 3001)
```

## 🥽 Version 1 (clip) — SAUVEGARDE FROID, utilisable à la demande
- **Profil Hermes** : `smart-optica` (gateway Telegram actif)
- **Branche git** : `v1-clip-stable` (tag `v1.0-clip-stable`, commit `6787b56`)
- **Caméra** : caméra simple (iPad / webcam) + clip de calibration
- **Flux** : 2 photos (face → profil) → calibration 3 mires → mesures faciales → latérales → résultat

### Revenir à la v1 (à la demande)
```bash
cd ~/hermes-workspace/smart-optica-app
git checkout v1-clip-stable   # ← retour à la version clip
# pour revenir au dev 3D : git checkout main
```

## 📌 Règles
- **v1 figée** : plus aucune modification dessus (sauf hotfix via branche dérivée)
- **Toute nouvelle fonctionnalité 3D** se fait sur `main` avec le profil `smart-optica-3d`
- Les 2 profils partagent le même repo git mais ont des skills/mémoire/sessions séparés
- Le bot Telegram actuel reste lié à la v1 (profil smart-optica) — pour le 3D par Telegram, il faudrait un 2e bot BotFather
