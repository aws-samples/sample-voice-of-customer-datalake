"""A workspace's category reprocess (7.13.00, TENETS.md D3; docs/multi-workspace.md).

The settings API starts it with the workspace on the job row (``WS#{ws}#JOB#category_reprocess``) and on the event
(``workspace_id``). The worker then reads only that workspace's reviews (``WS#{ws}#…``, through the workspace layer),
re-derives them with that workspace's own categories and dimensions (never the deployment's), writes its own index
partitions (``WS#{ws}#CATEGORY#…`` / ``WS#{ws}#URGENCY#…``), keeps each old version under ``ws/{ws}/silver/`` and
bumps the workspace's own data_version; the aggregator then moves the workspace's counters, never the deployment's.
Another workspace's reviews and the deployment's are left as they were.
"""
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import patch

import pytest

from jobs.category_reprocess import handler
from jobs.category_reprocess.handler import WRONG_WORKSPACE_ERROR, run_job
from shared import reprocess_jobs as jobs
from shared.data_version import data_version_key
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE = WorkspaceScope(WS)
#: The workspace's own taxonomy: none of it is the deployment's (conftest CATEGORIES: shipping, billing).
WS_CATEGORIES = [{'name': 'trail_gear', 'description': 'Trail gear', 'subcategories': [{'name': 'brakes'}]},
                 {'name': 'rentals', 'description': 'Rentals'}]
WS_DIMENSIONS = [{'key': 'terrain', 'label': 'Terrain', 'infer': True, 'values': [{'name': 'gravel'}, {'name': 'road'}]}]


def _today() -> str:
    """Today's date, read when a test runs (never pinned at import)."""
    return datetime.now(UTC).strftime('%Y-%m-%d')


def _review(feedback_id: str, ws: str | None, **overrides) -> dict:
    """A stored review of workspace ``ws`` (the deployment's for None), filed under ``rentals``."""
    prefix = '' if ws is None else f'WS#{ws}#'
    today = _today()
    item = {
        'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'gsi1pk': f'{prefix}DATE#{today}', 'gsi1sk': f'{today}T00:00:00+00:00#{feedback_id}',
        'gsi2pk': f'{prefix}CATEGORY#rentals', 'gsi2sk': f'0.1#{today}T00:00:00+00:00',
        'gsi3pk': f'{prefix}URGENCY#low', 'gsi3sk': f'{today}T00:00:00+00:00',
        'date': today, 'source_platform': 'web', 'source_channel': 'reviews', 'urgency': 'low',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.6'), 'persona_type': 'existing_customer',
        'original_text': 'The rear brakes squeal on every descent', 'category': 'rentals',
    }
    item.update(overrides)
    return item


@pytest.fixture
def seeded(tables):
    """The workspace's categories and dimensions, and a review in the workspace, another workspace and the
    deployment."""
    aggregates, feedback = tables['aggregates'], tables['feedback']
    aggregates.put_item(Item={**settings_key(WS, 'categories'), 'categories': WS_CATEGORIES})
    aggregates.put_item(Item={**settings_key(WS, 'dimensions'), 'dimensions': WS_DIMENSIONS})
    for item in (_review('w1', WS), _review('o1', OTHER), _review('d1', None)):
        feedback.put_item(Item=item)
    return tables


def _start(tables, mode: str = jobs.MODE_PROCESSED, scope: WorkspaceScope | None = SCOPE) -> dict:
    job = jobs.start_job(tables['aggregates'], mode=mode, days=0, include_manual=False, started_by='ada',
                         now=datetime.now(UTC), started_by_sub='sub-ada', scope=scope)
    assert job is not None
    return job


def _event(job: dict, ws: str = WS) -> dict:
    return {'job_id': job['sk'], 'workspace_id': ws}


def _run_raw(tables, worker_context, answer: dict):
    """A raw-mode job of the workspace whose enrichment answers ``answer``: ``(result, the enrichment mock)``."""
    job = _start(tables, mode=jobs.MODE_RAW)
    with patch.object(handler, 'run_enrichment') as enrichment:
        enrichment.return_value.llm_failed = False
        enrichment.return_value.category_valid = True
        enrichment.return_value.attributes = answer
        enrichment.return_value.llm_result = {'metadata': {}}
        result = run_job(_event(job), worker_context)
    return result, enrichment


