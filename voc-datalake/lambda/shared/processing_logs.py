"""The ``LOGS#…`` rows the processor writes and ``GET /logs/*`` reads back.

A stored row never carries the exception text (it can quote customer data); it carries one of these fixed
messages, which the logs API also answers with for a row whose error type it does not recognise.

A message stored in a workspace logs its failures there (``WS#{ws}#LOGS#{kind}#{source}``, processor/handler.py
``_log_row_base``); one stored deployment-wide at ``LOGS#{kind}#{source}``, as before. ``log_partition`` is that key for
the readers (api/logs_handler.py).
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

PROCESSING_FAILED_MESSAGE: Final = 'Processing failed; details are in the processor CloudWatch logs'
THROTTLED_MESSAGE: Final = 'Bedrock throttled the request; SQS will retry the message'


def log_partition(kind: str, source: str, workspace: WorkspaceScope | None = None) -> str:
    """The partition of ``kind`` (``validation``, ``processing``) logs of ``source``: the deployment's, or the
    workspace's (a message with no source logs under ``unknown`` there, as the processor writes it)."""
    return f'LOGS#{kind}#{source}' if workspace is None else workspace.key('LOGS', kind, source or 'unknown')
