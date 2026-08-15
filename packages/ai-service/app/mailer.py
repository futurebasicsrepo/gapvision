"""Sending mail, and being honest when we can't.

    CUE_SMTP_HOST      smtp.resend.com
    CUE_SMTP_PORT      587
    CUE_SMTP_USER      resend
    CUE_SMTP_PASSWORD  the provider's API key
    CUE_MAIL_FROM      "Cue <kr@cuesea.ai>"

Unset any of those and the provider is `console`: the message is printed to
the service log and *nothing is sent*. That is the right default for a service
whose first email is a password-reset link — silently pretending to send is
how somebody ends up locked out while the logs say everything is fine.

The failure mode this is built around
-------------------------------------
Password reset has an unusual property: **the request must succeed whether or
not the email goes out.** Telling a caller "we could not find that address" is
account enumeration, so `/auth/forgot` returns the same 202 either way — which
means an SMTP outage is invisible from the outside by design.

So delivery failures are loud on the inside instead. Every send returns a
result, failures are logged with the reason, and `status()` feeds a Health
check. A reset flow that quietly stopped working would otherwise look exactly
like a reset flow nobody used.

Why a provider and not Gmail
---------------------------
This pointed at `smtp.gmail.com` first, which is the obvious thing and does not
work: **Google does not offer app passwords to Workspace accounts**, and
`kr@cuesea.ai` is one. The app-passwords page renders "the setting you are
looking for is not available for your account" and there is no admin toggle to
undo that — Google retired less-secure-app access through 2024–25 and points at
OAuth 2.0 instead. Reaching Gmail properly now means a service account with
domain-wide delegation, which is a credential, a GCP project and a code path,
all to send three-line transactional messages.

So: an SMTP provider. It is one variable, it does not tie the product's ability
to invite people to one person's mailbox, and transactional mail from a
dedicated sender has better deliverability than from a human inbox anyway.

Any of them work — the seam is `CUE_SMTP_*` and nothing above this line knows
which one is behind it.
"""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any

_TIMEOUT = 12


def _cfg() -> dict[str, str | None]:
    return {
        "host": os.getenv("CUE_SMTP_HOST"),
        "port": os.getenv("CUE_SMTP_PORT", "587"),
        "user": os.getenv("CUE_SMTP_USER"),
        "password": os.getenv("CUE_SMTP_PASSWORD"),
        "from": os.getenv("CUE_MAIL_FROM") or os.getenv("CUE_SMTP_USER"),
    }


def provider() -> str:
    c = _cfg()
    return "smtp" if (c["host"] and c["user"] and c["password"]) else "console"


def status() -> dict[str, Any]:
    """For /health and the platform checks. Never reports the password, and
    never reports the *from* address as proof of anything — a configured
    sender with a wrong password looks identical until something is sent."""
    c = _cfg()
    return {
        "provider": provider(),
        "host": c["host"],
        "from": c["from"],
        "configured": provider() == "smtp",
    }


