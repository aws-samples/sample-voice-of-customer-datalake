"""Delegation from the MCP adapter to the domain API Lambdas.

The MCP Lambda does not read the data lake. It validates a credential, resolves
a scope, and then calls the domain function that already owns the route — so
every route's validation bounds, its error mapping, and its least-privilege role
are reused rather than restated. When a route gains a validated field, MCP gets
it for free.

Why this is not "an extra hop for nothing": a single Lambda holding the union of
every domain's permissions inverts the domain-isolation pattern this repo
mandates (see the 20 KB role-policy ceiling in the coding standards) and marches
toward that ceiling with no synth-time warning. It also removes a whole class of
drift — an in-process tool is a SECOND implementation of a route, and one of
them had already diverged: the old `get_project` tool recognised 2 of the 6
document sort-key prefixes, so an MCP client silently saw a third of a project's
documents and was told nothing was filtered.

There is deliberately no general `invoke_lambda_sync` sibling next to
`shared.aws.invoke_lambda_async`. What this module needs is not "invoke a
Lambda" but "invoke a Lambda PROXY HANDLER and decode a proxy response", which
is a narrower contract than a general helper would advertise. One caller, one
shape, stated here.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from botocore import exceptions as botocore_exceptions

from shared.aws import get_lambda_client
from shared.logging import logger

# The synthetic subject namespace. A service credential's subject can never
# collide with a Cognito `sub` (a UUID) because of this prefix — the same
# key-kind discipline the ballot keys use (`user:` / `anon:`). Without it, a
# token id could in principle be minted to look like somebody's subject, and
# every downstream row keyed by subject would merge the two identities.
SYNTHETIC_SUBJECT_PREFIX: Final = 'mcp:'

# Every claim the synthesized authorizer context carries. Named as a frozenset
# so the claim-synthesis test can assert the set is EXACTLY this — a claim
# nobody considered cannot arrive unremarked.
SYNTHETIC_CLAIM_KEYS: Final[frozenset[str]] = frozenset({'sub', 'cognito:groups', 'email'})


class DelegationUnavailable(Exception):
    """The domain function was never successfully consulted.

    Raised for a transport fault, an unhandled exception inside the domain
    function, or a response this module cannot decode. Callers must answer with
    a server error: the tool call did not fail, it never completed, and telling
    a model "no results" for an infrastructure fault teaches it the wrong thing.
    """


@dataclass(frozen=True)
class DomainCall:
    """One route call, as the static per-tool mapping describes it.

    `path` is the route path WITHOUT the stage prefix, which is what API Gateway
    puts in `event['path']` for a proxy integration and what the Powertools
    resolver routes on. `query` values are stringified on the way out because
    API Gateway only ever delivers strings, and the routes' validators
    (`validate_days`, `validate_limit`, …) are written against that.
    """

    function_name: str
    method: str
    path: str
    path_parameters: dict[str, str] = field(default_factory=dict)
    query: dict[str, Any] = field(default_factory=dict)
    body: dict | None = None


@dataclass(frozen=True)
class DomainResult:
    """A decoded proxy response: the route's own status code and parsed body."""

    status_code: int
    payload: Any

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300


def synthetic_claims(token_info: Mapping[str, Any]) -> dict[str, str]:
    """Build the authorizer claims for a delegated call, from the token record.

    ⚠️ This is the security hinge of the whole adapter: synthesizing claims
    makes the MCP Lambda an authorization authority, so the rule is that claims
    derive ONLY from the stored credential.

    That rule is enforced STRUCTURALLY rather than by careful filtering — this
    function takes the token record and nothing else. It never sees the JSON-RPC
    request, so no field of the request can reach a claim: not an argument named
    `sub`, not a nested `requestContext`, not a `cognito:groups` in the tool
    arguments. A filtering implementation would have to enumerate what to strip
    and would be wrong the first time somebody added a field; this one cannot be
    wrong because the data is not in scope. `test_mcp_security.py` pins it with
    a request that tries.

    `cognito:groups` is ALWAYS empty, and that is a decision rather than a
    placeholder. No token record carries a group — the mint route records
    `created_by` for provenance and nothing else — so there is no group to
    forward, and inventing one would hand a bearer credential the admin surface.
    Empty means `shared.api.get_caller_groups` returns `[]` and `require_admin`
    refuses, so an admin-gated route stays refused even if a future tool is
    mapped onto one by mistake. Fail-closed by construction, not by review.
    """
    token_id = token_info.get('token_id')
    if not isinstance(token_id, str) or not token_id:
        # A row without a token id cannot be attributed to anything. Refusing
        # is the only honest answer: the alternative is a delegated write (in a
        # later phase) landing under a subject nobody can trace.
        raise DelegationUnavailable('token record has no usable token_id')
    return {
        'sub': f'{SYNTHETIC_SUBJECT_PREFIX}{token_id}',
        'cognito:groups': '',
        # Not a mailbox. The routes that read an email use it as a display
        # label, and a service credential has no human address — so it names the
        # credential instead of borrowing its minter's identity, which would
        # attribute the agent's actions to a person who did not perform them.
        'email': f'{SYNTHETIC_SUBJECT_PREFIX}{token_id}',
    }


