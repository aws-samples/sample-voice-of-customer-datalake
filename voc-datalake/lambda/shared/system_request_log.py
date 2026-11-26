"""`GET /logs/system/request`: every line of ONE invocation, for a group of System errors.

An error line alone rarely says why: the INFO lines before it do (which project, which model,
which storefront). Given a group's function, request id and time, this reads that function's
ONE log group around that time with Logs Insights and returns every line of the request,
oldest first, any level. A Lambda is matched on its request id (`@requestId`, Powertools'
`function_request_id`, or the id inside a Node text line); a state machine on its execution
name. The API access log has no such lines (its request id is the gateway's), so `api` is not
a function here.

Same `running` / `query_id` contract as `GET /logs/system`. Lines are redacted and cut; none
is ever logged. No workspace's content is shown (shared/system_log_scope.py, TENETS.md D8): when any line of the
request names a workspace, the request is a workspace's and none of its lines is returned (counted in
`withheld_workspace_lines`; `truncated` stays false); otherwise a line tagged as the deployment's and Lambda's own
fixed lines read as before, and any other shows its time and level only (`withheld`, an empty message).
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.exceptions import NotFoundError, ValidationError
from shared.logging import logger
from shared.pii_redaction import redact_text
from shared.system_log_groups import iso_timestamp, json_object, line_level, truncate
from shared.system_log_scope import WORKSPACE_TAG, line_tag, names_a_workspace, runtime_line
from shared.system_log_sources import SOURCE_API, SOURCE_WORKFLOW, LogSources, LogTarget, discover, log_group_name
from shared.system_logs import FAILED_MESSAGE, POLL_BUDGET_SECONDS, QUERY_ID, aws_error_code, poll, result_row
from shared.usage_meter import DEPLOYMENT

WINDOW_SECONDS: Final = 20 * 60
MAX_LINES: Final = 500
MAX_LINE_CHARS: Final = 4000
_FUNCTION = re.compile(r'[a-z0-9_-]{1,64}')
# A Lambda / API Gateway request id is a uuid; an execution name is `[A-Za-z0-9_-]`. Both are
# interpolated into the Insights query, so nothing else (no quote, slash or space) gets through.
_REQUEST_ID = re.compile(r'[0-9A-Za-z_-]{8,80}')
_FIELDS: Final = f'fields @timestamp, @log, level, {WORKSPACE_TAG}, @message'


@dataclass(frozen=True)
class RequestLookup:
    function: str
    request_id: str
    at: float
    query_id: str | None


def _parse_at(value: str | None) -> float:
    if not value:
        raise ValidationError('at must be an ISO 8601 time')
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError as error:
        raise ValidationError('at must be an ISO 8601 time') from error
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).timestamp()


def parse_lookup(params: dict[str, str]) -> RequestLookup:
    function = (params.get('function') or '').strip()
    request_id = (params.get('request_id') or '').strip()
    if not _FUNCTION.fullmatch(function):
        raise ValidationError('function must be a function short name')
    if not _REQUEST_ID.fullmatch(request_id):
        raise ValidationError('request_id must be a request id')
    query_id = (params.get('query_id') or '').strip() or None
    if query_id is not None and not QUERY_ID.fullmatch(query_id):
        raise ValidationError('query_id must be one query id')
    return RequestLookup(function, request_id, _parse_at(params.get('at')), query_id)


def request_query(target: LogTarget, request_id: str) -> str:
    if target.source == SOURCE_WORKFLOW:
        match = f'execution_arn like "{request_id}"'
    else:
        match = f'@requestId = "{request_id}" or function_request_id = "{request_id}" or @message like "{request_id}"'
    return f'filter {match} | {_FIELDS} | sort @timestamp asc | limit {MAX_LINES + 1}'


def _target(client: Any, function: str) -> LogTarget:
    for target in discover(client, LogSources.from_env()):
        if target.function == function and target.source != SOURCE_API:
            return target
    raise NotFoundError('No log group of that function on this deployment')


def _line(row: dict[str, str]) -> dict[str, Any]:
    """One line as the deployment's admins may read it: the deployment's (tagged) or one of Lambda's own fixed lines
    as it is, any other its time and level only."""
    raw = row.get('@message', '')
    shown = runtime_line(raw) or line_tag(row, json_object(raw)) == DEPLOYMENT
    return {
        'timestamp': iso_timestamp(row.get('@timestamp', '')),
        'level': line_level(row),
        'message': truncate(redact_text(raw).text, MAX_LINE_CHARS) if shown else '',
        'withheld': not shown,
    }


def _lines(answers: list[dict], target: LogTarget) -> tuple[list[dict[str, Any]], bool, int]:
    """(the lines, whether past the cap, how many were withheld because the request is a workspace's)."""
    rows = [result_row(fields) for answer in answers for fields in answer.get('results') or []]
    # GetQueryResults is granted on `*`: keep only rows of the group this lookup resolved.
    mine = [row for row in rows if log_group_name(row.get('@log', '')) == target.name]
    if any(names_a_workspace(' '.join(row.values())) for row in mine):
        return [], False, len(mine)
    return [_line(row) for row in mine[:MAX_LINES]], len(mine) > MAX_LINES, 0


def _window(at: float, now: float) -> tuple[int, int]:
    """`at` ± 20 minutes, never ending in the future (and never empty)."""
    start = int(at) - WINDOW_SECONDS
    return start, max(min(int(at) + WINDOW_SECONDS, int(now)), start + 1)


def _no_lines(base: dict[str, Any], status: str, **extra: str) -> dict[str, Any]:
    body = {**base, 'status': status, **extra, 'lines': [], 'truncated': False, 'withheld_workspace_lines': 0}
    return {**body, 'message': FAILED_MESSAGE} if status == 'failed' else body


def lookup(client: Any, request: RequestLookup, *, now: float | None = None,
           budget: float = POLL_BUDGET_SECONDS, sleep: Callable[[float], None] = time.sleep,
           clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    """The `GET /logs/system/request` body (see the module docstring)."""
    base: dict[str, Any] = {'function': request.function, 'request_id': request.request_id}
    try:
        target = _target(client, request.function)
        query_id = request.query_id
        if query_id is None:
            start, end = _window(request.at, time.time() if now is None else now)
            query_id = client.start_query(logGroupNames=[target.name], startTime=start, endTime=end,
                                          queryString=request_query(target, request.request_id),
                                          limit=MAX_LINES + 1)['queryId']
        status, answers = poll(client, (query_id,), budget, sleep, clock)
    except (ClientError, BotoCoreError) as error:
        logger.warning('System request log lookup failed', extra={'error_code': aws_error_code(error)})
        return _no_lines(base, 'failed')
    base['source'] = target.source
    if status == 'running':
        return _no_lines(base, 'running', query_id=query_id)
    if status == 'failed':
        return _no_lines(base, 'failed')
    lines, truncated, withheld = _lines(answers, target)
    return {**base, 'status': 'complete', 'lines': lines, 'truncated': truncated, 'withheld_workspace_lines': withheld}
