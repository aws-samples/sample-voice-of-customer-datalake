"""Grouping of CloudWatch Logs Insights rows for `GET /logs/system` (shared/system_logs.py).

Turns the rows one search returned into the groups Administration → System → Logs
shows: one per (function, level, normalized message), newest first. Every text that
leaves this module went through `shared.pii_redaction.redact_text` (regex only) and is
truncated. Nothing here logs a row: the rows are the deployment's own log lines and
may carry anything a handler printed.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Final

from shared.pii_redaction import redact_text

MAX_GROUPS: Final = 200
MAX_MESSAGE_CHARS: Final = 300
MAX_SAMPLE_CHARS: Final = 6000  # a whole Python stack trace (2000 cut them, 5.43)

ERROR_LEVELS: Final = ('ERROR', 'CRITICAL')
WARNING_LEVELS: Final = ('ERROR', 'CRITICAL', 'WARNING')
PLATFORM: Final = 'PLATFORM'
#: Exceptions raised on purpose to refuse a request (see ``_expected_level``).
EXPECTED_REFUSALS: Final = ('SignUpRefusedError',)

# Lambda's own lines (no structured `level`): timeouts, runtime crashes, failed inits.
# One text for both the Insights filter (shared/system_logs.py) and this classifier, so
# a line the query selects is always recognised here; plain groups only (Insights regex).
PLATFORM_TEXT: Final = (r'Task timed out|Runtime\.[A-Za-z]+(Error|Exception)|Status: (timeout|error)'
                        r'|Process exited before completing|Runtime exited')
_PLATFORM_LINE = re.compile(PLATFORM_TEXT)
_REPORT_LINE = re.compile(r'^\s*(?:INIT_|RESTORE_)?REPORT\b')
_REPORT_STATUS = re.compile(r'Status: (\w+)')
_REPORT_ERROR_TYPE = re.compile(r'Error Type: ([\w.]+)')
# A Node.js text line: `<iso ts>\t<request id>\t<LEVEL>\t<message>`.
_NODE_LINE = re.compile(r'^\S+\t\S+\t(ERROR|WARN|INFO|DEBUG|FATAL)\t(.*)\Z', re.DOTALL)
# A plain Python runtime line: `[LEVEL]\t<ts>\t<request id>\t<message>` (or `[ERROR] Runtime.X: …`).
_PYTHON_LINE = re.compile(r'^\[(ERROR|CRITICAL|WARNING)\]\s+(.*)\Z', re.DOTALL)
_PYTHON_PREFIX = re.compile(r'^\S+Z?\t[0-9a-f-]{36}\t')
_TEXT_LEVELS: Final = {'ERROR': 'ERROR', 'FATAL': 'CRITICAL', 'WARN': 'WARNING',
                       'CRITICAL': 'CRITICAL', 'WARNING': 'WARNING'}

_NORMALIZERS: Final = (
    (re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?'), '<time>'),
    (re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b'), '<id>'),
    # `_` counts as a separator: `job_80cbfb058cf7408f` groups as `job_<hex>` (a word boundary would not split it).
    (re.compile(r'(?<![0-9A-Za-z])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,}(?![0-9A-Za-z])'), '<hex>'),
    (re.compile(r"'[^'\n]{0,200}'|\"[^\"\n]{0,200}\""), '<value>'),
    (re.compile(r'\b\d+(?:\.\d+)?\b'), '<n>'),
    (re.compile(r'\s+'), ' '),
)


@dataclass(frozen=True)
class LogLine:
    """One row of a search, already classified; `text` is raw (unredacted)."""

    function: str
    level: str
    text: str
    sample: str
    timestamp: str
    request_id: str | None
    source: str = 'lambda'


@dataclass
class _Group:
    source: str
    function: str
    level: str
    message: str
    newest: LogLine
    first_seen: str
    count: int = 0

    def add(self, line: LogLine) -> None:
        self.count += 1
        if line.timestamp > self.newest.timestamp:
            self.newest = line
        self.first_seen = min(self.first_seen, line.timestamp)


def normalize(text: str) -> str:
    """`text` with ids, times, numbers and quoted values replaced: the grouping key."""
    normalized = text
    for pattern, placeholder in _NORMALIZERS:
        normalized = pattern.sub(placeholder, normalized)
    return normalized.strip()


def iso_timestamp(value: str) -> str:
    """Insights' `2026-10-27 08:44:43.123` as `2026-10-27T08:44:43.123Z`; other shapes unchanged."""
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)', value.strip())
    return f'{match.group(1)}T{match.group(2)}Z' if match else value


def _report_message(raw: str) -> str:
    """A compact text for a REPORT line: its duration and memory figures vary on every call."""
    status = _REPORT_STATUS.search(raw)
    error_type = _REPORT_ERROR_TYPE.search(raw)
    kind = raw.strip().split(' ', 1)[0]
    text = f'{kind}: invocation ended with Status: {status.group(1) if status else "error"}'
    return f'{text} (Error Type: {error_type.group(1)})' if error_type else text


