#!/usr/bin/env python3
"""Write the KV namespace id into wrangler.jsonc so nobody has to hand-edit it."""
import re, sys, pathlib
kv_id = sys.argv[1]
if not re.fullmatch(r'[0-9a-f]{32}', kv_id):
    sys.exit(f"not a KV id: {kv_id!r}")
p = pathlib.Path('wrangler.jsonc')
text = p.read_text()
new = re.sub(r'("binding":\s*"STATE",\s*"id":\s*")[^"]*"', lambda m: m.group(1) + kv_id + '"', text)
if new == text:
    sys.exit("wrangler.jsonc has no STATE binding to fill in")
p.write_text(new)
