"""CORS for a request from an OPAQUE origin (``Origin: null``) on one route.

A prototype opened on its own is sandboxed to an opaque origin by its CSP
(lib/utils/prototype-csp.ts), so the pin widget's direct POST to its form's
public ``/feedback-forms/{form_id}/submit`` route arrives with ``Origin: null``.

The route's handler calls :func:`accept` once it knows the form is a
``prototype_pin`` form; :func:`apply` then answers THAT response with
``Access-Control-Allow-Origin: null`` and ``Vary: Origin`` — only when the
request's Origin is exactly ``null``, never ``*`` alongside credentials and never
``Access-Control-Allow-Credentials``. Any other request, form or route keeps the
response exactly as the resolver built it. :func:`reset` runs around every
invocation, so a warm container never carries the decision into the next one.
"""
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any

NULL_ORIGIN = 'null'

_ACCEPTED: ContextVar[bool] = ContextVar(
    'null_origin_cors_accepted',  # pragma: no mutate  the name only labels the variable in its repr
    default=False,
)


def reset() -> None:
    """Forget any earlier invocation's decision."""
    _ACCEPTED.set(False)


def accept() -> None:
    """This request's route answers an ``Origin: null`` caller (a prototype pin form)."""
    _ACCEPTED.set(True)


def request_origin(event: Mapping[str, Any]) -> str | None:
    """The request's Origin header (case-insensitive, either API Gateway header shape)."""
    for name, value in (event.get('headers') or {}).items():
        if isinstance(name, str) and name.lower() == 'origin' and isinstance(value, str):
            return value
    for name, values in (event.get('multiValueHeaders') or {}).items():
        if isinstance(name, str) and name.lower() == 'origin' and isinstance(values, list) and values:
            first = values[0]
            return first if isinstance(first, str) else None
    return None


def _without(headers: dict, names: set[str]) -> dict:
    return {k: v for k, v in headers.items() if not (isinstance(k, str) and k.lower() in names)}


def _vary_with_origin(existing: list[str]) -> str:
    tokens = [t.strip() for value in existing for t in value.split(',') if t.strip()]
    if not any(t.lower() == 'origin' for t in tokens):
        tokens.append('Origin')
    return ', '.join(tokens)


_REPLACED = {'access-control-allow-origin', 'access-control-allow-credentials', 'vary'}


def apply(event: Mapping[str, Any], response: dict) -> dict:
    """``response`` answering ``Origin: null`` when this request was accepted, else unchanged."""
    if not _ACCEPTED.get() or request_origin(event) != NULL_ORIGIN:
        return response
    single = response.get('headers') or {}
    multi = response.get('multiValueHeaders') or {}
    vary = [v for k, v in single.items() if isinstance(k, str) and k.lower() == 'vary' and isinstance(v, str)]
    vary += [v for k, vs in multi.items() if isinstance(k, str) and k.lower() == 'vary'
             for v in (vs if isinstance(vs, list) else []) if isinstance(v, str)]
    answered = dict(response)
    answered['headers'] = {
        **_without(single, _REPLACED),
        'Access-Control-Allow-Origin': NULL_ORIGIN,
        'Vary': _vary_with_origin(vary),
    }
    if 'multiValueHeaders' in response:
        answered['multiValueHeaders'] = _without(multi, _REPLACED)
    return answered
