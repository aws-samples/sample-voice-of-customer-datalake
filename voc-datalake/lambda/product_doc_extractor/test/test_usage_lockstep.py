"""The extractor's stdlib `bedrock_usage` line must match `shared/usage_meter.py`.

The extractor cannot import `shared/` at runtime (module docstring), so it re-states the line for its one Converse
call. The cost rollup reads every function's line with one query, so a drift in a field name would drop this
function's tokens from the estimate. A TEST can import shared/, as the other lockstep tests here do.
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from product_doc_extractor import handler as extractor
from shared import usage_meter

from .conftest import png_header

MODEL = 'global.anthropic.claude-haiku-5-5'


def test_the_constants_match():
    assert extractor._USAGE_FIELDS == usage_meter.USAGE_FIELDS
    assert extractor._USAGE_LINE == usage_meter.USAGE_LINE
    assert extractor._USAGE_UNREADABLE == usage_meter.UNREADABLE_LINE
    assert extractor._UNATTRIBUTED == usage_meter.UNATTRIBUTED


def _shared_line(response: dict) -> dict:
    """The fields shared/usage_meter.py logs for the same Converse response, with no attribution set."""
    usage_meter.reset()
    with patch.object(usage_meter, 'logger') as log:
        usage_meter.log_usage(http_response=SimpleNamespace(status_code=200), parsed=response,
                              model=SimpleNamespace(name='Converse'), context={'voc_usage_model_id': MODEL})
    return log.info.call_args.kwargs['extra']


@pytest.mark.parametrize('response', [
    {'usage': {'inputTokens': 120, 'outputTokens': 45, 'totalTokens': 165}},
    {'usage': {'inputTokens': 3, 'outputTokens': 0, 'cacheReadInputTokens': 7, 'cacheWriteInputTokens': 9},
     'serviceTier': {'type': 'flex'}},
])
def test_the_fields_match(response):
    assert extractor._usage_fields(MODEL, response) == _shared_line(response)


@pytest.mark.parametrize('response', [
    {}, {'usage': None}, {'usage': {'inputTokens': 1}}, {'usage': {'inputTokens': -1, 'outputTokens': 2}},
    {'usage': {'inputTokens': True, 'outputTokens': 2}}, 'not a response',
])
def test_an_unreadable_response_logs_the_operation_only_and_never_raises(response):
    with patch.object(extractor, 'logger') as log:
        extractor._log_usage(MODEL, response)
    log.info.assert_not_called()
    assert log.warning.call_args.args == ('bedrock_usage_unreadable',)
    assert log.warning.call_args.kwargs['extra'] == {'operation': 'Converse', 'reason': 'usage is unreadable'}


def test_the_image_extraction_logs_one_line_with_the_scoped_model_id(wire, monkeypatch):
    monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')
    body = png_header(640, 480) + b'\x00' * 64
    mocks = wire(body=body)
    mocks['bedrock'].converse.return_value = {
        'output': {'message': {'content': [{'text': 'A fictional storefront design'}]}},
        'usage': {'inputTokens': 1500, 'outputTokens': 80, 'totalTokens': 1580}}
    with patch.object(extractor, 'logger') as log:
        text, _ = extractor._extract_image('example-bucket', 'raw/doc.png', 'image/png', len(body))
    assert text == 'A fictional storefront design'
    sent = mocks['bedrock'].converse.call_args.kwargs['modelId']
    lines = [c for c in log.info.call_args_list if c.args == ('bedrock_usage',)]
    assert len(lines) == 1
    assert lines[0].kwargs['extra'] == {
        'workspace_id': 'UNATTRIBUTED', 'model_id': 'eu.' + sent.removeprefix('global.'), 'operation': 'Converse',
        'service_tier': 'default', 'input_tokens': 1500, 'output_tokens': 80, 'cache_read_tokens': 0,
        'cache_write_tokens': 0}
    assert sent.startswith('global.')


def test_a_usage_line_that_raises_never_fails_the_extraction(wire):
    body = png_header(640, 480) + b'\x00' * 64
    wire(body=body, model_text='A fictional storefront design')
    with patch.object(extractor, '_usage_fields', side_effect=RuntimeError('boom')), \
            patch.object(extractor, 'logger') as log:
        text, _ = extractor._extract_image('example-bucket', 'raw/doc.png', 'image/png', len(body))
    assert text == 'A fictional storefront design'
    assert log.warning.call_args.kwargs['extra'] == {'operation': 'Converse', 'reason': 'RuntimeError'}


def test_a_readable_response_logs_one_line_of_numbers_and_ids():
    response = {'usage': {'inputTokens': 10, 'outputTokens': 2},
                'output': {'message': {'content': [{'text': 'a fictional description'}]}}}
    with patch.object(extractor, 'logger') as log:
        extractor._log_usage(MODEL, response)
    assert log.info.call_args.args == ('bedrock_usage',)
    assert log.info.call_args.kwargs['extra'] == {
        'workspace_id': 'UNATTRIBUTED', 'model_id': MODEL, 'operation': 'Converse', 'service_tier': 'default',
        'input_tokens': 10, 'output_tokens': 2, 'cache_read_tokens': 0, 'cache_write_tokens': 0}
