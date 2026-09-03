"""Research is a managed versioned document type.

Every assertion here fails on the pre-#406-follow-up writer, which minted
``research_{timestamp}`` ids, wrote the user's title verbatim with no ``(vN)``,
and incremented ``document_count`` outside any allocation transaction.

The table is real (moto), not a request-shape mock: the version, the title and
the count all come out of one ``transact_write_items`` whose condition
expressions a mock cannot honour, so a mock would prove the request was ISSUED
and nothing about the identity it produced.
"""
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from shared.document_versions import version_partition_key

from .conftest import research_document


def save_event(job_id: str, title: str = 'Churn drivers', question: str = 'Why?') -> dict:
    return {
        'project_id': 'p1',
        'job_id': job_id,
        'research_config': {'question': question, 'title': title, 'filters': {}},
        'feedback_count': 4,
        'analysis': 'A',
        'synthesis': 'S',
        'validation': 'V',
    }


def research_rows(table) -> list[dict]:
    items = table.query(
        KeyConditionExpression=Key('pk').eq('PROJECT#p1'),
        ConsistentRead=True,
    )['Items']
    return sorted(
        (item for item in items if str(item.get('sk', '')).startswith('RESEARCH#')),
        key=lambda item: int(item['version']),
    )


def document_count(table) -> int:
    meta = table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    return int(meta['document_count'])


@pytest.fixture
def step_save():
    from research_step_handler import step_save as save
    with patch('research_step_handler.update_job_status'):
        yield save


def test_repeated_research_for_one_title_numbers_from_v1(
    saved_research_table, step_save,
):
    step_save(save_event('job_a'))
    step_save(save_event('job_b'))

    rows = research_rows(saved_research_table)
    assert [row['title'] for row in rows] == [
        'Churn drivers (v1)', 'Churn drivers (v2)',
    ]
    assert [int(row['version']) for row in rows] == [1, 2]
    assert {row['base_title'] for row in rows} == {'Churn drivers'}
    assert document_count(saved_research_table) == 2


def test_a_replayed_save_returns_the_committed_document_without_drift(
    saved_research_table, step_save,
):
    """Step Functions retries a step. A retry must not allocate a second version
    nor inflate the count."""
    first = step_save(save_event('job_a'))
    replay = step_save(save_event('job_a'))

    assert replay['document_id'] == first['document_id']
    stored = research_document(saved_research_table)
    assert stored['title'] == 'Churn drivers (v1)'
    assert document_count(saved_research_table) == 1
    counter = saved_research_table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
        ConsistentRead=True,
    )['Items']
    assert [int(item['last_version']) for item in counter if 'last_version' in item] == [1]


def test_deleting_an_earlier_version_leaves_later_identities_unchanged(
    saved_research_table, step_save,
):
    step_save(save_event('job_a'))
    step_save(save_event('job_b'))
    third = step_save(save_event('job_c'))

    first, second, _ = research_rows(saved_research_table)
    saved_research_table.delete_item(Key={'pk': first['pk'], 'sk': first['sk']})

    survivors = research_rows(saved_research_table)
    assert [row['title'] for row in survivors] == [
        'Churn drivers (v2)', 'Churn drivers (v3)',
    ]
    assert survivors[0]['document_id'] == second['document_id']
    assert survivors[1]['document_id'] == third['document_id']


def test_two_titles_number_independently(saved_research_table, step_save):
    step_save(save_event('job_a', title='Churn drivers'))
    step_save(save_event('job_b', title='Pricing survey'))

    rows = research_rows(saved_research_table)
    assert sorted(row['title'] for row in rows) == [
        'Churn drivers (v1)', 'Pricing survey (v1)',
    ]


def test_a_legacy_research_row_keeps_v1_and_pushes_the_next_save_to_v2(
    saved_research_table, step_save,
):
    """A row written before research was managed carries no version. It must get
    a durable one rather than being renumbered under a newer sibling."""
    saved_research_table.put_item(Item={
        'pk': 'PROJECT#p1',
        'sk': 'RESEARCH#research_20260101120000',
        'document_id': 'research_20260101120000',
        'document_type': 'research',
        'title': 'Churn drivers',
        'content': 'legacy report',
        'created_at': '2026-01-01T12:00:00+00:00',
    })

    step_save(save_event('job_a'))

    rows = research_rows(saved_research_table)
    assert [row['document_id'] for row in rows] == [
        'research_20260101120000', rows[1]['document_id'],
    ]
    assert [row['title'] for row in rows] == [
        'Churn drivers (v1)', 'Churn drivers (v2)',
    ]


def test_an_untitled_request_derives_one_series_from_its_question(
    saved_research_table, step_save,
):
    """Both live writers derive the fallback title the same way, so two runs of
    one untitled question stay in ONE series."""
    step_save(save_event('job_a', title='', question='What hurts most?'))
    step_save(save_event('job_b', title='', question='What hurts most?'))

    rows = research_rows(saved_research_table)
    assert [row['title'] for row in rows] == [
        'Research: What hurts most? (v1)', 'Research: What hurts most? (v2)',
    ]


def test_the_job_result_names_the_stored_canonical_title(
    saved_research_table,
):
    """The job panel reads `result.title`. It must be the stored `(vN)` title,
    not the raw request, or the panel and the Documents tab disagree."""
    from research_step_handler import step_save as save

    with patch('research_step_handler.update_job_status') as status:
        save(save_event('job_a'))
        save(save_event('job_b'))

    completed = [
        call for call in status.call_args_list
        if call.args[2] == 'completed'
    ]
    titles = [call.kwargs['result']['title'] for call in completed]
    assert titles == ['Churn drivers (v1)', 'Churn drivers (v2)']
