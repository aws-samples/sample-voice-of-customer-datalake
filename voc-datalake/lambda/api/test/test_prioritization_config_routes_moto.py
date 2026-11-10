"""The configurable scoring setup, end to end against moto (docs/prioritization.md).

`GET/PUT /projects/prioritization/config`, the setup riding on `GET
/projects/prioritization`, ballots (signed-in PATCH and the room's anonymous
submit) scored against it, and the composite the aggregate reports.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

PARTITION = 'PRIORITIZATION'
BUILTINS = ('impact', 'time_to_market', 'strategic_fit', 'confidence')
SESSION_ID = 'vs_' + '1a' * 16


@pytest.fixture
def lambda_context():
    return MagicMock()


@pytest.fixture
def tables():
    with mock_aws():
        aggregates, projects = pk_sk_table('aggr'), pk_sk_table('projects')
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'One'})
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1',
                                'created_at': '2026-01-01'})
        aggregates.put_item(Item={'pk': PARTITION, 'sk': 'ROW#r1', 'row_id': 'r1', 'project_id': 'p1',
                                  'document_ids': ['d1'], 'is_default': True})
        yield aggregates, projects


def _call(tables, ctx, method, path, body=None, *, subject='alice', admin=True):
    import projects_handler

    claims = {'sub': subject, 'cognito:groups': 'admins' if admin else 'users',
              'cognito:username': f'{subject}-name'}
    aggregates, projects = tables
    return invoke(projects_handler, rest_event(method, path, claims=claims, body=body), ctx,
                  aggregates=aggregates, projects=projects)


def _put_setup(tables, ctx, axes, base_version=0, **kwargs):
    return _call(tables, ctx, 'PUT', '/projects/prioritization/config',
                 {'axes': axes, 'base_version': base_version}, **kwargs)


def _input(axis):
    return {k: v for k, v in axis.items() if k != 'builtin'}


def _default_inputs(tables, ctx):
    _, body = _call(tables, ctx, 'GET', '/projects/prioritization/config')
    return [_input(axis) for axis in body['axes']]


def _value_effort(tables, ctx):
    """The "Value vs Effort" template: built-ins archived, two new metrics."""
    archived = [{**axis, 'archived': True} for axis in _default_inputs(tables, ctx)]
    return [*archived, {'label': 'Value', 'weight': 60},
            {'label': 'Effort', 'weight': 40, 'direction': 'lower_better'}]


def _submit(tables, ctx, body):
    import ballots_handler

    aggregates, _ = tables
    aggregates.put_item(Item={
        'pk': 'VOTING_SESSION', 'sk': f'SESSION#{SESSION_ID}', 'session_id': SESSION_ID, 'row_id': 'r1',
        'row_title': 'Refunds', 'status': 'open', 'ballot_cap': 40, 'ballot_count': 0,
        'created_by': 'f', 'created_at': '2026-08-17T10:00:00+00:00',
        'expires_at': '2096-10-02T07:06:40+00:00', 'ttl': 4_000_000_000,
    })
    return _public(ballots_handler, tables, ctx, 'POST', f'/voting-sessions/{SESSION_ID}/submit', body)


def _public(module, tables, ctx, method, path, body=None):
    event = {
        'httpMethod': method, 'path': path, 'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {'requestId': 't', 'stage': 'test', 'httpMethod': method, 'path': path,
                           'identity': {'sourceIp': '1.2.3.4'}},
        'body': json.dumps(body) if body is not None else None,
        'pathParameters': {'session_id': SESSION_ID}, 'queryStringParameters': None,
        'multiValueQueryStringParameters': None, 'stageVariables': None, 'multiValueHeaders': {},
        'isBase64Encoded': False,
    }
    aggregates, projects = tables
    with patch.object(module, 'get_aggregates_table', return_value=aggregates), \
            patch.object(module, 'get_projects_table', return_value=projects):
        response = module.lambda_handler(event, ctx)
    return response['statusCode'], json.loads(response['body'])


class TestTheDefaultSetup:
    def test_no_stored_setup_reads_as_the_four_builtins_at_version_zero(self, tables, lambda_context):
        status, body = _call(tables, lambda_context, 'GET', '/projects/prioritization/config', admin=False)
        assert (status, body['config_version'], body['updated_by']) == (200, 0, None)
        assert [(a['id'], a['weight'], a['builtin']) for a in body['axes']] == [
            ('impact', 40, True), ('time_to_market', 30, True), ('strategic_fit', 20, True), ('confidence', 10, True)]

    def test_the_board_carries_the_setup(self, tables, lambda_context):
        _, body = _call(tables, lambda_context, 'GET', '/projects/prioritization', admin=False)
        assert (body['config_version'], [a['id'] for a in body['axes']]) == (0, list(BUILTINS))

    def test_a_ballot_stored_before_the_setup_existed_reads_unchanged(self, tables, lambda_context):
        aggregates, _ = tables
        aggregates.put_item(Item={'pk': PARTITION, 'sk': 'BALLOT#r1#user:alice', 'row_id': 'r1',
                                  'reviewer': 'user:alice', 'updated_at': 'then', 'impact': 4,
                                  'time_to_market': 3, 'strategic_fit': 5, 'confidence': 2, 'notes': 'n'})
        _, body = _call(tables, lambda_context, 'GET', '/projects/prioritization')
        assert body['scores']['r1'] == {'row_id': 'r1', 'impact': 4.0, 'time_to_market': 3.0,
                                        'strategic_fit': 5.0, 'confidence': 2.0, 'notes': 'n'}
        assert body['aggregates']['r1']['composite'] == pytest.approx(round(4 * .4 + 3 * .3 + 5 * .2 + 2 * .1, 2))


class TestSavingTheSetup:
    def test_an_admin_saves_and_new_metrics_get_minted_ids(self, tables, lambda_context):
        status, body = _put_setup(tables, lambda_context, _value_effort(tables, lambda_context))
        assert (status, body['config_version'], body['updated_by']) == (200, 1, 'alice-name')
        assert [(a['id'], a['archived']) for a in body['axes'][-2:]] == [('value', False), ('effort', False)]

    def test_the_saved_setup_is_what_every_reader_gets(self, tables, lambda_context):
        _put_setup(tables, lambda_context, _value_effort(tables, lambda_context))
        _, body = _call(tables, lambda_context, 'GET', '/projects/prioritization', admin=False, subject='bob')
        assert (body['config_version'], [a['id'] for a in body['axes'] if not a['archived']]) == (
            1, ['value', 'effort'])

    def test_a_user_who_is_not_an_admin_is_refused(self, tables, lambda_context):
        status, _ = _put_setup(tables, lambda_context, _default_inputs(tables, lambda_context), admin=False)
        aggregates, _ = tables
        assert status == 403
        assert 'Item' not in aggregates.get_item(Key={'pk': PARTITION, 'sk': 'CONFIG'})

    def test_a_stale_base_version_is_a_409(self, tables, lambda_context):
        axes = _default_inputs(tables, lambda_context)
        _put_setup(tables, lambda_context, axes, 0)
        status, body = _put_setup(tables, lambda_context, axes, 0, subject='bob')
        assert (status, 'reload' in body['error']) == (409, True)

    def test_the_current_base_version_saves(self, tables, lambda_context):
        axes = _default_inputs(tables, lambda_context)
        _put_setup(tables, lambda_context, axes, 0)
        assert _put_setup(tables, lambda_context, axes, 1)[1]['config_version'] == 2

    def test_saving_bumps_the_cache_config_version(self, tables, lambda_context):
        aggregates, _ = tables
        _put_setup(tables, lambda_context, _default_inputs(tables, lambda_context))
        assert aggregates.get_item(Key={'pk': 'METRIC#meta', 'sk': 'config_version'})['Item']['v'] == 1

    def test_dropping_an_existing_metric_is_a_400(self, tables, lambda_context):
        status, body = _put_setup(tables, lambda_context, _default_inputs(tables, lambda_context)[1:])
        assert (status, 'archive it instead' in body['error']) == (400, True)

    def test_a_missing_base_version_is_a_400(self, tables, lambda_context):
        status, _ = _call(tables, lambda_context, 'PUT', '/projects/prioritization/config',
                          {'axes': _default_inputs(tables, lambda_context)})
        assert status == 400

    def test_an_invalid_setup_writes_nothing(self, tables, lambda_context):
        aggregates, _ = tables
        axes = [{**axis, 'weight': 0} for axis in _default_inputs(tables, lambda_context)]
        status, _ = _put_setup(tables, lambda_context, axes)
        assert status == 400
        assert 'Item' not in aggregates.get_item(Key={'pk': PARTITION, 'sk': 'CONFIG'})


class TestBallotsAgainstTheSetup:
    def _configure(self, tables, ctx):
        _put_setup(tables, ctx, _value_effort(tables, ctx))

    def test_a_signed_in_ballot_scores_an_active_custom_metric(self, tables, lambda_context):
        self._configure(tables, lambda_context)
        status, _ = _call(tables, lambda_context, 'PATCH', '/projects/prioritization',
                          {'scores': {'r1': {'row_id': 'r1', 'value': 5, 'effort': 2}}})
        aggregates, _ = tables
        stored = aggregates.get_item(Key={'pk': PARTITION, 'sk': 'BALLOT#r1#user:alice'})['Item']
        assert (status, stored['value'], stored['effort']) == (200, 5, 2)

    def test_an_archived_metric_is_a_400(self, tables, lambda_context):
        self._configure(tables, lambda_context)
        status, body = _call(tables, lambda_context, 'PATCH', '/projects/prioritization',
                             {'scores': {'r1': {'impact': 4}}})
        assert (status, 'archived' in body['error']) == (400, True)

    def test_an_unknown_metric_is_a_400(self, tables, lambda_context):
        status, _ = _call(tables, lambda_context, 'PATCH', '/projects/prioritization',
                          {'scores': {'r1': {'impactt': 4}}})
        assert status == 400

    def test_a_room_ballot_scores_an_active_custom_metric(self, tables, lambda_context):
        self._configure(tables, lambda_context)
        status, body = _submit(tables, lambda_context, {'value': 4, 'effort': 1})
        assert (status, body['success']) == (200, True)

    @pytest.mark.parametrize('body', [{'impact': 4}, {'value': 4, 'ghost': 2}])
    def test_a_room_ballot_naming_an_archived_or_unknown_metric_is_refused(self, tables, lambda_context, body):
        self._configure(tables, lambda_context)
        status, refusal = _submit(tables, lambda_context, body)
        assert (status, refusal['reason']) == (400, 'invalid')

    def test_the_public_config_lists_only_active_metrics_without_weights(self, tables, lambda_context):
        import ballots_handler

        self._configure(tables, lambda_context)
        _submit(tables, lambda_context, {'value': 3})
        _, body = _public(ballots_handler, tables, lambda_context, 'GET',
                          f'/voting-sessions/{SESSION_ID}/config')
        assert body['session']['axes'] == [
            {'id': 'value', 'label': 'Value', 'description': None, 'low_label': None, 'high_label': None,
             'direction': 'higher_better', 'builtin': False},
            {'id': 'effort', 'label': 'Effort', 'description': None, 'low_label': None, 'high_label': None,
             'direction': 'lower_better', 'builtin': False},
        ]


class TestTheComposite:
    def _scored(self, tables, ctx, ballots):
        _put_setup(tables, ctx, _value_effort(tables, ctx))
        for subject, scores in ballots.items():
            _call(tables, ctx, 'PATCH', '/projects/prioritization', {'scores': {'r1': scores}}, subject=subject)
        return _call(tables, ctx, 'GET', '/projects/prioritization')[1]['aggregates']['r1']

    def test_weights_and_lower_is_better(self, tables, lambda_context):
        # value 5 (x60) + effort 2 -> 6-2=4 (x40) = 4.6
        aggregate = self._scored(tables, lambda_context, {'alice': {'value': 5, 'effort': 2}})
        assert (aggregate['composite'], aggregate['value'], aggregate['effort']) == (4.6, 5.0, 2.0)

    def test_the_team_composite_counts_every_vote_through_the_team_axis_means(self, tables, lambda_context):
        aggregate = self._scored(tables, lambda_context, {
            'alice': {'value': 5, 'effort': 2},   # 4.6
            'bob': {'value': 3, 'effort': 5},     # (180 + 40) / 100 = 2.2
            'cy': {'value': 1},                   # partial: in the means, not in the spread
        })
        # value mean (5+3+1)/3 = 3.0, effort mean 3.5 -> 6-3.5 = 2.5: 0.6*3 + 0.4*2.5 = 2.8
        assert (aggregate['composite'], aggregate['score_spread'], aggregate['reviewer_count']) == (2.8, 2.4, 3)

    def test_a_partial_owner_ballot_is_not_dropped_beside_a_full_room_ballot(self, tables, lambda_context):
        # The 5.34 e2e: the owner left one metric unscored, a room ballot scored all of
        # them, and the team score read the room ballot alone over "2 reviewers".
        aggregate = self._scored(tables, lambda_context, {
            'owner': {'value': 5},                # partial
            'room': {'value': 1, 'effort': 5},    # full: 0.6*1 + 0.4*1 = 1.0
        })
        # value mean 3.0, effort mean 5 -> 1: 0.6*3 + 0.4*1 = 2.2 (not the room's 1.0)
        assert (aggregate['composite'], aggregate['reviewer_count']) == (2.2, 2)

    def test_a_partial_ballot_alone_composites_over_what_it_scored(self, tables, lambda_context):
        aggregate = self._scored(tables, lambda_context, {'alice': {'effort': 1}})
        assert (aggregate['composite'], aggregate['axis_counts']) == (5.0, {'value': 0, 'effort': 1})

    def test_archived_metrics_are_not_in_the_aggregate(self, tables, lambda_context):
        aggregate = self._scored(tables, lambda_context, {'alice': {'value': 2}})
        assert not set(BUILTINS) & set(aggregate)
