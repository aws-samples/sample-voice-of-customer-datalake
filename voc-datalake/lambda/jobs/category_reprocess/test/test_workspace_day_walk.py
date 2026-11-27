"""A workspace's category reprocess reads only its own index partitions (docs/multi-workspace.md, the Scale note of
7.13.00's "a later fix"): Queries of voc-feedback's ``gsi1-by-date``, one day partition ``WS#{ws}#DATE#{day}`` at a
time, from the day before the workspace was created (its ``META`` ``created_at``) to today, never a Scan of the table.

The processor stamps ``gsi1pk`` with the day it PROCESSED a review (lambda/processor/handler.py build_feedback_item:
``now``), never the review's own date, and it writes into a workspace only while the workspace is active, so no review
of a workspace sits in a day partition before the workspace existed (an imported review written years before keeps
its ``source_created_at``, and is filed under the day it was imported). The walk's cursor is ``{day, start}``: the day
partition and the Query's ``LastEvaluatedKey`` in it. A job checkpointed with a Scan cursor (``{pk, sk}``, before this
change) finishes its Scan; so does a workspace whose ``META`` names no creation time. The deployment's job is
unchanged: its Scan, byte for byte.
"""
import json
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from jobs.category_reprocess import handler
from jobs.category_reprocess.handler import first_possible_day as REAL_FIRST_POSSIBLE_DAY
from jobs.category_reprocess.handler import run_job
from jobs.category_reprocess.test.conftest import CATEGORIES
from shared import reprocess_jobs as jobs
from shared.reprocess_slices import ReprocessSlice
from shared.test.moto_tables import create_feedback_table_by_date_and_id, create_pk_sk_table
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE = WorkspaceScope(WS)
#: The walk's clock: today (UTC) for every test here.
TODAY = date(2026, 11, 20)
#: The workspace was created on 2026-11-10 at 15:00 UTC: its walk starts on the 9th (a day's margin for the clocks).
CREATED_AT = '2026-11-10T15:00:00+00:00'
CREATED = date(2026, 11, 10)
WS_CATEGORIES = [{'name': 'trail_gear', 'description': 'Trail gear'}, {'name': 'rentals', 'description': 'Rentals'}]


def _day(offset: int) -> str:
    """The workspace's creation day plus ``offset`` days."""
    return (CREATED + timedelta(days=offset)).isoformat()


def _review(feedback_id: str, ws: str | None, day: str, **overrides) -> dict:
    """A review of ``ws`` (the deployment's for None) processed on ``day``, filed under ``rentals``."""
    prefix = '' if ws is None else f'WS#{ws}#'
    item = {
        'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'gsi1pk': f'{prefix}DATE#{day}', 'gsi1sk': f'{day}T08:00:00+00:00#{feedback_id}',
        'gsi2pk': f'{prefix}CATEGORY#rentals', 'gsi2sk': f'0.1#{day}T08:00:00+00:00',
        'gsi3pk': f'{prefix}URGENCY#low', 'gsi3sk': f'{day}T08:00:00+00:00',
        'gsi4pk': f'{prefix}FEEDBACK#{feedback_id}',
        'date': day, 'source_platform': 'web', 'source_channel': 'reviews', 'urgency': 'low',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.6'),
        'original_text': 'The rear brakes squeal on every descent', 'category': 'rentals',
    }
    item.update(overrides)
    return item


class Calls:
    """Every DynamoDB request the job sends to voc-feedback, as sent (operation, wire body)."""

    def __init__(self, feedback_name: str) -> None:
        self._name = feedback_name
        self.sent: list[tuple[str, dict]] = []

    def __call__(self, model, params, **_kwargs) -> None:
        body = json.loads(params.get('body') or b'{}')
        if body.get('TableName') == self._name:
            self.sent.append((model.name, body))

    def operations(self) -> set[str]:
        return {name for name, _body in self.sent}

    def reads(self) -> list[tuple[str, dict]]:
        return [(name, body) for name, body in self.sent if name in ('Scan', 'Query')]

    def queried_partitions(self) -> list[str]:
        return [body['ExpressionAttributeValues'][':p']['S'] for name, body in self.sent if name == 'Query']


