"""Mode Cast « second écran » (TV via navigateur).

Principe : la TV ouvre /tv → se connecte ici en rôle `tv` → reçoit un CODE court qu'elle
affiche. Le téléphone (lecteur) se connecte en rôle `phone` avec ce code → le backend relie
les deux et **relaie l'état de lecture** (manga / chapitre / page / cinéma…) du tel vers la TV.

La TV n'a PAS besoin d'auth : les images d'un chapitre sont servies publiquement (chargées via
<img src>), donc elle rend les pages toute seule à partir de l'état reçu. Le téléphone, lui,
doit présenter un token valide (seul un utilisateur connecté peut diffuser).

État en mémoire (un seul worker uvicorn en prod → suffisant, trafic quasi nul). Les salons
expirent à la déconnexion de la TV.
"""
import secrets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import jwt, JWTError

from ..config import SECRET_KEY, ALGORITHM

router = APIRouter(tags=["cast"])

# Caractères non ambigus (pas de 0/O, 1/I…) → code facile à recopier sur une télécommande.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


class Room:
    __slots__ = ("code", "tv", "controllers", "state")

    def __init__(self, code: str, tv: WebSocket):
        self.code = code
        self.tv = tv
        self.controllers: set[WebSocket] = set()
        self.state: dict | None = None


_rooms: dict[str, Room] = {}


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(_ALPHABET) for _ in range(4))
        if code not in _rooms:
            return code


async def _safe_send(ws: WebSocket, msg: dict):
    try:
        await ws.send_json(msg)
    except Exception:
        pass


@router.websocket("/cast/ws")
async def cast_ws(websocket: WebSocket):
    role = websocket.query_params.get("role")
    await websocket.accept()

    if role == "tv":
        code = _new_code()
        room = Room(code, websocket)
        _rooms[code] = room
        await _safe_send(websocket, {"type": "code", "code": code})
        try:
            while True:
                # La TV ne pilote rien : on lit juste pour détecter la fermeture (+ ping éventuel).
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            if _rooms.get(code) is room:
                for c in list(room.controllers):
                    await _safe_send(c, {"type": "tv_gone"})
                _rooms.pop(code, None)
        return

    if role == "phone":
        code = (websocket.query_params.get("code") or "").upper()
        token = websocket.query_params.get("token") or ""
        # Auth : seul un utilisateur connecté peut diffuser.
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if not payload.get("sub"):
                raise JWTError()
        except JWTError:
            await _safe_send(websocket, {"type": "error", "error": "auth"})
            await websocket.close()
            return
        room = _rooms.get(code)
        if not room:
            await _safe_send(websocket, {"type": "error", "error": "code"})
            await websocket.close()
            return
        room.controllers.add(websocket)
        await _safe_send(websocket, {"type": "paired"})
        await _safe_send(room.tv, {"type": "paired"})
        if room.state is not None:                       # nouvel arrivant → resynchro immédiate
            await _safe_send(room.tv, {"type": "state", "state": room.state})
        try:
            while True:
                data = await websocket.receive_json()
                t = data.get("type")
                if t == "state":
                    room.state = data.get("state") or {}
                    await _safe_send(room.tv, {"type": "state", "state": room.state})
                elif t == "ping":
                    await _safe_send(websocket, {"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            room.controllers.discard(websocket)
            if not room.controllers:
                await _safe_send(room.tv, {"type": "unpaired"})
        return

    await websocket.close()
