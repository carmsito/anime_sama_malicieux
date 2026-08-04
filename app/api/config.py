import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent


def _load_dotenv() -> None:
    """Charge .env (racine repo, app/, deploy/) sans dépendance. Les vars d'env
    déjà définies (ex: docker-compose env_file) restent prioritaires (setdefault)."""
    for rel in (".env", "app/.env", "deploy/.env"):
        f = PROJECT_ROOT / rel
        if not f.exists():
            continue
        try:
            for line in f.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
        except Exception:
            pass
        break


_load_dotenv()
EXTRACTION_DIR = PROJECT_ROOT / "extraction"
COVERS_DIR = Path(__file__).parent / "data" / "covers"
USERS_FILE = Path(__file__).parent / "data" / "users.json"
JOBS_FILE = Path(__file__).parent / "data" / "jobs.json"

# Secret depuis l'env en prod ; fallback dev uniquement.
SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-in-production-use-a-long-random-string")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Nombre d'instances Chrome pour Sushiscan (parallélisme search/download).
# 2 = une recherche ne bloque jamais derrière un download. Monte selon la RAM.
SUSHISCAN_POOL_SIZE = int(os.environ.get("SUSHISCAN_POOL_SIZE", "2"))
# Ferme les navigateurs INACTIFS depuis N secondes (libère la RAM). 0 = jamais.
# Ne touche jamais un navigateur en cours d'usage ; la réutilisation à chaud reste active.
SUSHISCAN_IDLE_TIMEOUT = int(os.environ.get("SUSHISCAN_IDLE_TIMEOUT", "600"))

# Mini-DB (mapping data ↔ Telegram, etc.). SQLite par défaut ; DATABASE_URL
# permettra plus tard de basculer vers Postgres (Neon/Supabase) sans changer le code appelant.
DATA_DIR = Path(__file__).parent / "data"
DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "app.db")))
DATABASE_URL = os.environ.get("DATABASE_URL")  # ex: postgres://... (facultatif)

# ── Stockage Telegram (MTProto) ───────────────────────────────────────────────
# Vide → stockage local (comportement actuel). Renseigné → offload EPUB vers Telegram.
# MTProto (Telethon) car les volumes EPUB atteignent 75–106 Mo (> limites Bot API).
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "local")  # "local" | "telegram"
TELEGRAM_API_ID = os.environ.get("TELEGRAM_API_ID")
TELEGRAM_API_HASH = os.environ.get("TELEGRAM_API_HASH")
TELEGRAM_CHANNEL = os.environ.get("TELEGRAM_CHANNEL")     # @canal ou id du canal de stockage
TELEGRAM_SESSION = os.environ.get("TELEGRAM_SESSION", str(DATA_DIR / "tg.session"))
# Durée de vie du cache EPUB local après upload (secondes). 0 = supprime tout de suite.
LOCAL_CACHE_TTL = int(os.environ.get("LOCAL_CACHE_TTL", "86400"))

# ── Console admin (terminal web → shell ROOT sur l'hôte via SSH) ───────────────
# RCE volontaire, réservé admin + passphrase dédiée + audit. DÉSACTIVÉE par défaut :
# il faut CONSOLE_ENABLED=1 ET une CONSOLE_PASSPHRASE non vide pour l'allumer.
CONSOLE_ENABLED = os.environ.get("CONSOLE_ENABLED", "0").lower() in ("1", "true", "yes", "on")
CONSOLE_PASSPHRASE = os.environ.get("CONSOLE_PASSPHRASE", "")
CONSOLE_SSH_TARGET = os.environ.get("CONSOLE_SSH_TARGET", "")     # ex: root@62.238.63.117
CONSOLE_SSH_KEY = os.environ.get("CONSOLE_SSH_KEY", str(DATA_DIR / "console_host_key"))
# Session tmux persistante sur l'hôte : on s'y ré-attache depuis n'importe quel
# appareil → même shell, mêmes commandes en cours.
CONSOLE_TMUX_SESSION = os.environ.get("CONSOLE_TMUX_SESSION", "mangalib")

# Ambiance sonore : le classifieur (torch/open_clip) vit dans un venv HORS conteneur.
# Le job délègue la classif à l'hôte via SSH (réutilise CONSOLE_SSH_KEY / CONSOLE_SSH_TARGET).
AMBIENCE_PYTHON = os.environ.get("AMBIENCE_PYTHON", "/home/emmanuel/ambience-proto/venv/bin/python")
AMBIENCE_SCRIPT = os.environ.get("AMBIENCE_SCRIPT", "/root/anime_sama_malicieux/scripts/ambience_analyze.py")

COVERS_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)
