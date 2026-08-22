"""Steps for every checkpoint. They probe the running lab; they do not fake it."""

import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from behave import given, then, when

import lab


# ----------------------------------------------------------------- the lab

@given("the lab is up")
def step_lab_up(context):
    lab.lab_up()
    assert lab.worker_up(), f"the control plane is not answering at {lab.WORKER}"


@given("the Telegram outbox is empty")
def step_clear_outbox(context):
    status, _ = lab.request(f"{lab.SHIM}/tg/_clear")
    assert status == 200, "the lab shim is not answering; the lab is not fully up"


def outbox():
    _, data = lab.get_json(f"{lab.SHIM}/tg/_sent")
    return data if isinstance(data, list) else []


# ------------------------------------------------------------------ probes

@when('I GET "{path}" on the control plane')
def step_get(context, path):
    context.status, context.body = lab.request(f"{lab.WORKER}{path}")


@when("I POST an action with no code")
def step_action_no_code(context):
    context.status, context.body = lab.action({"action": "cold-start", "provider": "docker"})


@then("the response status is {code:d}")
def step_status_is(context, code):
    assert context.status == code, f"got {context.status}: {context.body[:200]}"


@then("the response status is not {code:d}")
def step_status_is_not(context, code):
    assert context.status != code, f"got {context.status}: {context.body[:200]}"


@then('the response contains "{needle}"')
def step_body_contains(context, needle):
    assert needle in context.body, f"body did not contain {needle!r}: {context.body[:300]}"


# --------------------------------------------------------------- telegram

@when('a Telegram message "{text}" arrives')
def step_telegram(context, text):
    if "{code}" in text:
        context.status, context.body = lab.with_fresh_code(
            lambda code: lab.telegram(text.replace("{code}", code)))
        return
    context.status, context.body = lab.telegram(text)


@when('a forged Telegram message "{text}" arrives')
def step_telegram_forged(context, text):
    context.status, context.body = lab.request(
        f"{lab.WORKER}/telegram", "POST",
        {"message": {"chat": {"id": 1}, "text": text}},
        {"x-telegram-bot-api-secret-token": "not-the-secret"},
    )


@then("the bot replies within {seconds:d} seconds")
def step_bot_replies(context, seconds):
    assert lab.wait_for(lambda: len(outbox()) > 0, seconds, every=1.0), \
        "the bot sent nothing back to Telegram"
    context.replies = outbox()


@then('no reply mentions "{needle}"')
def step_no_reply_mentions(context, needle):
    hits = [m for m in outbox() if needle.lower() in (m.get("text") or "").lower()]
    assert not hits, f"a reply mentioned {needle!r}: {hits[0].get('text')[:200]}"


# ------------------------------------------------------------------ boxes

@given("no boxes are running")
def step_no_boxes(context):
    lab.kill_boxes()
    lab.kill_backups()
    assert lab.wait_for(
        lambda: not any(lab.origin_healthy(r, timeout=2) for r in ("primary", "standby")),
        60, every=1.0,
    ), "a box is still answering after being destroyed"


@given('a "{role}" box is registered and healthy')
def step_box_up(context, role):
    # Registered is not healthy. A killed container leaves its row in the
    # control plane's table, so probe the box itself before believing it.
    if lab.boxes().get(role) and lab.origin_healthy(role):
        return
    lab.kill_boxes(role)
    status, text = lab.with_fresh_code(lambda code: lab.action(
        {"action": "cold-start", "provider": "docker", "role": role, "code": code}))
    assert status == 200, f"cold-start refused ({status}): {text[:300]}"
    assert lab.wait_for(lambda: bool(lab.boxes().get(role)) and lab.origin_healthy(role), 300), \
        f"the {role} never came up and reported in"


@when('the "{role}" box is destroyed')
def step_kill_box(context, role):
    lab.kill_boxes(role)


@when("every box is destroyed")
def step_kill_all(context):
    lab.kill_boxes()
    lab.kill_backups()


@then('the apex serves the "{role}" within {seconds:d} seconds')
def step_apex_serves(context, role, seconds):
    assert lab.wait_for(lambda: lab.whoami(lab.EDGE) == role, seconds), \
        f"the apex served {lab.whoami(lab.EDGE)!r}, expected {role!r}"


@then('the control plane serves the "{role}" within {seconds:d} seconds')
def step_control_serves(context, role, seconds):
    assert lab.wait_for(lambda: lab.whoami(lab.WORKER) == role, seconds), \
        f"the control plane served {lab.whoami(lab.WORKER)!r}, expected {role!r}"


@when("I promote the standby")
def step_promote(context):
    status, text = lab.with_fresh_code(
        lambda code: lab.action({"action": "promote", "code": code}))
    assert status == 200, f"promote refused ({status}): {text[:300]}"


# ------------------------------------------------------------- cold start

