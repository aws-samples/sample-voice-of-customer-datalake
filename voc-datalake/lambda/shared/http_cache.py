"""HTTP revalidation for every API GET (docs/caching.md).

Applied to the proxy response ``create_api_resolver``'s resolver builds, after the
body is serialized (so the tag is the hash of the exact bytes sent):

* a GET answering 200 with a JSON body gets ``ETag: W/"<32 hex of its SHA-256>"``,
  ``Cache-Control: private, no-cache`` and ``Vary: Authorization``. The browser may
  keep it but must revalidate on every use; when the request's ``If-None-Match``
  names the same tag the answer becomes ``304 Not Modified`` with an empty body (the
  data is not sent twice). Never ``max-age``: a browser cache is keyed by URL, not by
  user, and freshness belongs to the server's versions;
* a GET of per-user live state (``NO_STORE_PATTERNS``: chat conversations, agent
  runs, plans, jobs and their polls, the brief, scan / run status, memory import
  polls, tokens, the system log search and its polls) and any
  GET that is not a 200 JSON answer get ``Cache-Control: private, no-store`` and no
  tag: nothing to keep, nothing to revalidate.

Other methods are left untouched. REST proxy answers only (``multiValueHeaders``), which
is what ``APIGatewayRestResolver`` builds.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, MutableMapping
from typing import Any, Final

ETAG_HEX_LENGTH: Final = 32
REVALIDATE: Final = 'private, no-cache'
NO_STORE: Final = 'private, no-store'
VARY: Final = 'Authorization'
NOT_MODIFIED: Final = 304

# Request paths (no stage prefix in a REST proxy event) whose GET answers are live,
# per-user state: never stored, never tagged.
NO_STORE_PATTERNS: Final = tuple(re.compile(pattern) for pattern in (
    r'^/chat(/|$)',
    r'^/agents/[^/]+/runs(/|$)',
    r'^/agents/plans(/|$)',
    r'(^|/)jobs(/|$)',
    r'^/settings/my-briefing(/|$)',
    r'^/settings/categories/reprocess$',
    r'^/settings/erasure$',
    r'^/scrapers/manual/parse(/|$)',
    r'^/scrapers/[^/]+/status$',
    r'^/(sources|integrations)/status$',
    r'^/connect/tokens(/|$)',
    # MCP OAuth: consent, "my sign-ins", the facade and its discovery documents (docs/mcp.md).
    r'^/connect/oauth(/|$)',
    r'^/oauth/',
    r'^/\.well-known/',
    r'^/memory/imports(/|$)',
    r'^/voting-sessions(/[^/]+)?$',
    r'^/logs/system(/|$)',
    # The caller's way of working with AI: an admin's change must show at the next read.
    r'^/users/me/ai-mode$',
    # Document comment threads and review links: a teammate's or reviewer's comment must show at once.
    r'^/projects/[^/]+/documents/[^/]+/(comments|share)$',
    r'^/review/[^/]+$',
))


def is_no_store_path(path: str) -> bool:
    return any(pattern.search(path) for pattern in NO_STORE_PATTERNS)


def etag_for(body: str) -> str:
    """The weak tag of a serialized body: ``W/"<first 32 hex of its SHA-256>"``."""
    return f'W/"{hashlib.sha256(body.encode()).hexdigest()[:ETAG_HEX_LENGTH]}"'


def _opaque(tag: str) -> str:
    """The tag without its weak prefix (If-None-Match uses the weak comparison)."""
    tag = tag.strip()
    return tag[2:] if tag[:2] in ('W/', 'w/') else tag


def matches_if_none_match(header: str | None, etag: str) -> bool:
    """Whether ``If-None-Match`` names ``etag`` (any listed tag, or ``*``)."""
    if not header:
        return False
    wanted = _opaque(etag)
    return any(candidate == '*' or _opaque(candidate) == wanted
               for candidate in (part.strip() for part in header.split(',')) if candidate)


def request_header(event: Mapping[str, Any], name: str) -> str | None:
    """A request header, case-insensitively (single-value headers first, then multi-value)."""
    lowered = name.lower()
    headers = event.get('headers')
    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if str(key).lower() == lowered and isinstance(value, str):
                return value
    multi = event.get('multiValueHeaders')
    if isinstance(multi, Mapping):
        for key, values in multi.items():
            if str(key).lower() == lowered and isinstance(values, list) and values:
                return ','.join(str(value) for value in values)
    return None


def _response_headers(response: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    """The response's header map: REST answers use ``multiValueHeaders`` (lists)."""
    multi = response.get('multiValueHeaders')
    if isinstance(multi, MutableMapping):
        return multi
    response['multiValueHeaders'] = {}
    return response['multiValueHeaders']


def _set(headers: MutableMapping[str, Any], name: str, value: str) -> None:
    for key in [key for key in headers if str(key).lower() == name.lower()]:
        del headers[key]
    headers[name] = [value]


def _is_json(headers: Mapping[str, Any]) -> bool:
    for key, value in headers.items():
        if str(key).lower() == 'content-type':
            values = value if isinstance(value, list) else [value]
            return any(str(item).startswith('application/json') for item in values)
    return False


def _revalidatable(response: Mapping[str, Any], headers: Mapping[str, Any]) -> bool:
    return (response.get('statusCode') == 200 and not response.get('isBase64Encoded')
            and isinstance(response.get('body'), str) and _is_json(headers))


def mark_nosniff(response: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    """`X-Content-Type-Options: nosniff` on every API answer (EDGE-8): a JSON error that echoes
    input is never sniffed as HTML. Every method and status, unlike the caching headers."""
    _set(_response_headers(response), 'X-Content-Type-Options', 'nosniff')
    return response


def apply(event: Mapping[str, Any], response: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    """Add the caching headers to a GET's proxy response (and turn a matching revalidation into 304)."""
    if str(event.get('httpMethod') or '').upper() != 'GET':
        return response
    headers = _response_headers(response)
    path = str(event.get('path') or '')
    if is_no_store_path(path) or not _revalidatable(response, headers):
        _set(headers, 'Cache-Control', NO_STORE)
        return response
    etag = etag_for(response['body'])
    _set(headers, 'ETag', etag)
    _set(headers, 'Cache-Control', REVALIDATE)
    _set(headers, 'Vary', VARY)
    if matches_if_none_match(request_header(event, 'If-None-Match'), etag):
        response['statusCode'] = NOT_MODIFIED
        response['body'] = ''
    return response
