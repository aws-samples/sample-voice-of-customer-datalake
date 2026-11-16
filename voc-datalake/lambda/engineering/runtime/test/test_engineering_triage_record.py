"""The ``voc-triage/1`` record (runtime/outputs.py): the understander's triage, its labels and their allowlist."""
from __future__ import annotations

import pytest

from engineering.runtime.outputs import (
    TRIAGE_LABELS,
    TRIAGE_SCHEMA,
    TriageError,
    triage_labels,
    triage_record,
)

GOOD = {'kind': 'bug', 'severity': 'S2', 'priority': 'P2', 'summary': ' divide(7, 2) floors to 3 ',
        'paths': ['src/calc.py', 'src/calc.py'], 'acceptance_criteria': ['divide(7, 2) == 3.5'], 'tenets': []}


def test_a_triage_is_normalised_to_its_schema() -> None:
    record = triage_record(GOOD)
    assert record == {'schema': TRIAGE_SCHEMA, 'kind': 'bug', 'severity': 'S2', 'priority': 'P2',
                      'summary': 'divide(7, 2) floors to 3', 'tenets': [], 'paths': ['src/calc.py'],
                      'acceptance_criteria': ['divide(7, 2) == 3.5']}
    # No tenets, paths or criteria named: empty lists, never missing.
    bare = triage_record({key: GOOD[key] for key in ('kind', 'severity', 'priority', 'summary')})
    assert (bare['tenets'], bare['paths'], bare['acceptance_criteria']) == ([], [], [])


@pytest.mark.parametrize(('change', 'reason'), [
    ({'kind': 'chore'}, 'kind is one of'),
    ({'severity': 's2'}, 'severity is one of'),
    ({'priority': 'high'}, 'priority is one of'),
    ({'summary': ' '}, 'summary is text'),
    ({'summary': 'x' * 1001}, 'summary is text'),
    ({'paths': ['../etc/passwd']}, 'repository path'),
    ({'paths': ['/etc/passwd']}, 'repository path'),
    ({'paths': ['a b.py']}, 'its own shape'),
    ({'tenets': ['tenet three']}, 'its own shape'),
    ({'acceptance_criteria': ['x' * 301]}, 'text of 1-300'),
    ({'acceptance_criteria': ['ok'] * 11}, 'at most 10'),
    ({'acceptance_criteria': 'one'}, 'a list'),
])
def test_a_triage_off_its_shape_is_refused(change: dict[str, object], reason: str) -> None:
    with pytest.raises(TriageError, match=reason):
        triage_record({**GOOD, **change})
    with pytest.raises(TriageError):
        triage_record(['not', 'an', 'object'])


def test_the_labels_a_triage_puts_on_its_issue_are_the_allowlist() -> None:
    assert triage_labels('bug', 'S2') == ('voc-triage/bug', 'voc-severity/s2')
    expected = {'voc-triage/bug', 'voc-triage/feature', 'voc-triage/investigation',
                'voc-severity/s1', 'voc-severity/s2', 'voc-severity/s3', 'voc-severity/s4'}
    assert expected == TRIAGE_LABELS
