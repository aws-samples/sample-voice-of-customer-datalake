"""Rows of the non-Lambda sources of `GET /logs/system`: the API access log and Step Functions.

Each source has its own Logs Insights query (the rows look nothing alike) and its own
classifier turning a row into the `LogLine` shared/system_log_groups.py groups:

* API Gateway access log (lib/stacks/api-access-log.ts): one JSON line per request. A 5xx is
  level `HTTP`; in `warning` mode a 4xx other than 401 / 403 / 404 / 409 / 410 is `WARNING` (those
  are the ordinary answers to a signed-out caller, a forbidden page, a missing record, a conflict the
  caller resolves by reloading and a link that has expired or been closed). 400 and 429 stay: a
  malformed request or a throttle can point at a client bug or a too-low limit. Requests
  of the end-to-end suite (User-Agent `voc-e2e/<run>`, docs/testing) are never shown.
* Step Functions execution logs: the failure events of a run (`ExecutionFailed`, `TaskFailed`, …)
  are level `ERROR`, labelled with the state machine; the request id is the execution name.

The caller IP of an access-log line is never read. Texts are redacted by the grouping step.
"""
from __future__ import annotations

import re
from typing import Final

from shared.system_log_groups import LogLine, iso_timestamp, json_object
from shared.system_log_sources import API_FUNCTION, SOURCE_API, SOURCE_WORKFLOW

HTTP_LEVEL: Final = 'HTTP'
WARNING_LEVEL: Final = 'WARNING'
ERROR_LEVEL: Final = 'ERROR'
E2E_USER_AGENT: Final = 'voc-e2e/'
QUIET_CLIENT_STATUSES: Final = frozenset({'401', '403', '404', '409', '410'})
MAX_CAUSE_CHARS: Final = 2000

WORKFLOW_FAILURES: Final = ('ExecutionFailed', 'ExecutionTimedOut', 'ExecutionAborted', 'TaskFailed',
                            'TaskTimedOut', 'LambdaFunctionFailed', 'LambdaFunctionTimedOut')

_API_FIELDS: Final = ('fields @timestamp, @log, requestId, requestTime, httpMethod, path, resourcePath, status, '
                      'integrationStatus, errorMessage, responseLength, userAgent')
_WORKFLOW_FIELDS: Final = 'fields @timestamp, @log, type, `details.error`, `details.cause`, execution_arn, @message'

_STATUS = re.compile(r'[1-5]\d\d')
# A path segment that names a record rather than a route: a uuid, or one carrying a digit that
# is long or `_`-joined (`proj_1`, `job_80cb…`, a sha). `v1`, `s3`, `s3-import` stay as they are.
_ID_SEGMENT = re.compile(r'[0-9a-fA-F-]{36}|(?=[^/]*\d)(?:[^/]{16,}|[^/]*_[^/]*)')
_EXECUTION_NAME = re.compile(r':execution:[^:]+:([^:]+)\Z')


def api_query(level: str, row_limit: int) -> str:
    """Insights query of the access log: 5xx, plus the telling 4xx in `warning` mode."""
    quiet = ', '.join(f'"{status}"' for status in sorted(QUIET_CLIENT_STATUSES))
    statuses = rf'/^[45]\d\d$/ and status not in [{quiet}]' if level == 'warning' else r'/^5\d\d$/'
    return (f'filter status like {statuses} and userAgent not like /voc-e2e\\// | {_API_FIELDS} '
            f'| sort @timestamp desc | limit {row_limit}')


def workflow_query(row_limit: int) -> str:
    """Insights query of the state machines' logs: the failure events only."""
    events = ', '.join(f'"{event}"' for event in WORKFLOW_FAILURES)
    return f'filter type in [{events}] | {_WORKFLOW_FIELDS} | sort @timestamp desc | limit {row_limit}'


def normalized_path(path: str) -> str:
    """`/v1/projects/proj_1/jobs/0b6a…` → `/v1/projects/{id}/jobs/{id}`."""
    return '/'.join('{id}' if _ID_SEGMENT.fullmatch(segment) else segment for segment in path.split('/'))


