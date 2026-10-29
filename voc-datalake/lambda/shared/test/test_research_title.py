"""Research report titles carry their UTC creation date and time (research is not versioned)."""
from datetime import UTC, datetime, timedelta, timezone

import pytest

from shared.research_title import research_document_title

CREATED = datetime(2026, 10, 17, 14, 5, 59, tzinfo=UTC)


@pytest.mark.parametrize(('title', 'expected'), [
    pytest.param('Churn drivers', 'Churn drivers — 2026-10-17 14:05 UTC', id='plain title gets the stamp'),
    pytest.param('  Churn drivers  ', 'Churn drivers — 2026-10-17 14:05 UTC', id='surrounding space trimmed'),
    pytest.param('Churn 2026-09-01', 'Churn 2026-10-17 14:05 UTC', id='a date is replaced, not doubled'),
    pytest.param('Churn 2026-09-01 08:30', 'Churn 2026-10-17 14:05 UTC', id='a date and time are replaced'),
    pytest.param('Churn 2026-09-01T08:30:12Z', 'Churn 2026-10-17 14:05 UTC', id='an ISO timestamp is replaced'),
    pytest.param(
        'Churn — 2026-09-01 08:30 UTC', 'Churn — 2026-10-17 14:05 UTC', id='an earlier stamp is replaced',
    ),
    pytest.param('Release 12026-09-011', 'Release 12026-09-011 — 2026-10-17 14:05 UTC', id='digits glued on are not a date'),
])
def test_the_title_holds_one_creation_stamp(title, expected):
    assert research_document_title(title, 'Q', CREATED) == expected


@pytest.mark.parametrize('title', [None, '', '   ', 7])
def test_a_missing_or_blank_title_falls_back_to_the_question(title):
    assert research_document_title(title, 'Why do users churn?', CREATED) == (
        'Research: Why do users churn? — 2026-10-17 14:05 UTC'
    )


def test_the_default_quotes_only_the_first_50_question_characters():
    assert research_document_title('', 'abcde' * 12, CREATED) == (
        'Research: ' + ('abcde' * 10)[:49] + '… — 2026-10-17 14:05 UTC'
    )


def test_the_default_quotes_the_question_up_to_a_whole_word():
    question = 'Why do customers who lose baggage contact support several times?'
    assert research_document_title('', question, CREATED) == (
        'Research: Why do customers who lose baggage contact support… — 2026-10-17 14:05 UTC'
    )


def test_the_stamp_is_utc_whatever_the_given_zone():
    tokyo = CREATED.astimezone(timezone(timedelta(hours=9)))

    assert research_document_title('T', 'Q', tokyo) == 'T — 2026-10-17 14:05 UTC'
