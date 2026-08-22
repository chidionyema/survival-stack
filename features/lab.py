"""Talking to the dry-run lab: the real Worker, fake infrastructure.

Nothing here re-implements the lab. `scripts/dry-run.sh` still owns bringing it
up and tearing it down; these are the probes the scenarios assert on.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

WORKER = os.environ.get("LAB_WORKER", "http://127.0.0.1:8799")
EDGE = os.environ.get("LAB_EDGE", "http://127.0.0.1:8080")
SHIM = os.environ.get("LAB_SHIM", "http://127.0.0.1:2456")
ORIGIN_P1 = os.environ.get("LAB_ORIGIN_P1", "http://127.0.0.1:3001")
ORIGIN_P2 = os.environ.get("LAB_ORIGIN_P2", "http://127.0.0.1:3002")
ORIGINS = {"primary": ORIGIN_P1, "standby": ORIGIN_P2}

# A published RFC 6238 test vector, not a secret. The real one lives in Worker
# Secrets and never reaches this machine.
LAB_TOTP = os.environ.get("LAB_TOTP", "JBSWY3DPEHPK3PXP")
LAB_HOOK = os.environ.get("LAB_HOOK", "lab-webhook-secret")

# Which code has been spent is the Worker's state, not this process's. It burns
# each code in KV, so a second `behave` run starting inside the same 30-second
# window would replay a dead code. The file carries it across processes.
_CODE_FILE = ROOT / "lab" / "state" / "last-totp"


def totp(secret: str = LAB_TOTP, at: float | None = None) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    counter = struct.pack(">Q", int((at or time.time()) // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF
    return f"{code % 1_000_000:06d}"


def _spent() -> str | None:
    try:
        return _CODE_FILE.read_text().strip() or None
    except OSError:
        return None


def _spend(code: str) -> None:
    _CODE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CODE_FILE.write_text(code)


def fresh_code(timeout: int = 40) -> str:
    """Every code is spent once, by design. Wait for the next window, never replay."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        c = totp()
        if c != _spent():
            _spend(c)
            return c
        time.sleep(2)
    raise AssertionError("no fresh TOTP window inside %ss" % timeout)


def with_fresh_code(send, tries: int = 2):
    """Send an action with a code; if the Worker says it is spent, take the next one.

    The file above only records codes this suite spent. Anything else that talks
    to the lab — a curl, another run, the Telegram shim — burns codes we never
    saw, and the only place that truth lives is the Worker's reply.
    """
    for attempt in range(tries):
        status, text = send(fresh_code())
        if not (status == 401 and "already used" in text):
            return status, text
        _spend(totp())  # believe the Worker over the file, then wait it out
    return status, text


def request(url: str, method: str = "GET", body=None, headers=None, timeout: int = 20):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault("content-type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        return 0, str(e)


def get_json(url: str, timeout: int = 20):
    status, text = request(url, timeout=timeout)
    try:
        return status, json.loads(text)
    except json.JSONDecodeError:
        return status, {}


def telegram(text: str):
    """A message from the phone, through the real webhook."""
    return request(
        f"{WORKER}/telegram", "POST",
        {"message": {"chat": {"id": 1}, "text": text}},
        {"x-telegram-bot-api-secret-token": LAB_HOOK},
    )


def action(payload: dict):
    """The same action from the phone console."""
    return request(f"{WORKER}/api/action", "POST", payload)


def worker_up(timeout: int = 5) -> bool:
    status, text = request(f"{WORKER}/health", timeout=timeout)
    return status == 200 and "survival-control-plane" in text


def wait_for(predicate, seconds: int, every: float = 2.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(every)
    return False


def boxes() -> dict:
    _, data = get_json(f"{WORKER}/api/status")
    return data.get("boxes", {}) or {}


def whoami(base: str) -> str:
    _, data = get_json(f"{base}/api/whoami", timeout=25)
    return data.get("role", "")


def docker(*args, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def kill_boxes(role: str | None = None) -> None:
    flt = f"label=survival.role={role}" if role else "label=survival.role"
    ids = docker("ps", "-q", "--filter", flt).stdout.split()
    if ids:
        docker("rm", "-f", *ids)


def lab_up(timeout: int = 900) -> None:
    """Reuse the lab that is already running; otherwise let dry-run.sh build it."""
    if worker_up():
        return
    if os.environ.get("LAB_AUTOSTART", "1") != "1":
        raise AssertionError(
            f"the lab is not up at {WORKER} and LAB_AUTOSTART=0.\n"
            f"Run: scripts/dry-run.sh up"
        )
    log = ROOT / "lab" / "state" / "bdd-lab-up.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as fh:
        subprocess.run(["bash", "scripts/dry-run.sh", "up"], cwd=ROOT,
                       stdout=fh, stderr=subprocess.STDOUT, timeout=timeout)
    if not worker_up(timeout=10):
        raise AssertionError(f"the lab did not come up — see {log}")


def origin_healthy(role: str, timeout: int = 5) -> bool:
    """The registry says a box reported in once. This says it is answering now.

    A precondition that trusts the control plane's own table is the failure this
    function exists to stop: a killed container leaves its registration behind.
    """
    base = ORIGINS.get(role)
    if not base:
        return False
    return request(f"{base}/health", timeout=timeout)[0] == 200


def kill_backups() -> None:
    names = docker("ps", "-a", "--format", "{{.Names}}").stdout.split()
    dead = [n for n in names if n.endswith("-backup")]
    if dead:
        docker("rm", "-f", *dead)
