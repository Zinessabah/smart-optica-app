#!/usr/bin/env bash
# Smart Optica — Démarrage global des 3 serveurs
# Usage: ./start.sh   (depuis la racine du projet smart-optica-app)
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "🔧 Smart Optica — démarrage des services"
echo "  • Backend API   → http://localhost:8000"
echo "  • Frontend      → https://localhost:5173 (centrage)"
echo "  • Admin         → https://localhost:5174 (comptes)"
echo ""

# 1. Backend (uvicorn) — arrière-plan
echo "▶ Backend API (uvicorn:8000)…"
cd "$ROOT/backend"
./venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/so_backend.log 2>&1 &
BACKEND_PID=$!
echo "  pid=$BACKEND_PID (log: /tmp/so_backend.log)"

# 2. Frontend principal (vite:5173) — arrière-plan
echo "▶ Frontend (vite:5173)…"
cd "$ROOT"
nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 > /tmp/so_frontend.log 2>&1 &
FRONTEND_PID=$!
echo "  pid=$FRONTEND_PID (log: /tmp/so_frontend.log)"

# 3. Interface Admin (vite.admin.config.js:5174) — arrière-plan
echo "▶ Interface Admin (vite:5174)…"
nohup ./node_modules/.bin/vite --config vite.admin.config.js --host 0.0.0.0 --port 5174 > /tmp/so_admin.log 2>&1 &
ADMIN_PID=$!
echo "  pid=$ADMIN_PID (log: /tmp/so_admin.log)"

echo ""
echo "✅ Tous les services démarrés."
echo "   Ctrl+C pour tout arrêter."
echo ""

# Attendre Ctrl+C puis nettoyer
cleanup() {
  echo ""
  echo "🛑 Arrêt des services…"
  kill $BACKEND_PID $FRONTEND_PID $ADMIN_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# Boucle pour garder le script vivant (et capturer Ctrl+C)
while true; do sleep 1; done
