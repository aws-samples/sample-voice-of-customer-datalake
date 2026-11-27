"""7.97.00 (3g-ui, q-6): an owing run's rows name why in a code beside the English ``incomplete_reason`` (the web app
translates the code and keeps the text for older rows), and the run's mode, which says which later run makes the marks.
Pure: ``registries.fields`` of a run dict."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from jobs.retention import registries
from shared import lineage_owed


def _owing(result: str | None, mode: str = 'erase', reason: str | None = None) -> dict:
    run: dict = {'mode': mode, registries.LINEAGE_OWED: True}
    if result is not None:
        run[registries.RESULT] = result
    if reason is not None:
        run[registries.INCOMPLETE_REASON] = reason
    return run


@pytest.mark.parametrize(('result', 'code'), [
    (registries.REGISTRIES_NOT_BACKFILLED, lineage_owed.OWED_NOT_BACKFILLED),
    (registries.REGISTRIES_INCOMPLETE, lineage_owed.OWED_INCOMPLETE),
    (registries.REGISTRIES_COMPLETE, lineage_owed.OWED_FAILED_BEFORE_MARKS),
    (None, lineage_owed.OWED_NOT_BACKFILLED),
])
def test_an_owing_run_names_its_reason_by_code_and_its_mode(result, code):
    fields = registries.fields(_owing(result, mode='retention'))
    assert (fields[registries.OWED_REASON], fields[registries.OWED_MODE]) == (code, 'retention')
    assert fields[registries.INCOMPLETE_REASON] == registries.owed_reason(_owing(result, mode='retention'))


def test_an_owe_that_could_not_be_recorded_says_so_by_code_whatever_the_registries_read():
    fields = registries.fields(_owing(registries.REGISTRIES_COMPLETE, reason=registries.OWE_FAILED_REASON))
    assert fields[registries.OWED_REASON] == lineage_owed.OWED_OWE_FAILED
    assert fields[registries.INCOMPLETE_REASON] == registries.OWE_FAILED_REASON


def test_the_codes_are_the_web_apps():
    """The web app's list (frontend/src/api/sourceProfilesApi.ts ``LINEAGE_OWED_REASONS``) is the shared one, in order."""
    source = (Path(__file__).resolve().parents[4] / 'frontend' / 'src' / 'api' / 'sourceProfilesApi.ts').read_text()
    match = re.search(r'const LINEAGE_OWED_REASONS = \[([^\]]*)\] as const', source)
    assert match is not None
    assert tuple(re.findall(r"'([a-z_]+)'", match.group(1))) == lineage_owed.OWED_CODES
    assert lineage_owed.OWED_CODES == ('not_backfilled', 'incomplete', 'failed_before_marks', 'owe_failed')


def test_the_runs_code_is_the_shared_rule():
    run = _owing(registries.REGISTRIES_INCOMPLETE)
    assert registries.run_owed_code(run) == lineage_owed.owed_code(None, registries.REGISTRIES_INCOMPLETE)


def test_a_run_that_owes_nothing_names_no_code():
    fields = registries.fields({'mode': 'erase', registries.RESULT: registries.REGISTRIES_COMPLETE})
    assert registries.OWED_REASON not in fields
    assert registries.OWED_MODE not in fields


def test_a_mode_other_than_retention_or_erase_is_left_out():
    fields = registries.fields(_owing(registries.REGISTRIES_INCOMPLETE, mode='other'))
    assert registries.OWED_MODE not in fields
    assert fields[registries.OWED_REASON] == lineage_owed.OWED_INCOMPLETE
