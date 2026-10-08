"""Mutation hardening for `api/manual_import_processor.py`.

`test_manual_import_processor.py` pins the outline of a parse job: `completed`
after a good answer, `failed` for an empty paste or a Bedrock error, the
capability-aware `thinking` field and the import-date defaulting. A mutation run
found what none of those tests could see:

* the exact DynamoDB writes — the job key `MANUAL_IMPORT#<id>`/`JOB`, both
  `UpdateExpression`s, every placeholder, and the error text stored on a failed
  job (the earlier tests read only `:status`);
* the request sent to Bedrock: `anthropic_version`, `max_tokens=16000`, the
  thinking budget of 5000, the `user` turn, the `contentType`/`accept` headers,
  and the step name and label the retry policy logs under;
* the WORDING of both prompts (an `XX…XX` mutant left every earlier assertion
  true) and of every log line an operator triages a stuck import from;
* which of the three JSON extraction paths answers (bare, fenced with or without
  a `json` tag, embedded in prose), and the exact fallback `{'reviews': [],
  'unparsed_sections': [<the whole answer>]}`;
* the first-text-block rule: a thinking block is skipped, an EMPTY text block
  ends the search rather than falling through to a later one;
* the rating rounding (`4.5`→`4`, `4.6`→`5`, `'3'`→`3`, junk→`None`), the
  defaults of a review with no text/author/title, and a non-string `created_at`;
* the cold-start state (no table without `AGGREGATES_TABLE`, the lambda root
  first on `sys.path`) and the handler's instrumentation, cold-start metric
  included.
"""
from __future__ import annotations

import datetime as dt
import importlib
import json
import os
import sys
from collections.abc import Callable, Iterator
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from typing import ClassVar
from unittest.mock import ANY, MagicMock, call, patch

import pytest
from handler_events_fixtures import aws_error
from module_reload_fixtures import reload_cycle

import manual_import_processor as p
from shared.exceptions import ValidationError
from shared.logging import metrics
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

# Not retryable, so the shared retry policy raises at once (a RuntimeError is retried with backoff).
MODEL_ERROR = aws_error('model exploded', 'InvokeModel', code='ValidationException')
MODEL_ERROR_TEXT = 'An error occurred (ValidationException) when calling the InvokeModel operation: model exploded'
JOB_ID = 'job-7'
JOB_KEY = {'pk': 'MANUAL_IMPORT#job-7', 'sk': 'JOB'}
ADAPTIVE_MODEL = 'global.anthropic.claude-sonnet-5'
BUDGETED_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
CREATED_AT = '2026-04-09T08:00:00+00:00'
IMPORT_DAY = '2026-04-09'


def _bedrock_answer(*blocks: dict) -> dict:
    body = MagicMock()
    body.read.return_value = json.dumps({'content': list(blocks)}).encode()
    return {'body': body}


def _text(text: str) -> dict:
    return {'type': 'text', 'text': text}


class World:
    """A patched table, Bedrock client, logger and model pick for one `process_job` call."""

    def __init__(self, table: MagicMock, bedrock: MagicMock, logger: MagicMock) -> None:
        self.table = table
        self.bedrock = bedrock
        self.logger = logger

    def job(self, **item: object) -> None:
        self.table.get_item.return_value = {'Item': item}

    def answer(self, *blocks: dict) -> None:
        self.bedrock.invoke_model.return_value = _bedrock_answer(*blocks)

    def run(self) -> None:
        p.process_job(JOB_ID)

    def stored(self) -> dict:
        [update] = self.table.update_item.call_args_list
        return update.kwargs['ExpressionAttributeValues']

    def body(self) -> dict:
        return json.loads(self.bedrock.invoke_model.call_args.kwargs['body'])

    def prompt(self) -> str:
        return self.body()['messages'][0]['content']

    def messages(self, level: str) -> list[str]:
        return [c.args[0] for c in getattr(self.logger, level).call_args_list]


