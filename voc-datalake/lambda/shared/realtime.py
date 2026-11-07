"""Push notifications over AWS AppSync Events (docs/realtime.md): the Python publisher.

A notice tells ONE person's browser that something it may be polling changed, so the SPA re-reads
it at once instead of on its next poll. A notice carries ids and statuses only (never content), and
it is never the source of truth: the SPA always re-reads the row through the API, which applies the
caller's access as on every poll. Polling stays the fallback (reload, reconnect, a lost notice).

Channels are ``/<namespace>/<cognito sub>`` (``jobs``, ``chat``, ``runs``); AppSync lets a browser
subscribe only to its own sub's channels, and only IAM may publish.

Publishing is BEST EFFORT: a failure is logged and swallowed, never raised, so a job, a run or a
plan step never fails because a notice could not be sent. It is a no-op when the Event API is not
configured (the dev mock, an older deployment, a test):

``REALTIME_HTTP_DNS`` (the one variable every publisher is given) holds the Event API's HTTP host.
The Event API lives in VocCoreStack, which deploys first, so every publisher in every stack gets the
host as a plain stack reference.

The request is ``POST https://<host>/event`` ``{channel, events: [<json string>]}``, SigV4-signed
for service ``appsync`` with the Lambda role's credentials (``appsync:EventPublish`` on exactly the
namespace the Lambda publishes to).
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from typing import Any, Final

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import BotoCoreError

from shared.logging import logger

NAMESPACES: Final = frozenset({'jobs', 'chat', 'runs'})
HTTP_DNS_ENV: Final = 'REALTIME_HTTP_DNS'
# One short request; a slow Event API must not hold a job's last write back.
TIMEOUT_SECONDS: Final = 3
# A Cognito sub is a UUID; anything else cannot name a channel segment.
_SUB_RE: Final = re.compile(r'[A-Za-z0-9-]{1,128}')
_HOST_RE: Final = re.compile(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+')


def http_host() -> str:
    """The Event API's HTTP host, or '' when notices are off here."""
    host = os.environ.get(HTTP_DNS_ENV, '')
    return host if _HOST_RE.fullmatch(host) else ''


def configured() -> bool:
    """True when this Lambda can publish (a caller may skip the reads a notice needs otherwise)."""
    return bool(http_host())


def channel(namespace: str, sub: object) -> str | None:
    """``/<namespace>/<sub>``, or None for an unknown namespace or a value that is not a sub."""
    if namespace not in NAMESPACES or not isinstance(sub, str) or not _SUB_RE.fullmatch(sub):
        return None
    return f'/{namespace}/{sub}'


class _NoCredentialsError(Exception):
    """The Lambda has no AWS credentials to sign with."""


def _signed_headers(host: str, body: bytes) -> dict[str, str]:
    """SigV4 headers (service ``appsync``) for ``POST https://<host>/event`` with ``body``."""
    session = boto3.Session()
    credentials = session.get_credentials()
    if credentials is None:
        raise _NoCredentialsError
    region = session.region_name or os.environ.get('AWS_REGION', '')
    request = AWSRequest(method='POST', url=f'https://{host}/event', data=body,
                         headers={'content-type': 'application/json', 'host': host})
    SigV4Auth(credentials.get_frozen_credentials(), 'appsync', region).add_auth(request)
    return dict(request.headers.items())


def publish(namespace: str, sub: object, event: Mapping[str, Any]) -> bool:
    """Send one notice to ``sub``'s channel in ``namespace``. True when AppSync accepted it; never raises."""
    host = http_host()
    target = channel(namespace, sub)
    if not host or target is None:
        return False
    body = json.dumps({'channel': target, 'events': [json.dumps(dict(event), default=str)]}).encode('utf-8')
    try:
        response = requests.post(f'https://{host}/event', data=body, headers=_signed_headers(host, body),
                                 timeout=TIMEOUT_SECONDS)
    except (requests.RequestException, BotoCoreError, _NoCredentialsError) as exc:
        # Best effort: a lost notice falls back to polling.
        logger.warning('Realtime notice not sent', extra={'namespace': namespace, 'error': type(exc).__name__})
        return False
    if not response.ok:
        logger.warning('Realtime notice refused', extra={'namespace': namespace, 'status': response.status_code})
    return response.ok
