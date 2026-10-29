"""One address, one design reference: the URL comparison behind the 409 on a duplicate.

Adding a link reference (website, GitHub, Figma) whose address is already among the non-archived
references would start a second billed browser session or repository read and a second model call
for the same thing. Two addresses are the same reference when they differ only in what does not
change the page: the scheme's and host's case, a trailing dot on the host, the default port, a
trailing slash, the fragment, or userinfo. The query is kept (``?page=2`` is another page), and the
path's case is kept (paths are case-sensitive).

The SPA mirrors this in ``frontend/src/pages/Company/referenceUrl.ts`` to say so while typing; the
409 here is the gate.
"""
from __future__ import annotations

from typing import Final
from urllib.parse import urlsplit, urlunsplit

DEFAULT_PORTS: Final = {'https': 443, 'http': 80}


def normalised_reference_url(url: str) -> str:
    """The comparison form of *url*; the stripped input itself when it cannot be parsed."""
    text = url.strip()
    try:
        parts = urlsplit(text)
        host = (parts.hostname or '').rstrip('.')
        port = parts.port
    except ValueError:
        return text
    scheme = parts.scheme.lower()
    shown_host = f'[{host}]' if ':' in host else host
    netloc = shown_host if port in (None, DEFAULT_PORTS.get(scheme)) else f'{shown_host}:{port}'
    return urlunsplit((scheme, netloc, parts.path.rstrip('/'), parts.query, ''))


def duplicate_reference(references: list[dict], url: str) -> dict | None:
    """The first of *references* (already without archived ones) whose ``url`` is the same address."""
    wanted = normalised_reference_url(url)
    for reference in references:
        existing = reference.get('url')
        if isinstance(existing, str) and normalised_reference_url(existing) == wanted:
            return reference
    return None


def duplicate_message(reference: dict) -> str:
    """The 409's reason, naming the existing reference."""
    name = str(reference.get('title') or reference.get('url') or reference.get('id') or '')
    return f'This address is already a design reference: "{name}". Use Fetch again on it instead of adding it twice'
