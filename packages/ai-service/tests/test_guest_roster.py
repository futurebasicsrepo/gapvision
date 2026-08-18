"""The roster endpoint, and the promise it has to keep.

The customer deck tells a general counsel, in the section written for one:

    "No customer list to leak — There is deliberately no endpoint that
     enumerates your customers."

`GET /api/guests` is an endpoint that enumerates guests. It survives because
picking a name off a list is how the simulator and the associate view stage an
arrival when there is no plate to tap, and the ids it returns are the ids
`/api/guest-context` accepts — so an open roster is not a list, it is a key to
every card behind it.

It used to be bounded by `tenant !== "gap"` in the realtime proxy, which made
the rule a statement about a *slug*: a real store provisioned under that name
would have been enumerable, and a second demo tenant under any other name was
refused something harmless. Nothing in this repository tested it, which is why
that held for as long as it did.

The rule now asks the only question that cannot be typed by hand — whether the
adapter behind the tenant can name a real person.
"""
import pytest
from fastapi.testclient import TestClient

from app import crm_provider, main
from app.main import app

client = TestClient(app)


class FakeLiveStore:
    """Stands in for any adapter holding a live credential.

    Deliberately not a Shopify instance: the rule must hold for the second
    adapter too, and a test that names one provider would pass while the next
    one shipped wide open.
    """

    def all_guests(self):                       # pragma: no cover - must not run
        raise AssertionError(
            "a real store's customer list was enumerated — this is the leak")


def test_a_demo_tenant_may_list_its_invented_people(auth_headers):
    r = client.get("/api/guests?tenant=gap", headers=auth_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_a_tenant_with_a_live_store_is_refused(monkeypatch, auth_headers):
    monkeypatch.setattr(main, "get_crm_for", lambda t: FakeLiveStore())
    r = client.get("/api/guests?tenant=anything", headers=auth_headers)
    assert r.status_code == 403
    # The sentence has to carry why, because the person reading it is usually
    # deciding whether we are lying in the deck.
    assert "demo tenants only" in r.json()["detail"]


def test_the_rule_follows_the_adapter_not_the_slug(monkeypatch, auth_headers):
    """The actual bug. A real store called "gap" was the enumerable case, and
    naming a demo store anything else was the needlessly refused one."""
    monkeypatch.setattr(main, "get_crm_for", lambda t: FakeLiveStore())
    assert client.get("/api/guests?tenant=gap", headers=auth_headers).status_code == 403

    monkeypatch.setattr(main, "get_crm_for", lambda t: crm_provider._MOCK)
    assert client.get("/api/guests?tenant=demo-two", headers=auth_headers).status_code == 200


def test_the_roster_still_needs_the_service_key():
    """The gate above is about *whose* data, not about who is asking. Both
    have to hold, and a 403 on one must never stand in for the other."""
    r = client.get("/api/guests?tenant=gap")
    assert r.status_code == 401


@pytest.mark.parametrize("crm,synthetic", [
    (crm_provider._MOCK, True),
    (FakeLiveStore(), False),
])
def test_serves_synthetic_guests(crm, synthetic):
    assert crm_provider.serves_synthetic_guests(crm) is synthetic
