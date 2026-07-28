"""Read the capability token the engine mints at startup.

The engine writes ~/.cynco/tokens.json (owner-only) and refuses any WebSocket
upgrade that does not present a bridge-scoped secret. The TUI is our own client,
so it reads the same file rather than taking a flag — launching the TUI stays a
zero-argument operation.

Every failure path returns None rather than raising. A missing or damaged token
file must surface as a normal connection failure against the engine's 401, not as
a traceback before the app has a screen to show it on.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

TOKEN_FILENAME = "tokens.json"


def bridge_token(base_dir: Optional[Path] = None) -> Optional[str]:
    """Return the secret carrying the 'bridge' scope, or None if unavailable."""
    base = Path(base_dir) if base_dir is not None else Path.home() / ".cynco"
    try:
        raw = (base / TOKEN_FILENAME).read_text(encoding="utf-8")
        entries = json.loads(raw)["tokens"]
    except (OSError, ValueError, KeyError, TypeError):
        return None

    if not isinstance(entries, list):
        return None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        scopes = entry.get("scopes")
        secret = entry.get("secret")
        if isinstance(scopes, list) and "bridge" in scopes and isinstance(secret, str):
            return secret
    return None
