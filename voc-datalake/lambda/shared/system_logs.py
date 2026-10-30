"""`GET /logs/system`: this deployment's errors, read with CloudWatch Logs Insights.

Administration → System → Logs → System errors. The real exceptions (a persona avatar
that failed, an App Store run, an assist job…) are only in CloudWatch; this module finds
every log group of the deployment (shared/system_log_sources.py: its Lambdas, the state
machines and the API access log), runs one Insights query per ≤ 50 groups of one kind
and groups the matching lines (shared/system_log_groups.py, shared/system_log_rows.py).
Each group says its `source`: `lambda`, `workflow` or `api`.

An Insights query can outlive one API call (API Gateway stops at 29 s), so the search
polls for at most `POLL_BUDGET_SECONDS` and otherwise answers `running` with the query
ids; the caller polls again with `query_id`. The queries are started and read concurrently,
a finished query is not read again, and the first reads come sooner than the later ones
(most searches finish in 1 to 2 s). Rows are only ever returned redacted and
are never logged. AWS error text is never returned either: a failure is `failed` with a
fixed message.
"""
from __future__ import annotations

import contextlib
import itertools
import re
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.concurrency import ordered_map
from shared.e2e_tag import TEST_RUN_KEY
from shared.exceptions import ValidationError
from shared.logging import logger
from shared.system_log_groups import (
    ERROR_LEVELS,
    PLATFORM_TEXT,
    WARNING_LEVELS,
    LogLine,
    classify,
    group_lines,
)
from shared.system_log_rows import HTTP_LEVEL, api_query, classify_api, classify_workflow, workflow_query
from shared.system_log_sources import (
    SOURCE_API,
    SOURCE_LAMBDA,
    SOURCE_WORKFLOW,
    LogSources,
    LogTarget,
    discover,
    log_group_name,
)

LEVELS: Final = {'error': (*ERROR_LEVELS, HTTP_LEVEL), 'warning': (*WARNING_LEVELS, HTTP_LEVEL)}
# The raw `level` values the Insights filter selects: the TypeScript stream Lambda logs `WARN` /
# `FATAL` where Python Powertools logs `WARNING` / `CRITICAL` (classify() maps both to the latter).
_QUERY_LEVELS: Final = {'error': (*ERROR_LEVELS, 'FATAL'), 'warning': (*WARNING_LEVELS, 'FATAL', 'WARN')}
DEFAULT_LEVEL: Final = 'error'
GROUPS_PER_QUERY: Final = 50          # StartQuery accepts at most 50 log group names
MAX_LAMBDA_QUERIES: Final = 4
# Lambda queries + one for the state machines + one for the API access log.
MAX_QUERIES: Final = MAX_LAMBDA_QUERIES + 2
ROW_LIMIT: Final = 10000              # Insights' own cap on one query's rows
POLL_BUDGET_SECONDS: Final = 18.0     # the Lambda has 30 s, API Gateway 29 s
# Waits between reads: short at first (a 7-day search measured 0.5 to 1.9 s per query), then 1 s.
# At most MAX_QUERIES reads per round stays under GetQueryResults' 10 requests/s account quota.
POLL_INTERVALS_SECONDS: Final = (0.5, 0.5)
POLL_INTERVAL_SECONDS: Final = 1.0
SECONDS_PER_DAY: Final = 86400
FAILED_MESSAGE: Final = 'The log search failed. Try again in a minute.'
QUERY_ID: Final = re.compile(r'[0-9a-f-]{36}')  # used with fullmatch: a trailing newline is refused
DONE_FAILED: Final = frozenset({'Failed', 'Cancelled', 'Timeout', 'Unknown'})

# Lambda's own lines carry no `level`; Node.js text lines carry it between tabs.
_ERROR_TEXT: Final = PLATFORM_TEXT + r'|\tERROR\t|\tFATAL\t|^\[(ERROR|CRITICAL)\]'
_WARNING_TEXT: Final = r'|\tWARN\t|^\[WARNING\]'
_FIELDS: Final = 'fields @timestamp, @log, level, message, exception, function_request_id, @requestId, @message'


