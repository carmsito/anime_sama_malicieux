#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Nettoyage Docker sur l'HÔTE (hors application).
#
# Pourquoi côté hôte et pas dans l'app : le conteneur applicatif ne monte pas
# /var/run/docker.sock (et ne DOIT pas, pour la sécurité) → il ne peut pas purger
# le Docker de l'hôte. Ce nettoyage est donc un job HÔTE (cron), pas un scénario
# de l'app. Le VRAI poste qui remplit le disque = le BUILD CACHE Docker, gonflé
# par les rebuilds `up -d --build` répétés (le cache EPUB de l'app, lui, est déjà
# borné par éviction LRU/TTL).
#
# Ce qu'il fait (sans danger) :
#   • borne le build cache à KEEP_STORAGE (garde du récent pour des rebuilds rapides) ;
#   • supprime les images SANS TAG (dangling) non utilisées.
# Il ne touche PAS aux conteneurs, volumes, ni aux images taguées en service.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

KEEP_STORAGE="${DOCKER_CACHE_KEEP_STORAGE:-2GB}"   # plafond du build cache conservé
LOG="${DOCKER_CLEANUP_LOG:-/root/anime_sama_malicieux/srv-data/docker_cleanup.log}"

mkdir -p "$(dirname "$LOG")"

{
  echo "==================================================================="
  echo "==== $(date -Is) : nettoyage Docker (hôte) ===="
  echo "[avant]"
  docker system df 2>&1

  echo "[action] build cache → plafond ${KEEP_STORAGE}"
  # BuildKit : garde jusqu'à KEEP_STORAGE de cache, purge le reste (inutilisé).
  # Le nom du flag a changé selon la version : --reserved-space (récent) ⇄ --keep-storage (ancien,
  # déprécié). On tente le récent, puis l'ancien, puis un prune simple en dernier recours.
  docker builder prune -f --reserved-space "${KEEP_STORAGE}" 2>&1 \
    || docker builder prune -f --keep-storage "${KEEP_STORAGE}" 2>&1 \
    || docker builder prune -f 2>&1 || true

  echo "[action] images dangling (sans tag, non utilisées)"
  docker image prune -f 2>&1 || true

  echo "[après]"
  docker system df 2>&1
  echo "==== fin $(date -Is) ===="
} >> "$LOG" 2>&1
