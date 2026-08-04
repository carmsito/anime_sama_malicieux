#!/usr/bin/env bash
# Déploiement robuste, à lancer SUR L'HÔTE (idéalement depuis le tmux de la console web).
#
# Pourquoi : la console web est servie PAR l'app. Un `docker compose up --build`
# redémarre l'app → coupe le WebSocket de la console. Mais ce script tourne dans le
# tmux CÔTÉ HÔTE (pas dans le conteneur) → il continue malgré la coupure, et tout est
# loggé dans deploy.log. On se ré-attache au tmux après → on voit le résultat.
# → plus jamais "dans le noir" pendant un déploiement.
set -u
cd "$(dirname "$0")/.." || exit 1     # racine du repo (/root/anime_sama_malicieux)
LOG="$PWD/deploy.log"

{
  echo ""
  echo "=========== deploy $(date -u +%FT%TZ) ==========="
  echo "--- git : alignement sur origin/main ---"
  git fetch origin && git reset --hard origin/main || { echo "git KO"; exit 1; }
  echo "HEAD: $(git log --oneline -1)"
  echo "--- rebuild + redémarrage (l'app va se couper ~30s : normal) ---"
  ( cd deploy && docker compose -f docker-compose.prod.yml up -d --build && docker image prune -f )
  echo "--- healthcheck ---"
  ok=0
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/health 2>/dev/null || echo 000)
    echo "health($i): $code"
    [ "$code" = "200" ] && { ok=1; break; }
    sleep 4
  done
  [ "$ok" = "1" ] && echo "=========== DEPLOY OK ===========" || echo "=========== DEPLOY ÉCHOUÉ (voir ci-dessus) ==========="
} 2>&1 | tee -a "$LOG"
