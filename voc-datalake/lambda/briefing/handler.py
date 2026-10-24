"""``voc-briefing``: the per-user morning brief worker (docs/briefing.md).

Two entry points on one function:

- EventBridge, every 15 minutes: the dispatcher queues the subscribers whose local
  brief hour has passed (``briefing/dispatch.py``). Nobody subscribed = one empty Query.
- SQS ``voc-briefing`` (batch 1, at most 2 concurrent — the Bedrock quota is shared):
  build one user's brief (``briefing/build.py``), from a scheduled dispatch or a
  Refresh (``POST /settings/my-briefing/refresh``).

A message that cannot be valid is dropped (logged); a transient fault (Cognito,
DynamoDB, SNS) fails the record so SQS retries it, then the DLQ keeps it.

Bundled as ``briefing/`` + ``shared/``; tests import it as ``briefing.handler``.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from briefing.build import BuildRequest, Tables, build_for_user
from briefing.dispatch import dispatch
from briefing.identity import DirectoryUnavailable
from shared import briefing_store as store
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.briefing_requests import REASON_REFRESH, REASON_SCHEDULED
from shared.exceptions import ApiError
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.warm_init import warm_at_init

REASONS: Final = (REASON_REFRESH, REASON_SCHEDULED)
TRANSIENT: Final = (DirectoryUnavailable, ClientError, BotoCoreError, ApiError)
_TABLE_ENVS: Final = {
    'feedback': 'FEEDBACK_TABLE', 'aggregates': 'AGGREGATES_TABLE', 'memory': 'MEMORY_TABLE',
    'agents': 'AGENTS_TABLE', 'projects': 'PROJECTS_TABLE', 'radar': 'RADAR_TABLE',
}


def tables() -> Tables:
    resource = get_dynamodb_resource()
    names = {field: os.environ.get(env, '') for field, env in _TABLE_ENVS.items()}
    return Tables(**{field: resource.Table(name) if name else None for field, name in names.items()})


def parse_request(body: str) -> BuildRequest | None:
    """The build request in a queue body, None when it is not one."""
    try:
        message = json.loads(body)
    except ValueError:
        return None
    if not isinstance(message, dict) or message.get('kind') != 'build':
        return None
    sub, username, reason = message.get('sub'), message.get('username'), message.get('reason')
    if not (isinstance(sub, str) and sub and isinstance(username, str) and username and reason in REASONS):
        return None
    return BuildRequest(sub=sub, username=username, reason=str(reason))


def _site_url(aggregates: Any, sub: str) -> str:
    """The SPA link stored on the subscriber row (from the settings API's CORS origin)."""
    item = aggregates.get_item(Key=store.subscriber_key(sub)).get('Item') or {}
    url = item.get('site_url')
    return url if isinstance(url, str) and url.startswith('https://') else ''


def consume(event: Mapping[str, Any], now: datetime) -> dict[str, list[dict[str, str]]]:
    """Partial-batch response: the records to retry."""
    resources = tables()
    failures: list[dict[str, str]] = []
    for record in event.get('Records') or []:
        request = parse_request(str(record.get('body') or ''))
        if request is None:
            logger.warning('Dropped an unreadable brief message')
            continue
        try:
            build_for_user(resources, replace(request, site_url=_site_url(resources.aggregates, request.sub)), now)
        except TRANSIENT:
            logger.exception('Brief build failed; it will be retried')
            metrics.add_metric(name='BriefBuildErrors', unit='Count', value=1)
            failures.append({'itemIdentifier': str(record.get('messageId'))})
    return {'batchItemFailures': failures}


def run_dispatch(now: datetime) -> dict[str, int]:
    queue_url = os.environ.get('BRIEFING_QUEUE_URL', '')
    resources = tables()
    if not queue_url or resources.aggregates is None:
        logger.warning('Brief dispatcher not configured; nothing to do')
        return {'subscribers': 0, 'queued': 0}
    summary = dispatch(resources.aggregates, get_sqs_client(), queue_url, now)
    metrics.add_metric(name='BriefsQueued', unit='Count', value=summary['queued'])
    return summary


def _is_sqs(event: Mapping[str, Any]) -> bool:
    records = event.get('Records')
    return isinstance(records, list) and all(
        isinstance(r, Mapping) and r.get('eventSource') == 'aws:sqs' for r in records)


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_sqs_client)


@instrumented_handler
def lambda_handler(event: dict, _context: Any) -> dict:
    now = datetime.now(UTC)
    if _is_sqs(event):
        return consume(event, now)
    return run_dispatch(now)