@pytest.fixture
def world() -> Iterator[World]:
    table, bedrock, logger = MagicMock(), MagicMock(), MagicMock()
    with patch.object(p, 'aggregates_table', table), patch.object(p, 'bedrock', bedrock), \
            patch.object(p, 'logger', logger), \
            patch.object(p, 'get_active_model_id', MagicMock(return_value=ADAPTIVE_MODEL)):
        yield World(table, bedrock, logger)


# ============================================
# Cold start and instrumentation
# ============================================


class TestColdStart:
    @pytest.fixture
    def reload_with_env(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., ModuleType]]:
        yield from reload_cycle(monkeypatch, p)

    def test_no_table_variable_means_an_empty_name_and_no_table(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE=None)
        assert module.AGGREGATES_TABLE == ''
        assert module.aggregates_table is None

    def test_the_table_is_the_one_the_variable_names(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE='t-1')
        assert module.aggregates_table.name == 't-1'

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(p.__file__)))
        sentinel = os.path.join(os.sep, 'elsewhere-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env(AGGREGATES_TABLE='t-1')
        assert sys.path[:2] == [lambda_root, sentinel]

    def test_the_module_talks_to_bedrock_runtime_and_dynamodb(self):
        assert p.bedrock.meta.service_model.service_name == 'bedrock-runtime'
        assert p.dynamodb.meta.service_name == 'dynamodb'


class TestTheHandlerIsInstrumented:
    def test_process_job_is_traced(self):
        assert_tracer_wrapped(p, 'process_job')

    def test_the_handler_is_wrapped_and_injects_the_invocation_context(self):
        assert_handler_wrapped(p)
        # A plain object: Powertools reads `context.lambda_context` whenever it exists.
        context = SimpleNamespace(
            function_name='voc-manual-import-processor', memory_limit_in_mb=512, aws_request_id='req-p-1',
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-manual-import-processor',
        )
        with patch.object(p, 'process_job'):
            p.lambda_handler({'job_id': JOB_ID}, context)
        assert p.logger.get_current_keys()['function_name'] == 'voc-manual-import-processor'

    def test_the_handler_is_registered_with_the_tracer(self):
        try:
            with patch.object(p.tracer, 'capture_lambda_handler', side_effect=lambda f: f) as capture:
                module = importlib.reload(p)
            wrapped = vars(module.lambda_handler)['__wrapped__']
            assert capture.call_args_list == [call(wrapped)]
            assert wrapped.__name__ == 'lambda_handler'
        finally:
            importlib.reload(p)

    def test_the_cold_start_metric_is_flushed_as_emf(self, lambda_context, capsys):
        with patch.object(p, 'process_job'):
            names = cold_start_metric_names(
                metrics, lambda: p.lambda_handler({'job_id': JOB_ID}, lambda_context), capsys)
        assert names == {'ColdStart'}


class TestTheHandler:
    def test_it_processes_the_job_and_answers_with_its_id(self, lambda_context):
        with patch.object(p, 'process_job') as process:
            assert p.lambda_handler({'job_id': JOB_ID}, lambda_context) == {'success': True, 'job_id': JOB_ID}
        process.assert_called_once_with(JOB_ID)

    @pytest.mark.parametrize('event', [{}, {'job_id': ''}, {'job_id': None}])
    def test_an_event_without_a_job_id_is_refused_by_name(self, lambda_context, event):
        with patch.object(p, 'process_job') as process, patch.object(p, 'logger') as logger, \
                pytest.raises(ValidationError) as refused:
            p.lambda_handler(event, lambda_context)
        assert str(refused.value) == 'No job_id provided'
        logger.error.assert_called_once_with('No job_id in event')
        process.assert_not_called()


# ============================================
# process_job: the reads, the request, the writes
# ============================================


class TestTheJobRead:
    def test_no_table_logs_and_reads_nothing(self, world):
        with patch.object(p, 'aggregates_table', None):
            world.run()
        assert world.messages('error') == ['Aggregates table not configured']
        world.bedrock.invoke_model.assert_not_called()

    def test_the_job_row_is_read_by_its_key(self, world):
        world.table.get_item.return_value = {}
        world.run()
        world.table.get_item.assert_called_once_with(Key=JOB_KEY)

    def test_a_missing_job_is_logged_and_left_alone(self, world):
        world.table.get_item.return_value = {'Item': None}
        world.run()
        assert world.messages('error') == ['Job job-7 not found']
        world.table.update_item.assert_not_called()
        world.bedrock.invoke_model.assert_not_called()

    @pytest.mark.parametrize('item', [{'source_origin': 'g2'}, {'raw_text': ''}])
    def test_no_raw_text_fails_the_job_without_calling_bedrock(self, world, item):
        world.job(**item)
        world.run()
        world.table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #status = :status, #error = :error',
            ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
            ExpressionAttributeValues={':status': 'failed', ':error': 'No raw text to parse'},
        )
        world.bedrock.invoke_model.assert_not_called()


