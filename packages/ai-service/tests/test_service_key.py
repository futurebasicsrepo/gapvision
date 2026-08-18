"""The service key, and the whitespace that broke it in production.

A service key reaches a deployment by somebody pasting it into a dashboard,
and a paste carries a trailing newline about as often as not — invisible in
every UI that shows the value. Untrimmed on either end, that newline decides
whether two identical keys are considered equal, and the refusal is a flat 401
that reads as "wrong key" about a key that is right.

That is not hypothetical. On 18 Aug a gated deck open was rejected for exactly
this: the sender was fixed to trim, and the mismatch survived, because the
whitespace was on the *receiving* side. Both ends trim now, and these hold it
there — the property is that a key is equal to itself however it was pasted.
"""
from __future__ import annotations

import importlib
import os

import pytest
from fastapi.testclient import TestClient

KEY = "test-key-" + "0" * 32


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GAPVISION_API_KEY", KEY)
    monkeypatch.setenv("GAPVISION_AUTH_MODE", "strict")
    from app import auth
    importlib.reload(auth)
    from app.main import app
    return TestClient(app)


def call(client, header_value):
    """Any service-key door will do; `/api/ingest/deck-lead` is the one the
    deck host actually knocks on, and it answers 204 on success."""
    return client.post(
        "/api/ingest/deck-lead",
        headers={"x-gapvision-key": header_value},
        json={"deck": "floor", "email": "whitespace@merchant.example.com"},
    )


def test_the_exact_key_is_accepted(client):
    assert call(client, KEY).status_code != 401


def test_a_key_sent_with_a_trailing_newline_is_accepted(client):
    """A client that pasted it into its own config."""
    assert call(client, KEY + "\n").status_code != 401


def test_a_key_sent_with_surrounding_spaces_is_accepted(client):
    assert call(client, f"  {KEY} ").status_code != 401


def test_a_configured_key_with_a_trailing_newline_still_matches_a_clean_one(
        client, monkeypatch):
    """The 18 Aug failure, in the direction that actually bit.

    The whitespace was on *our* side: the deployment's own variable carried a
    newline, so we demanded one, and a caller who copied the key correctly was
    refused.
    """
    monkeypatch.setenv("GAPVISION_API_KEY", KEY + "\n")
    from app import auth
    importlib.reload(auth)
    from app.main import app
    assert call(TestClient(app), KEY).status_code != 401


def test_a_wrong_key_is_still_refused(client):
    """Trimming must not become forgiving about anything that matters."""
    assert call(client, "test-key-" + "1" * 32).status_code == 401


def test_a_missing_key_is_still_refused(client):
    assert client.post(
        "/api/ingest/deck-lead",
        json={"deck": "floor", "email": "nokey@merchant.example.com"},
    ).status_code == 401


def test_a_whitespace_only_key_is_refused_not_treated_as_absent(client):
    """A header of spaces trims to empty. It must read as wrong, never as a
    match against an empty expected value."""
    assert call(client, "   ").status_code == 401
