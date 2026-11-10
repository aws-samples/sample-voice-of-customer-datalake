"""The run summary of a failed step carries the step's own reason, bounded and masked."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from agents.failure_reason import (
    GENERIC_FAILURE,
    INTERNAL_FAILURE,
    MAX_REASON_CHARS,
    REDACTED,
    WRONG_DOCUMENT,
    document_label,
    failure_summary,
    plain_failure,
    plain_route_failure,
    reason_text,
)


@pytest.mark.parametrize(('reason', 'expected'), [
    # A raw technical reason never reaches the summary (wave 4: "the review analysis was not valid JSON").
    ('the review analysis was not valid JSON', "Aggregate failed. The AI's answer could not be read. Try running it again."),
    ('Project name taken.', 'Aggregate failed. Project name taken.'),
    (None, 'Aggregate failed.'),
    ('   ', 'Aggregate failed.'),
    (5, 'Aggregate failed.'),
])
def test_failure_summary_names_the_reason(reason, expected):
    assert failure_summary('Aggregate', reason) == expected


@pytest.mark.parametrize('secret', [
    'arn:aws:lambda:us-west-2:111122223333:function:voc-x',
    'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc',
    '111122223333',
])
def test_infrastructure_detail_is_masked(secret):
    text = reason_text(f'route refused {secret} today')
    assert text == f'route refused {REDACTED} today'


def test_the_reason_is_one_bounded_line():
    text = reason_text('line one\n\tline two ' + 'x' * 1000)
    assert text.startswith('line one line two x')
    assert len(text) == MAX_REASON_CHARS
    assert text.endswith('…')


@pytest.mark.parametrize(('detail', 'plain'), [
    ('the review analysis was not valid JSON', "The AI's answer could not be read. Try running it again."),
    ('the final review was not valid JSON', "The AI's answer could not be read. Try running it again."),
    ('there is no prfaq to revise yet',
     'There is no PR/FAQ to revise yet. Add a step that creates one earlier in the workflow.'),
    ('duplicate_document: unknown document kind', WRONG_DOCUMENT),
    ('the deep_research job failed',
     'The background work for this step failed, so the run stopped. It is safe to run it again.'),
    ('poll without a pending job', INTERNAL_FAILURE),
    ('something nobody planned for', GENERIC_FAILURE),
    (None, GENERIC_FAILURE),
])
def test_a_technical_reason_reads_in_plain_words(detail, plain):
    assert plain_failure(detail) == plain


@pytest.mark.parametrize('node_file', sorted(
    path for path in (Path(__file__).resolve().parents[1]).rglob('*.py') if '/test/' not in str(path)))
def test_every_node_failure_has_a_plain_sentence(node_file):
    """A new ``NodeFailure('…')`` without a mapping would read as the generic sentence: map it here."""
    literals = re.findall(r"NodeFailure\('([^'{]+)'\)", node_file.read_text(encoding='utf-8'))
    assert [text for text in literals if plain_failure(text) == GENERIC_FAILURE] == []


@pytest.mark.parametrize(('status', 'starts'), [(403, 'The agent is not allowed'), (404, 'The project or document'),
                                                (409, 'The project changed'), (500, 'A project service refused')])
def test_a_refusing_route_reads_in_plain_words(status, starts):
    assert plain_route_failure(status).startswith(starts)


def test_document_labels():
    assert [document_label('prfaq'), document_label('PRD'), document_label('custom_kind')] == [
        'PR/FAQ', 'PRD', 'custom kind']
