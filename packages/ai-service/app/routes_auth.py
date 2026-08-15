"""Login, logout, and "who am I".

Opaque bearer tokens rather than JWTs: the dashboard is a long-lived browser
session against one API, revocation has to be instant when an admin disables
someone, and a token you can invalidate server-side is worth more here than
one you can verify without a round trip.
"""
import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr

from . import identity, mailer
from .auth import throttle, throttle_key
from .identity import BearerHeader, current_user

router = APIRouter(prefix="/auth", tags=["auth"])

#: Two keys, two limits — see auth.throttle. The per-email numbers are what
#: stops somebody grinding one account; the per-IP numbers are sized for a
#: shop floor behind one NAT at the start of a shift, which is a building full
#: of people who all legitimately work here.
LOGIN_EMAIL_LIMIT = int(os.getenv("CUE_LOGIN_EMAIL_LIMIT", "6"))
LOGIN_IP_LIMIT = int(os.getenv("CUE_LOGIN_IP_LIMIT", "60"))
FORGOT_EMAIL_LIMIT = int(os.getenv("CUE_FORGOT_EMAIL_LIMIT", "3"))
FORGOT_IP_LIMIT = int(os.getenv("CUE_FORGOT_IP_LIMIT", "20"))
THROTTLE_WINDOW = 60


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotRequest(BaseModel):
    email: EmailStr


class ResetRequest(BaseModel):
    token: str
    password: str


@router.post("/login")
def login(req: LoginRequest, request: Request):
    throttle(request, "login-ip", LOGIN_IP_LIMIT, THROTTLE_WINDOW)
    throttle_key(f"login-email:{req.email.lower()}", LOGIN_EMAIL_LIMIT, THROTTLE_WINDOW)
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


@router.post("/forgot", status_code=202)
def forgot(req: ForgotRequest, request: Request):
    """Ask for a reset link.

    **Always 202**, whether or not that address has an account. Anything else
    turns this endpoint into a membership oracle: try an email, read the
    status, learn whether that person works at a CueSea customer. The cost is
    that a typo looks identical to success — which is why the response says
    "if there's an account" rather than "sent".

    Delivery failures are invisible here on purpose and loud in the log and on
    the Health panel. See mailer.py.
    """
    throttle(request, "forgot-ip", FORGOT_IP_LIMIT, THROTTLE_WINDOW)
    throttle_key(f"forgot-email:{req.email.lower()}", FORGOT_EMAIL_LIMIT, THROTTLE_WINDOW)
    user = identity.user_by_email(req.email)
    if user and user["status"] == "active":
        token, hours = identity.issue_password_link(str(user["id"]), "reset")
        mailer.send_reset(to=user["email"], name=user["name"],
                          role=user["role"], token=token, hours=hours)
    return {"ok": True,
            "message": "If there's an account for that address, a link is on its way."}


@router.post("/reset")
def reset(req: ResetRequest, request: Request):
    """Set a password from an invite or reset link.

    Throttled on the same bucket as login: a token is 32 random bytes, so
    guessing is not the threat — but an unthrottled endpoint that does an
    scrypt hash on every call is a cheap way to spend the service's CPU.
    """
    throttle(request, "login-ip", LOGIN_IP_LIMIT, THROTTLE_WINDOW)
    result = identity.redeem_password_link(req.token, req.password)
    # Deliberately no session issued. Signing in with the password they just
    # chose proves it works and that they remember it, which is worth one
    # extra screen — and it means a leaked link cannot both set a password and
    # hand back a live session in one request.
    return {"ok": True, "email": result["email"], "kind": result["kind"]}