@pytest.fixture
def world() -> Iterator[dict]:
    """voc-feedback with its gsi1 (all attributes, as core-stack.ts), voc-aggregates and voc-workspaces (the
    workspace's ``META`` with its ``created_at``); every request to voc-feedback recorded."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        feedback = create_feedback_table_by_date_and_id(handler.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        workspaces = create_pk_sk_table('test-workspaces-walk', resource)
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        aggregates.put_item(Item={**settings_key(WS, 'categories'), 'categories': WS_CATEGORIES})
        workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active', 'created_at': CREATED_AT,
                                  'name': 'Trail', 'slug': 'trail'})
        calls = Calls(handler.FEEDBACK_TABLE)
        resource.meta.client.meta.events.register('before-call.dynamodb', calls)
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'get_workspaces_table', return_value=workspaces), \
                patch.object(handler, 'first_possible_day', REAL_FIRST_POSSIBLE_DAY), \
                patch.object(handler, 'today_utc', return_value=TODAY), \
                patch('shared.categorization.get_active_model_id', return_value='test-model'), \
                patch('shared.reprocess_lineage.get_active_model_id', return_value='test-model'):
            yield {'feedback': feedback, 'aggregates': aggregates, 'workspaces': workspaces, 'calls': calls}


def _put(world: dict, *items: dict) -> None:
    for item in items:
        world['feedback'].put_item(Item=item)


def _start(world: dict, scope: WorkspaceScope | None = SCOPE, job_slice: ReprocessSlice | None = None,
           cursor: dict | None = None) -> dict:
    job = jobs.start_job(world['aggregates'], mode=jobs.MODE_PROCESSED, days=0, include_manual=False,
                         started_by='ada', now=datetime.now(UTC), job_slice=job_slice, scope=scope)
    assert job is not None
    if cursor is not None:
        # A job an earlier invocation checkpointed (its worker gone): the cursor on its row, no owner.
        token = 'bootstrap'
        assert jobs.claim_job(world['aggregates'], job['sk'], token, **jobs.scope_option(scope)) is not None
        counters = dict.fromkeys(jobs.ALL_COUNTERS, 0)
        assert jobs.checkpoint(world['aggregates'], job['sk'], counters, cursor, token,
                               **jobs.scope_option(scope)) is not None
        world['aggregates'].update_item(Key={'pk': job['pk'], 'sk': job['sk']}, UpdateExpression='REMOVE worker_token')
    return job


def _event(job: dict, **extra) -> dict:
    return {'job_id': job['sk'], 'workspace_id': WS, **extra}


def _category(world: dict, item: dict) -> str:
    return str(world['feedback'].get_item(Key={'pk': item['pk'], 'sk': item['sk']})['Item']['category'])


def _days(first: str, last: str) -> list[str]:
    start, end = date.fromisoformat(first), date.fromisoformat(last)
    return [(start + timedelta(days=n)).isoformat() for n in range((end - start).days + 1)]


def _partitions(days: list[str]) -> list[str]:
    return [f'WS#{WS}#DATE#{day}' for day in days]


def _run_slice(world: dict, worker_context, job_slice: ReprocessSlice) -> tuple[str, int]:
    """A workspace's job of ``job_slice`` run to its end: its status and how many reviews it scanned."""
    result = run_job(_event(_start(world, job_slice=job_slice)), worker_context)
    return result['status'], result['scanned']