def _stored(tables, pk: str, feedback_id: str) -> dict:
    return tables['feedback'].get_item(Key={'pk': pk, 'sk': f'FEEDBACK#{feedback_id}'})['Item']


@pytest.mark.usefixtures('invoke_mock')
class TestAWorkspacesReviewsAreReplayedWithItsOwnTaxonomy:
    def test_relabelled_with_the_workspaces_categories_in_its_own_index_partition(
            self, seeded, worker_context, converse_mock):
        converse_mock.return_value = '{"category": "trail_gear", "subcategory": "brakes"}'
        job = _start(seeded)

        result = run_job(_event(job), worker_context)

        assert (result['status'], result['scanned'], result['updated']) == ('completed', 1, 1)
        after = _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')
        assert (after['category'], after['subcategory']) == ('trail_gear', 'brakes')
        assert after['gsi2pk'] == f'WS#{WS}#CATEGORY#trail_gear'
        assert after['category_source'] == 'reprocess'
        # The model was offered the workspace's categories, never the deployment's.
        prompt = str(converse_mock.call_args)
        assert 'trail_gear' in prompt
        assert 'shipping' not in prompt
        assert converse_mock.call_count == 1
        stored = jobs.get_job(seeded['aggregates'], job['sk'], SCOPE)
        assert stored is not None
        assert (stored['status'], stored['workspace_id']) == ('completed', WS)

    def test_a_workspace_that_saved_no_categories_gets_the_defaults_never_the_deployments(
            self, tables, worker_context, converse_mock):
        tables['feedback'].put_item(Item=_review('w1', WS))
        converse_mock.return_value = '{"category": "delivery"}'
        job = _start(tables)

        result = run_job(_event(job), worker_context)

        assert result['status'] == 'completed'
        prompt = str(converse_mock.call_args)
        assert 'delivery' in prompt
        assert 'shipping' not in prompt
        assert _stored(tables, f'WS#{WS}#SOURCE#web', 'w1')['gsi2pk'] == f'WS#{WS}#CATEGORY#delivery'

    def test_dimensions_are_reinferred_with_the_workspaces_own(self, seeded, worker_context):
        job = _start(seeded, mode=jobs.MODE_DIMENSIONS)
        with patch.object(handler, 'classify_dimensions', return_value={'terrain': 'gravel'}) as classify:
            result = run_job(_event(job), worker_context)

        assert result['status'] == 'completed'
        assert [d['key'] for d in classify.call_args.args[2] if not d.get('builtin')] == ['terrain']
        after = _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')
        assert after['dimensions']['terrain'] == 'gravel'

    def test_raw_mode_files_its_urgency_in_the_workspaces_partition(self, seeded, worker_context):
        answer = {'category': 'trail_gear', 'subcategory': 'brakes', 'urgency': 'high'}
        result, enrichment = _run_raw(seeded, worker_context, answer)

        assert result['status'] == 'completed'
        after = _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')
        assert (after['gsi2pk'], after['gsi3pk']) == (f'WS#{WS}#CATEGORY#trail_gear', f'WS#{WS}#URGENCY#high')
        assert enrichment.call_args.args[3] == WS_CATEGORIES

    def test_a_summary_only_review_stays_summary_only(self, seeded, worker_context):
        seeded['feedback'].put_item(Item=_review('w2', WS, pii_policy='summary_only'))
        answer = {'category': 'rentals', 'subcategory': None, 'urgency': 'low', 'normalized_text': 'the full text'}
        _run_raw(seeded, worker_context, answer)

        assert 'normalized_text' not in _stored(seeded, f'WS#{WS}#SOURCE#web', 'w2')

    def test_each_old_version_is_kept_under_the_workspace(self, seeded, worker_context, converse_mock, kept_versions):
        converse_mock.return_value = '{"category": "trail_gear", "subcategory": "brakes"}'
        run_job(_event(_start(seeded)), worker_context)

        [kept] = kept_versions.call_args_list
        assert kept.args[0]['pk'] == f'WS#{WS}#SOURCE#web'
        assert kept.kwargs['scope'] == SCOPE

    def test_the_workspaces_own_data_version_is_bumped(self, seeded, worker_context, converse_mock):
        converse_mock.return_value = '{"category": "trail_gear"}'
        run_job(_event(_start(seeded)), worker_context)

        assert seeded['aggregates'].get_item(Key=data_version_key(SCOPE)).get('Item', {}).get('v', 0) >= 1
        assert 'Item' not in seeded['aggregates'].get_item(Key=data_version_key())


