#!/usr/bin/env bash
# Checkpoint 1. One line, because the scenarios in features/ are the
# verification and there is only ever one of them. The runner comes from
# .crew.json so changing it is one edit, not six.
set -euo pipefail
cd "$(dirname "$0")/.."
exec $(python3 -c 'import json;print(json.load(open(".crew.json"))["bdd_command"].format(tag="cp1"))')
