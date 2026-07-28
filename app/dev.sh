#!/bin/bash

set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONT_DIR="$APP_DIR/front"

echo "🚀 Démarrage du serveur de développement..."
echo ""

# Kill background processes on exit
cleanup() {
  echo ""
  echo "⏹️  Arrêt des serveurs..."
  jobs -p | xargs -r kill 2>/dev/null || true
  wait
}
trap cleanup EXIT

# Check if venv exists, create if not
if [ ! -d "$APP_DIR/venv" ]; then
  echo "📦 Création de l'environnement virtuel..."
  python -m venv "$APP_DIR/venv"
fi

# Activate venv
source "$APP_DIR/venv/bin/activate"

# Install deps if needed
if ! python -c "import fastapi" 2>/dev/null; then
  echo "📚 Installation des dépendances Python..."
  pip install -q -r "$APP_DIR/requirements.txt"
fi

# API server
echo "🔧 Lancement de l'API (http://127.0.0.1:8000)..."
cd "$APP_DIR"
python -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --reload 2>&1 | sed 's/^/  [API] /' &
API_PID=$!

# Frontend dev server
echo "⚛️  Lancement du frontend (http://localhost:5173)..."
cd "$FRONT_DIR"
npm run dev 2>&1 | sed 's/^/  [FRONT] /' &
FRONT_PID=$!

echo ""
echo "✅ Serveurs démarrés!"
echo "   API:    http://127.0.0.1:8000"
echo "   Frontend: http://localhost:5173"
echo ""
echo "🔥 Mode développement actif — les changements se rechargent automatiquement"
echo "   Ctrl+C pour arrêter"
echo ""

# Wait for both processes
wait
