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


def _valid_eocd(tail: bytes, file_size: int) -> bool:
    """Valide l'EOCD (fin de ZIP) dans le dernier bloc `tail` d'un fichier de `file_size`.
    Comme le fait zipfile : trouve la signature, puis vérifie que le central directory tient
    avant l'EOCD et que le commentaire consomme exactement la fin → rejette les fausses
    signatures (données JPEG) et les fichiers tronqués."""
    import struct
    sig = b"PK\x05\x06"
    if len(tail) < 22:
        return False
    end = len(tail)
    while True:
        i = tail.rfind(sig, 0, end)
        if i < 0:
            return False
        if i + 22 <= len(tail):
            try:
                cd_size, cd_offset = struct.unpack("<II", tail[i + 12:i + 20])
                comment_len = struct.unpack("<H", tail[i + 20:i + 22])[0]
            except struct.error:
                cd_size = cd_offset = comment_len = 1 << 62
            eocd_file_pos = file_size - (len(tail) - i)
            if (cd_offset + cd_size <= eocd_file_pos
                    and i + 22 + comment_len == len(tail)):
                return True
        end = i   # cherche une occurrence antérieure (rfind sur [0, end) → strictement avant)


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
        self._loc_cache: dict = {}   # msg_id -> InputFileLocation (lecture live ZIP)

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
            up_size = getattr(doc, "size", None)
            return {"msg_id": msg.id, "file_id": file_id, "uploaded_size": up_size}

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

    def read_range(self, msg_id: int, offset: int, length: int) -> bytes:
        """Lit UNIQUEMENT [offset, offset+length) du fichier Telegram (download partiel
        MTProto). Sert la lecture ZIP « live » : on ne rapatrie jamais l'EPUB entier.
        La location est mise en cache ; on la rafraîchit si la file_reference expire."""
        channel = _channel()

        async def _do():
            from telethon import utils
            from telethon.tl.functions.upload import GetFileRequest
            from telethon.errors import FileReferenceExpiredError

            async def get_loc(refresh: bool):
                if not refresh and msg_id in self._loc_cache:
                    return self._loc_cache[msg_id]
                msg = await self._client.get_messages(channel, ids=msg_id)
                if not msg:
                    raise RuntimeError(f"message {msg_id} introuvable")
                _dc, loc = utils.get_input_location(msg.media)
                self._loc_cache[msg_id] = loc
                return loc

            ALIGN = 4096          # MTProto : offset ET limit multiples de 4096
            MB = 1 << 20          # …et une requête ne franchit jamais une frontière de 1 Mo
            start = offset - (offset % ALIGN)
            end = offset + length
            for attempt in (0, 1):
                loc = await get_loc(refresh=(attempt == 1))
                try:
                    buf = bytearray()
                    pos = start
                    while pos < end:
                        boundary = ((pos // MB) + 1) * MB
                        want = ((end - pos + ALIGN - 1) // ALIGN) * ALIGN   # arrondi 4096
                        limit = min(want, boundary - pos, MB)              # exact, sans sur-lecture
                        res = await self._client(GetFileRequest(loc, offset=pos, limit=limit))
                        data = getattr(res, "bytes", b"") or b""
                        buf += data
                        if len(data) < limit:
                            break        # fin de fichier
                        pos += limit
                    s = offset - start
                    return bytes(buf[s:s + length])
                except FileReferenceExpiredError:
                    self._loc_cache.pop(msg_id, None)   # référence périmée → on refait get_messages
                    continue
            return b""

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

    def get_sizes(self, msg_ids: list) -> dict:
        """Tailles Telegram (métadonnées, SANS téléchargement) pour vérifier l'intégrité.
        Batché : get_messages accepte une liste → 1-2 appels seulement."""
        channel = _channel()

        async def _do():
            out = {}
            ids = [int(i) for i in msg_ids if i is not None]
            for i in range(0, len(ids), 100):   # get_messages : max ~100 ids par appel
                batch = ids[i:i + 100]
                msgs = await self._client.get_messages(channel, ids=batch)
                for m in (msgs or []):
                    if m is None:
                        continue
                    try:
                        out[int(m.id)] = m.file.size
                    except Exception:
                        out[int(m.id)] = None
            return out

        return self._submit(_do())

    def check_integrity(self, msg_ids: list, on_progress=None) -> dict:
        """Vrai test d'intégrité ZIP : télécharge le dernier bloc de chaque EPUB et VALIDE
        structurellement l'EOCD (signature + central directory qui tient dans le fichier +
        commentaire cohérent). Détecte les troncatures ET évite les fausses signatures
        présentes par hasard dans les données JPEG.
        Retourne {msg_id: True(sain) | False(cassé) | None(inconnu)}."""
        channel = _channel()

        async def _do():
            from telethon import utils
            from telethon.tl.functions.upload import GetFileRequest
            ids = [int(i) for i in msg_ids if i is not None]
            msgs = {}
            for i in range(0, len(ids), 100):
                try:
                    got = await self._client.get_messages(channel, ids=ids[i:i + 100])
                except Exception as e:
                    print(f"[integrity] get_messages batch {i}: {type(e).__name__} {e}", flush=True)
                    got = []
                for m in (got or []):
                    if m is not None:
                        msgs[int(m.id)] = m
            out = {}
            done = 0
            for mid in ids:
                m = msgs.get(mid)
                if m is None:
                    out[mid] = False   # message disparu → cassé
                else:
                    try:
                        size = m.file.size
                        _dc, loc = utils.get_input_location(m.media)
                        # Dernier bloc de 512 Ko aligné : 512 Ko est un DIVISEUR de 1 Mo (limite
                        # valide côté Telegram) et l'alignement 512 Ko ne croise jamais une
                        # frontière de 1 Mo. Contient la fin du fichier → l'EOCD s'il existe.
                        PART = 524288
                        block_start = ((size - 1) // PART) * PART if size else 0
                        res = await self._client(GetFileRequest(loc, offset=block_start, limit=PART))
                        tail = getattr(res, "bytes", b"") or b""
                        out[mid] = _valid_eocd(tail, size)
                    except Exception as e:
                        print(f"[integrity] msg {mid}: {e}", flush=True)
                        out[mid] = None   # erreur → on ne flag pas à tort
                done += 1
                if on_progress:
                    try:
                        on_progress(done)
                    except Exception:
                        pass
            return out

        return self._submit(_do())

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
