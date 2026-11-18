"""voc-engineering-start's ``publish_docs`` (7.52.00): an administrator's request for the pull request of the docs
they approved, handed to the broker's ``push_approved_docs`` (docs/autonomous-engineering.md, "The knowledge docs pull
request").

The Agents API's ``POST /agents/engineering/docs/<connection>/publish`` invokes the start function with ``{"action":
"publish_docs", "connection", "repository", "default_branch", "kind", "digest", "draft", "actor"}``: the stored
connection's repository and default branch as its row has them, the kind (``knowledge`` or ``tenets``), the digest of
the docs the administrator saw, whether the pull request opens as a draft (the flow's ``pr``) and who asked. This
POSTs ``{"operation": "push_approved_docs", "args": {...}}`` to the broker's function URL (``ENGINEERING_BROKER_URL``),
SigV4-signed with the start function's own execution role's credentials, which the broker admits for this operation
and ``head`` alone (``connectors/identity.py`` ``START_ROLE``); sent once (``learning/reactions_broker.py``
``signed_call``), never retried here: the broker makes each write once per (connection, kind, version), so asking
again is safe.

It answers ``{"status": "opened", "pr": {number, url, branch}, "kind", "version", "digest", "draft"}``, or
``"repeated"`` with the pull request a publish of the same version opened before, or ``"refused"`` with the broker's
status, its reason and its ``code`` (``human_driven``, ``not_approved``, ``digest_mismatch``; '' for another). A broker
out of reach, or an answer off its shape, is ``DocsUnavailable``: whether the pull request was opened is then not
known, and the next publish of the version answers it.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.connectors.identity import PUSH_APPROVED_DOCS
from engineering.knowledge.render_docs import DIGEST, KINDS
from engineering.learning import reactions_broker
from engineering.learning.reactions_broker import BrokerAnswered, BrokerUnavailable, signed_call

#: The wait for the broker's answer: a token mint, the rendering's reads, the push and the pull request, inside the
#: start function's 30 s and the Agents API's 25 s wait for it.
TIMEOUT_SECONDS: Final = 22
#: The start function's action (runtime/handler.py ``start_handler``).
ACTION: Final = 'publish_docs'
_CODES: Final = frozenset({'human_driven', 'not_approved', 'digest_mismatch'})
_URL: Final = re.compile(r'https://[A-Za-z0-9.-]{1,253}/[^\s]{1,1000}\Z')


class DocsRefused(ValueError):
    """The request is not one this action takes (said before anything is asked of the broker)."""


class DocsUnavailable(RuntimeError):
    """The broker could not be reached, or answered off its shape: whether the pull request was opened is not known."""


@dataclass(frozen=True)
class BrokerDocs:
    """The broker's ``push_approved_docs``, called as the start function's own role (``credentials``: botocore's)."""

    url: str
    region: str
    credentials: Any
    opener: Any = field(default_factory=reactions_broker.default_opener)

    def __call__(self, args: Mapping[str, object]) -> bytes:
        return signed_call(self.url, self.region, self.credentials, PUSH_APPROVED_DOCS, dict(args),
                           opener=self.opener, timeout=TIMEOUT_SECONDS)


def request_args(event: Mapping[str, Any]) -> dict[str, object]:
    """The broker's args from the start function's event; ``DocsRefused`` for an event off its shape."""
    connection, kind, digest = str(event.get('connection', '')), event.get('kind'), event.get('digest')
    actor, draft = str(event.get('actor') or ''), event.get('draft', False)
    if not connection or kind not in KINDS or not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise DocsRefused('a docs publish names its connection, its kind (knowledge or tenets) and the digest seen')
    if not actor or not isinstance(draft, bool):
        raise DocsRefused('a docs publish names the administrator who asked, and draft is true or false')
    return {'connection': connection, 'repository': str(event.get('repository', '')),
            'default_branch': str(event.get('default_branch', '')), 'kind': kind, 'digest': digest,
            'requested_by': actor, 'draft': draft}


def _opened(raw: bytes) -> dict[str, Any]:
    if len(raw) > reactions_broker.MAX_ANSWER_BYTES:
        raise DocsUnavailable('the broker\'s answer is over its bound')
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise DocsUnavailable('the broker\'s answer is not JSON') from error
    result = parsed.get('result') if isinstance(parsed, dict) else None
    pr = result.get('pr') if isinstance(result, dict) else None
    number, url = (pr.get('number'), pr.get('url')) if isinstance(pr, dict) else (None, None)
    if (not isinstance(result, dict) or not isinstance(pr, dict) or not isinstance(number, int)
            or isinstance(number, bool) or number < 1 or not isinstance(url, str) or not _URL.fullmatch(url)):
        raise DocsUnavailable('the broker answered no pull request')
    return {'status': 'repeated' if result.get('repeated') is True else 'opened',
            'pr': {'number': number, 'url': url, 'branch': str(pr.get('branch', ''))},
            'kind': result.get('kind'), 'version': result.get('version'), 'digest': result.get('digest'),
            'draft': result.get('draft') is True}


def publish(event: Mapping[str, Any], broker: Callable[[Mapping[str, object]], bytes]) -> dict[str, Any]:
    """The action (the module's doc)."""
    args = request_args(event)
    try:
        raw = broker(args)
    except BrokerAnswered as refused:
        code = refused.code if refused.code in _CODES else ''
        return {'status': 'refused', 'http_status': refused.status, 'reason': refused.reason or str(refused),
                'code': code}
    except BrokerUnavailable as error:
        raise DocsUnavailable('the broker could not be reached: whether the pull request was opened is not known; '
                              'publish again to find out') from error
    return _opened(raw)