@pytest.mark.usefixtures('invoke_mock')
class TestAWorkspacesJobReadsOnlyItsOwnDayPartitions:
    def test_no_scan_one_query_of_gsi1_per_day_from_the_day_before_creation_to_today(
            self, world, worker_context, converse_mock):
        mine = [_review('w1', WS, _day(0)), _review('w2', WS, _day(3)), _review('w3', WS, TODAY.isoformat())]
        others = [_review('o1', OTHER, _day(0)), _review('o2', OTHER, _day(3)), _review('d1', None, _day(3)),
                  _review('d2', None, TODAY.isoformat())]
        _put(world, *mine, *others)
        converse_mock.return_value = '{"category": "trail_gear"}'

        result = run_job(_event(_start(world)), worker_context)

        assert (result['status'], result['scanned'], result['updated']) == ('completed', 3, 3)
        calls = world['calls']
        assert 'Scan' not in calls.operations()
        assert {body['IndexName'] for _name, body in calls.reads()} == {'gsi1-by-date'}
        # Oldest first, every day once, the creation day and today included (and the day before, a clock margin).
        assert calls.queried_partitions() == _partitions(_days(_day(-1), TODAY.isoformat()))
        assert {_category(world, item) for item in mine} == {'trail_gear'}
        assert {_category(world, item) for item in others} == {'rentals'}

    def test_a_review_written_before_the_workspace_existed_is_found_under_the_day_it_was_imported(
            self, world, worker_context, converse_mock):
        old = _review('w-old', WS, _day(2), source_created_at='2019-03-04T10:00:00+00:00')
        _put(world, old)
        converse_mock.return_value = '{"category": "trail_gear"}'
        # A review-date window entirely before the workspace's creation: the review's processing day is after it.
        job_slice = ReprocessSlice(days=None, date_from='2019-01-01', date_to='2019-12-31', date_basis='review')

        assert _run_slice(world, worker_context, job_slice) == ('completed', 1)
        assert _category(world, old) == 'trail_gear'
        # A review-date window does not choose the days: every day the workspace could hold is read.
        assert world['calls'].queried_partitions() == _partitions(_days(_day(-1), TODAY.isoformat()))

    def test_sources_categories_and_a_processed_window_filter_and_choose_the_days(
            self, world, worker_context, converse_mock):
        wanted = _review('w1', WS, _day(4))
        wrong_source = _review('w2', WS, _day(4), source_platform='app_store')
        wrong_category = _review('w3', WS, _day(5), category='trail_gear')
        before = _review('w4', WS, _day(2))
        after = _review('w5', WS, _day(7))
        _put(world, wanted, wrong_source, wrong_category, before, after)
        converse_mock.return_value = '{"category": "trail_gear"}'
        job_slice = ReprocessSlice(sources=('web',), categories=('rentals',), days=None,
                                   date_from=_day(3), date_to=_day(6))

        assert _run_slice(world, worker_context, job_slice) == ('completed', 1)
        assert _category(world, wanted) == 'trail_gear'
        for item in (wrong_source, before, after):
            assert _category(world, item) == 'rentals'
        assert _category(world, wrong_category) == 'trail_gear'  # untouched (it was trail_gear)
        assert world['calls'].queried_partitions() == _partitions(_days(_day(3), _day(6)))
        # The same filter as the Scan's: sources and categories pushed down to each Query.
        [(_name, first)] = world['calls'].reads()[:1]
        assert 'FilterExpression' in first

    def test_a_window_reaching_past_today_and_before_creation_is_clipped_to_the_days_there_can_be(
            self, world, worker_context, converse_mock):
        _put(world, _review('w1', WS, _day(1)))
        job_slice = ReprocessSlice(days=None, date_from='2026-01-01', date_to='2027-06-30')

        assert _run_slice(world, worker_context, job_slice) == ('completed', 1)
        assert world['calls'].queried_partitions() == _partitions(_days(_day(-1), TODAY.isoformat()))
        converse_mock.assert_called_once()

    def test_a_window_with_no_day_the_workspace_can_hold_reads_nothing(self, world, worker_context, converse_mock):
        _put(world, _review('w1', WS, _day(1)))
        job_slice = ReprocessSlice(days=None, date_from='2025-01-01', date_to='2025-02-01')

        assert _run_slice(world, worker_context, job_slice) == ('completed', 0)
        assert world['calls'].reads() == []
        converse_mock.assert_not_called()


@pytest.mark.usefixtures('converse_mock')
class TestTheWalkResumes:
    def test_mid_day_from_the_day_and_the_querys_last_key_then_across_days(
            self, world, worker_context, invoke_mock, converse_mock):
        """Thirty reviews on one day (more than a page) and two on later days: the job hands over mid-day, the next
        invocation goes on from that review, and every review is replayed exactly once."""
        busy = [_review(f'w{n:02d}', WS, _day(2)) for n in range(30)]
        later = [_review('x1', WS, _day(3)), _review('x2', WS, _day(6))]
        _put(world, *busy, *later)
        converse_mock.return_value = '{"category": "trail_gear"}'
        job = _start(world)
        # Time for 27 reviews, then the hand-over: the 28th review is on the busy day's second page.
        worker_context.get_remaining_time_in_millis.side_effect = (
            lambda: 1_000 if converse_mock.call_count >= 27 else 900_000)

        first = run_job(_event(job), worker_context)

        assert first['status'] == 'continued'
        [call] = invoke_mock.call_args_list
        cursor = call.args[1]['cursor']
        assert cursor['day'] == _day(2)
        assert cursor['start']['gsi1pk'] == f'WS#{WS}#DATE#{_day(2)}'
        assert set(cursor['start']) == {'pk', 'sk', 'gsi1pk', 'gsi1sk'}
        stored = jobs.get_job(world['aggregates'], job['sk'], SCOPE)
        assert stored is not None
        assert stored['cursor'] == cursor

        worker_context.get_remaining_time_in_millis.side_effect = None
        worker_context.get_remaining_time_in_millis.return_value = 900_000
        second = run_job(call.args[1], worker_context)

        assert (second['status'], second['scanned'], second['updated']) == ('completed', 32, 32)
        assert converse_mock.call_count == 32
        assert {_category(world, item) for item in (*busy, *later)} == {'trail_gear'}

    def test_from_a_later_day_leaves_the_days_before_it(self, world, worker_context, converse_mock):
        done, todo = _review('w1', WS, _day(1)), _review('w2', WS, _day(4))
        _put(world, done, todo)
        converse_mock.return_value = '{"category": "trail_gear"}'
        job = _start(world, cursor={'day': _day(3)})

        result = run_job(_event(job), worker_context)

        assert (result['status'], result['scanned']) == ('completed', 1)
        assert (_category(world, done), _category(world, todo)) == ('rentals', 'trail_gear')
        assert world['calls'].queried_partitions() == _partitions(_days(_day(3), TODAY.isoformat()))

    def test_the_ceiling_leaves_a_walk_cursor_a_resume_continues_from(self, world, worker_context, converse_mock):
        first_item, second_item = _review('w1', WS, _day(1)), _review('w2', WS, _day(5))
        _put(world, first_item, second_item)
        converse_mock.return_value = '{"category": "trail_gear"}'
        job = _start(world)
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', 1):
            result = run_job(_event(job), worker_context)

        assert result['status'] == 'partial'
        stored = jobs.get_job(world['aggregates'], job['sk'], SCOPE)
        assert stored is not None
        resume_from = stored['resume_from']
        # Where the walk goes on: the start of the day partition the second review is in (the first's day is done).
        assert resume_from == {'day': _day(5)}
        assert _category(world, second_item) == 'rentals'

        resumed = _start(world, cursor=dict(resume_from))
        again = run_job(_event(resumed), worker_context)

        assert (again['status'], again['scanned']) == ('completed', 1)
        assert _category(world, second_item) == 'trail_gear'
        assert converse_mock.call_count == 2