@given('an order "{order_id}" is written to the primary')
def step_write_order(context, order_id):
    status, text = lab.request(f"{lab.ORIGIN_P1}/api/orders", "POST", {"id": order_id})
    assert status in (200, 201), f"the primary refused the order ({status}): {text[:200]}"


@given("the write has reached object storage")
def step_wait_replication(context):
    time.sleep(15)  # litestream's replication interval, not a guess about timing


@when("I cold start from Telegram")
def step_cold_start_telegram(context):
    status, text = lab.with_fresh_code(
        lambda code: lab.telegram(f"/cold-start docker {code}"))
    assert status == 200, f"the webhook refused ({status}): {text[:200]}"


@then("a primary box is healthy within {seconds:d} seconds")
def step_primary_healthy(context, seconds):
    assert lab.wait_for(lambda: lab.request(f"{lab.ORIGIN_P1}/health", timeout=5)[0] == 200, seconds), \
        "the cold start never produced a healthy primary"


@then("the restored box carries at least {n:d} order")
@then("the restored box carries at least {n:d} orders")
def step_orders_restored(context, n):
    _, data = lab.get_json(f"{lab.ORIGIN_P1}/health")
    got = int(data.get("orders", 0) or 0)
    assert got >= n, f"the restored box has {got} order(s), expected at least {n} — the restore lost data"


# ---------------------------------------------------------------- degraded

@then("the degraded page shows the catalogue within {seconds:d} seconds")
def step_degraded_page(context, seconds):
    def ok():
        _, text = lab.request(f"{lab.WORKER}/", timeout=20)
        return "Starter Pack" in text
    assert lab.wait_for(ok, seconds, every=3.0), "the degraded page did not render the catalogue"


@then("an order is accepted by the control plane")
def step_degraded_order(context):
    status, text = lab.request(f"{lab.WORKER}/order", "POST",
                               {"sku": "pack-basic", "email": "a@b.test"}, timeout=25)
    assert '"ok":true' in text.replace(" ", ""), f"the order was refused ({status}): {text[:300]}"


@then("the audit log mentions degraded mode")
def step_audit(context):
    _, text = lab.request(f"{lab.WORKER}/api/audit?limit=50", timeout=20)
    assert "degraded" in text, "nothing about degraded mode in the audit log"


# -------------------------------------------------------------------- exit

@when("I bundle the repository to local disk")
def step_bundle(context):
    context.outdir = Path(tempfile.mkdtemp(prefix="crew-exit-"))
    context.bundle = context.outdir / "survival-stack.bundle"
    p = subprocess.run(["git", "bundle", "create", str(context.bundle), "--all"],
                       cwd=context.root, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-500:]


@then("the bundle verifies")
def step_bundle_verifies(context):
    p = subprocess.run(["git", "bundle", "verify", str(context.bundle)],
                       cwd=context.root, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-500:]


@then("the bundle contains the control plane source")
def step_bundle_has_src(context):
    clone = context.outdir / "clone"
    p = subprocess.run(["git", "clone", "-q", str(context.bundle), str(clone)],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-500:]
    assert (clone / "src" / "index.js").exists(), "the bundle has no src/index.js"
    shutil.rmtree(context.outdir, ignore_errors=True)


@when("I mirror the lab object store to local disk")
def step_mirror(context):
    out = Path(tempfile.mkdtemp(prefix="crew-mirror-"))
    p = subprocess.run([
        "docker", "run", "--rm", "--network", "lab_default",
        "-v", f"{out}:/out", "--entrypoint", "sh", "minio/mc:latest", "-c",
        "mc alias set lab http://minio:9000 admin password123 >/dev/null && "
        "mc mirror --overwrite lab/prospector /out",
    ], capture_output=True, text=True, timeout=300)
    context.mirror = p
    context.mirror_dir = out


@then("the mirror exits cleanly")
def step_mirror_ok(context):
    p = context.mirror
    assert p.returncode == 0, f"mirror failed:\n{(p.stderr or p.stdout)[-600:]}"
    shutil.rmtree(context.mirror_dir, ignore_errors=True)


@when("the exit drill runs with no object-store client")
def step_drill_no_rclone(context):
    out = Path(tempfile.mkdtemp(prefix="crew-drill-"))
    empty_path = out / "emptybin"
    empty_path.mkdir()
    p = subprocess.run(["bash", "scripts/exit-drill.sh", str(out / "target")],
                       cwd=context.root, capture_output=True, text=True,
                       env={"PATH": f"{empty_path}:/usr/bin:/bin", "HOME": str(out)}, timeout=300)
    context.drill = p
    shutil.rmtree(out, ignore_errors=True)


@then("it exits non-zero")
def step_drill_failed(context):
    assert context.drill.returncode != 0, "the drill reported success with no way to copy the data"


@then('it never prints "{needle}"')
def step_drill_no_green(context, needle):
    combined = context.drill.stdout + context.drill.stderr
    assert needle not in combined, f"the drill printed {needle!r} without copying anything"
