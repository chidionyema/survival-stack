#!/usr/bin/env python3
"""One lab, one holder.

There is a single lab on this machine. One set of host ports, one docker label
namespace, one `lab_default` network. Two sessions running tests at once do not
collide loudly; they destroy each other's boxes and the failure that comes out
reads as a real defect. Two of us spent a cycle each chasing exactly that on
2026-08-22.

This makes it loud. A test run takes the lease first and a second run is refused
by name, with who holds it and what they are doing.

    lab-lease.py acquire --holder chidionyema-60 --why "behave --tags=@cp2"
    lab-lease.py acquire --holder chidionyema-60 --why "..." --wait 600
    lab-lease.py release --holder chidionyema-60
    lab-lease.py who

The lease is not a lock on the lab being UP. `scripts/dry-run.sh up` is harmless
to share. It is a lock on running tests, which is the part that destroys boxes.

A lease whose process is gone is stale and is taken automatically, so a crashed
run never wedges the lab.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEASE = ROOT / "lab" / "state" / "HOLDER.json"


def default_holder() -> str:
    return os.environ.get("LAB_HOLDER") or f"{socket.gethostname()}:{os.getpid()}"


def alive(pid: int) -> bool:
    if pid <= 0:                     # a lease nobody's process owns; only the ttl frees it
        return True
    try:
        os.kill(pid, 0)
    except OSError as e:
        return e.errno == errno.EPERM
    return True


def expired(rec: dict) -> bool:
    """Stale means the owning process is gone, or the lease outlived its ttl.

    The pid recorded is the CALLER's, not this script's. This script exits in
    milliseconds, so recording its own pid made every lease instantly stale and
    the whole thing a no-op.
    """
    if not alive(int(rec.get("pid", -1))):
        return True
    ttl = float(rec.get("ttl", 0) or 0)
    return bool(ttl) and (time.time() - float(rec.get("at", 0))) > ttl


def read() -> dict | None:
    try:
        return json.loads(LEASE.read_text())
    except (OSError, ValueError):
        return None


def describe(rec: dict) -> str:
    held = time.time() - rec.get("at", 0)
    return (f"{rec.get('holder', '?')} has held the lab for {int(held)}s "
            f"running: {rec.get('why', 'unsaid')} (pid {rec.get('pid', '?')})")


def try_acquire(holder: str, why: str, pid: int, ttl: int) -> tuple[bool, str]:
    LEASE.parent.mkdir(parents=True, exist_ok=True)
    rec = {"holder": holder, "why": why, "pid": pid, "ttl": ttl, "at": time.time()}
    payload = json.dumps(rec)
    try:
        fd = os.open(LEASE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        cur = read()
        if cur is None:
            LEASE.unlink(missing_ok=True)          # unreadable, treat as free
            return try_acquire(holder, why, pid, ttl)
        if cur.get("holder") == holder:
            return True, f"already held by {holder}"
        if expired(cur):
            why_stale = ("its process is gone" if not alive(int(cur.get("pid", -1)))
                         else f"it outlived its {int(cur.get('ttl', 0))}s ttl")
            LEASE.unlink(missing_ok=True)
            ok, _ = try_acquire(holder, why, pid, ttl)
            return ok, f"took a stale lease from {cur.get('holder', '?')} ({why_stale})"
        return False, describe(cur)
    with os.fdopen(fd, "w") as fh:
        fh.write(payload)
    return True, f"{holder} holds the lab"


def acquire(holder: str, why: str, wait: int, pid: int, ttl: int) -> int:
    deadline = time.time() + wait
    told = False
    while True:
        ok, msg = try_acquire(holder, why, pid, ttl)
        if ok:
            print(msg)
            return 0
        if time.time() >= deadline:
            print(f"the lab is busy. {msg}\n"
                  f"Wait for them, or run with --wait <seconds>. "
                  f"Do not start a second lab: it destroys their boxes and yours.",
                  file=sys.stderr)
            return 1
        if not told:
            print(f"waiting for the lab. {msg}", file=sys.stderr)
            told = True
        time.sleep(3)


def release(holder: str) -> int:
    cur = read()
    if cur is None:
        print("the lab was not held")
        return 0
    if cur.get("holder") != holder and not expired(cur):
        print(f"refusing: {describe(cur)}, not {holder}", file=sys.stderr)
        return 1
    LEASE.unlink(missing_ok=True)
    print(f"{holder} released the lab")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="lab-lease.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("acquire")
    a.add_argument("--holder", default=default_holder())
    a.add_argument("--why", default="unsaid")
    a.add_argument("--wait", type=int, default=0, help="seconds to wait for the holder to finish")
    a.add_argument("--pid", type=int, default=os.getppid(),
                   help="the process that owns the lease; 0 for a hold no process owns")
    a.add_argument("--ttl", type=int, default=3600,
                   help="seconds after which the lease is stale even if the process lives")

    r = sub.add_parser("release")
    r.add_argument("--holder", default=default_holder())

    sub.add_parser("who")

    ns = ap.parse_args()
    if ns.cmd == "acquire":
        return acquire(ns.holder, ns.why, ns.wait, ns.pid, ns.ttl)
    if ns.cmd == "release":
        return release(ns.holder)
    cur = read()
    if cur is None:
        print("the lab is free")
        return 0
    stale = "  [STALE — it will be taken by the next run]" if expired(cur) else ""
    print(describe(cur) + stale)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
