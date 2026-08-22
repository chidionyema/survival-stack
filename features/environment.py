import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def before_all(context):
    context.root = Path(__file__).resolve().parents[1]
    context.status = None
    context.body = ""
