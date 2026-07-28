#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"

# Créer le venv si absent
if [ ! -f "$VENV/bin/activate" ]; then
  echo "▶ Création du venv Python..."
  python -m venv "$VENV"
fi

source "$VENV/bin/activate"

# Installer les dépendances Python si nécessaire
if ! python -c "import fastapi" 2>/dev/null; then
  echo "▶ Installation des dépendances Python..."
  pip install -q -r "$SCRIPT_DIR/requirements.txt"
fi

# API
echo "▶ Démarrage de l'API (port 8000)..."
cd "$SCRIPT_DIR"
uvicorn api.main:app --reload --port 8000 &
API_PID=$!

# Frontend
echo "▶ Démarrage du frontend (port 5173)..."
cd "$SCRIPT_DIR/front"
if [ ! -d node_modules ]; then
  npm install --silent
fi
npm run dev &
FRONT_PID=$!

echo ""
echo "✓ API     → http://localhost:8000"
echo "✓ Docs    → http://localhost:8000/docs"
echo "✓ Front   → http://localhost:5173"
echo ""
echo "Ctrl+C pour tout arrêter."

trap "kill $API_PID $FRONT_PID 2>/dev/null; exit" INT TERM
wait
