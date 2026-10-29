"""The full SHA-256 hex digest of a text, decided once.

Used wherever the platform stores a hash instead of a value: erasure jobs (the erased value), participant rows
(``EMAIL#<hash>``, emailed tokens), briefing endpoints and MCP token secrets. ``lambda/shared`` ships in every
Python bundle, so every module can import it.
"""
from __future__ import annotations

import hashlib


def sha256_hex(text: str) -> str:
    """The 64-character lowercase hex SHA-256 of ``text`` encoded as UTF-8."""
    return hashlib.sha256(text.encode('utf-8')).hexdigest()
