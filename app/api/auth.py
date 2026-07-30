from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
import bcrypt as _bcrypt

from .config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES, USERS_FILE

bearer_scheme = HTTPBearer(auto_error=False)


def _hash(password: str) -> str:
    return _bcrypt.hashpw(password.encode()[:72], _bcrypt.gensalt()).decode()


def _verify(password: str, hashed: str) -> bool:
    return _bcrypt.checkpw(password.encode()[:72], hashed.encode())


def _load_users() -> list[dict]:
    if not USERS_FILE.exists():
        USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        USERS_FILE.write_text("[]")
        return []
    return json.loads(USERS_FILE.read_text())


def _save_users(users: list[dict]) -> None:
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2))


ROLES = ("admin", "scrapper")


def ensure_admin() -> None:
    """Migration : garantit qu'au moins un admin existe. Promeut le plus ancien
    utilisateur si aucun n'a le rôle admin (comptes créés avant les rôles)."""
    users = _load_users()
    if not users or any(u.get("role") == "admin" for u in users):
        # normalise les rôles manquants
        changed = False
        for u in users:
            if not u.get("role"):
                u["role"] = "scrapper"
                changed = True
        if changed:
            _save_users(users)
        return
    oldest = min(users, key=lambda u: u.get("created_at", ""))
    for u in users:
        u.setdefault("role", "scrapper")
    oldest["role"] = "admin"
    _save_users(users)
    print(f"[auth] {oldest['username']} promu admin (migration rôles)", flush=True)


def create_user(username: str, password: str, role: str | None = None) -> dict:
    users = _load_users()
    if any(u["username"] == username for u in users):
        raise HTTPException(status_code=400, detail="Nom d'utilisateur déjà pris")
    # Le tout premier utilisateur est admin (bootstrap). Les suivants : scrapper par défaut.
    if not users:
        role = "admin"
    elif role not in ROLES:
        role = "scrapper"
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "password_hash": _hash(password),
        "role": role,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    _save_users(users)
    return user


def list_users() -> list[dict]:
    return [{"id": u["id"], "username": u["username"],
             "role": u.get("role", "scrapper"), "created_at": u.get("created_at")}
            for u in _load_users()]


def set_user_role(user_id: str, role: str) -> dict:
    if role not in ROLES:
        raise HTTPException(400, f"Rôle invalide (attendu: {ROLES})")
    users = _load_users()
    u = next((x for x in users if x["id"] == user_id), None)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    # Empêche de retirer le dernier admin.
    if u.get("role") == "admin" and role != "admin":
        if sum(1 for x in users if x.get("role") == "admin") <= 1:
            raise HTTPException(400, "Impossible : c'est le dernier admin")
    u["role"] = role
    _save_users(users)
    return {"id": u["id"], "username": u["username"], "role": role}


def delete_user(user_id: str) -> None:
    users = _load_users()
    u = next((x for x in users if x["id"] == user_id), None)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if u.get("role") == "admin" and sum(1 for x in users if x.get("role") == "admin") <= 1:
        raise HTTPException(400, "Impossible : c'est le dernier admin")
    _save_users([x for x in users if x["id"] != user_id])


def authenticate_user(username: str, password: str) -> Optional[dict]:
    users = _load_users()
    user = next((u for u in users if u["username"] == username), None)
    if not user or not _verify(password, user["password_hash"]):
        return None
    return user


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def _get_user_by_id(user_id: str) -> Optional[dict]:
    return next((u for u in _load_users() if u["id"] == user_id), None)


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Non authentifié")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if not user_id:
            raise JWTError()
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token invalide")
    user = _get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Utilisateur introuvable")
    return user


def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> Optional[dict]:
    if not credentials:
        return None
    try:
        return get_current_user(credentials)
    except HTTPException:
        return None


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Réservé aux administrateurs")
    return user


def require_scraper(user: dict = Depends(get_current_user)) -> dict:
    # admin ET scrapper peuvent scraper
    if user.get("role") not in ("admin", "scrapper"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Droits de scraping requis")
    return user
