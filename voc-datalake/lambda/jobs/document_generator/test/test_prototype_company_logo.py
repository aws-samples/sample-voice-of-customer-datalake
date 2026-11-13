"""The uploaded company logo in a prototype build.

With a logo (and the "Design system" box on): the prompt names the placeholder, and the stored
HTML carries the logo as a data: URL — the model never sees the image bytes. Without a logo, or
with the box off, the prompt is the one it always was. A revision sends the prior prototype with
the inlined logo turned back into the placeholder.
"""
import base64
from unittest.mock import MagicMock, patch

import pytest

from jobs.document_generator import handler
from jobs.document_generator.test.prototype_table_fixtures import (
    PRD_NEW,
    prompt_sent,
    run_prototype_build,
    saved_item,
    wire_projects_table,
)
from shared.company_logo import LOGO_INSTRUCTION, LOGO_MARKER, LOGO_PLACEHOLDER, LOGO_REMOVED_INSTRUCTION

LOGO = f'data:image/png;{LOGO_MARKER};base64,{base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 3000).decode()}'
MODEL_HTML = f'<!DOCTYPE html><html><body><img src="{LOGO_PLACEHOLDER}" alt="Company logo"></body></html>'


def _stored_html(mock_s3) -> str:
    return mock_s3.put_object.call_args.kwargs['Body'].decode('utf-8')


def _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, *, logo, html=MODEL_HTML,
           included=None, **config):
    wire_projects_table(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': []}])
    mock_converse.return_value = html
    answer = handler.BuildLogo(logo, True) if logo else handler.BuildLogo(None, included)
    with patch.object(handler, '_company_logo', return_value=answer) as company_logo:
        run_prototype_build(sample_job_event, lambda_context, **config)
    return prompt_sent(mock_converse), company_logo


@pytest.mark.usefixtures('mock_jobs_table')
class TestPrototypeLogo:
    def test_a_logo_puts_the_instruction_in_the_prompt_and_the_image_in_the_html(
        self, mock_dynamodb, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        prompt, _ = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, logo=LOGO)
        assert LOGO_INSTRUCTION in prompt
        assert LOGO not in prompt
        stored = _stored_html(mock_s3)
        assert f'<img src="{LOGO}" alt="Company logo">' in stored
        assert LOGO_PLACEHOLDER not in stored

    def test_no_logo_leaves_the_prompt_alone_and_writes_a_stray_placeholder_as_the_wordmark(
        self, mock_dynamodb, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        prompt, _ = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, logo=None,
                           brand='Example Air')
        assert 'COMPANY LOGO' not in prompt
        stored = _stored_html(mock_s3)
        assert LOGO_PLACEHOLDER not in stored
        assert '<span class="company-wordmark" style="font-weight:700">Example Air</span>' in stored

    def test_a_revision_without_a_logo_asks_for_a_wordmark_instead_of_the_placeholder(
        self, mock_dynamodb, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        prior = f'<!DOCTYPE html><html><body><img src="{LOGO}" alt="Company logo"></body></html>'
        with patch.object(handler, '_base_prototype', return_value={'document_id': 'base'}), \
                patch.object(handler, '_prior_prototype_html', return_value=prior):
            prompt, _ = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, logo=None,
                               feedback='make it bolder', base_prototype_id='base')
        assert LOGO_REMOVED_INSTRUCTION in prompt
        assert LOGO not in prompt
        assert LOGO_PLACEHOLDER not in _stored_html(mock_s3)

    @pytest.mark.usefixtures('mock_s3')
    @pytest.mark.parametrize(('config', 'expected'), [({}, True), ({'use_design_system': True}, True),
                                                      ({'use_design_system': False}, False)])
    def test_the_design_system_box_decides_for_the_logo(
        self, config, expected, mock_dynamodb, mock_converse, sample_job_event, lambda_context,
    ):
        _, company_logo = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, logo=None, **config)
        company_logo.assert_called_once_with(expected)


@pytest.mark.usefixtures('mock_jobs_table', 'mock_s3')
class TestDerivationRecordsTheLogo:
    @pytest.mark.parametrize(('logo', 'included', 'recorded'), [(LOGO, True, True), (None, False, False), (None, None, 'absent')])
    def test_company_logo_included(self, logo, included, recorded, mock_dynamodb, mock_converse,
                                   sample_job_event, lambda_context):
        _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, logo=logo, included=included)
        derivation = saved_item(mock_dynamodb)[handler.DERIVATION_FIELD]
        assert derivation.get('company_logo_included', 'absent') == recorded


class TestCompanyLogoRead:
    def test_off_reads_nothing(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        with patch.object(handler, 'get_dynamodb_resource') as dynamodb:
            assert handler._company_logo(False) == handler.BuildLogo()
        dynamodb.assert_not_called()

    def test_reads_the_design_system_row_and_the_bucket(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        table = MagicMock()
        table.get_item.return_value = {'Item': {'logo_s3_key': 'company-context/design/logo_aaaaaaaaaaaa.png'}}
        s3 = MagicMock()
        with patch.object(handler, 'get_dynamodb_resource') as dynamodb, \
                patch.object(handler, '_s3', return_value=s3), \
                patch.object(handler, 'company_logo_data_url', return_value=LOGO) as data_url:
            dynamodb.return_value.Table.return_value = table
            assert handler._company_logo(True) == handler.BuildLogo(LOGO, True)
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#design_system', 'sk': 'config'})
        assert data_url.call_args.args == (table.get_item.return_value['Item'], s3, handler.SCRATCH_BUCKET)

    def test_a_failed_row_read_builds_without_the_logo(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('throttled')
        with patch.object(handler, 'get_dynamodb_resource') as dynamodb:
            dynamodb.return_value.Table.return_value = table
            assert handler._company_logo(True) == handler.BuildLogo()

    def test_no_aggregates_table_is_no_logo(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert handler._company_logo(True) == handler.BuildLogo()

    @pytest.mark.parametrize(('row', 'data_url', 'expected'), [
        ({'logo_s3_key': 'company-context/design/logo_aaaaaaaaaaaa.png'}, None, (None, False)),  # uploaded, left out
        ({}, None, (None, None)),                                                                # none uploaded
    ])
    def test_a_logo_left_out_is_recorded_and_no_logo_is_not(self, monkeypatch, row, data_url, expected):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        table = MagicMock()
        table.get_item.return_value = {'Item': row}
        with patch.object(handler, 'get_dynamodb_resource') as dynamodb, patch.object(handler, '_s3'), \
                patch.object(handler, 'company_logo_data_url', return_value=data_url):
            dynamodb.return_value.Table.return_value = table
            assert handler._company_logo(True) == handler.BuildLogo(*expected)


class TestRevisionPriorHtml:
    def test_the_prior_prototype_reaches_the_model_with_the_placeholder_not_the_image(self):
        prior = f'<!DOCTYPE html><html><body><img src="{LOGO}" alt="Company logo"></body></html>'
        with patch.object(handler, '_prior_prototype_html', return_value=prior):
            section = handler._revision_feedback_section('proj', {'document_id': 'd'}, 'make it bolder')
        assert LOGO not in section
        assert f'<img src="{LOGO_PLACEHOLDER}" alt="Company logo">' in section