@pytest.mark.usefixtures('invoke_mock')
class TestNothingElseIsTouched:
    def test_another_workspaces_reviews_and_the_deployments_are_left_as_they_were(
            self, seeded, worker_context, converse_mock):
        before = {pk: _stored(seeded, pk, fid) for pk, fid in ((f'WS#{OTHER}#SOURCE#web', 'o1'), ('SOURCE#web', 'd1'))}
        converse_mock.return_value = '{"category": "trail_gear", "subcategory": "brakes"}'

        result = run_job(_event(_start(seeded)), worker_context)

        assert result['scanned'] == 1
        for pk, fid in ((f'WS#{OTHER}#SOURCE#web', 'o1'), ('SOURCE#web', 'd1')):
            assert _stored(seeded, pk, fid) == before[pk]

    def test_the_deployments_job_still_skips_every_workspaces_reviews(self, seeded, worker_context, converse_mock):
        converse_mock.return_value = '{"category": "shipping", "subcategory": "late"}'
        job = _start(seeded, scope=None)

        result = run_job({'job_id': job['sk']}, worker_context)

        assert (result['status'], result['scanned']) == ('completed', 1)
        assert _stored(seeded, 'SOURCE#web', 'd1')['gsi2pk'] == 'CATEGORY#shipping'
        assert _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')['category'] == 'rentals'
        assert 'trail_gear' not in str(converse_mock.call_args)

    def test_a_workspaces_job_is_not_found_outside_its_workspace(self, seeded, worker_context, converse_mock):
        job = _start(seeded)

        as_the_deployments = run_job({'job_id': job['sk']}, worker_context)
        in_another_workspace = run_job(_event(job, OTHER), worker_context)

        assert as_the_deployments == {'status': 'not_active'}
        assert in_another_workspace == {'status': 'not_active'}
        converse_mock.assert_not_called()

    def test_a_row_that_does_not_name_its_workspace_fails_before_any_read(self, seeded, worker_context, converse_mock):
        job = _start(seeded)
        seeded['aggregates'].update_item(Key={'pk': f'WS#{WS}#JOB#category_reprocess', 'sk': job['sk']},
                                         UpdateExpression='SET workspace_id = :o', ExpressionAttributeValues={':o': OTHER})

        result = run_job(_event(job), worker_context)

        assert result == {'status': 'failed'}
        stored = jobs.get_job(seeded['aggregates'], job['sk'], SCOPE)
        assert stored is not None
        assert stored['error'] == WRONG_WORKSPACE_ERROR
        converse_mock.assert_not_called()
        assert _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')['category'] == 'rentals'

    @pytest.mark.parametrize('named', [None, '', 'not-a-workspace'])
    def test_an_event_naming_no_real_workspace_is_ignored(self, seeded, worker_context, named):
        job = _start(seeded, scope=None)

        result = run_job({'job_id': job['sk'], 'workspace_id': named}, worker_context)

        assert result == {'status': 'ignored'}
        stored = jobs.get_job(seeded['aggregates'], job['sk'])
        assert stored is not None
        assert stored['status'] == 'queued'


def _hand_over_with_no_time_left(tables, worker_context, invoke_mock) -> tuple[dict, dict]:
    """Run a workspace job with no time left: ``(the job, the event it handed over with)``."""
    worker_context.get_remaining_time_in_millis.return_value = 0
    job = _start(tables)
    result = run_job(_event(job), worker_context)
    assert result['status'] == 'continued'
    [call] = invoke_mock.call_args_list
    event = call.args[1]
    assert (event['workspace_id'], event['job_id']) == (WS, job['sk'])
    return job, event


