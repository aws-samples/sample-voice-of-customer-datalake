"""
POST /projects/{id}/build-prototype — the source-document trust boundary (U25).

A build can name the PRD and PR/FAQ it should read. Those ids arrive from the
client and their content is read straight into a Bedrock prompt, so an id that
resolved outside this project would pull another project's document into this
project's generation.

Ownership and type are enforced by the key rather than by a check: `pk` is the
project and `sk` is `{TYPE}#{id}`. This file pins that, plus the reason the
validation happens here at all — an unresolvable id must cost a 4xx, not a
multi-minute billable build that fails at the end.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

PROJECT = 'proj_1'
PATH = f'/projects/{PROJECT}/build-prototype'


@pytest.fixture
def build_prototype(api_gateway_event, lambda_context):
    """
    Call the endpoint with a projects table holding one PRD and one PR/FAQ.

    Returns (response, job_config, table) where `job_config` is the doc_config
    handed to the generator, or None when no job was created.
    """
    def _call(body):
        table = MagicMock()
        documents = {'PRD#prd_1': {'document_id': 'prd_1'}, 'PRFAQ#prfaq_1': {'document_id': 'prfaq_1'}}

        def get_item(Key=None, **kwargs):
            item = documents.get((Key or {}).get('sk', ''))
            return {'Item': item} if item else {}

        table.get_item.side_effect = get_item

        with patch('projects_handler.get_projects_table', return_value=table), \
                patch('projects_handler.create_job', return_value=('job_1', {})) as create_job, \
                patch('projects_handler.invoke_lambda_async') as invoke:
            from projects_handler import lambda_handler
            response = lambda_handler(
                api_gateway_event(method='POST', path=PATH, body=body, path_params={'project_id': PROJECT}),
                lambda_context,
            )
        config = create_job.call_args.args[3] if create_job.call_args else None
        return response, config, table, invoke

    return _call


class TestAimedBuildIsAccepted:
    def test_named_documents_reach_the_generator(self, build_prototype):
        response, config, _table, invoke = build_prototype(
            {'source_prd_id': 'prd_1', 'source_prfaq_id': 'prfaq_1'},
        )

        assert response['statusCode'] == 200
        assert config['source_prd_id'] == 'prd_1'
        assert config['source_prfaq_id'] == 'prfaq_1'
        # And the generator is told the same thing the job records.
        assert invoke.call_args.args[1]['doc_config']['source_prd_id'] == 'prd_1'

    def test_naming_nothing_leaves_both_slots_unaimed(self, build_prototype):
        """The pre-existing request shape. Both slots must come through as None so
        the generator falls back to latest-of-each, exactly as before."""
        response, config, _table, _invoke = build_prototype({'title': 'Prototype'})

        assert response['statusCode'] == 200
        assert config['source_prd_id'] is None
        assert config['source_prfaq_id'] is None

    def test_a_blank_id_is_not_a_choice(self, build_prototype):
        """A cleared picker sends '', which means "unaimed", not "document ''"."""
        response, config, _table, _invoke = build_prototype(
            {'source_prd_id': '', 'source_prfaq_id': '   '},
        )

        assert response['statusCode'] == 200
        assert config['source_prd_id'] is None
        assert config['source_prfaq_id'] is None

    def test_surrounding_whitespace_is_trimmed(self, build_prototype):
        response, config, _table, _invoke = build_prototype({'source_prd_id': ' prd_1 '})

        assert response['statusCode'] == 200
        assert config['source_prd_id'] == 'prd_1'


class TestUnresolvableIdIsRejectedBeforeAnyCost:
    def test_an_unknown_id_is_a_404_and_starts_no_job(self, build_prototype):
        """The whole reason to validate here rather than only in the generator:
        no job row, no generator invocation, no Bedrock spend."""
        response, config, _table, invoke = build_prototype({'source_prd_id': 'prd_nope'})

        assert response['statusCode'] == 404
        assert 'source_prd_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_a_prfaq_id_offered_as_a_prd_is_rejected(self, build_prototype):
        """`prfaq_1` is a real document in this project, just not a PRD. The `sk`
        prefix is what separates the two, so no type check is needed."""
        response, _config, _table, invoke = build_prototype({'source_prd_id': 'prfaq_1'})

        assert response['statusCode'] == 404
        invoke.assert_not_called()

    def test_lookups_only_ever_address_this_project(self, build_prototype):
        """The ownership property, asserted on the key that gets built: the
        supplied string reaches `sk` only, never `pk`."""
        _response, _config, table, _invoke = build_prototype(
            {'source_prd_id': '../PROJECT#victim/prd_1'},
        )

        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert keys, 'expected at least one keyed read'
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}
        assert keys[0]['sk'] == 'PRD#../PROJECT#victim/prd_1'

    @pytest.mark.parametrize('value', [
        pytest.param(['prd_1'], id='list'),
        pytest.param({'id': 'prd_1'}, id='object'),
        pytest.param(7, id='number'),
        pytest.param(True, id='bool'),
    ])
    def test_a_non_string_id_is_a_400(self, build_prototype, value):
        """JSON can deliver any of these. None of them can be a document id, and
        an f-string would happily interpolate every one into a key."""
        response, config, _table, invoke = build_prototype({'source_prd_id': value})

        assert response['statusCode'] == 400
        assert 'source_prd_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_an_absurdly_long_id_is_a_400_not_a_500(self, build_prototype):
        """A sort key is capped at 1024 bytes. Unbounded, this reaches DynamoDB
        and comes back as a ValidationException — a 500 for what is a bad
        request."""
        response, _config, table, _invoke = build_prototype({'source_prd_id': 'x' * 5000})

        assert response['statusCode'] == 400
        # Rejected before the key was ever built.
        assert not any(
            'x' * 5000 in str(call.kwargs.get('Key', {}))
            for call in table.get_item.call_args_list
        )
