# Build: Survival Stack — the crew's first tracked build

Issue: https://github.com/chidionyema/survival-stack/issues/1
Written by pm-agent on 2026-08-22 from conversation with @chidionyema.

## What the founder asked for

I need to not lose sleep. The app is on Fly and I want failover to another
provider. I want to cold start from my phone, on a park bench, with no laptop.
I do not want bash scripts in the recovery path. The engine is Rust, Python and
Next.js, so the stack has to be agnostic — treat the engine as a container.
TOTP on every action that spends money or moves traffic. About £15 a month.

The control plane is a single Cloudflare Worker. There is no machine in the
recovery path that can die and take the recovery tooling with it.

Every checkpoint below is proved by a `behave` scenario against the dry-run lab:
the real Worker, fake infrastructure. Nothing is ticked by an agent's opinion.

## Checkpoints

### CP1: The control plane answers, and refuses everything it should

Verified by `@cp1` in `features/`.

### CP2: The standby takes over without me

Verified by `@cp2` in `features/`.

### CP3: Cold start from a park bench, with the data

Verified by `@cp3` in `features/`.

### CP4: Every box is ash and the shop still sells

Verified by `@cp4` in `features/`.

### CP5: The exit is a command, not a hope

Verified by `@cp5` in `features/`.

