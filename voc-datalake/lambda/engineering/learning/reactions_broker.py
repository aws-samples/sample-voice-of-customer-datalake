"""voc-engineering-runtime's one call of the connector broker (7.10.00): its ``reactions`` operation for an ended run.

A POST of ``{"operation": "reactions", "args": {"run_id"}}`` to the broker's function URL (``ENGINEERING_BROKER_URL``:
https, a function URL's own host, nothing else), SigV4-signed (service ``lambda``) with the runtime's own execution
role's credentials, which the broker admits for this operation alone (``connectors/identity.py``
``runtime_caller_from_event``). Sent once and never retried (its one wait, past the broker's own 120 s limit, fits the
runtime's 5 minutes); a redirect is never followed. It answers the broker's ``reactions`` (a ``voc-reactions/1`` or
None for no recorded pull request); anything else (a refusal, a lost or unreadable answer) is ``BrokerUnavailable``
with the broker's status, never its body. The agents' own client is the harness's (``runtime/harness/broker_client.py``),
which ships in their images and is not used here.
"""
from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Final
from urllib.parse import urlsplit

from engineering.connectors.identity import REACTIONS
from engineering.runtime.interface import FUNCTION_URL_RE

#: The wait for the broker's answer: past its own limit (120 s, engineering-broker.ts), inside the runtime's 300 s.
TIMEOUT_SECONDS: Final = 125
#: A function URL answers at most 6 MB.
MAX_ANSWER_BYTES: Final = 6 * 1024 * 1024
_LOST: Final = (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException)


class BrokerUnavailable(RuntimeError):
    """The broker refused the read, or its answer never came whole or could not be read."""


class _NoFollow(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as the error it is: the signed request never follows one to another host."""

    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


_OPENER: Final = urllib.request.build_opener(_NoFollow)


def function_url(url: str) -> str:
    """``url`` as the broker's function URL (https, a function URL's own host, no port, credentials, path or query)."""
    parts = urlsplit(url)
    # (a netloc that is its host alone carries no port and no credentials)
    plain = (parts.scheme, parts.path or '/', parts.query, parts.fragment) == ('https', '/', '', '')
    if not (plain and parts.netloc == parts.hostname and FUNCTION_URL_RE.match(parts.netloc)):
        raise BrokerUnavailable('the broker\'s address is not a function URL')
    return f'https://{parts.netloc}/'


@dataclass(frozen=True)
class BrokerReactions:
    """The broker's ``reactions`` answer for a run, called as the runtime's own role (``credentials``: botocore's)."""

    url: str
    region: str
    credentials: Any
    opener: Any = field(default_factory=lambda: _OPENER)

    def __call__(self, run_id: str) -> object:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        address = function_url(self.url)
        data = json.dumps({'operation': REACTIONS, 'args': {'run_id': run_id}}, separators=(',', ':')).encode()
        signed = AWSRequest(method='POST', url=address, data=data, headers={'Content-Type': 'application/json'})
        SigV4Auth(self.credentials.get_frozen_credentials(), 'lambda', self.region).add_auth(signed)
        request = urllib.request.Request(address, data=data, method='POST',  # noqa: S310 - https, checked above
                                         headers=dict(signed.headers.items()))
        try:
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as answer:
                raw = answer.read(MAX_ANSWER_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise BrokerUnavailable(f'the broker answered {error.code}') from error
        except _LOST as error:
            raise BrokerUnavailable('the broker\'s answer never came') from error
        return _reactions(raw)


def _reactions(raw: bytes) -> object:
    """The answer's ``result.reactions``; ``BrokerUnavailable`` for an answer over its bound, not JSON, or off its
    shape."""
    if len(raw) > MAX_ANSWER_BYTES:
        raise BrokerUnavailable('the broker\'s answer is over its bound')
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise BrokerUnavailable('the broker\'s answer is not JSON') from error
    result = parsed.get('result') if isinstance(parsed, dict) else None
    if not isinstance(result, dict) or 'reactions' not in result:
        raise BrokerUnavailable('the broker answered no reactions')
    return result['reactions']
