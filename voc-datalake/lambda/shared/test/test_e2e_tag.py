"""The e2e traffic tag: `test_run=<run id>` on every log line of a tagged request, never on others."""

import io
import json
import logging
import uuid
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools import Logger

from shared.e2e_tag import TEST_RUN_KEY, e2e_run_id, tag_test_run

CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'


def _event(user_agent: str | None, *, multi: bool = False, header: str = 'User-Agent') -> dict:
    if user_agent is None:
        return {'headers': None, 'multiValueHeaders': None}
    if multi:
        return {'headers': None, 'multiValueHeaders': {header: [user_agent]}}
    return {'headers': {header: user_agent}}


def _logger() -> tuple[Logger, io.StringIO]:
    """A real Powertools Logger writing to its own buffer. A unique service name per
    instance: loggers sharing a name share the stdlib logger and its first handler."""
    stream = io.StringIO()
    return Logger(service=f'e2e-tag-test-{uuid.uuid4().hex}', logger_handler=logging.StreamHandler(stream)), stream


def _lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


class TestE2eRunId:
    @pytest.mark.parametrize(('user_agent', 'expected'), [
        (f'{CHROME} voc-e2e/e2e-20261010T080000Z', 'e2e-20261010T080000Z'),
        ('node voc-e2e/1717171717171', '1717171717171'),
        ('voc-e2e/s1-1717.a_b', 's1-1717.a_b'),
        (f'voc-e2e/{"a" * 64}', 'a' * 64),
    ])
    def test_reads_a_valid_token(self, user_agent, expected):
        assert e2e_run_id(_event(user_agent)) == expected

    @pytest.mark.parametrize('user_agent', [
        CHROME,
        'voc-e2e/',
        f'voc-e2e/{"a" * 65}',
        'voc-e2e/bad$id',
        'voc-e2e/a;rm',
        'xvoc-e2e/abc',
        'voc-e2e/abc/def',
        'voc-e2e/abc\nforged',
        f'{"x" * 3000} voc-e2e/abc',
    ])
    def test_ignores_anything_else(self, user_agent):
        assert e2e_run_id(_event(user_agent)) is None

    def test_header_name_is_case_insensitive_and_multi_value_headers_count(self):
        assert e2e_run_id(_event('voc-e2e/run1', header='user-agent')) == 'run1'
        assert e2e_run_id(_event('voc-e2e/run2', multi=True, header='USER-AGENT')) == 'run2'

    @pytest.mark.parametrize('event', [
        None, 'text', {}, {'headers': None}, {'headers': {'User-Agent': 5}},
        {'multiValueHeaders': {'User-Agent': 'not-a-list'}}, {'headers': {1: 'voc-e2e/x'}},
    ])
    def test_missing_or_odd_headers_are_fine(self, event):
        assert e2e_run_id(event) is None


class TestTagTestRun:
    def test_tagged_invocation_every_line_carries_the_run(self):
        logger, stream = _logger()
        assert tag_test_run(logger, _event(f'{CHROME} voc-e2e/run-7')) == 'run-7'
        logger.info('first')
        logger.warning('second')
        lines = _lines(stream)
        assert [line[TEST_RUN_KEY] for line in lines] == ['run-7', 'run-7']
        # The User-Agent itself is never logged.
        assert 'Chrome' not in stream.getvalue()

    def test_untagged_after_tagged_on_a_warm_logger_has_no_key(self):
        logger, stream = _logger()
        tag_test_run(logger, _event('voc-e2e/run-7'))
        logger.info('tagged')
        tag_test_run(logger, _event(CHROME))
        logger.info('real user')
        tag_test_run(logger, _event(None))
        logger.info('no headers')
        tagged, real, bare = _lines(stream)
        assert tagged[TEST_RUN_KEY] == 'run-7'
        assert TEST_RUN_KEY not in real
        assert TEST_RUN_KEY not in bare

    def test_malformed_token_sets_no_key(self):
        logger, stream = _logger()
        assert tag_test_run(logger, _event('voc-e2e/bad$id')) is None
        logger.info('line')
        assert TEST_RUN_KEY not in _lines(stream)[0]


class TestApiHandlerTagsTheInvocation:
    """`api_handler` applies the tag per invocation, on the shared (warm) logger."""

    @patch('shared.api.metrics')
    @patch('shared.api.tracer')
    def test_tag_follows_each_request(self, mock_tracer, mock_metrics):
        mock_tracer.capture_lambda_handler = lambda f: f
        mock_metrics.log_metrics = lambda **_kwargs: lambda f: f
        logger, stream = _logger()
        with patch('shared.api.logger', logger), patch('shared.invocation_cost.logger', logger):
            from shared.api import api_handler

            @api_handler
            def handler(_event, _context):
                logger.info('handled')
                return {'statusCode': 200}

            context = MagicMock()
            context.memory_limit_in_mb = '256'
            handler(_event('node voc-e2e/run-9'), context)
            first = len(_lines(stream))
            handler(_event('node'), context)
        lines = _lines(stream)
        assert first >= 2  # 'handled' + the invocation_cost line
        assert all(line.get(TEST_RUN_KEY) == 'run-9' for line in lines[:first])
        assert all(TEST_RUN_KEY not in line for line in lines[first:])
