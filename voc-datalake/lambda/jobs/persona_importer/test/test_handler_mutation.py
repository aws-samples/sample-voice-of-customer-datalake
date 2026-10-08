"""Mutation hardening for `jobs/persona_importer/handler.py`.

`test_handler.py` proves an import succeeds and `test_unsupported_input.py` that
unreadable input is refused before the model call. A mutation run found 97
survivors in what lies between those two: everything the handler SENDS and
WRITES was only ever checked with `in`, `any(...)` and `assert_called()`, so a
renamed key, a swapped literal or a dropped default changed nothing a test saw.

Pinned here as literals:

* the Converse request — one `{'role': 'user'}` message whose content is the
  image block (`format` from the media type, decoded bytes) or the formatted
  text prompt, each followed by the template's schema dumped with `indent=2`;
  the template's `system_prompt` and `max_tokens`; the model resolved for the
  `documents` surface; `step_name='import_persona'` on the retry wrapper;
* the persisted row — every key, including `pk`/`sk`/`gsi1pk` composed from the
  project and persona ids, the `persona_<yyyymmddhhmmss>` id, the per-field
  defaults when the model omits a key, `imported_from`, `llm_metadata`, and
  the avatar fields (present only when an avatar URL came back, with the
  prompt defaulting to `''`); the `persona_count` counter it increments;
* the job's progress ladder (10/30/60/90/100 with its step names), the
  `Persona import failed` error prefix, the `Imported: <name>` title, the
  exact log lines, and the `PROJECTS_TABLE`/`RAW_DATA_BUCKET` environment
  reads with their `''` defaults;
* that `lambda_handler` is wrapped: context keys reach the logger, the
  `ColdStart` metric is flushed as EMF, the tracer registers the handler.

The run also showed three dead pieces, deleted rather than tested: the `''`
default on `media_type` (text never reads it; for an image `None` and `''`
are refused with the same message), the second `.split('```')[0]` on the
plain-fence branch (the piece between two fences cannot contain one), and the
`'Imported Persona'` default on `item.get('name')` (the key is always set).
"""
import base64
import importlib
import json
import os
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import pytest

from shared.exceptions import ServiceError
from shared.logging import logger, metrics, tracer
from shared.prompts import PERSONA_IMPORT_PROMPTS, load_prompt_file
from shared.test.emf_fixtures import cold_start_metric_names

PROJECT_ID = 'proj_20250101120000'
FIXED_NOW = datetime(2025, 1, 2, 3, 4, 5, tzinfo=UTC)
FIXED_ISO = '2025-01-02T03:04:05+00:00'
FIXED_PERSONA_ID = 'persona_20250102030405_a1b2c3d4'  # stamp + the `fixed_id_suffix` tail
pytestmark = pytest.mark.usefixtures('fixed_id_suffix')
MODEL_ID = 'model-under-test'
AVATAR_URL = 's3://test-bucket/avatars/test.png'
AVATAR_PROMPT = 'Professional headshot of Sarah Chen'

# One distinct value per section, so a swapped key is caught by the row equality.
FULL_PERSONA = {
    'name': 'Sarah Chen',
    'tagline': 'Efficiency-focused PM',
    'confidence': 'high',
    'identity': {'role': 'Product Manager'},
    'goals_motivations': {'primary_goal': 'Ship faster'},
    'pain_points': {'blockers': ['Too many meetings']},
    'behaviors': {'tech_savviness': 'high'},
    'context_environment': {'devices': ['laptop']},
    'quotes': ['I spend too much time in meetings'],
    'scenario': {'narrative': 'A Monday morning'},
}


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW if tz is not None else FIXED_NOW.replace(tzinfo=None)


def _bedrock_response(text: str) -> dict:
    return {'output': {'message': {'content': [{'text': text}]}}}


def _progress_ladder(mock_jobs_table) -> list[tuple[int, str]]:
    """Every (progress, step) the job record was moved through, in order."""
    ladder = []
    for update in mock_jobs_table.update_item.call_args_list:
        values = update.kwargs['ExpressionAttributeValues']
        if ':progress' in values:
            ladder.append((values[':progress'], values[':step']))
    return ladder


