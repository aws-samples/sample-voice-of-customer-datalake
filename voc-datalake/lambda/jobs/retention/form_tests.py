"""voc-retention: retention and erasure also reach a feedback form's test responses (TENETS.md D5; 7.55.00's AI review).

A test link's tagged response is kept in voc-aggregates, in the test responses' own partition, never as a feedback
item (``shared/form_test_responses.py`` says what the row is, and why that partition): the deployment's
``FEEDBACK_FORM_TEST``, or a workspace's ``WS#{ws}#FEEDBACK_FORM_TEST``, beside its forms partition. The owner's
decision keeps it until an admin or the form's creator deletes it,
but a legal obligation still applies: the same run that deletes the ``feedback_form`` source's real responses
deletes the test responses it matches, under the same legal basis, in the same scopes.

Which rows a run reaches (``row_matcher``):

- ``retention``: the ``feedback_form`` source's retention window (the cutoff day its profile's ``retention_days``
  gives its feedback items): the rows created before that day. Nothing when that source keeps its data;
- ``erase``, ``email``: a row whose contact email (``submitter_email``, or a contact answer's ``email``) equals the
  value, ignoring case and surrounding spaces, as an email erasure of feedback items does (``shared/retention.py``
  ``erase_filter`` matches the lower-cased value and the value as typed);
- ``erase``, ``author``: a row whose contact name (``submitter_name``, or a contact answer's ``name``) equals the
  value exactly, as an ``author`` erasure matches ``author``. A form's REAL response keeps that name only as
  ``metadata.submitter_name`` and carries no ``author`` (lambda/api/feedback_form_handler.py ``_ingest``, the
  processor copies ``author`` from the record), so an erasure by name does not reach it; it reaches the test copy,
  the safe side for a copy that serves no analysis (docs/source-policies.md, "What erasure does not reach");
- ``erase``, ``source`` = ``feedback_form`` (Delete all data from a source): every test response;
- ``source_id``, ``csv_row_id``, a job limited to another source: none (a test row has no source id or CSV row).

Which partitions (``scopes``), exactly as the same run reaches feedback items (shared/retention.py
``reaches_workspaces``, ``erase_filter``'s ``scope``): a job that names one workspace walks that workspace's test
partition only (by email or by name); every other run walks the deployment's ``FEEDBACK_FORM_TEST`` first, then, for a
retention window (the windows are the deployment's, for every workspace) or an erasure by email (one address is one
person), every listed workspace's (workspaces.py: the platform's listing, with its re-walk passes), when voc-workspaces
is configured. An erasure by name or a whole-source erasure stays the deployment's, as for feedback items.

The rows are read with a paged Query of each test partition (test responses and nothing else, a workspace's through
its ``ws_table``), never a table scan, and matched in code: the contact answer sits under a question id that differs
per form, which no FilterExpression can name. Each page's matches get a contentless tombstone first
(``AUDIT#tombstone#feedback_form`` / ``test#{response_id}``, a workspace's ``{ws}#test#{response_id}`` with its
``workspace_id``; ``store: form_test``; the ``test#`` keeps it apart from a feedback item's id), then each is deleted
by key, conditional on the row still being there, and counted (``FORM_TEST_COUNTER``). An erasure that deletes a
workspace's test response first closes that workspace's exports (exports.py ``note_workspace``: an export's
``feedback_form_tests`` holds the row), which its ``exports`` phase then clears, as for a deleted item. A test response is
never cited by a document or persona, so it is not noted as erased evidence: it never starts a lineage pass.

On voc-aggregates the worker may delete in the test partitions only, the deployment's and one workspace id's
(``dynamodb:LeadingKeys``, lib/stacks/retention-worker.ts): never a form's definition, revision or funnel row (the
forms partitions).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import exports, workspaces
from jobs.retention.copies import tombstone_record
from jobs.retention.project_people import DEPLOYMENT, DEPLOYMENT_DONE
from jobs.retention.runs import MODE_ERASE, MODE_RETENTION
from shared.aws import is_conditional_check_failure
from shared.feedback_form_raw import FEEDBACK_FORM_SOURCE
from shared.form_test_responses import (
    CONTACT_EMAIL,
    CONTACT_NAME,
    person_values,
    response_id_of,
    test_responses_partition,
)
from shared.ingest_tables import table_view
from shared.project_walk import checked_key, query_page
from shared.retention import FORM_TEST_COUNTER, SOURCE_FIELD, reaches_workspaces
from shared.timestamps import now_iso
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, scope_from_message

#: The tombstones' ``store`` (a feedback item's is ``feedback``, a Radar review's ``radar``).
STORE_FORM_TESTS: Final = 'form_test'
#: The tombstone id's prefix: never a feedback id.
TOMBSTONE_ID_PREFIX: Final = 'test#'
PAGE_SIZE: Final = 100
# The cursor's part for the deployment's own partition (``DEPLOYMENT``: ``{'start': key}``) and its mark once that is
# done (``DEPLOYMENT_DONE``) are the names project_people.py's walk of the deployment gives its own.

RowMatch = Callable[[Mapping[str, Any]], bool]


def _created_day(row: Mapping[str, Any]) -> str | None:
    """The row's ``YYYY-MM-DD`` (its ``created_at``'s), or None without a readable one: never deleted by age."""
    created_at = row.get('created_at')
    day = created_at[:10] if isinstance(created_at, str) else ''
    return day if len(day) == 10 and day[4] == '-' and day[7] == '-' else None


def _older_than(cutoff: str) -> RowMatch:
    def matches(row: Mapping[str, Any]) -> bool:
        day = _created_day(row)
        return day is not None and day < cutoff
    return matches


def _person(field: str, value: str) -> RowMatch:
    """A row holding ``value`` as its contact ``field``: an email ignoring case and spaces, a name exactly."""
    if field == CONTACT_EMAIL:
        wanted = value.strip().lower()
        return lambda row: any(stored.strip().lower() == wanted for stored in person_values(row, CONTACT_EMAIL))
    return lambda row: value in person_values(row, CONTACT_NAME)


#: An erasure field → the contact field it finds a person by (the others name ids a test row never has).
_PERSON_FIELDS: Final = {'email': CONTACT_EMAIL, 'author': CONTACT_NAME}


def row_matcher(run: Mapping[str, Any], value: str) -> RowMatch | None:
    """Which test rows ``run`` deletes (``value``: the erasure's value), or None when it reaches none (see the
    module docstring)."""
    if run.get('mode') == MODE_RETENTION:
        cutoffs = run.get('cutoffs')
        cutoff = cutoffs.get(FEEDBACK_FORM_SOURCE) if isinstance(cutoffs, Mapping) else None
        return _older_than(cutoff) if isinstance(cutoff, str) and cutoff else None
    field, source = run.get('field'), run.get('source')
    if field == SOURCE_FIELD:
        # A whole-source erasure is the deployment's (a job that names a workspace never is one).
        return (lambda _row: True) if source == FEEDBACK_FORM_SOURCE and workspaces.named(run) is None else None
    if source not in (None, '', FEEDBACK_FORM_SOURCE) or not isinstance(field, str) or not value:
        return None
    contact = _PERSON_FIELDS.get(field)
    return _person(contact, value) if contact is not None else None


def walks_workspaces(run: Mapping[str, Any]) -> bool:
    """Whether a run that names no workspace walks every listed workspace's test partition too: a retention window
    and an erasure by email, as for feedback items (``shared/retention.py`` ``reaches_workspaces``)."""
    return run.get('mode') == MODE_RETENTION or reaches_workspaces(str(run.get('field') or ''))


def tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str,
              scope: WorkspaceScope | None = None) -> dict[str, Any]:
    """One deleted test response's record: the form and response ids, the run and the legal basis (a workspace's:
    its ``workspace_id`` too), never content."""
    response_id = response_id_of(row)
    record = tombstone_record(run, FEEDBACK_FORM_SOURCE, f'{TOMBSTONE_ID_PREFIX}{response_id}', STORE_FORM_TESTS, now,
                              scope)
    form_id = row.get('form_id')
    return {**record, 'response_id': response_id, **({'form_id': form_id} if isinstance(form_id, str) else {})}


class FormTestEraser:
    """Deletes the test responses one run matches, one Query page of one test partition a step, counting into
    ``run``: the deployment's partition first (the cursor's ``deployment`` part), then the workspaces' (workspaces.py's
    cursor: the page of ids still to walk, the listing's state, ``at`` the partition's next key), or a job's one
    workspace only."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], matches: RowMatch,
                 clock: Callable[[], datetime] = workspaces.utc_now, listing_table: str = '') -> None:
        self._run = run
        self._aggregates = tables['aggregates']
        self._workspaces = tables.get(listing_table) if listing_table else None
        self._matches = matches
        self._clock = clock

    def step(self, cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One page from ``cursor`` (None: the start), and the cursor of the next; None once every partition is
        done."""
        only = workspaces.named(self._run)
        here = dict(cursor) if cursor else (workspaces.one_start(only) if only is not None else {DEPLOYMENT: {}})
        if DEPLOYMENT in here:
            return self._deployment_step(here, only)
        page = workspaces.checked_page(self._run, here)
        if page:
            return self._workspace_step(here, page)
        # The page of ids is done: the listing's next one, or the end (also without voc-workspaces configured).
        ended = here.get('listing_done') or self._workspaces is None
        return None if ended else workspaces.listing_page(self._run, self._workspaces, here, self._clock())

    def _workspace_step(self, here: dict[str, Any], page: list[str]) -> dict[str, Any]:
        """One page of the first listed workspace's partition; once it is done, the cursor without that workspace."""
        following = self._page(scope_from_message({WORKSPACE_FIELD: page[0]}), (here.get('at') or {}).get('start'))
        return {**here, 'ws': page[1:], 'at': {}} if following is None else {**here, 'at': {'start': following}}

    def _deployment_step(self, here: dict[str, Any], only: str | None) -> dict[str, Any] | None:
        """One page of the deployment's partition; once it is done, the listing's start when the run walks the
        workspaces too (and voc-workspaces is configured), else the end. A one-workspace job never walks it
        (ValueError: a hand-over of one must not)."""
        if only is not None:
            raise ValueError("a one-workspace job carried the deployment's test partition")
        carried = here[DEPLOYMENT]
        if not isinstance(carried, Mapping):
            raise ValueError("a carried deployment's walk is not a map")
        following = self._page(None, carried.get('start'))
        if following is not None:
            return {**here, DEPLOYMENT: {'start': following}}
        if not walks_workspaces(self._run) or self._workspaces is None:
            return None
        return {**workspaces.listing_start(self._clock()), DEPLOYMENT_DONE: True}

    def _page(self, scope: WorkspaceScope | None, start: object) -> dict[str, Any] | None:
        """Tombstone, then delete, the matches of one page of ``scope``'s test responses; the next page's key."""
        view = table_view(scope, self._aggregates)
        rows, following = query_page(view, test_responses_partition(scope), checked_key(start), Limit=PAGE_SIZE)
        self._run['scanned'] = int(self._run.get('scanned') or 0) + len(rows)
        matched = [row for row in rows if self._matches(row)]
        if matched:
            if scope is not None and self._run.get('mode') == MODE_ERASE:
                # Its exports hold a copy of the row: closed before it goes, cleared by the `exports` phase.
                exports.note_workspace(self._run, scope, self._aggregates)
            self.tombstones(matched, scope)
            for row in matched:
                self.erase(view, row)
        return following

    def tombstones(self, rows: Sequence[Mapping[str, Any]], scope: WorkspaceScope | None = None) -> None:
        """One tombstone per matched row, one PutItem each, before any of them is deleted (copies.write_tombstones'
        rule: never a delete without its record)."""
        now = now_iso()
        for row in rows:
            self._aggregates.put_item(Item=tombstone(self._run, row, now, scope))

    def erase(self, view: Any, row: Mapping[str, Any]) -> None:
        """Delete the row (gone meanwhile, by its form's Delete all: nothing to count)."""
        try:
            view.delete_item({'pk': row['pk'], 'sk': row['sk']}, ConditionExpression='attribute_exists(pk)')
        except ClientError as e:
            if is_conditional_check_failure(e):
                return
            raise
        self._run[FORM_TEST_COUNTER] = int(self._run.get(FORM_TEST_COUNTER) or 0) + 1
