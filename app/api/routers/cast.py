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
from fastapi.responses import Response
from jose import jwt, JWTError

from ..config import SECRET_KEY, ALGORITHM

router = APIRouter(tags=["cast"])


@router.get("/cast/qr", summary="QR code (SVG) pour rejoindre une diffusion")
def cast_qr(data: str):
    """Encode `data` (une URL de jointure http://host/?castcode=XXXX) en QR SVG. La TV
    l'affiche ; le téléphone le scanne avec son APPAREIL PHOTO NATIF (l'app s'ouvre avec le
    code pré-rempli et lance la diffusion) → pas besoin de caméra in-app (impossible en HTTP)."""
    import segno, io
    buf = io.BytesIO()   # le writer SVG de segno écrit des bytes
    segno.make((data or "")[:512], error="m").save(buf, kind="svg", scale=7, border=2, dark="#000", light="#fff")
    return Response(content=buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})

# Caractères non ambigus (pas de 0/O, 1/I…) → code facile à recopier sur une télécommande.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


class Room:
    __slots__ = ("code", "tv", "controllers", "state")

    def __init__(self, code: str, tv=None):
        self.code = code
        self.tv = tv
        self.controllers = set()
        self.state = None


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
        # Code imposé (flux Presentation/Cast : tel et TV partagent le même code) ou généré.
        code = (websocket.query_params.get("code") or "").upper().strip() or _new_code()
        room = _rooms.get(code)
        if room is None:
            room = Room(code, websocket); _rooms[code] = room
        else:
            room.tv = websocket
        await _safe_send(websocket, {"type": "code", "code": code})
        # Un téléphone attendait déjà cette salle (il l'a créée) → on le prévient + resynchro.
        for c in list(room.controllers):
            await _safe_send(c, {"type": "paired"})
        if room.state is not None:
            await _safe_send(websocket, {"type": "state", "state": room.state})
        try:
            while True:
                # La TV peut renvoyer des COMMANDES au téléphone (ex. auto-scroll arrivé en bas
                # de planche → demander la page suivante). On les relaie aux contrôleurs.
                data = await websocket.receive_json()
                if data.get("type") == "cmd":
                    for c in list(room.controllers):
                        await _safe_send(c, {"type": "cmd", "cmd": data.get("cmd")})
        except WebSocketDisconnect:
            pass
        finally:
            if _rooms.get(code) is room and room.tv is websocket:
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
        create = websocket.query_params.get("create") == "1"   # flux Presentation : le tel crée la salle
        room = _rooms.get(code)
        if not room:
            if not create:
                await _safe_send(websocket, {"type": "error", "error": "code"})
                await websocket.close()
                return
            room = Room(code); _rooms[code] = room          # la TV (présentée) rejoindra ce même code
        room.controllers.add(websocket)
        await _safe_send(websocket, {"type": "paired"})
        if room.tv is not None:
            await _safe_send(room.tv, {"type": "paired"})
            if room.state is not None:                     # TV déjà là → resynchro immédiate
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
                if room.tv is not None:
                    await _safe_send(room.tv, {"type": "unpaired"})
                elif _rooms.get(code) is room:
                    _rooms.pop(code, None)   # salle créée par le tel mais TV jamais venue → nettoyage
        return

    await websocket.close()