def _job_errors(mock_jobs_table) -> list[str]:
    return [
        update.kwargs['ExpressionAttributeValues'][':error']
        for update in mock_jobs_table.update_item.call_args_list
        if ':error' in update.kwargs['ExpressionAttributeValues']
    ]


def _persona_row(template: dict, persona_fields: dict) -> dict:
    """The exact row a text import of ``persona_fields`` writes (keys, stamps, metadata, avatar)."""
    return {
        'pk': f'PROJECT#{PROJECT_ID}',
        'sk': f'PERSONA#{FIXED_PERSONA_ID}',
        'gsi1pk': f'PROJECT#{PROJECT_ID}#PERSONAS',
        'gsi1sk': FIXED_ISO,
        'persona_id': FIXED_PERSONA_ID,
        **persona_fields,
        'research_notes': [],
        'imported_from': 'text',
        'llm_metadata': {'model': MODEL_ID, 'prompt_version': template['version']},
        'created_at': FIXED_ISO,
        'updated_at': FIXED_ISO,
        'avatar_url': AVATAR_URL,
        'avatar_prompt': AVATAR_PROMPT,
    }


def _put_item(mock_dynamodb) -> dict:
    mock_dynamodb['table'].put_item.assert_called_once()
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']


@pytest.fixture
def template() -> dict:
    return load_prompt_file(PERSONA_IMPORT_PROMPTS)


@pytest.fixture
def schema_text(template) -> str:
    return json.dumps(template['output_schema'], indent=2)


class _Run:
    """What `run` yields: the handler invoker plus what it recorded on the way."""

    def __init__(self, invoke: Callable[..., dict], retry_kwargs: dict, model: Mock) -> None:
        self._invoke = invoke
        self.retry_kwargs = retry_kwargs
        self.model = model

    def __call__(self, *args: object, **kwargs: object) -> dict:
        return self._invoke(*args, **kwargs)


@pytest.fixture
def run(request, mock_bedrock, lambda_context):
    """Invoke the handler with time, model resolution and the retry wrapper pinned.

    The retry wrapper is replaced by a recorder that runs the call once: the
    production policy backs off for seconds per attempt, so a mutant that breaks
    the request would otherwise be killed by the runner's timeout instead of by
    an assertion on the request.
    """
    for name in ('mock_dynamodb', 'mock_jobs_table', 'mock_avatar_generation'):
        request.getfixturevalue(name)
    retry_kwargs: dict = {}

    def run_once(call_fn, **kwargs):
        retry_kwargs.update(kwargs)
        return call_fn()

    with (
        patch('jobs.persona_importer.handler.datetime', _FrozenDatetime),
        patch('jobs.persona_importer.handler.get_active_model_id', return_value=MODEL_ID) as model,
        patch('jobs.persona_importer.handler.bedrock_call_with_retry', side_effect=run_once),
    ):
        from jobs.persona_importer.handler import lambda_handler

        def invoke(event: dict, persona=FULL_PERSONA, response_text: str | None = None,
                   context=lambda_context) -> dict:
            text = json.dumps(persona) if response_text is None else response_text
            mock_bedrock.converse.return_value = _bedrock_response(text)
            return lambda_handler(event, context)

        yield _Run(invoke, retry_kwargs, model)


