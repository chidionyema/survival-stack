"""Placeholder engine. Swap for the real one; keep /health and the port.

It writes a row on every order so the dry run can prove a restored database
carries real data across, not just that a file appeared.
"""
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, request

app = Flask(__name__)
DB_TYPE = os.environ.get("DB_TYPE", "sqlite")
VERSION = os.environ.get("ENGINE_VERSION", "dry-run-1.0")
ROLE = os.environ.get("ROLE", "unknown")

SQLITE_PATH = os.environ.get("DATABASE_URL", "sqlite:///data/app.db").replace("sqlite://", "")
PG_DSN = os.environ.get("DATABASE_URL", "") if DB_TYPE == "postgres" else ""


def connect():
    if DB_TYPE == "postgres":
        import psycopg
        return psycopg.connect(PG_DSN)
    os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
    conn = sqlite3.connect(SQLITE_PATH)
    conn.execute("PRAGMA journal_mode=WAL")  # litestream requires WAL
    return conn


def init():
    conn = connect()
    with conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, at TEXT NOT NULL)"
        )
    conn.close()


def count():
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM orders")
    n = cur.fetchone()[0]
    conn.close()
    return n


@app.get("/health")
def health():
    try:
        orders = count()
    except Exception as err:
        return jsonify({"status": "degraded", "error": str(err)}), 503
    return jsonify({"status": "ok", "version": VERSION, "role": ROLE,
                    "db": DB_TYPE, "orders": orders})


@app.get("/api/whoami")
def whoami():
    """Which box answered. The dry run needs to see failover, not just a 200."""
    return jsonify({"role": ROLE, "db": DB_TYPE})


@app.get("/api/packs")
def packs():
    return jsonify([{"id": "1", "name": "Test Pack", "price_cents": 1000}])


@app.post("/api/orders")
def order():
    oid = request.json.get("id") if request.is_json else None
    oid = oid or str(uuid.uuid4())
    conn = connect()
    ph = "%s" if DB_TYPE == "postgres" else "?"
    with conn:
        conn.execute(f"INSERT INTO orders (id, at) VALUES ({ph}, {ph})",
                     (oid, datetime.now(timezone.utc).isoformat()))
    conn.close()
    return jsonify({"id": oid, "client_secret": "pi_test_123", "orders": count()})


if __name__ == "__main__":
    init()
    app.run(host="0.0.0.0", port=3000)
