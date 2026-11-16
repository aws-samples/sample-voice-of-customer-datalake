"""The Responses API on the ``bedrock-mantle`` endpoint, where the web search surface's OpenAI GPT models run.

One SigV4-signed POST (service ``bedrock-mantle``, the caller's own role, no API key) to
``https://bedrock-mantle.<region>.api.aws/openai/v1/responses``, shared by the two callers:

* the web_reviews ingestor's Bedrock web search reader (plugins/web_reviews/ingestor/web_search_reader.py),
  which reads a review page from the web search cache;
* the Test button of Administration -> AI models for that surface (shared/web_search_model_probe.py),
  one tiny request with no tool.

IAM: ``bedrock-mantle:CreateInference`` on the account's default project (a request names no project).
A refusal or no answer is a ``ResponsesError`` whose message is client-safe (the status and at most
``ERROR_DETAIL_CHARS`` of the answer, never a credential), and ``cannot_serve`` says whether it means
the model cannot serve now (throttled, no capacity, the model not available to the account), which is
what moves the ingestor's read to the next model (shared/model_fallback.py ``run_with_fallback``).
"""
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any, Final

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from shared.model_fallback import names_model_unavailable

#: The service the requests are signed for, and the Responses API's OpenAI-compatible path.
SIGNING_SERVICE: Final = 'bedrock-mantle'
RESPONSES_PATH: Final = '/openai/v1/responses'
#: First HTTP status that is the API's refusal.
HTTP_ERROR_FROM: Final = 400
#: Characters of an error answer kept in the client-safe message.
ERROR_DETAIL_CHARS: Final = 160
#: Statuses that mean the model cannot serve now, whatever the answer says: throttled or out of capacity.
CAPACITY_STATUSES: Final = frozenset({429, 503})
#: Statuses that mean it only when the answer names the model's availability (no access to it, not available).
MESSAGE_GATED_STATUSES: Final = frozenset({400, 403, 404})

#: ``(url, body, headers, timeout) -> (status, response body)``; ``urlopen_post`` in production.
Post = Callable[[str, bytes, dict[str, str], float], tuple[int, bytes]]  # pragma: no mutate  an alias read only as an annotation


class ResponsesError(RuntimeError):
    """The Responses API refused the request (``status``) or did not answer (``status`` None); client-safe."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def responses_url(region: str) -> str:
    return f'https://bedrock-mantle.{region}.api.aws{RESPONSES_PATH}'


def urlopen_post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method='POST')  # noqa: S310  an https URL built here
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310  same
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def signed_post(url: str, payload: dict[str, Any], region: str, credentials: Any, post: Post,
                timeout: float) -> dict[str, Any]:
    """POST *payload* SigV4-signed for ``bedrock-mantle``; the JSON answer, or ``ResponsesError``."""
    data = json.dumps(payload).encode()
    request = AWSRequest(method='POST', url=url, data=data, headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, SIGNING_SERVICE, region).add_auth(request)
    try:
        status, raw = post(url, data, dict(request.headers.items()), timeout)
    except (OSError, ValueError) as error:  # URLError and timeouts are OSErrors
        raise ResponsesError(f'no answer ({type(error).__name__})') from error
    if status >= HTTP_ERROR_FROM:
        detail = raw.decode('utf-8', 'replace')[:ERROR_DETAIL_CHARS]
        raise ResponsesError(f'HTTP {status}: {detail}', status)
    try:
        answer = json.loads(raw)
    except ValueError as error:
        raise ResponsesError('an unreadable answer') from error
    if not isinstance(answer, dict):
        raise ResponsesError('an unreadable answer')
    return answer


def cannot_serve(error: BaseException) -> bool:
    """True when *error* means this model cannot serve now (try the next model): HTTP 429 or 503, or a 400 / 403 /
    404 whose answer names the model's availability (shared/model_fallback.py MODEL_UNAVAILABLE_PATTERNS). A
    request the API refuses for its own shape, a denied role and no answer at all are not."""
    if not isinstance(error, ResponsesError) or error.status is None:
        return False
    if error.status in CAPACITY_STATUSES:
        return True
    return error.status in MESSAGE_GATED_STATUSES and names_model_unavailable(str(error))


def failure_reason(error: BaseException) -> str:
    """A short name of *error* (the fallback record's reason, the test's code): ``HTTP <status>``, ``no answer``
    for a request that got none, else the error's type."""
    if not isinstance(error, ResponsesError):
        return type(error).__name__
    return f'HTTP {error.status}' if error.status is not None else 'no answer'