class TestTheConverseRequest:
    """What the model is sent, field by field."""

    def test_a_text_import_sends_the_formatted_prompt_then_the_schema(
        self, run, mock_bedrock, text_import_event, template, schema_text,
    ):
        run(text_import_event)

        content = text_import_event['import_config']['content']
        prompt = template['user_prompts']['text'].replace('{content}', content)
        mock_bedrock.converse.assert_called_once_with(
            modelId=MODEL_ID,
            system=[{'text': template['system_prompt']}],
            messages=[{
                'role': 'user',
                'content': [{'text': f'{prompt}\n\nSchema:\n{schema_text}'}],
            }],
            inferenceConfig={'maxTokens': template['max_tokens']},
        )

    def test_an_image_import_sends_the_decoded_image_then_the_prompt_and_schema(
        self, run, mock_bedrock, image_import_event, template, schema_text,
    ):
        run(image_import_event)

        encoded = image_import_event['import_config']['content']
        assert mock_bedrock.converse.call_args.kwargs['messages'] == [{
            'role': 'user',
            'content': [
                {'image': {'format': 'png', 'source': {'bytes': base64.b64decode(encoded)}}},
                {'text': f"{template['user_prompts']['image']}\n\nSchema:\n{schema_text}"},
            ],
        }]

    def test_the_model_is_resolved_for_the_documents_surface(self, run, text_import_event):
        run(text_import_event)
        run.model.assert_called_once_with('documents')

    def test_the_call_goes_through_the_retry_policy_under_its_step_name(
        self, run, text_import_event,
    ):
        run(text_import_event)
        assert run.retry_kwargs == {'step_name': 'import_persona'}

    def test_the_schema_is_dumped_with_two_space_indent(self, run, mock_bedrock, text_import_event, template):
        run(text_import_event)
        text = mock_bedrock.converse.call_args.kwargs['messages'][0]['content'][0]['text']
        assert text.endswith('\n\nSchema:\n' + json.dumps(template['output_schema'], indent=2))
        assert not text.endswith(json.dumps(template['output_schema'], indent=3))


class TestTheResponseIsUnfenced:
    """JSON arrives bare, in a ```json fence, or in a plain ``` fence."""

    @pytest.mark.parametrize('wrap', [
        '{json}',
        'Here it is:\n```json\n{json}\n```\nDone.',
        'Here it is:\n```\n{json}\n```\nDone.',
    ])
    def test_each_shape_yields_the_same_persona(self, run, mock_dynamodb, text_import_event, wrap):
        run(text_import_event, response_text=wrap.format(json=json.dumps(FULL_PERSONA)))
        assert _put_item(mock_dynamodb)['name'] == 'Sarah Chen'

    def test_non_json_fails_the_job_with_the_decoder_message(
        self, run, mock_jobs_table, mock_dynamodb, text_import_event,
    ):
        with pytest.raises(ServiceError) as caught:
            run(text_import_event, response_text='This is not valid JSON')

        assert str(caught.value) == 'Persona import failed'
        assert _job_errors(mock_jobs_table) == [
            'Persona import failed: Expecting value: line 1 column 1 (char 0)',
        ]
        mock_dynamodb['table'].put_item.assert_not_called()


class TestThePersistedRow:
    def test_every_field_of_a_full_persona_lands_under_its_own_key(
        self, run, mock_dynamodb, text_import_event, template,
    ):
        run(text_import_event)

        assert _put_item(mock_dynamodb) == _persona_row(template, FULL_PERSONA)

    def test_a_persona_the_model_left_empty_gets_every_default(
        self, run, mock_dynamodb, text_import_event, template,
    ):
        result = run(text_import_event, persona={})

        assert _put_item(mock_dynamodb) == _persona_row(template, {
            'name': 'Imported Persona',
            'tagline': '',
            'confidence': 'medium',
            'identity': {},
            'goals_motivations': {},
            'pain_points': {},
            'behaviors': {},
            'context_environment': {},
            'quotes': [],
            'scenario': {},
        })
        assert result == {
            'success': True,
            'persona_id': FIXED_PERSONA_ID,
            'title': 'Imported: Imported Persona',
        }

    def test_an_image_import_is_marked_as_such(self, run, mock_dynamodb, image_import_event):
        run(image_import_event)
        assert _put_item(mock_dynamodb)['imported_from'] == 'image'

    def test_the_row_is_written_with_the_persona_counter_increment(
        self, run, mock_dynamodb, text_import_event,
    ):
        run(text_import_event)

        (update,) = mock_dynamodb['table'].update_item.call_args_list
        assert update.kwargs['Key'] == {'pk': f'PROJECT#{PROJECT_ID}', 'sk': 'META'}
        assert update.kwargs['ExpressionAttributeNames']['#count'] == 'persona_count'
        assert update.kwargs['ExpressionAttributeValues'][':now'] == FIXED_ISO

    def test_the_result_names_the_persona(self, run, text_import_event):
        assert run(text_import_event) == {
            'success': True,
            'persona_id': FIXED_PERSONA_ID,
            'title': 'Imported: Sarah Chen',
        }


