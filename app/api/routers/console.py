"""
Console d'administration : terminal web (style Azure Cloud Shell) donnant un shell
ROOT sur l'HÔTE via SSH.

⚠️ C'est une exécution de commandes arbitraires (RCE) VOLONTAIRE. Garde-fous :
  - réservé aux comptes admin (JWT vérifié) ;
  - passphrase console dédiée (2ᵉ secret, différent du mot de passe de compte) ;
  - journal d'audit (ouverture/fermeture + lignes saisies) ;
  - DÉSACTIVÉE par défaut : nécessite CONSOLE_ENABLED=1 + CONSOLE_PASSPHRASE non vide.

Le shell hôte est atteint via SSH (clé dédiée, hors image et hors git, dans le
volume monté data/). Le conteneur se connecte à CONSOLE_SSH_TARGET (root@hôte).
"""
from __future__ import annotations

import asyncio
import fcntl
import hmac
import json
import os
import signal
import struct
import termios
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from jose import JWTError, jwt

from ..auth import require_admin, _get_user_by_id
from ..config import (
    ALGORITHM, DATA_DIR, SECRET_KEY,
    CONSOLE_ENABLED, CONSOLE_PASSPHRASE, CONSOLE_SSH_KEY, CONSOLE_SSH_TARGET,
    CONSOLE_TMUX_SESSION,
)

router = APIRouter(prefix="/admin/console", tags=["admin-console"])

_AUDIT = DATA_DIR / "console_audit.log"


def _ready_reason() -> tuple[bool, str]:
    if not CONSOLE_ENABLED:
        return False, "Console désactivée (mets CONSOLE_ENABLED=1)."
    if not CONSOLE_PASSPHRASE:
        return False, "Passphrase console non définie (CONSOLE_PASSPHRASE)."
    if not CONSOLE_SSH_TARGET:
        return False, "Cible SSH hôte non définie (CONSOLE_SSH_TARGET)."
    if not os.path.exists(CONSOLE_SSH_KEY):
        return False, "Clé SSH hôte absente."
    return True, "ok"


def _audit(user: str, event: str, detail: str = "") -> None:
    try:
        with open(_AUDIT, "a") as f:
            f.write(f"{datetime.now(timezone.utc).isoformat()}\t{user}\t{event}\t{detail}\n")
    except Exception:
        pass


@router.get("/status")
def status(_: dict = Depends(require_admin)):
    ready, reason = _ready_reason()
    return {"ready": ready, "reason": reason,
            "target": CONSOLE_SSH_TARGET if ready else None}


def _user_from_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        uid = payload.get("sub")
        return _get_user_by_id(uid) if uid else None
    except JWTError:
        return None


@router.websocket("/ws")
async def ws_console(ws: WebSocket):
    await ws.accept()
    # 1) Auth admin (token en query : les WebSockets n'ont pas d'en-tête Authorization simple)
    user = _user_from_token(ws.query_params.get("token", ""))
    if not user or user.get("role") != "admin":
        await ws.send_json({"type": "error", "message": "Réservé aux administrateurs."})
        return await ws.close()
    ready, reason = _ready_reason()
    if not ready:
        await ws.send_json({"type": "error", "message": reason})
        return await ws.close()

    # 2) Handshake passphrase (1er message)
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except Exception:
        return await ws.close()
    if (first.get("type") != "auth"
            or not hmac.compare_digest(str(first.get("passphrase", "")), CONSOLE_PASSPHRASE)):
        _audit(user["username"], "auth_fail")
        await ws.send_json({"type": "error", "message": "Passphrase invalide."})
        return await ws.close()

    _audit(user["username"], "session_open", CONSOLE_SSH_TARGET)
    await ws.send_json({"type": "ready"})

    # 3) PTY + SSH root vers l'hôte
    master, slave = os.openpty()
    # On s'attache à une session tmux PERSISTANTE sur l'hôte (créée au besoin) :
    # le shell vit côté serveur, pas dans l'onglet. Donc F5, changement d'appareil
    # ou coupure réseau ne tuent rien — on se ré-attache à la MÊME instance, et les
    # commandes continuent de tourner même sans client connecté.
    # (Repli sur un shell simple si tmux n'est pas installé.)
    remote = (
        "command -v tmux >/dev/null 2>&1 "
        f"&& exec tmux new-session -A -s {CONSOLE_TMUX_SESSION} "
        "|| exec ${SHELL:-/bin/bash} -l"
    )
    cmd = [
        "ssh", "-tt",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ServerAliveInterval=20",
        "-i", CONSOLE_SSH_KEY, CONSOLE_SSH_TARGET,
        remote,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    os.set_blocking(master, False)
    loop = asyncio.get_event_loop()
    out_q: asyncio.Queue = asyncio.Queue()
    line_buf = bytearray()

    def _on_readable():
        try:
            data = os.read(master, 65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            out_q.put_nowait(None)
            return
        out_q.put_nowait(data or None)

    loop.add_reader(master, _on_readable)

    async def sender():
        while True:
            data = await out_q.get()
            if data is None:
                break
            try:
                await ws.send_bytes(data)
            except Exception:
                break

    send_task = asyncio.create_task(sender())

    def _feed_stdin(b: bytes):
        # audit ligne par ligne (peut contenir des secrets tapés — c'est un journal admin)
        nonlocal line_buf
        try:
            os.write(master, b)
        except OSError:
            return
        for byte in b:
            if byte in (10, 13):
                if line_buf:
                    _audit(user["username"], "cmd", line_buf.decode("utf-8", "replace"))
                    line_buf = bytearray()
            else:
                line_buf.append(byte)

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            txt = msg.get("text")
            if txt is None:
                b = msg.get("bytes")
                if b:
                    _feed_stdin(b)
                continue
            try:
                obj = json.loads(txt)
            except Exception:
                _feed_stdin(txt.encode())
                continue
            if obj.get("type") == "data":
                _feed_stdin(obj.get("data", "").encode())
            elif obj.get("type") == "resize":
                cols = max(1, int(obj.get("cols", 80)))
                rows = max(1, int(obj.get("rows", 24)))
                try:
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack("HHHH", rows, cols, 0, 0))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        _audit(user["username"], "session_close")
        try:
            loop.remove_reader(master)
        except Exception:
            pass
        out_q.put_nowait(None)
        try:
            proc.send_signal(signal.SIGHUP)
        except Exception:
            pass
        try:
            os.close(master)
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        await send_task
        try:
            await ws.close()
        except Exception:
            pass
