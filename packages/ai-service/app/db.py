"""Database access — connection pool and migrations.

Everything above the prototype line needs to survive a redeploy: leaderboards
that reset when someone pushes a commit are not leaderboards, and "add a
tenant" needs somewhere to write. This module is that floor.

Deliberately plain SQL over an ORM. The schema is small, the queries are
mostly reporting, and a migration you can read in a diff is worth more here
than model classes. `psycopg` (v3) is the only new dependency.

Local dev and CI: point CUE_DATABASE_URL at any Postgres. Railway injects
DATABASE_URL for its managed instance, which is read as a fallback so nothing
has to be configured twice.
"""
from __future__ import annotations

import os
import pathlib
import threading

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"

_pool: ConnectionPool | None = None
_lock = threading.Lock()


class DatabaseNotConfigured(RuntimeError):
    """Raised when a database-backed feature is used without a database.

    Kept distinct from a connection error: "you haven't set this up" and
    "the database is down" want different responses from the caller.
    """


def database_url() -> str | None:
    url = os.environ.get("CUE_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        return None
    # Railway hands out postgres:// ; psycopg wants postgresql://
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def configured() -> bool:
    return database_url() is not None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is not None:
        return _pool
    with _lock:
        if _pool is not None:
            return _pool
        url = database_url()
        if not url:
            raise DatabaseNotConfigured(
                "No database configured. Set CUE_DATABASE_URL (or add Postgres "
                "in Railway, which provides DATABASE_URL)."
            )
        _pool = ConnectionPool(
            url,
            min_size=1,
            max_size=int(os.environ.get("CUE_DB_POOL_MAX", "8")),
            kwargs={"row_factory": dict_row},
            open=True,
        )
        return _pool


def reset_pool() -> None:
    """Drop the pool — used by tests that swap databases between cases."""
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
        _pool = None


class _ConnCtx:
    """`with connection() as conn:` — commits on success, rolls back on error."""

    def __enter__(self):
        self._cm = get_pool().connection()
        return self._cm.__enter__()

    def __exit__(self, *exc):
        return self._cm.__exit__(*exc)


def connection() -> _ConnCtx:
    return _ConnCtx()


def query(sql: str, params: tuple | dict = ()) -> list[dict]:
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []


def query_one(sql: str, params: tuple | dict = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple | dict = ()) -> int:
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


# --- migrations --------------------------------------------------------------

def _applied(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name       text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("SELECT name FROM schema_migrations")
        return {r["name"] for r in cur.fetchall()}


def migrate(verbose: bool = True) -> list[str]:
    """Apply pending migrations in filename order. Safe to run on every boot.

    Each file runs in its own transaction: a failure halfway through a deploy
    leaves the schema at the last complete migration rather than in a state
    nobody can reason about.
    """
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    ran: list[str] = []
    with connection() as conn:
        done = _applied(conn)
        conn.commit()

    for path in files:
        if path.name in done:
            continue
        sql = path.read_text()
        with connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                cur.execute(
                    "INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,)
                )
            conn.commit()
        ran.append(path.name)
        if verbose:
            print(f"[cue] migration applied: {path.name}", flush=True)
    return ran


def health() -> dict:
    """Reported by /health. Never raises — a database problem should show up
    as degraded status, not a 500 on the endpoint used to detect it."""
    if not configured():
        return {"configured": False}
    try:
        with connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) AS n FROM schema_migrations")
                n = cur.fetchone()["n"]
        return {"configured": True, "reachable": True, "migrations": n}
    except (psycopg.Error, DatabaseNotConfigured) as e:
        return {"configured": True, "reachable": False, "error": str(e)[:200]}
