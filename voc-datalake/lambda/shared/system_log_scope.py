"""What of the deployment's diagnostics a workspace's content may reach: nothing (TENETS.md D8).

Administration → System → Logs (``GET /logs/system*``, lambda/api/logs_handler.py) spans every workspace and is read by
the deployment's ``admins``, whose group grants nothing inside a workspace. So what it shows is held to the
deployment's own: a platform admin who needs a workspace's details enters that workspace (decision 2, live-checked
and audited); nothing here is a way round that.

* Attribution. Every line of the shared logger carries ``workspace_id`` (``tag_record``, a filter shared/usage_meter.py
  installs): the workspace the code resolved for this context, as the Bedrock meter counts it (``DEPLOYMENT`` once a
  request or message resolved none, the workspace's id once it resolved one, ``UNATTRIBUTED`` before either; reset at
  each invocation's start and end). Never a header's word: a job that does not call ``message_scope`` and a public
  route that finds its workspace from a stored row resolve nothing through the resolvers, so their lines stay
  ``UNATTRIBUTED``.
* A text names a workspace when it holds a workspace id or a workspace key (``WS#``): ``names_a_workspace``. A backstop:
  it cannot see a workspace's slug or content that carries no id, so the tag carries the rule.
* A failure queue's message body is shown only when it parses (JSON), names no workspace and holds nothing encoded (a
  long base64 run): ``queue_body_shown``. Every other sampled message is counted, never shown.
* A System errors line, or a line of one request: one that names a workspace is dropped and counted; one tagged
  ``DEPLOYMENT`` reads as before; Lambda's own fixed lines (``runtime_line``: a timeout, START / END / REPORT) read as
  before; every other line shows its time, function, level and error type (``error_type``: the exception's name, never
  its message), flagged ``withheld`` (the page says why, in the reader's language).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Final

from shared.workspace_ids import WORKSPACE_FIELD, WORKSPACE_ID_TEXT

#: The log key every line carries: the field an asynchronous message names its workspace in.
WORKSPACE_TAG: Final = WORKSPACE_FIELD
_NAMES_A_WORKSPACE: Final = re.compile(f'{WORKSPACE_ID_TEXT}|(?<![A-Z])WS#')
#: A long run of base64: an encoded payload or cursor, which could hold anything (a hyphenated name is no such run).
_ENCODED: Final = re.compile(r'[A-Za-z0-9+/]{48,}={0,2}')
#: An error's name: a dotted path's last part ending in Error or Exception (``Runtime.`` kept: the runtime's crash).
_ERROR_NAME: Final = re.compile(r'((?:[A-Za-z_]\w*\.)*)([A-Z]\w*(?:Error|Exception))')
#: Lambda's own fixed lines: what the runtime writes, never a handler's text. A REPORT holds only its own fields
#: (``Duration: 1.23 ms``, ``Status: timeout``, ``Error Type: Runtime.ExitError``…), nothing else on one line.
_RUNTIME_LINE: Final = re.compile(
    r'\s*(?:(?:START|END) RequestId: [0-9a-f-]{36}(?: Version: \S+)?'
    r'|REPORT RequestId: [0-9a-f-]{36}(?:\t[A-Z][A-Za-z ]*: [\w.$:-]+(?: ms| MB)?)+\t?'
    r'|\S+ [0-9a-f-]{36} Task timed out after [\d.]+ seconds)\s*')
#: A workflow failure's error: a ``States.*`` error or an error's name, nothing else shown.
_WORKFLOW_ERROR: Final = re.compile(r'States\.[A-Za-z]+|(?:[A-Za-z_]\w*\.)*[A-Z]\w*(?:Error|Exception)')


def names_a_workspace(text: str) -> bool:
    """Whether ``text`` holds a workspace id or a workspace key (``WS#…``)."""
    return _NAMES_A_WORKSPACE.search(text) is not None


def queue_body_shown(body: str) -> bool:
    """Whether a failure queue's message body may be shown: it parses as JSON, names no workspace and holds no
    encoded run."""
    try:
        json.loads(body)
    except ValueError:
        return False
    return not names_a_workspace(body) and _ENCODED.search(body) is None


def _name(match: re.Match[str]) -> str:
    return f'Runtime.{match.group(2)}' if match.group(1) == 'Runtime.' else match.group(2)


def error_type(text: str, exception_name: str = '') -> str:
    """The error's type: the record's exception name when it is one, else the last line of ``text`` that starts with
    ``Name:`` (a traceback's last line, ``ValidationException: …``); '' when none. A word inside a message is never
    taken."""
    recorded = _ERROR_NAME.fullmatch(exception_name.strip())
    if recorded is not None:
        return _name(recorded)
    names = [match for line in text.splitlines()
             if (match := _ERROR_NAME.match(line.strip())) is not None and line.strip()[match.end():][:1] in {':', ''}]
    return _name(names[-1]) if names else ''


def workflow_error(error: str) -> str:
    """A workflow failure's error as shown: ``States.TaskFailed`` or an error's name, '' for anything else."""
    return error if _WORKFLOW_ERROR.fullmatch(error) else ''


def runtime_line(raw: str) -> bool:
    """Whether ``raw`` is one of Lambda's own fixed lines (START, END, REPORT, a timeout), as the runtime writes it."""
    return _RUNTIME_LINE.fullmatch(raw) is not None


def line_tag(row: dict[str, str], record: dict[str, object] | None) -> str:
    """The ``workspace_id`` tag of an Insights row (its field, else its JSON record's), '' when untagged."""
    tag = row.get(WORKSPACE_TAG) or (record or {}).get(WORKSPACE_TAG) or ''
    return tag if isinstance(tag, str) else ''


def tag_record(attribution: str, record: logging.LogRecord) -> None:
    """Put ``attribution`` on ``record`` as its ``workspace_id``, unless the line names one itself (``extra=``)."""
    if not hasattr(record, WORKSPACE_TAG):
        setattr(record, WORKSPACE_TAG, attribution)
