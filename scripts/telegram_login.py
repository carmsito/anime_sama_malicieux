#!/usr/bin/env python3
"""
Génère la session MTProto Telegram (à lancer UNE fois, en interactif).

Prérequis :
  pip install telethon
  export TELEGRAM_API_ID=...     # https://my.telegram.org → API development tools
  export TELEGRAM_API_HASH=...
  export TELEGRAM_SESSION=app/api/data/tg.session   # (optionnel, défaut = data/tg.session)

Utilisation :
  python scripts/telegram_login.py
  → entre ton numéro (+33...), le code reçu sur Telegram, et le mot de passe 2FA si activé.
  → crée le fichier tg.session réutilisé ensuite par le serveur (sans interaction).

Astuce : crée un **canal privé** dédié au stockage, ajoute ton compte comme admin,
et mets son @username ou son id dans TELEGRAM_CHANNEL.
"""
import os
import sys
from pathlib import Path


def _load_dotenv() -> None:
    """Charge .env (repo racine, app/, deploy/) sans dépendance externe."""
    for p in (".env", "app/.env", "deploy/.env"):
        f = Path(p)
        if not f.exists():
            continue
        for line in f.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
        return


def main() -> int:
    _load_dotenv()
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    session = os.environ.get("TELEGRAM_SESSION", "app/api/data/tg.session")
    if not api_id or not api_hash:
        print("TELEGRAM_API_ID / TELEGRAM_API_HASH manquants (voir https://my.telegram.org).")
        return 1
    try:
        from telethon.sync import TelegramClient
    except ImportError:
        print("Telethon absent : pip install telethon")
        return 1

    with TelegramClient(session, int(api_id), api_hash) as client:
        me = client.get_me()
        print(f"\n✓ Connecté en tant que {me.first_name} (@{me.username}).")
        print(f"✓ Session écrite : {session}\n")

        # Liste les canaux/supergroupes (candidats pour le stockage) avec leur id
        print("── Tes canaux/groupes (pour TELEGRAM_CHANNEL) ─────────────────")
        found = False
        for d in client.iter_dialogs():
            if getattr(d.entity, "broadcast", False) or getattr(d.entity, "megagroup", False):
                found = True
                kind = "canal" if getattr(d.entity, "broadcast", False) else "groupe"
                print(f"  [{kind}] {d.name!r:40}  id = {d.id}")
        if not found:
            print("  (aucun canal trouvé — crée un canal privé puis relance ce script)")
        print("───────────────────────────────────────────────────────────────")
        print("\nProchaine étape : mets dans .env")
        print("  STORAGE_BACKEND=telegram")
        print("  TELEGRAM_CHANNEL=<id ci-dessus, ex: -1001234567890>")
        print("  (ou 'me' pour utiliser tes Messages enregistrés)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