def _text_line(raw: str, wanted: tuple[str, ...]) -> tuple[str, str] | None:
    """(level, message) of a line with no structured level, or None when it is not wanted."""
    matched = _NODE_LINE.match(raw) or _PYTHON_LINE.match(raw)
    if matched is not None:
        level = _TEXT_LEVELS.get(matched.group(1), '')
        message = _PYTHON_PREFIX.sub('', matched.group(2))
        # `[ERROR] Runtime.ImportModuleError: …` is the runtime's crash, not a handler's log.
        if level == 'ERROR' and _PLATFORM_LINE.search(message):
            return PLATFORM, message
        return (level, message) if level in wanted else None
    if _PLATFORM_LINE.search(raw):
        return PLATFORM, _report_message(raw) if _REPORT_LINE.match(raw) else raw
    return None


def json_object(raw: str) -> dict[str, object] | None:
    if not raw.lstrip().startswith('{'):
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def classify(row: dict[str, str], function: str, wanted: tuple[str, ...]) -> LogLine | None:
    """One Insights row (field → value) as a `LogLine`, or None when its level is not wanted."""
    raw = row.get('@message', '')
    structured = row.get('level') or ''
    message = row.get('message') or ''
    exception = row.get('exception') or ''
    if not structured:
        parsed = json_object(raw)
        if parsed is not None:
            structured = str(parsed.get('level') or '')
            message = message or str(parsed.get('message') or '')
            exception = exception or str(parsed.get('exception') or '')
    if structured:
        level = _TEXT_LEVELS.get(structured.upper(), '')
        if level not in wanted:
            return None
        text = message or raw
        sample = f'{text}\n{exception}' if exception else text
    else:
        found = _text_line(raw, wanted)
        if found is None:
            return None
        level, text = found
        sample = raw
    request_id = row.get('function_request_id') or row.get('@requestId') or None
    level = _expected_level(level, text)
    if level not in wanted and level != PLATFORM:
        return None
    return LogLine(function=function, level=level, text=text, sample=sample,
                   timestamp=iso_timestamp(row.get('@timestamp', '')), request_id=request_id)


def _expected_level(level: str, text: str) -> str:
    """An ERROR that is a designed refusal, not a failure, reads as a WARNING.

    The board PreSignUp trigger must RAISE to refuse a sign-up (Cognito's contract), so the
    runtime logs every refused address (`SignUpRefusedError: domain_not_allowed`) as an error.
    It is the trigger doing its job; listing it among the errors hides the real ones.
    """
    return 'WARNING' if level == 'ERROR' and text.lstrip().startswith(EXPECTED_REFUSALS) else level


def line_level(row: dict[str, str]) -> str:
    """The level of ANY line of one invocation (INFO included), for `GET /logs/system/request`."""
    raw = row.get('@message', '')
    structured = row.get('level') or ''
    if not structured:
        parsed = json_object(raw)
        structured = str(parsed.get('level') or '') if parsed is not None else ''
    if structured:
        return _TEXT_LEVELS.get(structured.upper(), structured.upper()[:16])
    matched = _NODE_LINE.match(raw) or _PYTHON_LINE.match(raw)
    if matched is not None:
        return _TEXT_LEVELS.get(matched.group(1), matched.group(1))
    if _PLATFORM_LINE.search(raw) or _REPORT_LINE.match(raw) or raw.startswith(('START ', 'END ')):
        return PLATFORM
    return 'INFO'


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _group_message(line: LogLine) -> str:
    """The redacted grouping text. An API row's text is already normalized (`{id}` path,
    `<METHOD> <path> → <status> <detail>`): its status code is the point of the row, so its
    numbers are kept — `→ 403` and `→ 500` are different problems."""
    redacted = redact_text(line.text).text
    return ' '.join(redacted.split()) if line.source == 'api' else normalize(redacted)


def group_lines(lines: list[LogLine]) -> list[dict[str, object]]:
    """The response groups: newest `last_seen` first, at most `MAX_GROUPS`, every text redacted.

    The grouping key is built from the REDACTED text, so a group's `message` is already
    clean; only the newest raw sample is redacted on the way out.
    """
    groups: dict[tuple[str, str, str, str], _Group] = {}
    for line in lines:
        message = _group_message(line)
        key = (line.source, line.function, line.level, message)
        group = groups.get(key)
        if group is None:
            group = groups[key] = _Group(line.source, line.function, line.level, message, line, line.timestamp)
        group.add(line)
    ordered = sorted(groups.values(), key=lambda g: g.newest.timestamp, reverse=True)[:MAX_GROUPS]
    return [{
        'source': group.source,
        'function': group.function,
        'level': group.level,
        'message': truncate(group.message, MAX_MESSAGE_CHARS),
        'sample': truncate(redact_text(group.newest.sample).text, MAX_SAMPLE_CHARS),
        'count': group.count,
        'first_seen': group.first_seen,
        'last_seen': group.newest.timestamp,
        'request_id': group.newest.request_id,
    } for group in ordered]
