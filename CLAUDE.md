# MangaLib — contexte projet (lu par Claude à chaque session, en LOCAL comme en REMOTE)

Bibliothèque de mangas : **FastAPI** (backend) + **React/Vite** (frontend), auth JWT.
Les EPUB finis sont stockés sur **Telegram (MTProto / Telethon)** et indexés dans une
petite **DB SQLite** ; le disque local ne sert que de cache. Déployé en Docker.

## Structure
- `app/api/` — backend FastAPI : `routers/` (endpoints), `services/` (db, storage,
  telegram_client, scraper, jobs, library, scenarios…), `auth.py`, `config.py`, `main.py`.
- `app/front/` — frontend React/Vite : `src/pages`, `src/components`, `src/api/client.js`.
- `deploy/` — Docker (`docker-compose.prod.yml`, `Dockerfile`) + CI.
- `scripts/`, `docs/`.

## Environnement de travail réciproque (local ⇄ serveur)
- **Local** : `/home/emmanuel/scripts/python/anime_sama_malicieux`.
- **Serveur (prod)** : `/root/anime_sama_malicieux` — clone git, fait tourner la prod.
- **Hub de synchro = GitHub** (`carmsito/anime_sama_malicieux`). On code d'un côté →
  `git commit` + `git push` → l'autre fait `git pull`. **Toujours committer/pusher**
  pour propager le travail entre local et serveur.
- `dev` = `main` (les deux suivies). **Déploiement** = push GitHub puis, sur le serveur :
  `git fetch && git reset --hard origin/main && docker compose -f deploy/docker-compose.prod.yml up -d --build`.

## Conventions
- Réponses et commentaires **en français** (préférence de l'utilisateur).
- Coller au style du code existant ; les commentaires expliquent le *pourquoi*.
- **Ne jamais committer de secrets** (`.env`, session Telegram, clés) — déjà gitignorés.
- Détails d'exploitation sensibles (accès serveur, etc.) : **hors du repo public**,
  dans `CLAUDE.local.md` (gitignoré, présent seulement là où c'est pertinent).

## En cours / plans
- Plan « **ambiance sonore des planches** » (analyse de scène zero-shot type MobileCLIP →
  marqueurs d'ambiance RLE → boucles audio partagées + crossfade Web Audio) : **étudié,
  non implémenté**. À démarrer par un prototype du classifieur sur 2-3 chapitres.