class TestThePrompt:
    def test_the_user_turn_names_the_source_the_day_and_fences_the_paste(self, world):
        world.job(raw_text='Loved it - Ann', source_origin='capterra', created_at=CREATED_AT)
        world.answer(_text('{"reviews": []}'))
        world.run()
        prompt = world.prompt()
        assert prompt.startswith(
            'Parse the following raw text into individual reviews. The reviews are from: capterra\n'
            'The import date is 2026-04-09. A review with no date in the text gets "date": null; '
            'the importer then uses the import date and shows the user that it did.\n\n'
            'Raw text:\n```\nLoved it - Ann\n```\n\nReturn JSON in this exact format:\n{\n  "reviews": [\n'
        )
        assert prompt.endswith('Remember: Do NOT modify the review text. Extract it exactly as written.')

    def test_an_unnamed_source_is_unknown(self, world):
        world.job(raw_text='x', created_at=CREATED_AT)
        world.answer(_text('{"reviews": []}'))
        world.run()
        assert 'The reviews are from: unknown\n' in world.prompt()

    def test_the_system_prompt_is_the_extract_only_parser(self, world):
        world.job(raw_text='x')
        world.answer(_text('{"reviews": []}'))
        world.run()
        system = world.body()['system']
        assert system.startswith('You are a review parser. Your job is to extract individual reviews')
        assert system.endswith('Output valid JSON only, no markdown code blocks, no other text.')


class TestTheBedrockRequest:
    @pytest.mark.parametrize(('model', 'thinking'), [
        (ADAPTIVE_MODEL, {}),
        (BUDGETED_MODEL, {'thinking': {'type': 'enabled', 'budget_tokens': 5000}}),
    ])
    def test_the_body_is_the_messages_request_for_the_models_capabilities(self, world, model, thinking):
        world.job(raw_text='x')
        world.answer(_text('{"reviews": []}'))
        with patch.object(p, 'get_active_model_id', MagicMock(return_value=model)):
            world.run()
        body = world.body()
        assert body == {
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 16000,
            'system': body['system'],
            'messages': [{'role': 'user', 'content': world.prompt()}],
            **thinking,
        }
        world.bedrock.invoke_model.assert_called_once_with(
            modelId=model, body=ANY, contentType='application/json', accept='application/json')
        assert world.messages('info')[0] == f'Invoking Bedrock for job job-7 with model {model}'

    def test_the_call_goes_through_the_retry_policy_under_the_jobs_step_name(self, world):
        world.job(raw_text='x')
        world.answer(_text('{"reviews": []}'))
        retry = MagicMock(side_effect=lambda request, **_labels: request())
        with patch.object(p, 'bedrock_call_with_retry', retry):
            world.run()
        retry.assert_called_once_with(ANY, step_name='manual_import_parse_job-7', call_label='client.invoke_model()')
        assert world.stored()[':status'] == 'completed'


