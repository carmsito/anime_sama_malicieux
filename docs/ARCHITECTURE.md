# Architecture — scaling & free deployment

État cible : ~10 utilisateurs simultanés, déploiement **gratuit**, API + jobs qui ne
s'éteignent pas, stockage des EPUB sur Telegram, mini-DB pour les liens.

---

## 1. Audit (état actuel)

### 🔴 Bloquant #1 — Starvation Sushiscan (le problème central)
- `app/api/services/sushiscan_svc.py` : **un seul** `_chrome_lock = threading.Lock()`.
- `download()` **garde ce lock pendant TOUT le job** (`with _chrome_lock:` autour de la
  boucle sur tous les chapitres → plusieurs minutes/heures).
- `search()`, `get_chapters()`, `get_meta()`, `fetch_image()` réclament le **même** lock.
- `scripts/sushiscan.py` n'a **qu'une** instance Chrome (`_driver` singleton global).
- **Conséquence** : pendant un download, aucune recherche Sushiscan d'un autre user ne
  peut passer. Blocage total.

### 🟠 Autres findings
1. Jobs lancés en `threading.Thread(daemon=True)` directement depuis le handler HTTP
   (`extract.py`). Pas de vraie file, pas de limite de concurrence, perdus au restart
   (juste marqués `interrupted` au reload).
2. Persistance jobs/users en JSON (`jobs.json`, `users.json`) — OK à petite échelle,
   pas concurrent-safe multi-process.
3. `close_driver()` appelé dans le `finally` de `download()` → tue l'instance Chrome
   **partagée** même si une recherche l'utilise.
4. Logique cover dupliquée 3× (get_meta, download, _cache_cover).
5. `SECRET_KEY` hardcodé (`config.py`).
6. CORS `allow_origins=["*"]` + `allow_credentials=True` → combinaison rejetée par les
   navigateurs.
7. Stockage 100 % filesystem local (`extraction/`) → incompatible hébergement éphémère.

### ⚠️ Contrainte découverte — taille des EPUB vs Telegram
- Les volumes complets font **75–106 Mo** (mesuré : Kingdom Vol 1 = 75 Mo, Vol 11 = 106 Mo).
- **Bot API Telegram** : envoi ≤ 50 Mo, download (`getFile`) ≤ 20 Mo → **insuffisant**.
- **Solution** : MTProto (**Telethon/Pyrogram**) avec un compte dédié → **jusqu'à 2 Go**/fichier.
  C'est la méthode standard pour « Telegram = stockage illimité ».

---

## 2. Architecture cible

```
                    ┌──────────────────────────────────────────────┐
   navigateur  ───► │  FastAPI (uvicorn)   — reste toujours up      │
                    │  • /search, /extract (enqueue only), /jobs    │
                    │  • sert le front + lit la DB                  │
                    └───────────────┬──────────────────────────────┘
                                    │  enqueue (DB job table)
                    ┌───────────────▼──────────────────────────────┐
                    │  Worker(s)  — process séparé, même box        │
                    │  • dépile les jobs (source-aware)             │
                    │  • BrowserPool (N instances Chrome)           │
                    │  • génère EPUB → upload Telegram → DB mapping  │
                    └───────────────┬──────────────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
        ┌─────▼─────┐        ┌──────▼───────┐       ┌───────▼────────┐
        │ SQLite/PG │        │ Telegram(MTP)│       │ cache local     │
        │ mini-DB   │        │ EPUB storage │       │ court (TTL)     │
        └───────────┘        └──────────────┘       └────────────────┘
```

### BrowserPool (fix concurrence — Phase 1)
- Pool de **N** navigateurs (`SUSHISCAN_POOL_SIZE`, défaut 2).
- `acquire(priority)` : **search = HIGH**, **download = LOW**.
- Le download acquiert **par chapitre** et **relâche entre** → les recherches
  s'intercalent (fonctionne même avec pool=1 grâce à la priorité).
- Health-check + respawn des navigateurs morts.
- `scripts/sushiscan.py` accepte un `driver=None` optionnel sur chaque fonction
  (fallback `get_driver()` pour l'usage CLI) → rétro-compatible.

### File de jobs durable + workers (Phase 2)
- `/extract` ne fait qu'**enfiler** (retour immédiat). API jamais bloquée.
- Worker loop consomme la file. Limite de concurrence par source.
- Jobs en DB → survivent aux redéploiements ; reprise des jobs `interrupted`.

### Mini-DB (Phase 3)
- SQLite + WAL en local/single-box (zéro service externe).
- Schéma provider-agnostic → bascule Neon/Supabase Postgres si hébergement éphémère.
- Tables : `users`, `jobs`, `telegram_files` (manga/chapitre/kind → file_id, msg_id, size).

### Stockage Telegram (Phase 4)
- Worker : EPUB fini → upload MTProto (Telethon) → `file_id`/`msg_id` en DB → purge locale.
- Lecture : lookup DB → stream depuis Telegram (cache local court-vécu).

---

## 3. Déploiement gratuit

| Option | Always-on | Chrome | RAM | Verdict |
|---|---|---|---|---|
| **Oracle Cloud Always Free** (ARM Ampere A1) | ✅ | ✅ | 24 Go | **Choix principal** — vrai VPS gratuit permanent |
| Fly.io | ~ (machines s'endorment) | ✅ | 256 Mo×3 | Fallback léger |
| Render free | ❌ (sleep 15 min) | ✅ lent | 512 Mo | Non (coupe l'API + jobs) |
| Railway | ❌ ($5 crédit) | ✅ | — | Non |

**Choix : Oracle Cloud Always Free.** Seule option réellement gratuite, permanente, et
assez large (24 Go RAM ARM) pour faire tourner ensemble : FastAPI + worker(s) +
BrowserPool (2–3 Chrome) + SQLite + session Telegram, sans jamais couper l'API ni les jobs.

Déploiement : `docker-compose` (api + worker + xvfb/chrome). SQLite sur volume persistant.
Secrets via variables d'env. Postgres externe (Neon/Supabase free) seulement si on migre
vers un hôte éphémère plus tard.