@pytest.mark.usefixtures('converse_mock')
def test_a_hand_over_carries_the_workspace(seeded, worker_context, invoke_mock):
    _job, event = _hand_over_with_no_time_left(seeded, worker_context, invoke_mock)

    assert 'worker_token' in event


def _lock(tables, ws: str = WS) -> dict:
    key = {'pk': f'WS#{ws}#JOB#category_reprocess', 'sk': 'LOCK'}
    return tables['aggregates'].get_item(Key=key, ConsistentRead=True).get('Item') or {}


@pytest.mark.usefixtures('invoke_mock')
def test_a_job_that_fails_frees_the_workspaces_lock(seeded, worker_context):
    job = _start(seeded)
    held = _lock(seeded)

    with patch.object(handler, 'reprocess_item', side_effect=RuntimeError('a review could not be read')):
        result = run_job(_event(job), worker_context)

    stored = jobs.get_job(seeded['aggregates'], job['sk'], SCOPE)
    after = _lock(seeded)
    assert held['active_job_id'] == job['sk']
    assert result == {'status': 'failed'}
    assert stored is not None
    assert (stored['status'], stored['error']) == ('failed', 'Reprocess failed (RuntimeError)')
    assert 'active_job_id' not in after
    next_job = _start(seeded)  # the workspace can start a new job at once
    assert next_job['sk'] != job['sk']


def test_one_live_job_per_workspace_beside_the_deployments(tables):
    def start(scope: WorkspaceScope | None) -> dict | None:
        return jobs.start_job(tables['aggregates'], mode=jobs.MODE_PROCESSED, days=0, include_manual=False,
                              started_by='ada', now=datetime.now(UTC), scope=scope)

    first = start(SCOPE)
    second = start(SCOPE)
    other = start(WorkspaceScope(OTHER))
    deployment = start(None)

    assert first is not None
    assert second is None  # the workspace's lock is held by its first job
    assert other is not None
    assert deployment is not None
    lock = tables['aggregates'].get_item(Key={'pk': f'WS#{WS}#JOB#category_reprocess', 'sk': 'LOCK'})['Item']
    assert lock['active_job_id'] == first['sk']


def _stream_record(name: str, seq: int, *, new: dict, old: dict | None = None) -> dict:
    """The DynamoDB Streams record of a feedback write (NEW_AND_OLD_IMAGES), as the aggregator receives it."""
    from boto3.dynamodb.types import TypeSerializer

    serializer = TypeSerializer()
    body: dict = {'SequenceNumber': f'{1000 + seq}', 'StreamViewType': 'NEW_AND_OLD_IMAGES',
                  'NewImage': {key: serializer.serialize(value) for key, value in new.items()}}
    if old is not None:
        body['OldImage'] = {key: serializer.serialize(value) for key, value in old.items()}
    return {'eventID': f'evt-{seq}', 'eventName': name, 'eventSource': 'aws:dynamodb', 'dynamodb': body}


def _aggregate(table, records: list[dict]) -> None:
    """Each record through the aggregator's record handler, on ``table`` (no dedupe table, no watermark write)."""
    from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

    from aggregator import handler as aggregator
    from shared.data_version import BatchBump

    with patch.object(aggregator, 'aggregates_table', table), \
            patch.object(aggregator, 'AGGREGATES_TABLE', table.name), \
            patch.object(aggregator, 'IDEMPOTENCY_TABLE', ''), \
            patch.object(aggregator, 'workspace_active', lambda _scope: True), \
            patch.object(aggregator, 'lower_earliest_date', lambda _date: None), \
            patch.object(aggregator, 'data_changed', BatchBump(aggregator.bump_data_version)), \
            patch.object(aggregator, 'metrics'):
        for raw in records:
            aggregator.record_handler(DynamoDBRecord(raw))


