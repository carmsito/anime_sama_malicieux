# Déploiement gratuit

Objectif : ~10 utilisateurs, **0 €**, API + jobs qui ne s'arrêtent jamais, stockage
EPUB sur Telegram.

## Pourquoi Oracle Cloud Always Free

| Option | Always-on | Chrome | RAM gratuite | Verdict |
|---|---|---|---|---|
| **Oracle Cloud Always Free (ARM Ampere A1)** | ✅ permanent | ✅ chromium | **24 Go** / 4 vCPU | ✅ **choix** |
| Fly.io | machines s'endorment | ✅ | 3×256 Mo | fallback léger |
| Render free | ❌ sleep 15 min | ✅ lent | 512 Mo | ❌ coupe API+jobs |
| Railway | ❌ crédit limité | ✅ | — | ❌ |

Seul Oracle offre un **vrai serveur permanent gratuit** assez large pour Chrome +
workers + SQLite + session Telegram sans jamais couper l'API ni les jobs. C'est ARM →
on utilise `chromium` (le Dockerfile est déjà arch-indépendant).

## 1. Créer la VM (une fois)

1. Compte Oracle Cloud → *Always Free*.
2. Instance → **Ampere A1 (ARM)**, shape `VM.Standard.A1.Flex`, ex. **2 OCPU / 12 Go**
   (largement suffisant ; jusqu'à 4/24 gratuit).
3. Image **Ubuntu 22.04**. Ouvre le port **8000** (ou 80/443 derrière un reverse-proxy)
   dans la *security list* + `iptables`/`ufw`.
4. SSH sur la VM.

## 2. Installer Docker + lancer

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker

git clone <ton-repo> app && cd app
cp deploy/.env.example .env
# édite .env : SECRET_KEY (obligatoire), pool/workers selon RAM
nano .env

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

L'API écoute sur `:8000`, sert le front buildé, démarre les workers et la DB.
`restart: unless-stopped` → la VM reboot ? le conteneur repart seul.

## 3. Activer le stockage Telegram (recommandé en prod)

Le disque gratuit est limité : on déporte les EPUB finis sur Telegram (jusqu'à **2 Go/fichier**
via MTProto — les volumes font 75–106 Mo, hors limites du *Bot API*).

```bash
# 1) https://my.telegram.org → API development tools → api_id + api_hash
# 2) crée un CANAL PRIVÉ dédié, ajoute ton compte admin, note son @username/id
# 3) génère la session (interactif, une fois) :
export TELEGRAM_API_ID=... TELEGRAM_API_HASH=...
export TELEGRAM_SESSION=$PWD/app/api/data/tg.session
pip install telethon
python scripts/telegram_login.py     # entre numéro + code reçu (+ 2FA)

# 4) dans .env : STORAGE_BACKEND=telegram, TELEGRAM_* renseignés
docker compose -f deploy/docker-compose.yml up -d
```

## Notes d'architecture

- **Workers = threads in-process** du `job_queue` (démarrés au lifespan). Tant que le
  conteneur tourne (always-on), ils ne s'arrêtent pas. Pas besoin de Redis à cette échelle.
- **Concurrence Sushiscan** : le `BrowserPool` (SUSHISCAN_POOL_SIZE) garantit qu'une
  recherche interactive passe **devant** un download → aucun user bloqué.
- **Scaling horizontal** (worker séparé, plusieurs conteneurs) : nécessiterait une file
  partagée (Redis) + verrou de pool distribué. Non requis pour ~10 users.
- **Postgres** (si un jour hôte éphémère) : renseigner `DATABASE_URL` (Neon/Supabase free)
  et adapter `db._connect()` (seam déjà prévu).

## Reverse-proxy HTTPS (optionnel)

Mets Caddy devant pour du TLS auto :
```
tondomaine.tld {
    reverse_proxy localhost:8000
}
```
