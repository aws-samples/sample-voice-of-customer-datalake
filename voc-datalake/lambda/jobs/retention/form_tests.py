"""voc-retention: retention and erasure also reach a feedback form's test responses (TENETS.md D5).

A test link's tagged response is kept in voc-aggregates, in the test responses' own partition, never as a feedback
item (``shared/form_test_responses.py`` says what the row is, and why that partition). The owner's decision keeps it
until an admin or the form's creator deletes it, but a legal obligation still applies: the same run that deletes the
``feedback_form`` source's real responses deletes the test responses it matches, under the same legal basis.

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

The rows are read with a paged Query of their partition (``pk FEEDBACK_FORM_TEST``: test responses and nothing else),
never a table scan, and matched in code: the contact answer sits under a question id that differs per form, which no
FilterExpression can name. Each match gets a contentless tombstone first (``AUDIT#tombstone#feedback_form`` / ``test#{response_id}``,
``store: form_test``; the ``test#`` keeps it apart from a feedback item's id), then is deleted by key, conditional on
the row still being there, and counted (``FORM_TEST_COUNTER``). A test response is never cited by a document or
persona, so it is not noted as erased evidence: it never starts the lineage pass.

On voc-aggregates the worker may delete in the ``FEEDBACK_FORM_TEST`` partition only (lib/stacks/retention-worker.ts):
never a form's definition, revision or funnel row (the ``FEEDBACK_FORM`` partition).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from jobs.retention.copies import tombstone_record
from jobs.retention.runs import FORM_TEST_COUNTER, MODE_RETENTION
from shared.aws import is_conditional_check_failure
from shared.feedback_form_raw import FEEDBACK_FORM_SOURCE
from shared.form_test_responses import CONTACT_EMAIL, CONTACT_NAME, TEST_RESPONSES_PK, person_values, response_id_of
from shared.retention import SOURCE_FIELD
from shared.timestamps import now_iso

#: The tombstones' ``store`` (a feedback item's is ``feedback``, a Radar review's ``radar``).
STORE_FORM_TESTS: Final = 'form_test'
#: The tombstone id's prefix: never a feedback id.
TOMBSTONE_ID_PREFIX: Final = 'test#'
PAGE_SIZE: Final = 100

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
        return (lambda _row: True) if source == FEEDBACK_FORM_SOURCE else None
    if source not in (None, '', FEEDBACK_FORM_SOURCE) or not isinstance(field, str) or not value:
        return None
    contact = _PERSON_FIELDS.get(field)
    return _person(contact, value) if contact is not None else None


def query_page(table: Any, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    """One page of the test responses' partition, whole rows (the match reads ``answers``: a small row)."""
    condition = Key('pk').eq(TEST_RESPONSES_PK)
    start = {'ExclusiveStartKey': dict(cursor)} if cursor else {}
    return table.query(KeyConditionExpression=condition, Limit=PAGE_SIZE, **start)


def tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str) -> dict[str, Any]:
    """One deleted test response's record: the form and response ids, the run and the legal basis, never content."""
    response_id = response_id_of(row)
    record = tombstone_record(run, FEEDBACK_FORM_SOURCE, f'{TOMBSTONE_ID_PREFIX}{response_id}', STORE_FORM_TESTS, now)
    form_id = row.get('form_id')
    return {**record, 'response_id': response_id, **({'form_id': form_id} if isinstance(form_id, str) else {})}


class FormTestEraser:
    """Deletes the test responses one run matches, page by page, counting into ``run``."""

    def __init__(self, run: dict[str, Any], aggregates_table: Any, matches: RowMatch) -> None:
        self._run = run
        self._table = aggregates_table
        self._matches = matches

    def page(self, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
        """One queried page with only its matching rows kept (its cursor and counts as read)."""
        page = query_page(self._table, cursor)
        return {**page, 'Items': [row for row in page.get('Items', []) if self._matches(row)]}

    def tombstones(self, rows: Sequence[Mapping[str, Any]]) -> None:
        """One tombstone per matched row, one PutItem each, before any of them is deleted (copies.write_tombstones'
        rule: never a delete without its record)."""
        now = now_iso()
        for row in rows:
            self._table.put_item(Item=tombstone(self._run, row, now))

    def erase(self, row: Mapping[str, Any]) -> None:
        """Delete the row (gone meanwhile, by its form's Delete all: nothing to count)."""
        try:
            self._table.delete_item(Key={'pk': row['pk'], 'sk': row['sk']},
                                    ConditionExpression='attribute_exists(pk)')
        except ClientError as e:
            if is_conditional_check_failure(e):
                return
            raise
        self._run[FORM_TEST_COUNTER] = int(self._run.get(FORM_TEST_COUNTER) or 0) + 1
