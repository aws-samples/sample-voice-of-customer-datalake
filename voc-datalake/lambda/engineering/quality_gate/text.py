"""Text that crosses a trust boundary: secrets scrubbed, repository text fenced as data, cells made safe.

Everything the gate shows a model (a diff, a check's output, the review guide, earlier findings) is repository
text, and repository text is data, never instructions: it goes inside a DATA block whose fence carries a random
nonce, so nothing in the text can close the block early. Anything that looks like a credential is replaced
before it reaches a model, the gate record or a pull request.

Not shared.prompt_safety's data_block: that one rewrites the platform's own tags inside the body, and a diff
must reach the reviewer byte for byte (code may hold any tag), or the quotes its findings are grounded on would
no longer match the diff.
"""
from __future__ import annotations

import re
import secrets

REDACTED = '<redacted>'
_SECRET_PATTERNS = (
    re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),                       # cloud access key ids
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),                       # GitHub tokens
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{40,}\b'),
    re.compile(r'\bglpat-[A-Za-z0-9_-]{20,}\b'),                          # GitLab tokens
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'),
    # A quoted value under a secret-like name, in code, JSON or YAML: api_key = "…", "DB_PASSWORD": "…".
    re.compile(r'(?i)["\']?[\w.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[\w.-]*["\']?\s*[:=]\s*'
               r'["\'][^"\'\s]{8,}["\']'),
    # A config line with a bare value: DB_PASSWORD=…, export API_KEY=…, password: … in YAML, an INI key (a diff's
    # +/- marker kept in front). A value with a dot, a bracket or a comma is code (form.password), not a secret.
    re.compile(r'(?im)^(?P<lead>[ \t+-]*)(?:export[ \t]+)?[\w.-]*(?:secret|token|password|passwd|api[_-]?key|'
               r'access[_-]?key)[\w.-]*[ \t]*[:=][ \t]*[^\s"\'.,;()\[\]{}]{8,}[ \t]*$'),
    re.compile(r'(?i)\bbearer[ \t]+[A-Za-z0-9._~+/-]{20,}=*'),                 # an Authorization header's token
)


def _replacement(match: re.Match[str]) -> str:
    return (match.groupdict().get('lead') or '') + REDACTED


def redact(text: str) -> str:
    """``text`` with every credential-shaped string replaced by ``<redacted>``."""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(_replacement, text)
    return text


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else f'{text[:limit]}\n[… {len(text) - limit} characters cut]'


def nonce() -> str:
    return secrets.token_hex(8)


def data_block(name: str, text: str, fence: str) -> str:
    """``text`` (redacted) inside a DATA block that only the holder of ``fence`` can close."""
    body = redact(text).replace(fence, REDACTED)
    return f'<<<DATA {name} {fence}>>>\n{body}\n<<<END DATA {name} {fence}>>>'


def cell(text: str, limit: int = 300) -> str:
    """Model- or repository-written text for a pull request: one redacted line in a code span, or ''.

    A code span renders literally: no link, image, HTML, @-mention or issue reference survives in it, so a planted
    instruction cannot make the description fetch, link or notify anything. Pipes are escaped for tables.
    """
    flat = ' '.join(redact(text).split()).replace('`', "'")
    if not flat:
        return ''
    flat = flat if len(flat) <= limit else f'{flat[:limit - 1]}…'
    return '`' + flat.replace('|', '\\|') + '`'