class TestTheAvatarStep:
    def test_the_generator_sees_the_row_before_avatar_fields_and_the_bucket(
        self, run, mock_avatar_generation, mock_dynamodb, text_import_event,
    ):
        run(text_import_event)

        (shown, bucket), owner = mock_avatar_generation.call_args
        persisted = _put_item(mock_dynamodb)
        assert (bucket, owner) == ('test-raw-data-bucket', {'project_id': persisted['pk'].removeprefix('PROJECT#')})
        assert 'avatar_url' not in shown
        assert shown == {k: v for k, v in persisted.items() if k not in ('avatar_url', 'avatar_prompt')}
        assert shown is not persisted

    def test_a_missing_avatar_prompt_is_stored_as_empty(
        self, run, mock_avatar_generation, mock_dynamodb, text_import_event,
    ):
        mock_avatar_generation.return_value = {'avatar_url': AVATAR_URL}
        run(text_import_event)

        item = _put_item(mock_dynamodb)
        assert item['avatar_url'] == AVATAR_URL
        assert item['avatar_prompt'] == ''

    @pytest.mark.parametrize('avatar_result', [
        {'avatar_url': None, 'avatar_prompt': None},
        {'avatar_url': ''},
        {},
    ])
    def test_no_avatar_url_means_no_avatar_fields(
        self, run, mock_avatar_generation, mock_dynamodb, text_import_event, avatar_result,
    ):
        mock_avatar_generation.return_value = avatar_result
        run(text_import_event)

        item = _put_item(mock_dynamodb)
        assert 'avatar_url' not in item
        assert 'avatar_prompt' not in item


class TestTheJobRecord:
    def test_progress_climbs_through_every_step_in_order(self, run, mock_jobs_table, text_import_event):
        run(text_import_event)
        assert _progress_ladder(mock_jobs_table) == [
            (10, 'extracting_persona'),
            (30, 'calling_ai'),
            (60, 'generating_avatar'),
            (90, 'saving_persona'),
            (100, 'complete'),
        ]

    def test_a_refusal_fails_the_job_under_the_import_prefix(
        self, run, mock_jobs_table, sample_job_event,
    ):
        event = {**sample_job_event, 'import_config': {'input_type': 'pdf', 'content': 'x'}}
        # A refusal is a terminal 4xx: the job fails and the handler returns
        # (no raise, so no Lambda error and no async-failure DLQ message).
        result = run(event)

        assert result == {
            'success': False,
            'error': 'Persona import failed: PDF import is not supported yet. '
                     'Persona import accepts pasted text or an image.',
        }
        assert _job_errors(mock_jobs_table) == [
            'Persona import failed: PDF import is not supported yet. '
            'Persona import accepts pasted text or an image.',
        ]
        # Validation runs after the first progress tick, so the record shows the
        # step it was refused at before it is marked failed.
        assert _progress_ladder(mock_jobs_table) == [(10, 'extracting_persona'), (0, 'error')]


