"""The broker's function URL in process, for the harness's broker client (harness/broker_client.py).

``FunctionUrl`` stands in for Lambda's IAM authentication in front of the broker: it checks each request's SigV4
signature (service ``lambda``, the region, the signed host, date, token and body, recomputed with botocore from the
credentials ``AgentSessions`` issued), refuses anything else 403 as the function URL does, and hands the verified
caller's assumed-role ARN and the body to the broker's own handler (connectors/handler.py ``handle``), which takes the
role, the run and the agent from that ARN alone. ``AgentSessions`` is the launcher's side: one role session per agent,
``voc-eng-<role>-...`` / ``<run>.<index>``, fictional keys only.
"""
from __future__ import annotations

import datetime as dt
import hmac
import io
import json
import re
import secrets
import urllib.error
from dataclasses import dataclass, field
from email.message import Message
from typing import Any, Final, Self

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

from engineering.connectors.broker import Broker
from engineering.connectors.handler import handle
from engineering.connectors.test.fakes import url_event

ACCOUNT: Final = '111111111111'
REGION: Final = 'us-east-1'
#: The agent roles' IAM names, as the broker's AGENT_ROLE_NAME_PATTERN has them.
PATTERN: Final = f'voc-eng-{{role}}-{ACCOUNT}-{REGION}'
_AUTH: Final = re.compile(r'AWS4-HMAC-SHA256 Credential=(?P<key>[A-Z0-9]{16,128})/(?P<date>\d{8})/(?P<region>[a-z0-9-]+)/'
                          r'(?P<service>[a-z0-9-]+)/aws4_request, SignedHeaders=(?P<signed>[a-z0-9;-]+), '
                          r'Signature=(?P<signature>[0-9a-f]{64})')
#: The headers a signature must cover: where it goes, when, and as which session.
MUST_SIGN: Final = frozenset({'host', 'x-amz-date', 'x-amz-security-token'})
MAX_SKEW: Final = dt.timedelta(minutes=5)


@dataclass(frozen=True)
class Issued:
    secret: str
    token: str
    arn: str


@dataclass
class AgentSessions:
    """The role sessions the launcher hands each agent of ``run_id`` (fictional credentials)."""

    run_id: str
    issued: dict[str, Issued] = field(default_factory=dict)

    def credentials(self, agent_id: str, *, role_name: str = '') -> Credentials:
        """A session of ``agent_id``'s agent role (``role_name``: another IAM role's name instead)."""
        role, index = agent_id.rsplit('-', 1)
        key = 'ASIA' + secrets.token_hex(8).upper()
        issued = Issued(secret=secrets.token_hex(20), token=f'session-token-{secrets.token_hex(8)}',
                        arn=f'arn:aws:sts::{ACCOUNT}:assumed-role/{role_name or PATTERN.replace("{role}", role)}/'
                            f'{self.run_id}.{index}')
        self.issued[key] = issued
        return Credentials(key, issued.secret, issued.token)


class Answer:
    """A function URL's 200 answer, as urllib's opener hands it back."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, limit: int) -> bytes:
        return self._body[:limit]


@dataclass
class FunctionUrl:
    """The broker's function URL at ``url``: IAM authentication, then the broker's handler."""

    url: str
    broker: Broker
    sessions: AgentSessions
    #: Each call: the verified caller (None: refused before the broker), its operation, the status, the wait.
    calls: list[tuple[str | None, str, int, float]] = field(default_factory=list)

    def open(self, request: Any, timeout: float) -> Answer:
        body = bytes(request.data or b'')
        caller = self.verified(request)
        operation = str(json.loads(body or b'{}').get('operation', '')) if body.startswith(b'{') else ''
        if caller is None:
            self.calls.append((None, operation, 403, timeout))
            raise urllib.error.HTTPError(request.full_url, 403, 'Forbidden', Message(),
                                         io.BytesIO(b'{"Message":"Forbidden"}'))
        response = handle(url_event(caller, body.decode()), PATTERN, ACCOUNT, self.broker)
        status, answer = int(response['statusCode']), str(response['body']).encode()
        self.calls.append((caller, operation, status, timeout))
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, 'refused', Message(), io.BytesIO(answer))
        return Answer(answer)

    def verified(self, request: Any) -> str | None:
        """The caller's assumed-role ARN when ``request`` is a POST to this URL signed, as SigV4 for ``lambda`` in
        the region, by a session this stub issued, and the signature covers the host, the date, the token and the
        body; None for anything else."""
        headers = {name.lower(): value for name, value in request.header_items()}
        auth = _AUTH.fullmatch(headers.get('authorization', ''))
        issued = self.sessions.issued.get(auth.group('key')) if auth else None
        if (auth is None or issued is None or request.get_method() != 'POST' or request.full_url != self.url
                or (auth.group('region'), auth.group('service')) != (REGION, 'lambda')
                or not set(auth.group('signed').split(';')) >= MUST_SIGN
                or headers.get('x-amz-security-token') != issued.token):
            return None
        stamp = headers.get('x-amz-date', '')
        try:
            signed_at = dt.datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.UTC)
        except ValueError:
            return None
        if not stamp.startswith(auth.group('date')) or abs(dt.datetime.now(dt.UTC) - signed_at) > MAX_SKEW:
            return None
        unsigned = {name: value for name, value in request.header_items() if name.lower() != 'authorization'}
        again = AWSRequest(method='POST', url=request.full_url, data=request.data, headers=unsigned)
        again.context['timestamp'] = stamp
        signer = SigV4Auth(Credentials(auth.group('key'), issued.secret, issued.token), 'lambda', REGION)
        canonical = signer.canonical_request(again)
        if signer.signed_headers(signer.headers_to_sign(again)) != auth.group('signed'):
            return None
        expected = signer.signature(signer.string_to_sign(again, canonical), again)
        return issued.arn if hmac.compare_digest(expected, auth.group('signature')) else None
