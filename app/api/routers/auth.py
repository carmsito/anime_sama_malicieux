from fastapi import APIRouter
from ..auth import authenticate_user, create_user, create_access_token, get_current_user
from ..models.schemas import UserCreate, UserLogin, Token, UserOut
from fastapi import Depends, HTTPException

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=Token, summary="Créer un compte")
def register(body: UserCreate):
    user = create_user(body.username, body.password)
    token = create_access_token(user["id"])
    return Token(
        access_token=token,
        user=UserOut(id=user["id"], username=user["username"], created_at=user["created_at"]),
    )


@router.post("/login", response_model=Token, summary="Se connecter")
def login(body: UserLogin):
    user = authenticate_user(body.username, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Identifiants incorrects")
    token = create_access_token(user["id"])
    return Token(
        access_token=token,
        user=UserOut(id=user["id"], username=user["username"], created_at=user["created_at"]),
    )


@router.get("/me", response_model=UserOut, summary="Profil courant")
def me(user: dict = Depends(get_current_user)):
    return UserOut(id=user["id"], username=user["username"], created_at=user["created_at"])