def build_proxy_event(call: DomainCall, claims: Mapping[str, str]) -> dict:
    """Synthesize the API Gateway v1 proxy event for a delegated route call.

    Mirrors the shape the `api_gateway_event` test fixture builds, which is the
    shape every one of these handlers is already tested against.

    Note what is NOT forwarded: no `Authorization` header (the domain function
    must never see the MCP credential — it has no use for it and forwarding a
    secret past its audience is how secrets leak into logs), and no
    `Accept-Encoding` (Powertools would be entitled to gzip the response body,
    and this module decodes plain JSON).
    """
    query = {
        key: _stringify(value)
        for key, value in (call.query or {}).items()
        if value is not None
    }
    return {
        'httpMethod': call.method,
        'path': call.path,
        # `resource` is the templated form. The Powertools resolver routes on
        # `path`, so this is for fidelity and for anything that logs the route
        # shape rather than the concrete path.
        'resource': call.path,
        'queryStringParameters': query or None,
        'pathParameters': dict(call.path_parameters) if call.path_parameters else None,
        'body': json.dumps(call.body) if call.body is not None else None,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {
            # The claims are placed here and nowhere else, and they are the
            # argument — this function does not build them (see synthetic_claims).
            'authorizer': {'claims': dict(claims)},
            'stage': 'v1',
        },
        'isBase64Encoded': False,
    }


def _stringify(value: Any) -> str:
    """Render a query-parameter value the way API Gateway would deliver it.

    Booleans need naming explicitly: `str(True)` is `'True'`, which no route's
    boolean validator accepts, and several of those validators are STRICT on
    purpose (a coerced `"false"` must not be able to authorize a billed image
    generation). Lowercasing here keeps a bool round-tripping as a bool; every
    other type takes `str`.
    """
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value)


def call_domain(call: DomainCall, *, claims: Mapping[str, str]) -> DomainResult:
    """Invoke the owning domain function and decode its proxy response.

    Raises:
        DelegationUnavailable: transport fault, an unhandled exception inside
            the domain function, or an undecodable response. A 4xx or 5xx that
            the ROUTE itself produced is not an error here — it is returned as a
            `DomainResult` so the caller can map it (a route's 404 is a fact the
            model should hear, not an infrastructure failure).
    """
    if not call.function_name:
        raise DelegationUnavailable(f'no function configured for {call.method} {call.path}')

    event = build_proxy_event(call, claims)
    try:
        response = get_lambda_client().invoke(
            FunctionName=call.function_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(event),
        )
    except (botocore_exceptions.ClientError, botocore_exceptions.BotoCoreError) as exc:
        # Deliberately NOT split into retryable/permanent the way the token
        # lookup is. There the distinction changes the ANSWER (401 vs 500);
        # here every outcome is the same server error, so classifying would be
        # a taxonomy with no consumer. The route path is logged, never the body.
        logger.exception(
            'Domain invoke failed',
            extra={'route': f'{call.method} {call.path}', 'error_type': type(exc).__name__},
        )
        raise DelegationUnavailable(type(exc).__name__) from exc

    # An unhandled exception inside the domain function. The payload holds its
    # stack trace, which must not reach an MCP client — it is a server fault,
    # and the trace is for CloudWatch.
    if response.get('FunctionError'):
        logger.error(
            'Domain function raised',
            extra={'route': f'{call.method} {call.path}',
                   'function_error': response.get('FunctionError')},
        )
        raise DelegationUnavailable('domain function raised')

    try:
        payload = json.loads(response['Payload'].read())
    except (json.JSONDecodeError, KeyError, TypeError, UnicodeDecodeError) as exc:
        raise DelegationUnavailable('domain response was not JSON') from exc

    if not isinstance(payload, dict) or 'statusCode' not in payload:
        raise DelegationUnavailable('domain response was not a proxy response')

    status_code = payload.get('statusCode')
    if not isinstance(status_code, int):
        raise DelegationUnavailable('domain response had no integer statusCode')

    raw_body = payload.get('body')
    if raw_body is None or raw_body == '':
        return DomainResult(status_code=status_code, payload=None)
    try:
        body = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError):
        # A non-JSON body from a JSON API is a fault, but the status code is
        # still informative, so it is passed through as text rather than
        # raising — the caller decides whether the status makes it usable.
        body = raw_body
    return DomainResult(status_code=status_code, payload=body)
