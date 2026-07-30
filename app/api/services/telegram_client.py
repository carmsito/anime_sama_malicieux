"""
Client Telegram MTProto (Telethon) utilisable depuis un serveur multi-thread.

Telethon est asyncio et son client est lié à UNE event-loop, non thread-safe.
Nos workers de jobs sont multi-threads → on fait tourner le client dans un
thread dédié avec sa propre loop, et on marshalle chaque opération via
`run_coroutine_threadsafe`. Les appels depuis les workers sont donc sérialisés
et sûrs.

L'import de Telethon est paresseux : l'app tourne sans la lib tant que le
backend Telegram n'est pas activé.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Optional

import re

from ..config import (
    TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_CHANNEL,
)


def _channel():
    """Un id numérique doit être passé en int à Telethon (une chaîne = @username)."""
    ch = TELEGRAM_CHANNEL
    if isinstance(ch, str) and re.fullmatch(r"-?\d+", ch.strip()):
        return int(ch.strip())
    return ch


class TelegramMTProto:
    def __init__(self):
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._client = None
        self._ready = threading.Event()
        self._start_err: Optional[Exception] = None
        self._start_lock = threading.Lock()

    # ── boucle dédiée ─────────────────────────────────────────────────────────

    def _run_loop(self) -> None:
        try:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            from telethon import TelegramClient  # import paresseux
            self._client = TelegramClient(
                TELEGRAM_SESSION, int(TELEGRAM_API_ID), TELEGRAM_API_HASH
            )
            self._loop.run_until_complete(self._client.connect())
            authed = self._loop.run_until_complete(self._client.is_user_authorized())
            if not authed:
                raise RuntimeError(
                    "Session Telegram non autorisée — lance `python scripts/telegram_login.py`."
                )
        except Exception as e:  # remonte l'erreur au thread appelant
            self._start_err = e
            self._ready.set()
            return
        self._ready.set()
        self._loop.run_forever()

    def _ensure_started(self) -> None:
        with self._start_lock:
            if self._thread is not None:
                if self._start_err:
                    raise self._start_err
                return
            self._thread = threading.Thread(
                target=self._run_loop, name="telegram-mtproto", daemon=True
            )
            self._thread.start()
            if not self._ready.wait(timeout=60):
                raise RuntimeError("Démarrage du client Telegram : timeout")
            if self._start_err:
                raise self._start_err

    def _submit(self, coro):
        """Exécute une coroutine sur la loop dédiée depuis n'importe quel thread."""
        self._ensure_started()
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result()

    # ── opérations ────────────────────────────────────────────────────────────

    def send_file(self, path: str, caption: str = "") -> dict:
        channel = _channel()

        async def _do():
            msg = await self._client.send_file(
                channel, path, caption=caption, force_document=True
            )
            doc = getattr(msg, "document", None)
            file_id = str(getattr(doc, "id", "") or msg.id)
            return {"msg_id": msg.id, "file_id": file_id}

        return self._submit(_do())

    def download(self, msg_id: int, out_path: str) -> Optional[str]:
        channel = _channel()

        async def _do():
            msg = await self._client.get_messages(channel, ids=msg_id)
            if not msg:
                return None
            # 1) Tentative rapide : téléchargement PARALLÈLE (plusieurs connexions).
            #    N'utilise que upload.getFile (pas les méthodes rate-limitées).
            try:
                ok = await self._download_parallel(msg, out_path)
                if ok:
                    return out_path
            except Exception as e:
                print(f"[telegram] download parallèle échoué, fallback: {e}", flush=True)
            # 2) Fallback sûr : méthode standard de Telethon.
            return await self._client.download_media(msg, file=out_path)

        return self._submit(_do())

    async def _download_parallel(self, msg, out_path: str) -> bool:
        """
        Télécharge le média avec plusieurs requêtes GetFile CONCURRENTES sur la
        connexion existante (MTProto multiplexe les requêtes → meilleur débit).
        Aucune nouvelle connexion / aucun export d'auth → robuste et sans risque
        sur les méthodes rate-limitées. Retourne True si la taille finale est bonne.
        """
        import asyncio, os
        from telethon import utils
        from telethon.tl.functions.upload import GetFileRequest

        try:
            size = msg.file.size
        except Exception:
            return False
        if not size:
            return False

        _dc_id, location = utils.get_input_location(msg.media)
        workers = int(os.environ.get("TELEGRAM_DL_CONN", "8"))
        workers = max(2, min(workers, 12))
        part = 512 * 1024                     # part standard Telegram
        stride = workers * part

        f = open(out_path, "wb")
        f.truncate(size)
        try:
            async def worker(start):
                offset = start
                while offset < size:
                    res = await self._client(GetFileRequest(location, offset=offset, limit=part))
                    data = getattr(res, "bytes", None)
                    if data:
                        f.seek(offset)        # pas d'await entre seek et write → sûr
                        f.write(data)
                    offset += stride

            await asyncio.gather(*[worker(i * part) for i in range(workers)])
        finally:
            f.close()

        if os.path.getsize(out_path) != size:
            try:
                os.remove(out_path)
            except Exception:
                pass
            return False
        return True

    def delete(self, msg_id: int) -> None:
        channel = _channel()

        async def _do():
            await self._client.delete_messages(channel, [msg_id])

        self._submit(_do())


# Singleton
_instance: Optional[TelegramMTProto] = None
_lock = threading.Lock()


def get_client() -> TelegramMTProto:
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = TelegramMTProto()
    return _instance
