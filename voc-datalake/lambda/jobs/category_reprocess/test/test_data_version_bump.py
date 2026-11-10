"""The reprocess worker publishes its rewrites to the read cache: data_version at completion (docs/caching.md)."""
import pytest

from jobs.category_reprocess.handler import run_job
from jobs.category_reprocess.test.test_handler import feedback_item
from shared.data_version import DATA_VERSION_KEY


def _data_version(tables) -> int:
    return int((tables['aggregates'].get_item(Key=DATA_VERSION_KEY).get('Item') or {}).get('v', 0))


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
def test_a_completed_job_bumps_data_version(tables, start_job, worker_context):
    tables['feedback'].put_item(Item=feedback_item('a'))
    job = start_job()
    assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'completed'
    assert _data_version(tables) == 1


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
def test_a_hand_over_bumps_too(tables, start_job, worker_context):
    tables['feedback'].put_item(Item=feedback_item('a'))
    job = start_job()
    worker_context.get_remaining_time_in_millis.return_value = 0
    assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'continued'
    assert _data_version(tables) == 1


def test_an_event_without_a_job_bumps_nothing(tables, worker_context):
    assert run_job({}, worker_context) == {'status': 'ignored'}
    assert _data_version(tables) == 0
