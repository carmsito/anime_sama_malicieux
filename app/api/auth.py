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


def create_user(username: str, password: str) -> dict:
    users = _load_users()
    if any(u["username"] == username for u in users):
        raise HTTPException(status_code=400, detail="Nom d'utilisateur déjà pris")
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "password_hash": _hash(password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    _save_users(users)
    return user


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
