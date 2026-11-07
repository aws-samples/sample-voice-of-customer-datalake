"""The methodology on the Projects API (tenet 2, shared/methodology.py, docs/project-workspace.md → Methodology).

A generation route answers ``methodology`` (the upstream steps it skips) and stores it in the
job config; a PR/FAQ / PRD reads feedback unless the body turns it off; a prototype with no
PRD and no PR/FAQ is refused before any job (409)."""
import json
from typing import Any
from unittest.mock import MagicMock, patch

from shared.category_access import CategoryScope

SCOPE = CategoryScope(all=True, categories=frozenset())


def _call(api_gateway_event, lambda_context, path: str, body: dict[str, Any], items: list[dict]):
    from projects_handler import lambda_handler
    event = api_gateway_event(method='POST', path=path, path_params={'project_id': 'p1'}, body=body)
    with patch('projects_handler.category_gate.scope_for_event', return_value=SCOPE), \
            patch('projects_handler._require_project_exists'), \
            patch('projects_handler._methodology_items', return_value=items), \
            patch('projects_handler.ensure_research_feedback'), \
            patch('projects_handler.create_job', return_value=('job-1', {})) as create_job, \
            patch('projects_handler.invoke_lambda_async'), \
            patch('projects_handler.boto3.client', return_value=MagicMock()), \
            patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': 'arn:sm:research',
                                      'DOCUMENT_STATE_MACHINE_ARN': ''}):
        response = lambda_handler(event, lambda_context)
    config = create_job.call_args.args[3] if create_job.call_args else None
    return response['statusCode'], json.loads(response['body']), config


PERSONA = {'sk': 'PERSONA#p1', 'persona_id': 'p1'}
PRFAQ = {'sk': 'PRFAQ#f1', 'document_id': 'f1'}


class TestDocumentRoute:
    def test_a_headless_post_reads_feedback_and_reports_the_gaps(self, api_gateway_event, lambda_context):
        status, body, config = _call(api_gateway_event, lambda_context, '/projects/p1/document',
                                     {'doc_type': 'prd'}, [])
        assert status == 200
        assert config is not None
        assert config['data_sources']['feedback'] is True
        assert body['methodology']['skipped'] == [
            {'step': 'personas', 'reason': 'missing'}, {'step': 'prfaq', 'reason': 'missing'},
        ]
        # The job finishes the same block on the document.
        assert config['methodology'] == body['methodology']

    def test_feedback_turned_off_is_honoured_and_said(self, api_gateway_event, lambda_context):
        status, body, config = _call(api_gateway_event, lambda_context, '/projects/p1/document', {
            'doc_type': 'prfaq', 'data_sources': {'feedback': False, 'personas': True},
        }, [PERSONA])
        assert status == 200
        assert config is not None
        assert config['data_sources']['feedback'] is False
        assert body['methodology']['skipped'] == [{'step': 'feedback', 'reason': 'not_selected'}]

    def test_the_full_path_skips_nothing(self, api_gateway_event, lambda_context):
        status, body, _ = _call(api_gateway_event, lambda_context, '/projects/p1/document', {
            'doc_type': 'prd', 'data_sources': {'personas': True, 'documents': True},
        }, [PERSONA, PRFAQ])
        assert status == 200
        assert body['methodology']['skipped'] == []

    def test_a_client_sent_block_is_replaced(self, api_gateway_event, lambda_context):
        _, _, config = _call(api_gateway_event, lambda_context, '/projects/p1/document',
                             {'doc_type': 'prd', 'methodology': {'skipped': []}}, [])
        assert config is not None
        assert config['methodology']['skipped'] != []


class TestPrototypeRoute:
    def test_no_source_is_refused_before_any_job(self, api_gateway_event, lambda_context):
        status, body, config = _call(api_gateway_event, lambda_context, '/projects/p1/build-prototype', {}, [])
        assert status == 409
        assert body['error'] == 'No PRD or PR/FAQ found for this project. Generate at least one first.'
        assert config is None

    def test_a_prfaq_alone_builds_and_says_the_prd_is_missing(self, api_gateway_event, lambda_context):
        status, body, config = _call(api_gateway_event, lambda_context, '/projects/p1/build-prototype', {}, [PRFAQ])
        assert status == 200
        assert body['methodology']['skipped'] == [{'step': 'prd', 'reason': 'missing'}]
        assert config is not None
        assert config['methodology'] == body['methodology']


class TestResearchRoute:
    def test_research_without_selected_personas_says_so(self, api_gateway_event, lambda_context):
        status, body, _ = _call(api_gateway_event, lambda_context, '/projects/p1/research', {}, [PERSONA])
        assert status == 200
        assert body['methodology']['skipped'] == [{'step': 'personas', 'reason': 'not_selected'}]
