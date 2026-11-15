"""One AgentCore browser session per run: started, connected over CDP, ALWAYS stopped.

The browser is the one ``BROWSER_IDENTIFIER`` names: the deployment's own Web Bot Auth
browser, which signs every request it makes (lib/stacks/ingestion-browser.ts), or, when
unset (``-c webReviewsBotAuth=false``, voc-design-capture, a local run), the AWS-managed
``aws.browser.v1``. A session is started (``StartBrowserSession``), its automation stream
is a websocket (``streams.automationStream.streamEndpoint``) whose handshake is
SigV4-signed for the ``bedrock-agentcore`` service, and the session is stopped
(``StopBrowserSession``) in ``finally`` whatever happened in between — a session left
running is billed until its timeout.

With ``BROWSER_PROFILE_IDENTIFIER`` the session starts from that browser profile (the
review sites' cookies and local storage of earlier runs) and, before it is stopped, is
saved into it (``SaveBrowserSessionProfile``), so the next run starts where this one
ended. A failed save is logged and the run goes on: the profile only keeps its earlier
state. IAM: lib/stacks/ingestion-roles.ts.
"""

import os
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from typing import Any, Final
from urllib.parse import urlparse

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import BotoCoreError, ClientError, ParamValidationError
from cdp_client import CdpConnection, WebSocketLike, open_websocket

from _shared.base_ingestor import logger

#: The AWS-managed browser, used when ``BROWSER_IDENTIFIER_ENV`` is unset.
MANAGED_BROWSER: Final = 'aws.browser.v1'
BROWSER_IDENTIFIER_ENV: Final = 'BROWSER_IDENTIFIER'
BROWSER_PROFILE_ENV: Final = 'BROWSER_PROFILE_IDENTIFIER'
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


def browser_identifier() -> str:
    """The browser sessions start on: ``BROWSER_IDENTIFIER``, else the AWS-managed one."""
    return os.environ.get(BROWSER_IDENTIFIER_ENV) or MANAGED_BROWSER


def browser_profile() -> str | None:
    """The profile sessions load and are saved into (``BROWSER_PROFILE_IDENTIFIER``), or ``None``."""
    return os.environ.get(BROWSER_PROFILE_ENV) or None


def _start_request(browser: str, profile: str | None, timeout_seconds: int) -> dict[str, Any]:
    request: dict[str, Any] = {
        'browserIdentifier': browser, 'name': SESSION_NAME,
        'sessionTimeoutSeconds': timeout_seconds, 'viewPort': VIEWPORT,
    }
    if profile is not None:
        request['profileConfiguration'] = {'profileIdentifier': profile}
    return request


def _start(agentcore: Any, browser: str, profile: str | None, timeout_seconds: int) -> tuple[dict[str, Any], str | None]:
    """The started session and the profile it loaded: ``None`` when there is none, or when the SDK predates
    browser profiles (the Lambda runtime's boto3 refuses the unknown parameter), so the run goes on without one."""
    if profile is not None:
        try:
            return agentcore.start_browser_session(**_start_request(browser, profile, timeout_seconds)), profile
        except ParamValidationError as error:
            logger.warning(f'StartBrowserSession without the browser profile, which this SDK does not know: {error}')
    return agentcore.start_browser_session(**_start_request(browser, None, timeout_seconds)), None


@contextmanager
def browser_session(
    timeout_seconds: int,
    *,
    client: Any = None,
    opener: Callable[[str, Mapping[str, str], float], WebSocketLike] = open_websocket,
    credentials: Any = None,
) -> Generator[CdpConnection, None, None]:
    """A connected CDP session on a fresh browser session; saved into its profile (if any), then stopped, on exit."""
    region = _region()
    browser, profile = browser_identifier(), browser_profile()
    try:
        # An SDK without the service raises UnknownServiceError, a BotoCoreError, here.
        agentcore = client if client is not None else boto3.client('bedrock-agentcore', region_name=region)
        session, profile = _start(agentcore, browser, profile, timeout_seconds)
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
        # Saved while the session still runs (the API requires it), whatever the run did.
        if profile is not None:
            _save_profile(agentcore, browser, profile, session_id)
        if connection is not None:
            connection.close()
        _stop(agentcore, browser, session_id)


def _save_profile(agentcore: Any, browser: str, profile: str, session_id: str) -> None:
    """The session's cookies and local storage into *profile*, while the session is still running."""
    try:
        agentcore.save_browser_session_profile(profileIdentifier=profile, browserIdentifier=browser, sessionId=session_id)
    except (ClientError, BotoCoreError) as error:
        # The profile keeps its earlier state; the next run starts from that.
        logger.warning(f'SaveBrowserSessionProfile failed: {error}')


def _stop(agentcore: Any, browser: str, session_id: str) -> None:
    try:
        agentcore.stop_browser_session(browserIdentifier=browser, sessionId=session_id)
    except (ClientError, BotoCoreError) as error:
        # Nothing more can be done from here; the session ends at its own timeout.
        logger.warning(f'StopBrowserSession failed: {error}')