@pytest.mark.usefixtures('invoke_mock')
def test_the_aggregator_moves_the_workspaces_counters_and_not_the_deployments(seeded, worker_context, converse_mock):
    """The rewrite's stream record (MODIFY, old and new image) applied by the aggregator: the review leaves the
    workspace's ``rentals`` counter for ``trail_gear``; no deployment counter is written."""
    import boto3

    counters = create_pk_sk_table('agg-reprocess-counters', boto3.resource('dynamodb', region_name='us-east-1'))
    before = _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')
    _aggregate(counters, [_stream_record('INSERT', 1, new=before)])
    converse_mock.return_value = '{"category": "trail_gear", "subcategory": "brakes"}'
    run_job(_event(_start(seeded)), worker_context)
    after = _stored(seeded, f'WS#{WS}#SOURCE#web', 'w1')

    _aggregate(counters, [_stream_record('MODIFY', 2, old=before, new=after)])

    rows = {(str(row['pk']), str(row['sk'])): row.get('count') for row in counters.scan()['Items']}
    day = str(before['date'])
    assert rows[(f'WS#{WS}#METRIC#daily_category#rentals', day)] == 0
    assert rows[(f'WS#{WS}#METRIC#daily_category#trail_gear', day)] == 1
    assert [pk for pk, _sk in rows if not pk.startswith(f'WS#{WS}#')] == []


@pytest.mark.usefixtures('converse_mock')
def test_a_workspace_job_hands_over_between_pages_of_other_scopes_rows(tables, worker_context, invoke_mock):
    """Pages holding none of the workspace's rows never reach the per-review time check: the job checks between
    pages too, and hands over from the page's cursor before its time runs out."""
    for n in range(30):
        tables['feedback'].put_item(Item=_review(f'o{n:02d}', OTHER))

    job, event = _hand_over_with_no_time_left(tables, worker_context, invoke_mock)

    assert event['cursor']
    stored = jobs.get_job(tables['aggregates'], job['sk'], SCOPE)
    assert stored is not None
    assert stored['cursor'] == event['cursor']


@pytest.mark.usefixtures('invoke_mock')
def test_a_workspace_job_pages_through_a_table_mostly_of_other_scopes(tables, worker_context, converse_mock):
    """More rows than a page, most of them another workspace's or the deployment's: a page's cursor is often
    another scope's row (``Limit`` applies before the filter), and the job still reads every row of its own."""
    for n in range(40):
        ws = WS if n % 4 == 0 else (OTHER if n % 2 else None)
        tables['feedback'].put_item(Item=_review(f'r{n:02d}', ws))
    converse_mock.return_value = '{"category": "delivery"}'
    job = _start(tables)

    result = run_job(_event(job), worker_context)

    assert (result['status'], result['scanned'], result['updated']) == ('completed', 10, 10)
    mine = [item for item in tables['feedback'].scan()['Items'] if str(item['pk']).startswith(f'WS#{WS}#')]
    assert {item['category'] for item in mine} == {'delivery'}
    others = [item for item in tables['feedback'].scan()['Items'] if not str(item['pk']).startswith(f'WS#{WS}#')]
    assert {item['category'] for item in others} == {'rentals'}


@pytest.mark.usefixtures('invoke_mock')
def test_a_page_that_rewrote_none_of_the_workspaces_reviews_bumps_nothing(tables, worker_context, converse_mock):
    """Three pages: one of another workspace's rows only, one with the workspace's review, then the last. The
    workspace's data_version is bumped after the page that rewrote its review and once when the invocation ends,
    never after the page that held none of its rows (the deployment's job bumps after every page)."""
    other, mine = _review('o1', OTHER), _review('w1', WS)
    for item in (other, mine):
        tables['feedback'].put_item(Item=item)
    pages = [{'Items': [other], 'LastEvaluatedKey': {'pk': other['pk'], 'sk': other['sk']}},
             {'Items': [mine], 'LastEvaluatedKey': {'pk': mine['pk'], 'sk': mine['sk']}},
             {'Items': []}]
    converse_mock.return_value = '{"category": "delivery"}'
    job = _start(tables)
    bumps: list[object] = []
    real_bump = handler.bump_data_version

    def counting_bump(*args, **kwargs):
        bumps.append(kwargs.get('scope'))
        return real_bump(*args, **kwargs)

    with patch.object(handler, 'scan_page', side_effect=pages), \
            patch.object(handler, 'bump_data_version', counting_bump):
        result = run_job(_event(job), worker_context)

    assert (result['status'], result['scanned'], result['updated']) == ('completed', 1, 1)
    assert bumps == [SCOPE, SCOPE]  # after page 2, and run_job's own at the end; none after page 1