@pytest.mark.usefixtures('invoke_mock')
class TestTheScanStaysWhereTheWalkCannotStart:
    def test_a_job_checkpointed_with_a_scan_cursor_finishes_its_scan(self, world, worker_context, converse_mock):
        item = _review('w1', WS, _day(1))
        _put(world, item)
        converse_mock.return_value = '{"category": "trail_gear"}'
        # A Scan cursor of the table (before the walk): a row before every item (moto scans in key order).
        job = _start(world, cursor={'pk': f'WS#{WS}#SOURCE#a', 'sk': 'FEEDBACK#0'})

        result = run_job(_event(job), worker_context)

        assert result['status'] == 'completed'
        assert world['calls'].operations() & {'Scan', 'Query'} == {'Scan'}

    def test_a_workspace_whose_meta_names_no_creation_time_is_scanned(self, world, worker_context, converse_mock):
        world['workspaces'].update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='REMOVE created_at')
        item = _review('w1', WS, _day(1))
        _put(world, item)
        converse_mock.return_value = '{"category": "trail_gear"}'

        result = run_job(_event(_start(world)), worker_context)

        assert (result['status'], result['scanned']) == ('completed', 1)
        assert world['calls'].operations() & {'Scan', 'Query'} == {'Scan'}
        assert _category(world, item) == 'trail_gear'


@pytest.mark.usefixtures('invoke_mock')
def test_the_creation_time_is_read_with_only_the_attributes_the_role_may_read(world):
    sent: list[dict] = []
    world['workspaces'].meta.client.meta.events.register(
        'before-call.dynamodb.GetItem', lambda params, **_kw: sent.append(json.loads(params['body'])))

    assert REAL_FIRST_POSSIBLE_DAY(SCOPE) == CREATED - timedelta(days=1)

    [request] = [body for body in sent if body['TableName'] == world['workspaces'].name]
    assert request['ConsistentRead'] is True
    assert sorted(request['ExpressionAttributeNames'].values()) == ['created_at', 'pk', 'sk']


@pytest.mark.usefixtures('invoke_mock')
def test_the_deployments_job_still_scans_the_table_as_before(world, worker_context, converse_mock):
    mine, theirs = _review('d1', None, _day(1)), _review('w1', WS, _day(1))
    _put(world, mine, theirs)
    converse_mock.return_value = '{"category": "billing"}'

    result = run_job({'job_id': _start(world, scope=None)['sk']}, worker_context)

    assert (result['status'], result['scanned']) == ('completed', 1)
    reads = world['calls'].reads()
    assert [name for name, _body in reads] == ['Scan']
    assert set(reads[0][1]) == {'TableName', 'Limit', 'FilterExpression', 'ExpressionAttributeNames',
                                'ExpressionAttributeValues'}
    assert (_category(world, mine), _category(world, theirs)) == ('billing', 'rentals')
