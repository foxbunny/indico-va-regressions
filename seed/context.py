"""Per-run state passed through every seed scenario."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / 'output'
MANIFEST_PATH = OUTPUT_DIR / 'manifest.json'


class SeedContext:
    def __init__(self, app):
        self.app = app
        self.manifest = {}
        self._refs = {}

    def remember(self, key, value):
        self.manifest[key] = value

    def stash(self, key, obj):
        self._refs[key] = obj

    def get(self, key):
        if key in self._refs:
            return self._refs[key]
        return self.manifest[key]

    def write_manifest(self):
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        MANIFEST_PATH.write_text(json.dumps(self.manifest, indent=2, sort_keys=True))