def send(to: str, subject: str, body: str) -> dict[str, Any]:
    """Send one plain-text message. Returns a result rather than raising.

    Plain text on purpose. These are three-line transactional messages whose
    entire job is to carry one link; HTML would add a rendering surface, a
    spam-score liability and a second copy of every string, for nothing.
    """
    c = _cfg()
    if provider() == "console":
        print(f"[cue][mail:console] to={to} subject={subject}\n{body}\n", flush=True)
        return {"ok": True, "provider": "console", "delivered": False}

    msg = EmailMessage()
    msg["From"] = c["from"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    try:
        with smtplib.SMTP(c["host"], int(c["port"] or 587), timeout=_TIMEOUT) as s:
            s.ehlo()
            s.starttls(context=ssl.create_default_context())
            s.login(c["user"], c["password"])
            s.send_message(msg)
        return {"ok": True, "provider": "smtp", "delivered": True}
    except Exception as e:
        # Loud in the log, quiet to the caller — see the module docstring.
        print(f"[cue][mail] FAILED to={to} subject={subject}: "
              f"{type(e).__name__}: {e}", flush=True)
        return {"ok": False, "provider": "smtp", "delivered": False,
                "error": f"{type(e).__name__}"}


# --- copy --------------------------------------------------------------------
#
# Kept here rather than in the route so the two paths cannot drift into saying
# different things about the same link, and so someone changing the wording
# does not have to read the token logic to do it.

def _app_url(role: str) -> str:
    """Where this person signs in.

    A cue_admin lives in the Console and everyone else in Studio. Sending a
    retailer's manager a link to internal.cuesea.ai would show them a
    dead-end page and make Cue look broken at the exact moment they are
    already having trouble getting in.
    """
    if role == "cue_admin":
        return os.getenv("CUE_CONSOLE_URL", "https://internal.cuesea.ai")
    return os.getenv("CUE_STUDIO_URL", "https://app.cuesea.ai")


def link_for(role: str, token: str) -> str:
    return f"{_app_url(role)}/set-password?token={token}"


def send_invite(*, to: str, name: str | None, role: str, token: str,
                tenant_name: str | None, hours: int) -> dict[str, Any]:
    url = link_for(role, token)
    who = (name or "").split(" ")[0] or "there"
    where = f" at {tenant_name}" if tenant_name else ""
    return send(
        to,
        "Set up your Cue account",
        f"Hi {who},\n\n"
        f"You've been given a Cue account{where}. Set your password here:\n\n"
        f"{url}\n\n"
        f"The link works once and expires in {hours // 24} days.\n\n"
        f"If you weren't expecting this, you can ignore it — the account "
        f"can't be used until a password is set.\n\n"
        f"— Cue\n",
    )


def send_test(*, to: str, name: str | None) -> dict[str, Any]:
    who = (name or "").split(" ")[0] or "there"
    return send(
        to,
        "Cue can send email",
        f"Hi {who},\n\n"
        f"Somebody pressed Send a test in Cue Console and this arrived, which "
        f"means outbound email works. Invitations and password resets will now "
        f"reach people instead of being written to the service log.\n\n"
        f"Nothing about your account changed.\n\n"
        f"— Cue\n",
    )


# Named failures. The lesson from `probe_connection`: when a credential does
# not work, the operator needs to know *which* of the plausible things is
# wrong. SMTP has about six ways to fail and they need six different sentences,
# because "authentication failed" sends somebody to re-type a password that was
# never the problem.
_HINTS = {
    "SMTPAuthenticationError":
        "The server rejected the username or password. With an SMTP provider "
        "the username is usually a fixed literal and the password is the API "
        "key — check CUE_SMTP_USER before assuming the key is wrong. Against "
        "Gmail this means an account password where an app password is needed, "
        "and Workspace accounts cannot create app passwords at all.",
    "SMTPSenderRefused":
        "The server accepted the login but refused the From address. With a "
        "provider this is almost always an unverified sending domain — "
        "CUE_MAIL_FROM is on a domain whose DNS records have not been added or "
        "have not propagated yet.",
    "SMTPRecipientsRefused":
        "The server refused the recipient address.",
    "SMTPNotSupportedError":
        "The server does not offer STARTTLS on this port. Gmail wants 587.",
    "SMTPConnectError":
        "Could not open a connection. Check the host and port.",
    "SMTPServerDisconnected":
        "The server hung up mid-conversation. Usually a wrong port — 465 is "
        "implicit TLS and this client speaks STARTTLS, which is 587.",
    "gaierror":
        "The hostname did not resolve. Check CUE_SMTP_HOST for a typo.",
    "timeout":
        "The connection timed out. The host may be unreachable from this "
        "deployment, or blocked outbound.",
    "TimeoutError":
        "The connection timed out. The host may be unreachable from this "
        "deployment, or blocked outbound.",
    "SSLError":
        "TLS negotiation failed.",
}


def hint(error: str | None) -> str:
    return _HINTS.get(error or "", "The send failed. The service log carries "
                                   "the exact exception.")


def send_reset(*, to: str, name: str | None, role: str, token: str,
               hours: int) -> dict[str, Any]:
    url = link_for(role, token)
    who = (name or "").split(" ")[0] or "there"
    return send(
        to,
        "Reset your Cue password",
        f"Hi {who},\n\n"
        f"Someone asked to reset the password for this Cue account. If it was "
        f"you, set a new one here:\n\n"
        f"{url}\n\n"
        f"The link works once and expires in {hours} hour"
        f"{'s' if hours != 1 else ''}.\n\n"
        f"If it wasn't you, nothing has changed and you can ignore this. "
        f"Your current password still works.\n\n"
        f"— Cue\n",
    )
