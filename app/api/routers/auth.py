from fastapi import APIRouter, Depends, HTTPException
from ..auth import (
    authenticate_user, create_user, create_access_token, get_current_user,
    require_admin, list_users, set_user_role, delete_user,
)
from ..models.schemas import UserCreate, UserLogin, Token, UserOut, RoleUpdate

router = APIRouter(prefix="/auth", tags=["auth"])


def _out(u: dict) -> UserOut:
    return UserOut(id=u["id"], username=u["username"],
                   role=u.get("role", "scrapper"), created_at=u.get("created_at"))


@router.post("/register", response_model=Token, summary="Créer un compte")
def register(body: UserCreate):
    user = create_user(body.username, body.password)
    token = create_access_token(user["id"])
    return Token(access_token=token, user=_out(user))


@router.post("/login", response_model=Token, summary="Se connecter")
def login(body: UserLogin):
    user = authenticate_user(body.username, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Identifiants incorrects")
    token = create_access_token(user["id"])
    return Token(access_token=token, user=_out(user))


@router.get("/me", response_model=UserOut, summary="Profil courant")
def me(user: dict = Depends(get_current_user)):
    return _out(user)


# ── Gestion des utilisateurs (admin uniquement) ───────────────────────────────

@router.get("/users", response_model=list[UserOut], summary="Lister les utilisateurs (admin)")
def get_users(_: dict = Depends(require_admin)):
    return [_out(u) for u in list_users()]


@router.post("/users", response_model=UserOut, summary="Créer un utilisateur (admin)")
def add_user(body: UserCreate, _: dict = Depends(require_admin)):
    role = getattr(body, "role", None)
    u = create_user(body.username, body.password, role=role)
    return _out(u)


@router.put("/users/{user_id}/role", response_model=UserOut, summary="Changer le rôle (admin)")
def change_role(user_id: str, body: RoleUpdate, _: dict = Depends(require_admin)):
    return _out(set_user_role(user_id, body.role))


@router.delete("/users/{user_id}", summary="Supprimer un utilisateur (admin)")
def remove_user(user_id: str, _: dict = Depends(require_admin)):
    delete_user(user_id)
    return {"deleted": True}