class TestTheCompletedWrite:
    def test_the_parsed_reviews_and_leftovers_are_stored_on_the_job(self, world):
        world.job(raw_text='x', created_at=CREATED_AT)
        world.answer({'type': 'thinking', 'thinking': 'hmm'}, _text(json.dumps({
            'reviews': [
                {'text': 'Great', 'rating': 4.6, 'author': 'Ann', 'title': 'Wow', 'date': '2026-01-02'},
                {'text': 'Meh', 'rating': '2'},
            ],
            'unparsed_sections': ['footer'],
        })))
        world.run()
        world.table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #status = :status, reviews = :reviews, unparsed_sections = :unparsed',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':status': 'completed',
                ':reviews': [
                    {'text': 'Great', 'author': 'Ann', 'date': '2026-01-02', 'date_defaulted': False,
                     'title': 'Wow', 'rating': 5},
                    {'text': 'Meh', 'author': None, 'date': IMPORT_DAY, 'date_defaulted': True,
                     'title': None, 'rating': 2},
                ],
                ':unparsed': ['footer'],
            },
        )
        assert world.messages('info')[-1] == 'Job job-7: Parsed 2 reviews, 1 unparsed sections'

    def test_an_answer_without_either_list_stores_two_empty_lists(self, world):
        world.job(raw_text='x')
        world.answer(_text('{"note": "nothing here"}'))
        world.run()
        assert world.stored() == {':status': 'completed', ':reviews': [], ':unparsed': []}
        assert world.messages('info')[-1] == 'Job job-7: Parsed 0 reviews, 0 unparsed sections'


class TestTheFailurePath:
    def test_an_error_is_logged_and_stored_on_the_job_word_for_word(self, world):
        world.job(raw_text='x')
        world.bedrock.invoke_model.side_effect = MODEL_ERROR
        world.run()
        world.logger.exception.assert_called_once_with(f'Failed to process job job-7: {MODEL_ERROR_TEXT}')
        world.table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #status = :status, #error = :error',
            ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
            ExpressionAttributeValues={':status': 'failed', ':error': MODEL_ERROR_TEXT},
        )

    def test_no_text_block_fails_the_job_with_the_reason(self, world):
        world.job(raw_text='x')
        world.answer({'type': 'thinking', 'thinking': 'only thoughts'})
        world.run()
        assert world.stored() == {':status': 'failed', ':error': 'No text response from Bedrock'}

    def test_a_job_that_cannot_be_marked_failed_is_logged_and_not_raised(self, world):
        world.job(raw_text='x')
        world.bedrock.invoke_model.side_effect = MODEL_ERROR
        world.table.update_item.side_effect = aws_error('table gone', 'UpdateItem')
        world.run()
        assert world.messages('warning') == [
            'Could not mark job job-7 failed: An error occurred (InternalFailure) '
            'when calling the UpdateItem operation: table gone'
        ]


# ============================================
# The pure helpers
# ============================================