class TestTheLogLines:
    def test_a_named_persona_is_logged_at_each_stage(self, run, text_import_event):
        with patch('jobs.persona_importer.handler.logger') as log:
            run(text_import_event)

        assert log.info.call_args_list == [
            call("Persona importer invoked with event keys: ['project_id', 'job_id', 'import_config']"),
            call(f'[IMPORT_PERSONA_JOB] Starting import from text for project {PROJECT_ID}'),
            call(f'[IMPORT_PERSONA_JOB] Invoking Bedrock with model {MODEL_ID}'),
            call('[IMPORT_PERSONA_JOB] Extracted persona: Sarah Chen'),
            call('[IMPORT_PERSONA_JOB] Successfully imported persona: Sarah Chen'),
        ]

    def test_an_unnamed_persona_is_logged_as_unknown_then_by_its_default(self, run, image_import_event):
        with patch('jobs.persona_importer.handler.logger') as log:
            run(image_import_event, persona={})

        assert log.info.call_args_list[1:] == [
            call(f'[IMPORT_PERSONA_JOB] Starting import from image for project {PROJECT_ID}'),
            call(f'[IMPORT_PERSONA_JOB] Invoking Bedrock with model {MODEL_ID}'),
            call('[IMPORT_PERSONA_JOB] Extracted persona: Unknown'),
            call('[IMPORT_PERSONA_JOB] Successfully imported persona: Imported Persona'),
        ]


class TestTheEnvironment:
    def test_the_table_and_bucket_come_from_the_environment(
        self, run, mock_dynamodb, mock_avatar_generation, text_import_event,
    ):
        run(text_import_event)

        # The suite's conftests set both; the module read them at import.
        mock_dynamodb['resource'].Table.assert_called_once_with(os.environ['PROJECTS_TABLE'])
        assert mock_avatar_generation.call_args.args[1] == os.environ['RAW_DATA_BUCKET']
        assert os.environ['RAW_DATA_BUCKET'] == 'test-raw-data-bucket'

    def test_both_default_to_empty_when_unset(self, monkeypatch):
        from jobs.persona_importer import handler

        table, bucket = os.environ['PROJECTS_TABLE'], os.environ['RAW_DATA_BUCKET']
        with monkeypatch.context() as env:
            env.delenv('PROJECTS_TABLE')
            env.delenv('RAW_DATA_BUCKET')
            try:
                importlib.reload(handler)
                assert handler.PROJECTS_TABLE == ''
                assert handler.RAW_DATA_BUCKET == ''
            finally:
                env.undo()
                importlib.reload(handler)

        assert table == handler.PROJECTS_TABLE
        assert bucket == handler.RAW_DATA_BUCKET


class TestLambdaHandlerIsWrapped:
    def test_the_lambda_context_reaches_the_logger(self, run, text_import_event):
        # Plain attributes: a MagicMock answers `.lambda_context` too, which the
        # logger reads as a durable-execution wrapper around the real context.
        context = SimpleNamespace(
            function_name='voc-persona-importer',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-persona-importer',
            aws_request_id='req-1',
            get_remaining_time_in_millis=lambda: 300_000,
        )
        logger.remove_keys(['function_name', 'cold_start'])

        run(text_import_event, context=context)

        assert logger.get_current_keys()['function_name'] == 'voc-persona-importer'

    def test_the_cold_start_metric_is_flushed_as_emf(self, run, text_import_event, capsys):
        assert cold_start_metric_names(metrics, lambda: run(text_import_event), capsys) == {'ColdStart'}

    def test_the_handler_is_registered_with_the_tracer(self):
        from jobs.persona_importer import handler

        try:
            with patch.object(tracer, 'capture_lambda_handler', side_effect=lambda f: f) as capture:
                importlib.reload(handler)
            (wrapped,), _ = capture.call_args
            assert capture.call_count == 1
            assert wrapped.__name__ == 'lambda_handler'
            # The tracer sits between the logger (outermost) and the metrics flush.
            assert vars(handler.lambda_handler)['__wrapped__'] is wrapped
        finally:
            importlib.reload(handler)


class TestTheSourceCarriesNoDeadDefaults:
    """The three deletions the mutation run justified; pinned so they stay gone."""

    def test_the_deleted_fallbacks_are_absent(self):
        from pathlib import Path

        from jobs.persona_importer import handler

        source = Path(handler.__file__).read_text(encoding='utf-8')
        assert "import_config.get('media_type')" in source
        assert "get('media_type', '')" not in source
        assert ".split('```')[1].split('```')[0]" not in source
        assert "item.get('name'" not in source
