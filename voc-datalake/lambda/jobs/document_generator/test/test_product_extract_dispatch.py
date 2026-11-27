"""The document generator runs the Product tab's extract (7.104.00, ``doc_type`` ``product_extract``): with this
bundle's projects table, the raw bucket and the Bedrock client; an extract that times out ends its job failed with
``error_code`` ``timed_out``."""
from __future__ import annotations

from unittest.mock import MagicMock, call, patch

from jobs.document_generator import handler as H
from shared import product_extract

EVENT = {'project_id': 'p1', 'job_id': 'job_1', 'doc_config': {'doc_type': 'product_extract', 'lock_id': 'l1'}}


def _resource() -> MagicMock:
    resource = MagicMock()
    resource.Table.side_effect = lambda name: MagicMock(name=name)
    return resource


def test_an_extract_job_runs_the_extract_with_this_bundles_clients():
    with patch.object(H, 'get_dynamodb_resource', return_value=_resource()), \
            patch.object(H, 'get_s3_client', return_value='s3'), patch.object(H, 'get_bedrock_client', return_value='br'), \
            patch.object(product_extract, 'run', return_value={'proposal_id': 'pp_1'}) as run, \
            patch('shared.jobs.update_job_status') as status, patch('shared.jobs.notify_project_job'):
        assert H.handle_job(dict(EVENT)) == {'success': True, 'proposal_id': 'pp_1'}
    ctx, project_id, job_id, doc_config = run.call_args.args
    assert set(run.call_args.kwargs) == {'clients'}
    clients = run.call_args.kwargs['clients']
    assert (project_id, job_id, doc_config) == ('p1', 'job_1', EVENT['doc_config'])
    assert (clients.s3, clients.bedrock, clients.bucket) == ('s3', 'br', H.SCRATCH_BUCKET)
    assert clients.table._mock_name == H.PROJECTS_TABLE
    assert ctx.job_id == 'job_1'
    assert status.call_args == call('p1', 'job_1', 'completed', 100, 'complete', result={'proposal_id': 'pp_1'},
                                    workspace=None)


def test_an_extract_that_timed_out_fails_its_job_with_the_word():
    failed = product_extract.ExtractFailed(product_extract.TIMED_OUT, code='timed_out')
    with patch.object(H, 'get_dynamodb_resource', return_value=_resource()), \
            patch.object(H, 'get_s3_client'), patch.object(H, 'get_bedrock_client'), \
            patch.object(product_extract, 'run', side_effect=failed), \
            patch('shared.jobs.update_job_status') as status, patch('shared.jobs.notify_project_job'):
        result = H.handle_job(dict(EVENT))
    assert result == {'success': False, 'error': f'Document generation failed: {product_extract.TIMED_OUT}',
                      'error_code': 'timed_out'}
    assert status.call_args.kwargs['error_code'] == 'timed_out'
