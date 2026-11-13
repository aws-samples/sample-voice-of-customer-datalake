"""The report builder Lambda: ``{run_id, level, subject[, head]}`` in, a new version of that report published.

Invoked by the trusted parts of a run: asynchronously by the run coordinator's closing task and the supervisor (the
goal report) and at the run's end (each commit report); synchronously by the write broker before it opens a pull
request (``level: pr``, the PR's number and its ``head`` commit), which takes the PR report's Markdown
(``markdown_key`` in the answer) as the description. It reads the run's record only: its table rows and the workspace
keys its tasks recorded. A refused request is logged, since an asynchronous caller never reads the answer.
"""
from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

from engineering.board.store import BoardStore
from engineering.bus.publish import new_event_id
from engineering.connectors.identity import WORKSPACE
from engineering.reports.build import build_report, gather
from engineering.reports.facts import FactsReader
from engineering.reports.render import render_markdown
from engineering.reports.store import ReportStore
from engineering.workspace.layout import ID, SHA
from engineering.workspace.store import WorkspaceStore
from shared.logging import logger, metrics
from shared.timestamps import now_iso

_PR = re.compile(r'[1-9][0-9]{0,9}\Z')
USAGE = 'run_id, and level commit (subject: its full sha) | pr (subject: its number, head: its full sha) | goal'


class Reports:
    def __init__(self, client: Any, table: str, workspace: WorkspaceStore) -> None:
        self.facts = FactsReader(client, table)
        self.board = BoardStore(client, table, new_id=new_event_id)
        self.workspace = workspace
        self.store = ReportStore(client, table, workspace)

    def build(self, run_id: str, level: str, subject: str, head: str = '') -> dict[str, Any]:
        facts = self.facts.read(WORKSPACE, run_id)
        if facts is None:
            logger.warning('reports: no such run', extra={'run_id': run_id, 'level': level})
            return {'status': 'refused', 'reason': 'no such run'}
        inputs = gather(facts, self.board.tasks(WORKSPACE, run_id), self.workspace.read_text, head=head,
                        history=self.board.history(WORKSPACE, run_id))
        at = now_iso()

        def document(version: int) -> tuple[dict[str, Any], str]:
            report = build_report(level, subject, inputs, version=version, built_at=at, head=head)
            return report, render_markdown(report, inputs.gate)

        published = self.store.publish(WORKSPACE, run_id, level, subject, document=document)
        return {'status': 'published', 'version': published.version, 'key': published.key,
                'markdown_key': published.markdown_key}


def _text(event: Mapping[str, Any], key: str) -> str:
    value = event.get(key, '')
    return value if isinstance(value, str) else ''


def _request(event: Mapping[str, Any]) -> tuple[str, str, str, str] | None:
    run_id, level, subject, head = (_text(event, key) for key in ('run_id', 'level', 'subject', 'head'))
    if not ID.fullmatch(run_id):
        return None
    valid = ((level == 'commit' and SHA.fullmatch(subject) and not head)
             or (level == 'pr' and _PR.fullmatch(subject) and SHA.fullmatch(head))
             or (level == 'goal' and subject == run_id and not head))
    return (run_id, level, subject, head) if valid else None


_reports: Reports | None = None


@metrics.log_metrics   # (the workspace store's count of denied reads taken as missing)
def handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """``context`` is unused."""
    global _reports   # the warm container's clients, built once
    del context
    request = _request(event)
    if request is None:
        logger.warning('reports: a request off the contract', extra={'level': _text(event, 'level')})
        return {'status': 'refused', 'reason': USAGE}
    if _reports is None:
        from shared.aws import get_dynamodb_client, get_s3_client

        _reports = Reports(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'],
                           # No ListBucket (engineering-bus.ts): a missing object answers 403. It may read every runs'
                           # key, so a denial reads as missing, and the store logs and counts each one
                           # (EngineeringWorkspaceDeniedReads: a real KMS or policy denial shows there).
                           WorkspaceStore(get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET'],
                                          denied_is_missing=True))
    return _reports.build(*request)
