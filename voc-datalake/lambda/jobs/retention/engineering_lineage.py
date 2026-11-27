"""voc-retention: the review ids the engineering agents' runs keep lose an erased one (7.84.00, projects 3g3-b;
TENETS.md D5 and D8; docs/multi-workspace.md, the project plan's 3g3-b).

With ``-c engineeringAgents=true`` an engineering agent's run keeps the ids of the reviews it started from (never
their text), in two places, neither with a ``ttl``:

- its engineering run's ``META`` in voc-engineering, ``WS#default#RUN#<run>`` / ``META``: ``feedback``, ``{ids (at
  most 50), count, category}`` (engineering/runtime/runs.py, written once by the run's start);
- the issue's run claim in voc-agents, ``ISSUE_RUN#default`` / ``<owner/name>#<n>`` (and its triage stage's
  ``…#triage``): ``feedback_id``, the review the GitHub issue was ingested as (shared/agents_store.py
  ``issue_claim_item``, create-only).

The engineering agents are the deployment's, in their own fixed scope (``default``, engineering/connectors/identity.py
``WORKSPACE``), never a workspace of the multi-workspace design, and their runs read only the deployment's own
feedback (D8: ``DATE#`` and ``CHANNEL#issue``, never a workspace's ``WS#{ws}#…``). So only the deployment's tombstones
apply (``{feedback_id}``, lineage.py ``erased_ids``), and a workspace's own job never runs the phase (``has_work``).

Which tombstones a cited id is looked up under (``sources``):

- the deployment's erasure (any field, deleting anything or nothing): every source a run of voc-retention ever deleted
  from, read from the retention audit rows (``AUDIT#retention``, each finished or failed run's ``erased_sources``,
  one strongly consistent Query of their one partition, at most ``MAX_AUDIT_ROWS``, past it the job fails, named),
  with this run's own. So a rerun of an erasure made before 7.84.00, which deletes nothing more, still removes the ids
  it left. Not counted: a source only an invocation killed before it wrote its audit row deleted from;
- the daily retention window: only once it deleted a deployment item, and only the sources it deleted from (its
  trigger: a window that deletes nothing reads nothing here).

An erased id is REMOVED, as from a project's artifacts (lineage.py): a run's ``feedback.ids`` keeps the others (its
``count`` and ``category`` are the trigger's, not ids: kept), a claim loses its ``feedback_id`` (the claim itself stays:
it is what keeps one issue to one run, ever); each row gains ``erased_evidence`` ``{count, job_id, mode, at}``
(lineage.py ``erased_mark``, ``count`` adding up over runs). Each update is conditional on the value read; a row
changed meanwhile is read again and tried again, at most ``MAX_TRIES`` times, then the job fails
(``EngineeringRowKeptChanging``, naming the engineering run). Counted: ``engineering_rows_marked``.

How the rows are found, never by a Scan:

- the claims: their one partition, ``ISSUE_RUN#default``, by Query pages (``PAGE_SIZE``), projected to the key,
  ``feedback_id``, the claim's engineering run and the mark. Bounded by the claims there are: one per issue and stage
  that ever started a run;
- the runs: the runs list's month partitions, ``WS#default#RUNLIST#<yyyy-mm>`` (one row per run started that month,
  since 7.51.00), from ``FIRST_MONTH`` to the clock's month, by Query pages projected to the key; then each listed
  run's ``META`` by one Query of its partition (``sk`` = ``META``), projected to the key, ``feedback`` and the mark.
  Bounded by the months since ``FIRST_MONTH`` (one partition each) and the runs they list. A run started before the
  runs list (7.47.00 to 7.50.00, 2026-11-16 to 2026-11-17) has no list row: its ``META`` is not reached (a gap
  docs/multi-workspace.md names).

The grants (lib/stacks/retention-worker.ts): Query of ``ISSUE_RUN#default`` and UpdateItem there of
``CLAIM_ATTRIBUTES`` only; Query of ``WS#default#RUNLIST#*`` and ``WS#default#RUN#*`` of ``RUN_ATTRIBUTES`` only and
UpdateItem of ``WS#default#RUN#*`` of those only; every Query says ``SPECIFIC_ATTRIBUTES``, no update asks for
anything back. A run partition holds the run's board, conversation and records too: IAM cannot pin the sort key, so
the Query and the UpdateItem reach any row of a run's partition (for those attributes only); the code reads and
updates its ``META`` only (the key condition, the update's key).

The cursor: ``{part: 'claims', start}`` then ``{part: 'runs', month, start}``, each with the ``sources`` once read
(at most ``MAX_CARRIED_SOURCES``), so the audit rows are read once per job, not once per invocation; one of the wrong
shape fails the job (ValueError).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import workspaces
from jobs.retention.lineage import MARK_FIELD, erased_ids, erased_mark
from jobs.retention.runs import AUDIT_PK, MODE_ERASE, job_scope
from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import query_all
from shared.feature_requests_raw import FEATURE_REQUESTS_SOURCE
from shared.logging import logger
from shared.project_walk import StuckQuery, checked_key
from shared.retention import ENGINEERING_MARK_COUNTER, WORKSPACE_ITEM_COUNTER

#: The walk's tables keys: voc-engineering and voc-agents, configured only with -c engineeringAgents=true.
STORE_ENGINEERING: Final = 'engineering'
STORE_AGENTS: Final = 'agents'
#: The engineering agents' fixed scope (engineering/connectors/identity.py ``WORKSPACE``; the retention bundle holds no
#: engineering runtime module, so the keys are spelled here and a test holds them to the runtime's).
ENGINEERING_SCOPE: Final = 'default'
CLAIMS_PARTITION: Final = f'ISSUE_RUN#{ENGINEERING_SCOPE}'
RUNLIST_PREFIX: Final = f'WS#{ENGINEERING_SCOPE}#RUNLIST#'
RUN_PREFIX: Final = f'WS#{ENGINEERING_SCOPE}#RUN#'
#: The first month a runs list was written in (7.51.00).
FIRST_MONTH: Final = '2026-11'
#: What the reads project and the updates name, the key included (the IAM statements' ``dynamodb:Attributes``, held
#: equal by a test); a claim's ``engineering_run_id`` is read only, to name the run of a claim that kept changing.
CLAIM_ATTRIBUTES: Final = ('pk', 'sk', 'feedback_id', 'engineering_run_id', 'erased_evidence')
RUN_ATTRIBUTES: Final = ('pk', 'sk', 'feedback', 'erased_evidence')
PAGE_SIZE: Final = 100
#: How often a mark is tried when its row changed since it was read (as boards.py ``MAX_TRIES``).
MAX_TRIES: Final = 3
#: The most retention audit rows (one per run of voc-retention) the deployment's erasure reads the sources of.
MAX_AUDIT_ROWS: Final = 100_000
_META: Final = 'META'
_MONTH: Final = re.compile(r'\A(\d{4})-(0[1-9]|1[0-2])\Z')
#: A run id (a ULID, engineering/runtime/interface.py ``check_run_id``).
_RUN_ID: Final = re.compile(r'\A[0-9A-HJKMNP-TV-Z]{26}\Z')
_BAD_CURSOR: Final = 'a carried engineering lineage cursor is not one'


class EngineeringRowKeptChanging(RuntimeError):
    """A run's ``META`` or a claim changed under every try of its mark (``MAX_TRIES``): the job fails, naming the
    engineering run, and a rerun of the erasure marks it."""


def applies(tables: Mapping[str, Any]) -> bool:
    """With the engineering tables configured (-c engineeringAgents=true); without them there is nothing to mark."""
    return STORE_ENGINEERING in tables and STORE_AGENTS in tables


def has_work(run: Mapping[str, Any]) -> bool:
    """A run that names no workspace and is the deployment's erasure (always: a rerun reaches what an earlier one
    left), or a retention window that deleted an item of the deployment's own feedback (the only reviews an
    engineering run cites)."""
    if job_scope(run) is not None:
        return False
    if run.get('mode') == MODE_ERASE:
        return True
    return int(run.get('deleted_items') or 0) - int(run.get(WORKSPACE_ITEM_COUNTER) or 0) > 0


def audited_sources(aggregates_table: Any) -> list[str]:
    """Every source a run of voc-retention deleted from, as its audit rows record it (``erased_sources``)."""
    rows = query_all(aggregates_table, {
        'KeyConditionExpression': '#pk = :pk', 'ProjectionExpression': '#sources', 'ConsistentRead': True,
        'ExpressionAttributeNames': {'#pk': 'pk', '#sources': 'erased_sources'},
        'ExpressionAttributeValues': {':pk': AUDIT_PK}}, max_items=MAX_AUDIT_ROWS + 1)
    if len(rows) > MAX_AUDIT_ROWS:
        raise RuntimeError('The retention audit holds more runs than an erasure reads the sources of')
    listed = (source for row in rows if isinstance(row.get('erased_sources'), list) for source in row['erased_sources'])
    return sorted({source for source in listed if isinstance(source, str) and source})


#: The most sources a cursor carries (each a source id: far fewer exist).
MAX_CARRIED_SOURCES: Final = 1_000
_SOURCE: Final = re.compile(r'\A[^\x00-\x1f]{1,200}\Z')


def _checked_sources(carried: object) -> list[str]:
    """A carried list of sources (ValueError when it is not one: a malformed run state)."""
    return workspaces.checked_strings(carried, cap=MAX_CARRIED_SOURCES, pattern=_SOURCE, error=_BAD_CURSOR)


def _next_month(month: str) -> str:
    year, number = (int(part) for part in month.split('-'))
    return f'{year + number // 12:04d}-{number % 12 + 1:02d}'


def _checked_month(value: object) -> str:
    if not isinstance(value, str) or not _MONTH.fullmatch(value) or value < FIRST_MONTH:
        raise ValueError(_BAD_CURSOR)
    return value


class EngineeringLineage:
    """One run's walk of the engineering rows (the module docstring), one step at a time; ``clock`` the wall clock
    its last month is read from."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any],
                 clock: Callable[[], datetime] = workspaces.utc_now) -> None:
        self._run = run
        self._engineering = tables[STORE_ENGINEERING]
        self._agents = tables[STORE_AGENTS]
        self._aggregates = tables['aggregates']
        self._clock = clock
        self._sources: list[str] | None = None

    def _lookup_sources(self) -> list[str]:
        """The sources a cited id's tombstone is looked up under (the module docstring), read once per job (then
        carried in the cursor); reviews only (a board request's tombstone names no review an engineering run cites)."""
        if self._sources is None:
            own = [str(source) for source in self._run.get('erased_sources') or []]
            audited = audited_sources(self._aggregates) if self._run.get('mode') == MODE_ERASE else []
            self._sources = sorted({*own, *audited} - {FEATURE_REQUESTS_SOURCE})
        return self._sources

    def step(self, cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One page from ``cursor`` (None: the start), and the next cursor; None once every month is read. Once the
        sources are read they travel in the cursor (``sources``), so a hand-over never reads the audit rows again."""
        here = dict(cursor) if cursor else {'part': 'claims', 'start': None}
        if 'sources' in here:
            self._sources = _checked_sources(here.pop('sources'))
        following = self._step(here)
        if following is not None and self._sources is not None:
            following['sources'] = list(self._sources)
        return following

    def _step(self, here: dict[str, Any]) -> dict[str, Any] | None:
        if here.get('part') == 'claims':
            following = self._claims_page(checked_key(here.get('start')))
            return {'part': 'claims', 'start': following} if following else {
                'part': 'runs', 'month': FIRST_MONTH, 'start': None}
        if here.get('part') != 'runs':
            raise ValueError(_BAD_CURSOR)
        month, last = _checked_month(here.get('month')), max(FIRST_MONTH, self._clock().strftime('%Y-%m'))
        if month > last:
            return None
        following = self._runs_page(month, checked_key(here.get('start')))
        if following:
            return {**here, 'start': following}
        return None if month == last else {'part': 'runs', 'month': _next_month(month), 'start': None}

    # ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _page(table: Any, partition: str, start: Mapping[str, Any] | None, projection: Sequence[str],
              sort_key: str | None = None) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        """One Query page of ``partition`` (its ``sk`` = ``sort_key`` when given), the ``projection`` only, saying so
        (``SPECIFIC_ATTRIBUTES``: the IAM statements require it); ``StuckQuery`` when it answers with ``start``."""
        names = {f'#a{n}': name for n, name in enumerate(projection)}
        request: dict[str, Any] = {
            'KeyConditionExpression': '#a0 = :pk' + (' AND #a1 = :sk' if sort_key is not None else ''),
            'ProjectionExpression': ', '.join(names), 'Select': 'SPECIFIC_ATTRIBUTES',
            'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': {':pk': partition, **({':sk': sort_key} if sort_key is not None else {})},
            'Limit': PAGE_SIZE}
        if start:
            request['ExclusiveStartKey'] = dict(start)
        page = table.query(**request)
        following = page.get('LastEvaluatedKey') or None
        if following is not None and start and dict(following) == dict(start):
            raise StuckQuery('an engineering Query answered with the key it started from')
        return list(page.get('Items') or []), following

    def _row(self, table: Any, row: Mapping[str, Any], projection: Sequence[str]) -> dict[str, Any] | None:
        """``row`` read again (its key), or None when it is gone."""
        found, _ = self._page(table, str(row['pk']), None, projection, sort_key=str(row['sk']))
        return found[0] if found else None

    def _claims_page(self, start: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One page of the issues' run claims and their marks; the next page's key."""
        rows, following = self._page(self._agents, CLAIMS_PARTITION, start, CLAIM_ATTRIBUTES)
        cited = [row for row in rows if isinstance(row.get('feedback_id'), str) and row['feedback_id']]
        erased = self._erased([row['feedback_id'] for row in cited])
        for row in cited:
            if row['feedback_id'] in erased:
                self._mark(self._agents, row, CLAIM_ATTRIBUTES, lambda now: _claim_update(now, erased, self._run),
                           str(row.get('engineering_run_id') or 'unnamed'))
        return following

    def _runs_page(self, month: str, start: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One page of a month's runs list, each listed run's ``META`` read and marked; the next page's key."""
        listed, following = self._page(self._engineering, f'{RUNLIST_PREFIX}{month}', start, ('pk', 'sk'))
        metas = []
        for row in listed:
            run_id = str(row.get('sk', '')).rsplit('#', 1)[-1]
            if not _RUN_ID.fullmatch(run_id):
                continue   # a list row that names no run (none is written so): nothing to read
            found, _ = self._page(self._engineering, f'{RUN_PREFIX}{run_id}', None, RUN_ATTRIBUTES, sort_key=_META)
            metas.extend((run_id, meta) for meta in found if _ids_of(meta) is not None)
        erased = self._erased([one for _run_id, meta in metas for one in _ids_of(meta) or []])
        for run_id, meta in metas:
            if erased.intersection(_ids_of(meta) or []):
                self._mark(self._engineering, meta, RUN_ATTRIBUTES, lambda now: _run_update(now, erased, self._run),
                           run_id)
        return following

    def _erased(self, ids: Sequence[str]) -> set[str]:
        """The ``ids`` the deployment's tombstones name (only the deployment's: D8)."""
        sources = self._lookup_sources() if ids else []
        if not sources:
            return set()
        return erased_ids(self._aggregates, sources, ids)

    # ── Marks ─────────────────────────────────────────────────────────────────────────────────────────────────────

    def _mark(self, table: Any, row: Mapping[str, Any], allowed: Sequence[str],
              plan: Callable[[Mapping[str, Any]], dict[str, Any] | None], run_id: str) -> None:
        """Mark ``row`` (``plan``: its conditional update as it reads now, None when it cites no erased id any more);
        a row changed meanwhile is read again and tried again, at most ``MAX_TRIES`` times, then the job fails
        naming the engineering run (``run_id``); a row gone meanwhile is left gone."""
        current: Mapping[str, Any] = row
        for _try in range(MAX_TRIES):
            update = plan(current)
            if update is None or self._update(table, current, update, allowed):
                return
            again = self._row(table, current, allowed)
            if again is None:
                return   # gone meanwhile: nothing left to mark
            current = again
        logger.error('An engineering row kept changing while its erased evidence was being marked',
                     extra={'engineering_run_id': run_id})
        raise EngineeringRowKeptChanging(f'the engineering run {run_id} kept changing')

    def _update(self, table: Any, row: Mapping[str, Any], update: dict[str, Any], allowed: Sequence[str]) -> bool:
        """One conditional mark (no returned values); False when the row changed since it was read."""
        if not {'pk', 'sk', *update['ExpressionAttributeNames'].values()} <= set(allowed):
            # IAM refuses any other (dynamodb:Attributes): fail here, saying so, rather than as AccessDenied.
            raise RuntimeError('An engineering mark names an attribute the worker may not update')
        try:
            table.update_item(Key={'pk': row['pk'], 'sk': row['sk']}, **update)
        except ClientError as e:
            if is_conditional_check_failure(e):
                return False
            raise
        workspaces.count(self._run, ENGINEERING_MARK_COUNTER)
        return True


def _claim_update(row: Mapping[str, Any], erased: set[str], run: Mapping[str, Any]) -> dict[str, Any] | None:
    """A claim's mark: its ``feedback_id`` REMOVEd, conditional on the id read; None when it cites no erased id."""
    cited = row.get('feedback_id')
    if not isinstance(cited, str) or cited not in erased:
        return None
    return {'UpdateExpression': 'REMOVE #id SET #mark = :mark', 'ConditionExpression': '#id = :old',
            'ExpressionAttributeNames': {'#id': 'feedback_id', '#mark': MARK_FIELD},
            'ExpressionAttributeValues': {':old': cited, ':mark': erased_mark(row, 1, run)}}


def _run_update(meta: Mapping[str, Any], erased: set[str], run: Mapping[str, Any]) -> dict[str, Any] | None:
    """A run META's mark: ``feedback.ids`` without the erased ones, conditional on the whole ``feedback`` read; None
    when it cites no erased id."""
    ids = _ids_of(meta)
    if not ids or not erased.intersection(ids):
        return None
    feedback = meta['feedback']
    kept = [one for one in feedback['ids'] if one not in erased]
    return {'UpdateExpression': 'SET #fb = :new, #mark = :mark', 'ConditionExpression': '#fb = :old',
            'ExpressionAttributeNames': {'#fb': 'feedback', '#mark': MARK_FIELD},
            'ExpressionAttributeValues': {':old': feedback, ':new': {**feedback, 'ids': kept},
                                          ':mark': erased_mark(meta, len(feedback['ids']) - len(kept), run)}}


def _ids_of(meta: Mapping[str, Any]) -> list[str] | None:
    """A run META's ``feedback.ids`` (strings only), or None when it keeps none (a run started by a person)."""
    feedback = meta.get('feedback')
    ids = feedback.get('ids') if isinstance(feedback, Mapping) else None
    if not isinstance(ids, list):
        return None
    return [one for one in ids if isinstance(one, str)]
