"""A workspace's agents and workflows in its export (7.80.00, docs/multi-workspace.md, the project plan 3g3-a).

* ``agents_workflows``: voc-agents' registry of the workspace's partitions, ``WS#{ws}#AGENT_REGISTRY`` (shared/ws_repo.py
  ``agent_registry_pk``: one row per agent and per workflow, written in the same transaction as its first row; a page
  of at most ``REGISTRY_PAGE`` rows, strongly consistent), then each listed partition by its listed row kinds only,
  each by its own key condition (a kind a later release adds is never read until it is listed here):

  - an agent's ``WS#{ws}#AGENT#{id}``: its ``META`` (``AGENT_FIELDS``) and its pause and resume history, ``LOG#``
    (``LOG_FIELDS``);
  - a workflow's ``WS#{ws}#WORKFLOW#{id}``: its ``CURRENT`` row (``CURRENT_FIELDS``) and every saved revision, ``REV#``
    (``REVISION_FIELDS``).

  Each row with only the fields it lists: what the agents API serves of it, plus its key. So never an index key
  (``gsi1pk``, ``gsi1sk``), the run lock (``active_run_id``), a counter (``runs_*``, ``scheduled_*``, ``month_*``), the
  heartbeat's trigger state or skip reason, an engineering agent's settings (none is in a workspace until 3g3-c), nor
  a saver's or archiver's sub on a workflow (``saved_by``, ``created_by``, ``archived_by``, which the API never
  serves). An agent's ``owner_sub``, ``created_by``, ``updated_by`` and ``paused_by`` and a history row's ``by`` are
  members' ids, the workspace's own collaboration data, as the project entities carry them.

A registry row of another shape (a later release's) is skipped and counted (``agents.registry_rows_skipped``). Not
exported: the agents' runs and their journals (``RUN#`` rows, ``WS#{ws}#RUN#{run}``): no run is written in a workspace
by this release (the agents API refuses one until the agents' runtime moves into the workspace).

The cursor carries the registry's key (``reg``, ``reg_done``), the listed entries still to do (``todo``, one page of
at most ``REGISTRY_PAGE``), which listed row kind it is in (``part``) and the Query's key (``start``), each checked as
it is read (``check_cursor``: a malformed one fails the job as a malformed run state).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final

from jobs.workspace_export.pages import TABLE_KEY, Page, Row, items, key, last_key, only, sort_key, start
from shared.agent_ids import AGENT_ID_RE, WORKFLOW_ID_RE
from shared.ws_repo import WorkspaceScope, WorkspaceTable, agent_pk, agent_registry_pk, workflow_pk

__all__ = ['ENTITIES', 'SKIPPED', 'AgentsSource', 'check_cursor']

ENTITIES: Final = ('agents_workflows',)
#: The registry rows one page reads at most (the cursor carries them).
REGISTRY_PAGE: Final = 100
#: The count of the registry rows of a shape this release does not list.
SKIPPED: Final = 'agents_registry_skipped'
#: An agent: the agents API's view of it (shared/agents_store.py ``agent_view``, without its derived ``stats``) and
#: its key.
AGENT_FIELDS: Final = (
    'pk', 'sk', 'agent_id', 'name', 'description', 'enabled', 'owner_sub', 'scope', 'instructions', 'personas',
    'triggers', 'models', 'output', 'workflow_id', 'budget', 'status', 'created_by', 'created_at', 'updated_by',
    'updated_at', 'paused', 'paused_at', 'paused_by',
)
#: A pause or resume history row (``set_paused``): who, when, what and through what.
LOG_FIELDS: Final = ('pk', 'sk', 'event', 'at', 'via', 'by', 'username')
#: A workflow's current row: the API's ``workflow_view`` fields as stored, and its key.
CURRENT_FIELDS: Final = (
    'pk', 'sk', 'workflow_id', 'slug', 'name', 'description', 'revision', 'definition', 'derived_from', 'created_at',
    'updated_at', 'updated_by_username', 'status',
)
#: A saved revision: the API's ``_revision_view`` fields as stored, and its key.
REVISION_FIELDS: Final = ('pk', 'sk', 'workflow_id', 'revision', 'name', 'definition', 'saved_at', 'saved_by_username')
#: Each listed partition's row kinds, in order: the sort condition and its values, and the fields kept.
_KINDS: Final[Mapping[str, tuple[tuple[dict[str, Any], tuple[str, ...]], ...]]] = {
    'AGENT': ((sort_key('#sk = :sk', {':sk': 'META'}), AGENT_FIELDS),
              (sort_key('begins_with(#sk, :sk)', {':sk': 'LOG#'}), LOG_FIELDS)),
    'WORKFLOW': ((sort_key('#sk = :sk', {':sk': 'CURRENT'}), CURRENT_FIELDS),
                 (sort_key('begins_with(#sk, :sk)', {':sk': 'REV#'}), REVISION_FIELDS)),
}
#: A registry row this release lists (its ``sk``): an agent's or a workflow's, by the ids' own shapes
#: (shared/agent_ids.py, which the layer checks before it builds their keys), so the two cannot drift apart.
_LISTED: Final = re.compile(f'(AGENT)#({AGENT_ID_RE.pattern})|(WORKFLOW)#({WORKFLOW_ID_RE.pattern})')


def _entry(value: object) -> tuple[str, str]:
    """``(kind, id)`` of a listed registry entry; ValueError for anything else."""
    found = _LISTED.fullmatch(value) if isinstance(value, str) else None
    if found is None:
        raise ValueError('an agents cursor names an entry that is not an agent or a workflow')
    kind = found.group(1) or found.group(3)
    return kind, found.group(2) or found.group(4)


def check_cursor(cursor: Mapping[str, Any]) -> None:
    """A carried ``agents_workflows`` cursor's own fields (handler.py ``RunState.from_event``): ``todo`` a list of
    listed entries (at most a page), ``part`` a row kind of the first one; ValueError otherwise. Every key the cursor
    names is checked again by the workspace layer before a Query is sent."""
    todo, part = cursor.get('todo') or [], cursor.get('part') or 0
    if not isinstance(todo, list) or len(todo) > REGISTRY_PAGE:
        raise ValueError('an agents cursor carries no list of entries')
    kinds = [_entry(entry)[0] for entry in todo]
    if isinstance(part, bool) or not isinstance(part, int) or part < 0 or (kinds and part >= len(_KINDS[kinds[0]])):
        raise ValueError('an agents cursor names no row kind')


class AgentsSource:
    """One workspace's agents and workflows, through its view of voc-agents."""

    def __init__(self, scope: WorkspaceScope, agents: WorkspaceTable) -> None:
        self.scope = scope
        self._agents = agents

    def page(self, _entity: str, cursor: Mapping[str, Any]) -> Page:
        """One page: the next registry page's entries (no rows), or one page of a listed partition's row kind."""
        check_cursor(cursor)
        todo = list(cursor.get('todo') or [])
        here = {'reg': cursor.get('reg'), 'reg_done': bool(cursor.get('reg_done'))}
        if not todo:
            return self._registry_page(cursor)
        kind, row_id = _entry(todo[0])
        partition = agent_pk(self.scope, row_id) if kind == 'AGENT' else workflow_pk(self.scope, row_id)
        part = int(cursor.get('part') or 0)
        condition, fields = _KINDS[kind][part]
        page = self._agents.query('pk', partition, ConsistentRead=True, **condition, **start(cursor.get('start')))
        rows = [Row(only(item, fields), {**here, 'todo': todo, 'part': part, 'start': key(item, TABLE_KEY)})
                for item in items(page)]
        following = last_key(page)
        if following is not None:
            return Page(rows, {**here, 'todo': todo, 'part': part, 'start': following})
        if part + 1 < len(_KINDS[kind]):
            return Page(rows, {**here, 'todo': todo, 'part': part + 1, 'start': None})
        return Page(rows, {**here, 'todo': todo[1:], 'part': 0, 'start': None})

    def _registry_page(self, cursor: Mapping[str, Any]) -> Page:
        """The next registry page's listed entries to do (a row of another shape skipped and counted), or the end."""
        if cursor.get('reg_done'):
            return Page([], None)
        page = self._agents.query('pk', agent_registry_pk(self.scope), Limit=REGISTRY_PAGE, ConsistentRead=True,
                                  **start(cursor.get('reg')))
        listed = [str(item['sk']) for item in items(page) if _LISTED.fullmatch(str(item.get('sk', '')))]
        skipped = len(items(page)) - len(listed)
        following = last_key(page)
        return Page([], {'reg': following, 'reg_done': following is None, 'todo': listed, 'part': 0, 'start': None},
                    {SKIPPED: skipped} if skipped else {})
