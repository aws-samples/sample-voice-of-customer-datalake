"""Reading a request body as a JSON object, the same way in every API handler.

`json_body` alone is two unhandled failures: unparseable JSON raises
`JSONDecodeError`, and a body that parses to a LIST or a string passes an
`or {}` guard truthy and then dies on `.get`. Neither has a registered handler,
so both surface as a bare 500 — a malformed REQUEST reported as a server fault,
counted as an error, with nothing the page can say about it.

The `or {}` idiom is wrong in a THIRD way, and it is the quietest: `or`
collapses every falsy value, so `[]`, `false`, `0` and `""` arrive at any later
isinstance check already disguised as an empty object and are accepted as "no
body". On a route that starts a billed job from the body, that is an unvalidated
entry rather than a 500. Hence `is None`, not `or`: only a genuinely absent body
(no body, or a literal JSON `null`) defaults.

A zero-length body (`Content-Length: 0`) also defaults, though by a route outside
this helper: powertools' `json_body` returns None for a falsy `decoded_body`
without parsing it, so `''` reaches the `is None` branch rather than the refusal.
Same answer as an absent body, which is the intended one.

Lives in `shared/` because the API handlers are packaged as separate Lambda
bundles that cannot import each other; `shared/` ships with every one of them.
"""

from __future__ import annotations

from typing import Any, Protocol

from shared.exceptions import ValidationError


class _JsonBodyEvent(Protocol):
    @property
    def json_body(self) -> Any: ...


class CurrentEventSource(Protocol):
    """What the helper reads: a Powertools resolver satisfies it, and so does any
    test double exposing a ``current_event`` with a ``json_body``."""

    @property
    def current_event(self) -> _JsonBodyEvent: ...


def json_body_value(app: CurrentEventSource) -> object:
    """The current request's body as whatever JSON value it parses to (None when
    absent), or a ValidationError when it does not parse at all.

    The parse half of `json_object_body`, for a route whose own code already
    refuses a non-object body with a message (and an absent-body answer) of its
    own that callers rely on: it keeps that check and its wording, and only the
    unparseable case — the one that used to escape as a 500 — is answered here.
    Every other route wants `json_object_body`.
    """
    try:
        return app.current_event.json_body
    except ValueError as e:
        # json.JSONDecodeError is a ValueError; a body that is not JSON at all is
        # the caller's mistake, not this service's.
        raise ValidationError('the request body must be JSON') from e


def json_object_body(app: CurrentEventSource) -> dict:
    """The current request's body as a JSON object, or a ValidationError.

    ``app`` is the handler's Powertools resolver; its ``current_event`` is read
    at call time so the helper can sit at module scope in a shared package.
    """
    body = json_body_value(app)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValidationError('the request body must be a JSON object')
    return body
