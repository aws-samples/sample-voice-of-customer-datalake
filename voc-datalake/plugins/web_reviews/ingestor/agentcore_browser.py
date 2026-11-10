"""One AgentCore managed-browser session per run: started, connected over CDP, ALWAYS stopped.

The AWS-managed browser ``aws.browser.v1`` needs no resource of our own: a
session is started (``StartBrowserSession``), its automation stream is a
websocket (``streams.automationStream.streamEndpoint``) whose handshake is
SigV4-signed for the ``bedrock-agentcore`` service, and the session is stopped
(``StopBrowserSession``) in ``finally`` whatever happened in between — a session
left running is billed until its timeout. IAM: lib/stacks/ingestion-roles.ts.
"""

import os
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from typing import Any, Final
from urllib.parse import urlparse

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import BotoCoreError, ClientError
from cdp_client import CdpConnection, WebSocketLike, open_websocket

from _shared.base_ingestor import logger

BROWSER_IDENTIFIER: Final = 'aws.browser.v1'
SIGNING_SERVICE: Final = 'bedrock-agentcore'
SESSION_NAME: Final = 'voc-web-reviews'
#: StartBrowserSession bounds (seconds).
MIN_SESSION_SECONDS: Final = 60
MAX_SESSION_SECONDS: Final = 900
VIEWPORT: Final = {'width': 1366, 'height': 900}
CONNECT_TIMEOUT_SECONDS: Final = 30.0


class BrowserUnavailableError(RuntimeError):
    """No browser session could be started; the message is client-safe."""


def session_seconds(remaining_seconds: float) -> int:
    """A session timeout that ends with the Lambda: its remaining time, within the API's bounds."""
    return int(max(MIN_SESSION_SECONDS, min(MAX_SESSION_SECONDS, remaining_seconds)))


def signed_handshake_headers(stream_url: str, region: str, credentials: Any) -> dict[str, str]:
    """SigV4 headers for the websocket handshake (signed as a GET of the https form of the URL)."""
    https_url = stream_url.replace('wss://', 'https://', 1)
    request = AWSRequest(method='GET', url=https_url, headers={'host': urlparse(https_url).netloc})
    SigV4Auth(credentials, SIGNING_SERVICE, region).add_auth(request)
    return dict(request.headers.items())


def _region() -> str:
    return os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or 'us-east-1'


@contextmanager
def browser_session(
    timeout_seconds: int,
    *,
    client: Any = None,
    opener: Callable[[str, Mapping[str, str], float], WebSocketLike] = open_websocket,
    credentials: Any = None,
) -> Generator[CdpConnection, None, None]:
    """A connected CDP session on a fresh managed browser; the session is stopped on exit."""
    region = _region()
    try:
        # An SDK without the service raises UnknownServiceError, a BotoCoreError, here.
        agentcore = client if client is not None else boto3.client('bedrock-agentcore', region_name=region)
        session = agentcore.start_browser_session(
            browserIdentifier=BROWSER_IDENTIFIER, name=SESSION_NAME,
            sessionTimeoutSeconds=timeout_seconds, viewPort=VIEWPORT,
        )
    except (ClientError, BotoCoreError) as error:
        logger.warning(f'StartBrowserSession failed in {region}: {error}')
        raise BrowserUnavailableError(f'AgentCore Browser is unavailable in {region}') from error
    session_id = session['sessionId']
    connection = None
    try:
        stream_url = session['streams']['automationStream']['streamEndpoint']
        signing_credentials = credentials if credentials is not None else boto3.Session().get_credentials()
        headers = signed_handshake_headers(stream_url, region, signing_credentials)
        connection = CdpConnection(opener(stream_url, headers, CONNECT_TIMEOUT_SECONDS))
        connection.browser_session_id = session_id
        yield connection
    finally:
        if connection is not None:
            connection.close()
        _stop(agentcore, session_id)


def _stop(agentcore: Any, session_id: str) -> None:
    try:
        agentcore.stop_browser_session(browserIdentifier=BROWSER_IDENTIFIER, sessionId=session_id)
    except (ClientError, BotoCoreError) as error:
        # Nothing more can be done from here; the session ends at its own timeout.
        logger.warning(f'StopBrowserSession failed: {error}')