@dataclass(frozen=True)
class SearchRequest:
    days: int
    level: str
    query_ids: tuple[str, ...]


def parse_level(value: str | None) -> str:
    if value is None or value == '':
        return DEFAULT_LEVEL
    if value not in LEVELS:
        raise ValidationError("level must be 'error' or 'warning'")
    return value


def parse_query_ids(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    ids = tuple(part.strip() for part in value.split(','))
    if len(ids) > MAX_QUERIES or not all(QUERY_ID.fullmatch(query_id) for query_id in ids):
        raise ValidationError(f'query_id must be up to {MAX_QUERIES} comma-separated query ids')
    return ids


def query_string(level: str) -> str:
    """The Insights query of the Lambda log groups.

    Lines of an end-to-end test invocation (`test_run`, shared/e2e_tag.py — the suite's
    deliberate 403s and fake ids) are left out, as the access-log query leaves out the
    `voc-e2e/` User-Agent: the tab shows what failed for real users.
    """
    levels = ', '.join(f'"{name}"' for name in _QUERY_LEVELS[level])
    text = _ERROR_TEXT + (_WARNING_TEXT if level == 'warning' else '')
    return (f'filter not ispresent({TEST_RUN_KEY}) | filter level in [{levels}] or @message like /{text}/ | {_FIELDS} '
            f'| sort @timestamp desc | limit {ROW_LIMIT}')


def _batches(names: list[str], max_queries: int) -> Iterable[list[str]]:
    for start in range(0, min(len(names), GROUPS_PER_QUERY * max_queries), GROUPS_PER_QUERY):
        yield names[start:start + GROUPS_PER_QUERY]


def query_plan(targets: list[LogTarget], level: str) -> list[tuple[list[str], str]]:
    """(log group names, query string) per query: ≤ 4 Lambda batches, then workflows, then the API."""
    def names(source: str) -> list[str]:
        return [target.name for target in targets if target.source == source]
    plan = [(batch, query_string(level)) for batch in _batches(names(SOURCE_LAMBDA), MAX_LAMBDA_QUERIES)]
    plan += [(batch, workflow_query(ROW_LIMIT)) for batch in _batches(names(SOURCE_WORKFLOW), 1)]
    plan += [(batch, api_query(level, ROW_LIMIT)) for batch in _batches(names(SOURCE_API), 1)]
    return plan


def start_queries(client: Any, plan: list[tuple[list[str], str]], start: int, end: int) -> tuple[str, ...]:
    """Start every query of `plan` concurrently; on any failure the ones that started are stopped."""
    def started(entry: tuple[list[str], str]) -> str | Exception:
        names, query = entry
        try:
            response = client.start_query(logGroupNames=names, startTime=start, endTime=end,
                                          queryString=query, limit=ROW_LIMIT)
        except (ClientError, BotoCoreError) as error:
            return error
        return str(response['queryId'])
    outcomes = ordered_map(started, plan)
    ids = tuple(outcome for outcome in outcomes if isinstance(outcome, str))
    failure = next((outcome for outcome in outcomes if isinstance(outcome, Exception)), None)
    if failure is not None:
        stop_queries(client, ids)
        raise failure
    return ids


def stop_queries(client: Any, ids: Iterable[str]) -> None:
    for query_id in ids:
        # Already finished, or gone: nothing left to stop.
        with contextlib.suppress(ClientError, BotoCoreError):
            client.stop_query(queryId=query_id)


def result_row(fields: list[dict[str, str]]) -> dict[str, str]:
    return {item['field']: item.get('value', '') for item in fields if 'field' in item}


def poll(client: Any, ids: tuple[str, ...], budget: float,
         sleep: Callable[[float], None], clock: Callable[[], float]) -> tuple[str, list[dict]]:
    """(`complete` | `running` | `failed`, each query's results, in `ids` order, once all are complete).

    Each round reads the queries still open, concurrently; a `Complete` answer is kept, not read again.
    """
    deadline = clock() + budget
    done: dict[str, dict] = {}
    waits = itertools.chain(POLL_INTERVALS_SECONDS, itertools.repeat(POLL_INTERVAL_SECONDS))
    while True:
        open_ids = [query_id for query_id in ids if query_id not in done]
        answers = ordered_map(lambda query_id: client.get_query_results(queryId=query_id), open_ids)
        statuses = {answer.get('status') for answer in answers}
        if statuses & DONE_FAILED:
            stop_queries(client, ids)
            return 'failed', []
        done.update((query_id, answer) for query_id, answer in zip(open_ids, answers, strict=True)
                    if answer.get('status') == 'Complete')
        if len(done) == len(ids):
            return 'complete', [done[query_id] for query_id in ids]
        wait = next(waits)
        if clock() + wait > deadline:
            return 'running', []
        sleep(wait)


def _classify(row: dict[str, str], target: LogTarget, wanted: tuple[str, ...]) -> LogLine | None:
    if target.source == SOURCE_API:
        return classify_api(row, wanted)
    if target.source == SOURCE_WORKFLOW:
        return classify_workflow(row, target.function, wanted)
    return classify(row, target.function, wanted)


def _lines(answers: list[dict], targets: dict[str, LogTarget], level: str) -> tuple[list[LogLine], bool]:
    """Classified lines of every answer, and whether any query hit the row cap.

    A row from a log group outside this deployment is dropped: `GetQueryResults` is
    granted on `*`, so a query id is never trusted to belong to this search.
    """
    lines: list[LogLine] = []
    truncated = False
    for answer in answers:
        results = answer.get('results') or []
        truncated = truncated or len(results) >= ROW_LIMIT
        for fields in results:
            row = result_row(fields)
            target = targets.get(log_group_name(row.get('@log', '')))
            line = _classify(row, target, LEVELS[level]) if target is not None else None
            if line is not None:
                lines.append(line)
    return lines, truncated


def _source_counts(targets: list[LogTarget]) -> dict[str, int]:
    return {source: sum(1 for target in targets if target.source == source)
            for source in (SOURCE_LAMBDA, SOURCE_WORKFLOW, SOURCE_API)}


def aws_error_code(error: ClientError | BotoCoreError) -> str:
    return str(error.response.get('Error', {}).get('Code')) if isinstance(error, ClientError) else type(error).__name__


def search(client: Any, request: SearchRequest, *, now: float | None = None,
           budget: float = POLL_BUDGET_SECONDS, sleep: Callable[[float], None] = time.sleep,
           clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    """The `GET /logs/system` body (see the module docstring)."""
    sources = LogSources.from_env()
    base: dict[str, Any] = {'days': request.days, 'level': request.level}
    try:
        targets = discover(client, sources)
        base['log_groups'] = len(targets)
        base['log_groups_by_source'] = _source_counts(targets)
        if not targets:
            return {**base, 'status': 'complete', 'truncated': False, 'count': 0, 'groups': []}
        end = int(time.time() if now is None else now)
        ids = request.query_ids or start_queries(client, query_plan(targets, request.level),
                                                 end - request.days * SECONDS_PER_DAY, end)
        status, answers = poll(client, ids, budget, sleep, clock)
    except (ClientError, BotoCoreError) as error:
        logger.warning('System log search failed', extra={'error_code': aws_error_code(error)})
        return {**base, 'status': 'failed', 'message': FAILED_MESSAGE}
    if status == 'running':
        return {**base, 'status': 'running', 'query_id': ','.join(ids)}
    if status == 'failed':
        return {**base, 'status': 'failed', 'message': FAILED_MESSAGE}
    lines, truncated = _lines(answers, {target.name: target for target in targets}, request.level)
    groups = group_lines(lines)
    return {**base, 'status': 'complete', 'truncated': truncated, 'count': len(groups), 'groups': groups}
