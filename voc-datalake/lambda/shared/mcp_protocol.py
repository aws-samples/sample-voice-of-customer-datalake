"""MCP protocol eras for the global endpoint (``api/mcp_global_handler.py``): docs/mcp.md.

The server is DUAL-ERA (spec 2026-07-28, "Versioning: Backward Compatibility"):

* **Legacy** (2025-11-25 and earlier): an ``initialize`` handshake, then requests
  that carry the negotiated version only in the ``MCP-Protocol-Version`` header.
  Kiro, Claude Code and Copilot speak this today; their answers are unchanged.
* **Modern** (2026-07-28): no handshake. Every request carries its version and
  client capabilities in ``params._meta`` and mirrors the version, the method and
  (for ``tools/call``) the tool name into ``MCP-Protocol-Version`` / ``Mcp-Method``
  / ``Mcp-Name``. The body is the source of truth; a header that is missing or
  disagrees with it is a ``HeaderMismatch`` (-32020, HTTP 400), so an
  intermediary routing on the header can never be told one thing while the
  server executes another. Results carry ``resultType`` and the server's
  identity in ``_meta``; cacheable ones (``server/discover``, ``tools/list``) carry
  ``ttlMs`` / ``cacheScope``.

An unknown version in either place is an ``UnsupportedProtocolVersionError``
(-32022, HTTP 400) listing every version this server speaks, which is also how a
dual-era client recognises a modern server and retries instead of falling back.

Pure functions only: no AWS, no I/O, so the handler stays the one place that
decides what a request may do.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable, Mapping
from typing import Any, Final

MODERN_PROTOCOL_VERSIONS: Final[tuple[str, ...]] = ('2026-07-28',)
# Newest first: a legacy `initialize` answers the client's version when supported, else the first.
LEGACY_PROTOCOL_VERSIONS: Final[tuple[str, ...]] = ('2025-11-25', '2025-06-18', '2024-11-05')
SUPPORTED_PROTOCOL_VERSIONS: Final[tuple[str, ...]] = (*MODERN_PROTOCOL_VERSIONS, *LEGACY_PROTOCOL_VERSIONS)

META_PROTOCOL_VERSION: Final = 'io.modelcontextprotocol/protocolVersion'
META_SERVER_INFO: Final = 'io.modelcontextprotocol/serverInfo'

# Protocol-defined error codes (the -32020..-32099 range the spec reserves).
HEADER_MISMATCH: Final = -32020
UNSUPPORTED_PROTOCOL_VERSION: Final = -32022

RESULT_COMPLETE: Final = 'complete'
DISCOVER_METHOD: Final = 'server/discover'
TOOLS_LIST_METHOD: Final = 'tools/list'
TOOLS_CALL_METHOD: Final = 'tools/call'
# What `tools/list` shows depends on the token (read vs write scope, admin backing),
# so it may only be cached per credential. The catalogue changes only on a deploy;
# five minutes keeps a client from re-listing on every turn.
TOOLS_LIST_TTL_MS: Final = 300_000
# Versions, capabilities and instructions are the same for every caller and change
# only on a deploy.
DISCOVER_TTL_MS: Final = 3_600_000

_BASE64_PREFIX: Final = '=?base64?'
_BASE64_SUFFIX: Final = '?='
_MAX_ECHOED_CHARS: Final = 64

HeaderReader = Callable[[str], str | None]


class ProtocolRefusal(Exception):
    """The request cannot be served under any protocol era; always HTTP 400."""

    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _echo(value: str) -> str:
    """A client-supplied value, bounded for an error message."""
    return value[:_MAX_ECHOED_CHARS]


def unsupported_version(requested: str) -> ProtocolRefusal:
    return ProtocolRefusal(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version',
                           data={'supported': list(SUPPORTED_PROTOCOL_VERSIONS), 'requested': _echo(requested)})


def _mismatch(message: str) -> ProtocolRefusal:
    return ProtocolRefusal(HEADER_MISMATCH, f'Header mismatch: {message}')


def body_version(params: Mapping[str, Any]) -> str | None:
    """``params._meta['io.modelcontextprotocol/protocolVersion']`` when it is a string."""
    meta = params.get('_meta')
    version = meta.get(META_PROTOCOL_VERSION) if isinstance(meta, Mapping) else None
    return version if isinstance(version, str) else None


def decoded_header_value(raw: str) -> str:
    """A header value with the spec's ``=?base64?…?=`` sentinel decoded (UTF-8).

    Raises ProtocolRefusal (HeaderMismatch) for a sentinel that is not valid
    base64 or UTF-8 — the spec requires rejecting invalid encodings.
    """
    if not (raw.startswith(_BASE64_PREFIX) and raw.endswith(_BASE64_SUFFIX)
            and len(raw) >= len(_BASE64_PREFIX) + len(_BASE64_SUFFIX)):
        return raw
    encoded = raw[len(_BASE64_PREFIX):len(raw) - len(_BASE64_SUFFIX)]
    try:
        return base64.b64decode(encoded, validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise _mismatch('a base64-encoded header is not valid base64 UTF-8') from exc


def _refuse_unservable_header(header_version: str | None) -> bool:
    """False (legacy) for a request with no body version, unless its header names a
    version it cannot be served under — then raises ProtocolRefusal."""
    if header_version is None or header_version in LEGACY_PROTOCOL_VERSIONS:
        return False
    if header_version in MODERN_PROTOCOL_VERSIONS:
        raise _mismatch(f'MCP-Protocol-Version {_echo(header_version)} needs a matching '
                        f'params._meta["{META_PROTOCOL_VERSION}"]')
    raise unsupported_version(header_version)


def _check_routing_headers(header: HeaderReader, method: str, params: Mapping[str, Any]) -> None:
    """``Mcp-Method`` always, and ``Mcp-Name`` for ``tools/call``, must equal the body."""
    mcp_method = header('mcp-method')
    if mcp_method is None:
        raise _mismatch('the Mcp-Method header is required')
    if mcp_method != method:
        raise _mismatch(f"Mcp-Method header value '{_echo(mcp_method)}' does not match body value '{_echo(method)}'")
    if method != TOOLS_CALL_METHOD:
        return
    raw_name = header('mcp-name')
    if raw_name is None:
        raise _mismatch('the Mcp-Name header is required for tools/call')
    name, body_name = decoded_header_value(raw_name), params.get('name')
    if name != body_name:
        shown = body_name if isinstance(body_name, str) else ''
        raise _mismatch(f"Mcp-Name header value '{_echo(name)}' does not match body value '{_echo(shown)}'")


def is_modern(header: HeaderReader, method: str, params: Mapping[str, Any]) -> bool:
    """True to serve this request under 2026-07-28 semantics, False for legacy;
    raises ProtocolRefusal (HTTP 400) when it can be served under neither.

    ``header`` reads a request header case-insensitively by its lowercase name.
    A legacy ``initialize`` is never refused for its version header: the handshake
    is where a legacy client learns what this server speaks.
    """
    declared = body_version(params)
    header_version = header('mcp-protocol-version')
    if declared is None:
        return False if method == 'initialize' else _refuse_unservable_header(header_version)
    if declared not in SUPPORTED_PROTOCOL_VERSIONS:
        raise unsupported_version(declared)
    if header_version is None:
        raise _mismatch('the MCP-Protocol-Version header is required')
    if header_version != declared:
        raise _mismatch(f"MCP-Protocol-Version header value '{_echo(header_version)}' "
                        f"does not match body value '{_echo(declared)}'")
    if declared in LEGACY_PROTOCOL_VERSIONS:
        return False
    _check_routing_headers(header, method, params)
    return True


def server_info(name: str, version: str) -> dict[str, str]:
    return {'name': name, 'version': version}


def discover_result(*, name: str, version: str, capabilities: Mapping[str, Any], instructions: str) -> dict:
    """The ``server/discover`` result (``DiscoverResult``, a cacheable result)."""
    return {
        'resultType': RESULT_COMPLETE,
        'supportedVersions': list(SUPPORTED_PROTOCOL_VERSIONS),
        'capabilities': dict(capabilities),
        'instructions': instructions,
        '_meta': {META_SERVER_INFO: server_info(name, version)},
        'ttlMs': DISCOVER_TTL_MS,
        'cacheScope': 'public',
    }


def modern_result(result: Mapping[str, Any], method: str, *, name: str, version: str) -> dict:
    """``result`` as a 2026-07-28 ``Result``: ``resultType``, the server's identity,
    and for ``tools/list`` the per-credential cache hints. Existing keys win."""
    out: dict[str, Any] = {'resultType': RESULT_COMPLETE, **result}
    existing = out.get('_meta')
    meta: Mapping[str, Any] = existing if isinstance(existing, Mapping) else {}
    out['_meta'] = {META_SERVER_INFO: server_info(name, version), **meta}
    if method == TOOLS_LIST_METHOD:
        out.setdefault('ttlMs', TOOLS_LIST_TTL_MS)
        out.setdefault('cacheScope', 'private')
    return out
