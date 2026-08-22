# Preferences

How this estate wants software to behave. Not laws — those are in `~/AGENTS.md`
and outrank everything here. These are the smaller, repeated judgements, written
down so they stop being re-argued. `CORRECTIONS.md` holds the incidents that
produced them.

## First-time user experience

Founder, 2026-08-22, after a migration created a zone with a credential that
could not write DNS and failed on record 1 of 8: *"This is not nice debugging."*

- **A script that fails after creating partial state is a bug, not a feature.**
- **Every mutation is preceded by a permission probe.** Where the provider has
  no read-only way to answer, the probe is a real call to the endpoint the work
  uses, and anything the probe had to create is removed again on failure.
- **Error messages say "your token needs X", never "403 Forbidden".** The
  provider's message describes its own call. It is the tool's job to say which
  permission is missing and where to add it.
- **One failed run leaves zero side effects.** A user who runs it twice gets the
  same outcome as a user who runs it once.
- **A rollback only undoes what this run did.** Never something that was already
  there.

## Setup

- **Setup is the product's first screen**, not an afterthought (`DECISIONS.md`
  entry 12). A new user is operational in 60 seconds, one command, three clicks.
  Longer than that is a bug.
- **Never assume a vendor's format is static.** Let the API be the validator.
  See `CORRECTIONS.md`.
- **A rejection always carries a reason.** Silence is the worse half of a wrong
  check: a bug that produces no output wears the costume of a working tool.