def _api_level(status: str, wanted: tuple[str, ...]) -> str | None:
    if not _STATUS.fullmatch(status):
        return None
    if status.startswith('5'):
        return HTTP_LEVEL if HTTP_LEVEL in wanted else None
    if status.startswith('4') and status not in QUIET_CLIENT_STATUSES and WARNING_LEVEL in wanted:
        return WARNING_LEVEL
    return None


_SAMPLE_KEYS: Final = ('requestId', 'requestTime', 'httpMethod', 'path', 'resourcePath', 'status',
                       'integrationStatus', 'errorMessage', 'responseLength', 'userAgent')
_EMPTY: Final = ('', '-')


def _api_sample(row: dict[str, str]) -> str:
    return '\n'.join(f'{key}: {row[key]}' for key in _SAMPLE_KEYS if (row.get(key) or '') not in _EMPTY)


def _api_detail(row: dict[str, str]) -> str:
    """The gateway's own error message, else the status the Lambda integration returned."""
    reason = row.get('errorMessage') or ''
    if reason not in _EMPTY:
        return reason
    integration = row.get('integrationStatus') or ''
    return f'integration {integration}' if integration not in _EMPTY else ''


def classify_api(row: dict[str, str], wanted: tuple[str, ...]) -> LogLine | None:
    """One access-log row as a `LogLine` (`function` = `api`), or None when it is not wanted."""
    if E2E_USER_AGENT in (row.get('userAgent') or ''):
        return None
    status = (row.get('status') or '').strip()
    level = _api_level(status, wanted)
    if level is None:
        return None
    method = row.get('httpMethod') or '?'
    path = normalized_path(row.get('path') or row.get('resourcePath') or '?')
    text = f'{method} {path} → {status} {_api_detail(row)}'.strip()
    return LogLine(function=API_FUNCTION, level=level, text=text, sample=_api_sample(row),
                   timestamp=iso_timestamp(row.get('@timestamp', '')), request_id=row.get('requestId') or None,
                   source=SOURCE_API)


def _workflow_details(row: dict[str, str]) -> tuple[str, str, str, str]:
    """(type, error, cause, execution arn), from the query's fields or else the raw JSON line."""
    event_type, error = row.get('type') or '', row.get('details.error') or ''
    cause, arn = row.get('details.cause') or '', row.get('execution_arn') or ''
    if not (event_type and arn):
        parsed = json_object(row.get('@message') or '') or {}
        raw_details = parsed.get('details')
        details = raw_details if isinstance(raw_details, dict) else {}
        event_type = event_type or str(parsed.get('type') or '')
        error = error or str(details.get('error') or '')
        cause = cause or str(details.get('cause') or '')
        arn = arn or str(parsed.get('execution_arn') or '')
    return event_type, error, cause, arn


def execution_name(arn: str) -> str | None:
    """The execution name: the last `:`-separated field of an execution ARN."""
    match = _EXECUTION_NAME.search(arn)
    return match.group(1) if match else None


def classify_workflow(row: dict[str, str], function: str, wanted: tuple[str, ...]) -> LogLine | None:
    """One Step Functions failure event as a `LogLine` (`function` = the state machine).

    An aborted execution is a person's or the runtime's own cancellation ("Cancelled by an
    admin", a superseded run), not a failure: it reads as a WARNING, listed in warning mode only.
    """
    event_type, error, cause, arn = _workflow_details(row)
    if event_type not in WORKFLOW_FAILURES:
        return None
    level = WARNING_LEVEL if event_type == 'ExecutionAborted' else ERROR_LEVEL
    if level not in wanted:
        return None
    cause = cause[:MAX_CAUSE_CHARS]
    head = f'{event_type}: {error}' if error else event_type
    text = f'{head} - {cause}' if cause else head
    return LogLine(function=function, level=level, text=text, sample=text,
                   timestamp=iso_timestamp(row.get('@timestamp', '')), request_id=execution_name(arn),
                   source=SOURCE_WORKFLOW)
