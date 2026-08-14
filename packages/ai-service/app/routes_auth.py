"""Login, logout, and "who am I".

Opaque bearer tokens rather than JWTs: the dashboard is a long-lived browser
session against one API, revocation has to be instant when an admin disables
someone, and a token you can invalidate server-side is worth more here than
one you can verify without a round trip.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from . import identity
from .identity import BearerHeader, current_user

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/login")
def login(req: LoginRequest):
    row = identity.authenticate(req.email, req.password)
    if row is None:
        # One message for every failure mode: unknown account, wrong password,
        # disabled account. Telling an attacker which one is a free hint.
        raise HTTPException(status_code=401, detail="Email or password is incorrect")

    token, expires = identity.issue_token(row["id"])
    user = identity.resolve_token(token)
    return {
        "token": token,
        "expires_at": expires,
        "user": identity.public_user(user or row),
    }


@router.post("/logout")
def logout(authorization: str | None = BearerHeader):
    if authorization and authorization.lower().startswith("bearer "):
        identity.revoke_token(authorization.split(" ", 1)[1].strip())
    return {"ok": True}


@router.get("/me")
def me(authorization: str | None = BearerHeader):
    return {"user": identity.public_user(current_user(authorization))}
