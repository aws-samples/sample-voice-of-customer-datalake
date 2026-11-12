"""What a person reads of an engineering run, behind the Agents API's ``/agents/engineering/<run_id>/…`` routes.

The board (its tasks, each with its history), the conversation (the run's messages in order, as data) and the
reports (an index of each report's latest written version, and a version's document and Markdown). Everything here
reads the run's record (the ``voc-engineering`` table and the workspace bucket); who may read is the route's to
decide (``api/agents_handler.py``), and an unknown run reads as None, which the route answers 404.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from engineering.board.store import BoardStore
from engineering.bus.publish import new_event_id
from engineering.connectors.identity import WORKSPACE
from engineering.conversation.store import ConversationStore
from engineering.reports.store import ReportStore
from engineering.rows import TAIL_WINDOW, next_after, window_page, window_start
from engineering.workspace.layout import REPORT_LEVELS, report_key
from engineering.workspace.store import WorkspaceStore


@dataclass(frozen=True)
class Report:
    document: dict[str, Any]
    markdown: str


class EngineeringViews:
    def __init__(self, client: Any, table: str, workspace: WorkspaceStore) -> None:
        """``client`` is a low-level DynamoDB client; the three stores share it."""
        self.board_store = BoardStore(client, table, new_id=new_event_id)
        self.conversation_store = ConversationStore(client, table)
        self.report_store = ReportStore(client, table, workspace)

    def run_exists(self, run_id: str) -> bool:
        return self.board_store.run_exists(WORKSPACE, run_id)

    def board(self, run_id: str) -> dict[str, Any] | None:
        if not self.run_exists(run_id):
            return None
        history = self.board_store.history(WORKSPACE, run_id)
        return {'tasks': [{**task.view(), 'history': [move.view() for move in history.get(task.task_id, ())]}
                          for task in self.board_store.tasks(WORKSPACE, run_id)]}

    def conversation(self, run_id: str, *, after: int, limit: int) -> dict[str, Any] | None:
        """A page of the conversation after ``after`` (a seq); ``next_after`` is where the next page starts.

        Two writers may commit their numbers out of order (engineering/conversation/store.py), so a message just
        below the newest can land after a reader passed it. Every page re-reads the ``TAIL_WINDOW`` messages below
        ``after`` (``rows.window_start``), a full page as much as the tail, and moves on to its last seq: at most
        ``limit`` messages above ``after`` and the window's again, which the reader keeps once, by its ``seq``.
        """
        if not self.run_exists(run_id):
            return None
        read = self.conversation_store.page(WORKSPACE, run_id, after=window_start(after), limit=limit + TAIL_WINDOW)
        items = window_page(after, read, limit, lambda item: item['seq'])
        return {'items': items, 'next_after': next_after(after, [item['seq'] for item in items])}

    def reports(self, run_id: str) -> dict[str, Any] | None:
        if not self.run_exists(run_id):
            return None
        return {'items': [{'level': entry.level, 'subject': entry.subject, 'latest_version': entry.latest_version}
                          for entry in self.report_store.index(WORKSPACE, run_id)]}

    def report(self, run_id: str, level: str, subject: str, version: int | None) -> Report | None:
        """A version of a report (``None``: the latest written), or None when there is no such report or version."""
        if level not in REPORT_LEVELS:
            return None
        latest = self.report_store.latest(WORKSPACE, run_id, level, subject)
        wanted = latest if version is None else version
        if not 1 <= wanted <= latest:
            return None   # (so a report was published under this subject, which makes it a valid key)
        keys = (report_key(WORKSPACE, run_id, level, subject, wanted),
                report_key(WORKSPACE, run_id, level, subject, wanted, 'md'))
        # A version below the latest can have been counted and never written (its build failed between the counter and
        # the put): it reads as missing (the Agents API builds its store with denied_is_missing, having no ListBucket).
        document, markdown = (self.report_store.workspace.read_text(key) for key in keys)
        if document is None or markdown is None:
            return None
        return Report(json.loads(document), markdown)
