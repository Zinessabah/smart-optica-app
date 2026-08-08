# 🗂️ Versions de Smart Optica

## Version actuelle (dev 3D en cours)
- **Branche** : `main`
- **Caméra** : ORBBEC Astra Pro 3D (depth map)
- **État** : exploration SDK v1, `backend/orbbec_test.py`

## Version stable (clip + caméra simple) — SAUVEGARDE
- **Branche** : `v1-clip-stable` (pointe vers `6787b56`)
- **Tag** : `v1.0-clip-stable`
- **Caméra** : caméra simple (iPad / webcam) + clip de calibration
- **Flux** : 2 photos (face → profil) → calibration 3 mires → mesures faciales → latérales → résultat

## 🔄 Revenir à la version clip (à la demande)

```bash
cd ~/hermes-workspace/smart-optica-app

# 1. Basculer sur la sauvegarde
git checkout v1-clip-stable

# 2. Reconstruire le frontend (si nécessaire)
cd frontend && npm install && npm run build && cd ..

# 3. Redémarrer les services (crontab @reboot les gère)
#    backend : uvicorn backend.main:app --host 0.0.0.0 --port 8000
#    frontend : vite preview --host 0.0.0.0 --port 5177
```

## ➡️ Revenir à la version 3D (dev)

```bash
git checkout main
```

## 📌 Notes
- La branche `v1-clip-stable` est **figée** : elle ne recevra plus de modifications.
- Toute nouvelle fonctionnalité 3D se fait sur `main`.
- Si un correctif urgent est nécessaire sur la v1 : créer une branche depuis `v1-clip-stable` (ex: `v1-hotfix`), merger ensuite si besoin.
