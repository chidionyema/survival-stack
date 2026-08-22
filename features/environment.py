import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# One lab, one holder. There is a single set of host ports, one docker label
# namespace and one lab_default network on this machine. Two runs at once do not
# collide loudly: they destroy each other's boxes, and the failure that comes out
# reads as a real defect. Two sessions each spent a cycle chasing exactly that on
# 2026-08-22.
#
# behave and scripts/dry-run.sh both drive the same lab, so both take the same
# lease. LAB_WAIT=600 queues behind the holder instead of refusing.
LEASE = Path(__file__).resolve().parents[1] / "scripts" / "lab-lease.py"


def _lease(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(LEASE), *args],
                          capture_output=True, text=True)


def before_all(context):
    context.root = Path(__file__).resolve().parents[1]
    context.status = None
    context.body = ""

    if not LEASE.is_file():
        raise RuntimeError(f"no lab lease at {LEASE} — this checkout is incomplete")

    # The pid recorded is this behave process, so the lease dies with the run and
    # a crash never wedges the lab for the next person.
    context.lab_holder = os.environ.get("LAB_HOLDER") or f"behave:{os.getpid()}"
    r = _lease("acquire", "--holder", context.lab_holder,
               "--why", "behave " + " ".join(sys.argv[1:]),
               "--pid", str(os.getpid()),
               "--wait", os.environ.get("LAB_WAIT", "0"))
    if r.returncode != 0:
        # Say who has it and what they are doing. A bare "the lab is busy" sends
        # the reader to docker ps to work out the same thing.
        raise RuntimeError((r.stderr or r.stdout).strip())
    print(r.stdout.strip())

    # Only after the lease is held, so nothing between here and after_all can
    # raise and skip the release. behave does not call after_all when before_all
    # raises.


def after_all(context):
    holder = getattr(context, "lab_holder", None)
    if not holder:
        return
    r = _lease("release", "--holder", holder)
    print((r.stdout or r.stderr).strip())