class TestParseLlmResponse:
    REVIEWS: ClassVar[dict[str, list]] = {'reviews': [{'text': 'a', 'meta': {'k': 1}}], 'unparsed_sections': []}

    @pytest.mark.parametrize('answer', [
        json.dumps(REVIEWS),
        f'Here you go:\n```json\n{json.dumps(REVIEWS)}\n```\nThanks',
        f'```\n{json.dumps(REVIEWS)}\n```',
        f'Sure! {json.dumps(REVIEWS)} hope that helps',
        'Result:\n{"reviews" : [{"text": "a", "meta": {"k": 1}}],\n "unparsed_sections": []}',
    ], ids=['bare', 'fenced-json', 'fenced-untagged', 'in-prose', 'spaced-colon'])
    def test_every_extraction_path_yields_the_same_object(self, answer):
        assert p.parse_llm_response(answer) == self.REVIEWS

    @pytest.mark.parametrize(('answer', 'parsed'), [
        ('```json\n{"unparsed_sections": ["a"]}\n```', {'unparsed_sections': ['a']}),
        ('```json\n{"meta": {"n": 1}, "reviews": []}\n```', {'meta': {'n': 1}, 'reviews': []}),
        ('```json\n{"reviews": []}\n```\nNote: {braces} here', {'reviews': []}),
    ], ids=['no-reviews-key', 'braces-before-reviews', 'braces-after-the-fence'])
    def test_a_fenced_object_the_reviews_search_cannot_see_is_still_read(self, answer, parsed):
        assert p.parse_llm_response(answer) == parsed

    def test_a_bad_fence_falls_through_to_the_reviews_object_after_it(self):
        answer = '```json\n{not json}\n``` then {"reviews": [], "unparsed_sections": ["z"]}'
        assert p.parse_llm_response(answer) == {'reviews': [], 'unparsed_sections': ['z']}

    @pytest.mark.parametrize('answer', [
        'no json here',
        '',
        'x {"reviews": [1,]} y',
        '```json\n{"broken": }\n```',
        '{"other": [1]} trailing',
    ])
    def test_anything_else_is_kept_whole_as_one_unparsed_section(self, answer):
        assert p.parse_llm_response(answer) == {'reviews': [], 'unparsed_sections': [answer]}


class TestFirstTextBlock:
    def test_thinking_blocks_are_skipped(self):
        content = [{'type': 'thinking', 'text': 'not me'}, _text('me'), _text('not me either')]
        assert p._first_text_block({'content': content}) == 'me'

    @pytest.mark.parametrize('response', [
        {},
        {'content': []},
        {'content': [{'type': 'thinking', 'thinking': 't'}]},
        {'content': [{'type': 'text'}, _text('later')]},
        {'content': [_text(''), _text('later')]},
    ], ids=['no-content', 'empty', 'thinking-only', 'textless-text', 'empty-text-first'])
    def test_no_usable_first_text_block_raises(self, response):
        with pytest.raises(ValueError, match=r'^No text response from Bedrock$'):
            p._first_text_block(response)


class TestImportDate:
    @pytest.mark.parametrize('created_at', [None, 20260409, Decimal('1'), 'garbage'])
    def test_a_missing_or_unreadable_creation_time_is_today(self, created_at):
        with patch.object(p, 'datetime', wraps=dt.datetime) as clock:
            clock.now.return_value = dt.datetime(2027, 2, 3, tzinfo=dt.UTC)
            assert p.import_date_of({'created_at': created_at}) == '2027-02-03'
        clock.now.assert_called_once_with(dt.UTC)

    def test_the_creation_time_is_read_in_utc(self):
        assert p.import_date_of({'created_at': '2026-04-09T22:00:00-05:00'}) == '2026-04-10'


class TestCalendarDate:
    @pytest.mark.parametrize(('value', 'expected'), [
        ('2025-03-04', '2025-03-04'),
        ('  2025-03-04 at noon', '2025-03-04'),
        ('2025-03-04T10:00:00Z', '2025-03-04'),
        ('on 2025-03-04', None),
        ('2025-02-30', None),
        ('2025-3-4', None),
        (20250304, None),
        (None, None),
    ])
    def test_only_a_leading_real_calendar_date_counts(self, value, expected):
        assert p._calendar_date(value) == expected


class TestSanitizeReview:
    @pytest.mark.parametrize(('rating', 'stored'), [
        (None, None), (4.4, 4), (4.5, 4), (4.6, 5), ('3', 3), (Decimal('2.7'), 3),
        ('five', None), ([5], None), ({}, None), (0, 0),
    ])
    def test_the_rating_is_a_rounded_int_or_none(self, rating, stored):
        assert p._sanitize_review({'text': 't', 'rating': rating}, IMPORT_DAY)['rating'] == stored

    def test_a_bare_review_gets_every_default(self):
        assert p._sanitize_review({}, IMPORT_DAY) == {
            'text': '', 'author': None, 'date': IMPORT_DAY, 'date_defaulted': True,
            'title': None, 'rating': None,
        }
