"""Mutation hardening for `api/projects.py` lines 1266-2671 (project delete,
persona generation, the three AI assists and custom-document CRUD).

`test_persona_chain.py`, `test_persona_context_limits.py`,
`test_persona_parse_tiers.py`, `test_project_delete_lifecycle_moto.py` and
`test_projects_ai_assists.py` pin that a generation runs two steps, that the
corpus is reported honestly and that every artifact a project owns is swept,
but a mutation run found what they cannot see:

* the WORDING of every refusal and every operator-facing log line. A
  `ValidationError`/`ServiceError` message is the 400/500 body a user reads in
  the browser; the `[PERSONA]` log lines, with their `extra` keys, are how an
  operator follows a multi-minute job in CloudWatch. Every message is pinned
  here as a literal, as are the `extra` dictionaries (a renamed key is a
  dashboard that silently reads nothing).
* the exact progress percentages and step names handed to the job's progress
  callback, which the jobs panel renders verbatim.
* the exact DynamoDB arguments the stubs ignore: the key condition and the
  projection of the names-to-avoid query, and the `:now` of the tombstone
  update being the same UTC reading the deletion fence was stamped with.
* the ACCEPTED side of each bound: exactly 30 names are kept and the 31st
  oldest dropped; a 60-character name survives intact and a 61st character is
  cut; a synthesis step that is the LAST step with one result short is a
  named refusal, not an IndexError.
* the scanner's string-awareness on escapes, stray tokens between objects and
  a truncated nested object; and that one unterminated object in the MIDDLE
  of the array drops only itself.
"""
import json
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from typing import ClassVar
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from projects_mutation_fixtures import PERSONA_SECTIONS

import projects
from shared import project_writes
from shared.exceptions import ConfigurationError, NotFoundError, ServiceError, ValidationError
from shared.test.converse_fixtures import chain_results

#: Every id minted in this module ends in the `fixed_id_suffix` tail (shared/ids.py).
pytestmark = pytest.mark.usefixtures('fixed_id_suffix')

RESEARCH_STEP = 'research_analysis'
SYNTHESIS_STEP = 'persona_synthesis'


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch.object(projects, 'logger') as logger:
        yield logger


@pytest.fixture
def metrics() -> Iterator[MagicMock]:
    with patch.object(projects, 'metrics') as metrics:
        yield metrics


def _corpus(**overrides) -> projects._PersonaCorpus:
    fields = {
        'items': [{'feedback_id': 'fb-1'}, {'feedback_id': 'fb-2'}, {'feedback_id': 'fb-3'}],
        'context': 'CTX', 'stats': 'STATS', 'context_budget': 5000, 'fetch_limit': 40,
        'fetch_limit_reached': False, 'corpus_chars': 1234, 'char_cap_applied': True,
    }
    fields.update(overrides)
    return projects._PersonaCorpus(**fields)


def _client_error(code: str, message: str | None = None) -> ClientError:
    if message is None:
        return ClientError({'Error': {'Code': code}}, 'Converse')
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'Converse')


def _table_with_batch() -> tuple[MagicMock, MagicMock]:
    """A projects-table stub whose ``batch_writer()`` context yields the returned batch."""
    table = MagicMock()
    batch = MagicMock()
    table.batch_writer.return_value.__enter__ = MagicMock(return_value=batch)
    table.batch_writer.return_value.__exit__ = MagicMock(return_value=False)
    return table, batch


# ---------------------------------------------------------------------------
# Project delete
# ---------------------------------------------------------------------------


class TestSweepWithoutABucketWarnsAndTouchesNothing:
    def test_the_warning_names_the_variable_and_the_project(self, log, monkeypatch):
        monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
        with patch.object(projects, '_delete_objects_under_prefix') as prefix_sweep, \
                patch.object(projects, '_delete_project_avatar_objects') as avatar_sweep:
            projects._sweep_project_objects('proj-1', ['persona_1'])
        prefix_sweep.assert_not_called()
        avatar_sweep.assert_not_called()
        log.warning.assert_called_once_with(
            'RAW_DATA_BUCKET is not configured; project objects were not deleted',
            extra={'project_id': 'proj-1'},
        )

    def test_with_a_bucket_every_sweep_runs_against_it(self, monkeypatch):
        monkeypatch.setenv('RAW_DATA_BUCKET', 'the-bucket')
        with patch.object(projects, '_delete_objects_under_prefix') as prefix_sweep, \
                patch.object(projects, '_delete_project_avatar_objects') as avatar_sweep:
            projects._sweep_project_objects('proj-1', ['persona_1'])
        assert prefix_sweep.call_args_list == [
            call('proj-1', 'the-bucket', projects.prototype_project_prefix('proj-1')),
            call('proj-1', 'the-bucket', projects.product_docs_project_prefix('proj-1')),
        ]
        avatar_sweep.assert_called_once_with('proj-1', 'the-bucket', ['persona_1'])


class TestDeleteProject:
    @pytest.mark.parametrize('name', [
        'delete_project', 'generate_personas', 'autofill_prfaq_questions', 'suggest_document_brief',
        'suggest_research_questions', 'create_document', 'update_document', 'delete_document',
    ])
    def test_every_entry_point_is_the_tracer_wrapper_around_the_named_function(self, name):
        # functools.wraps stores __wrapped__ in the function's __dict__; a dropped
        # decorator is a missing key, not a renamed function.
        assert vars(getattr(projects, name))['__wrapped__'].__qualname__ == name

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.delete_project('proj-1')
        assert str(exc.value) == 'Projects table not configured'

    def test_the_fence_and_the_tombstone_share_one_utc_reading(self):
        table, batch = _table_with_batch()
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, '_start_project_deletion') as fence, \
                patch.object(projects, '_iter_partition_keys', return_value=iter(())), \
                patch.object(projects, '_delete_project_job_rows'), \
                patch.object(projects, '_sweep_project_objects'):
            assert projects.delete_project('proj-1') == {'success': True}

        now = fence.call_args.args[2]
        assert fence.call_args == call('proj-1', {'pk': 'PROJECT#proj-1', 'sk': 'META'}, now)
        assert datetime.fromisoformat(now).tzinfo == UTC
        table.update_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj-1', 'sk': 'META'},
            UpdateExpression='SET #status = :deleted, deleted_at = if_not_exists(deleted_at, :now)',
            ConditionExpression='attribute_exists(#deleting)',
            ExpressionAttributeNames={'#deleting': 'deletion_started_at', '#status': 'status'},
            ExpressionAttributeValues={':deleted': 'deleted', ':now': now},
        )
        batch.delete_item.assert_not_called()


# ---------------------------------------------------------------------------
# Oversized-prompt detection
# ---------------------------------------------------------------------------


class TestOversizedInputIsRecognisedOnlyFromBedrocksWording:
    @pytest.mark.parametrize('phrase', [
        'too long', 'too many tokens', 'input is too', 'context window',
        'maximum context', 'exceeds the maximum',
    ])
    def test_each_phrase_is_recognised_case_insensitively(self, phrase):
        error = _client_error('ValidationException', f'The request {phrase.upper()} for the model')
        assert projects._is_oversized_input_error(error) is True

    @pytest.mark.parametrize('error', [
        pytest.param(RuntimeError('too long'), id='not a ClientError'),
        pytest.param(_client_error('ThrottlingException', 'input is too long'), id='another code'),
        pytest.param(_client_error('ValidationException', 'temperature is not supported'),
                     id='an unrelated validation message'),
        pytest.param(_client_error('ValidationException'), id='no message at all'),
    ])
    def test_anything_else_is_not(self, error):
        assert projects._is_oversized_input_error(error) is False


# ---------------------------------------------------------------------------
# Persona generation: the pieces
# ---------------------------------------------------------------------------


def test_the_progress_hook_type_is_a_two_argument_callable():
    assert projects.PersonaProgress == Callable[[int, str], None]


@pytest.mark.parametrize(('instance', 'field'), [
    pytest.param(_corpus(), 'context', id='corpus'),
    pytest.param(projects._ParsedPersonas([], 'strict'), 'tier', id='parsed personas'),
])
def test_the_generation_records_are_frozen(instance, field):
    with pytest.raises(FrozenInstanceError):
        setattr(instance, field, 'changed')


class TestProgressReporterLogsEveryUpdate:
    def test_without_a_callback_only_the_update_is_logged(self, log):
        projects._persona_progress_reporter(None)(5, 'fetching_feedback')
        log.info.assert_called_once_with('[PERSONA] Progress update: 5% - step: fetching_feedback')

    def test_a_working_callback_is_called_and_its_success_logged(self, log):
        callback = MagicMock()
        projects._persona_progress_reporter(callback)(10, 'formatting_data')
        callback.assert_called_once_with(10, 'formatting_data')
        assert log.info.call_args_list == [
            call('[PERSONA] Progress update: 10% - step: formatting_data'),
            call('[PERSONA] Progress callback succeeded'),
        ]

    def test_a_failing_callback_is_logged_and_never_breaks_generation(self, log):
        callback = MagicMock(side_effect=RuntimeError('job table down'))
        projects._persona_progress_reporter(callback)(20, 'executing_llm_chain')
        log.exception.assert_called_once_with('[PERSONA] Progress callback failed')
        log.info.assert_called_once_with('[PERSONA] Progress update: 20% - step: executing_llm_chain')


class TestFetchingTheCorpus:
    def test_the_fetch_passes_the_limit_and_logs_the_count(self, log):
        items = [{'feedback_id': 'a'}, {'feedback_id': 'b'}]
        with patch.object(projects, 'get_feedback_context', return_value=items) as fetch:
            assert projects._fetch_persona_feedback({'days': 7}, 40) == items
        fetch.assert_called_once_with({'days': 7}, limit=40)
        log.info.assert_called_once_with('[PERSONA] Fetched 2 feedback items')

    @pytest.mark.parametrize('empty', [[], None])
    def test_no_feedback_is_a_400_naming_the_filters(self, log, empty):
        with patch.object(projects, 'get_feedback_context', return_value=empty), \
                pytest.raises(ValidationError) as exc:
            projects._fetch_persona_feedback({}, 10)
        assert str(exc.value) == 'No feedback data found for the given filters'
        log.info.assert_called_once_with('[PERSONA] Fetched 0 feedback items')
        log.warning.assert_called_once_with('[PERSONA] No feedback data found for filters')

    def test_a_failing_fetch_is_logged_with_its_traceback_and_re_raised(self, log):
        with patch.object(projects, 'get_feedback_context', side_effect=RuntimeError('db down')), \
                pytest.raises(RuntimeError, match='db down'):
            projects._fetch_persona_feedback({}, 10)
        log.exception.assert_called_once_with('[PERSONA] Failed to fetch feedback')


class TestFormattingTheCorpus:
    def test_returns_the_formatted_context_and_the_statistics(self, log):
        items = [{'feedback_id': 'a'}]
        with patch.object(projects, 'format_feedback_for_llm', return_value='- a review') as fmt, \
                patch.object(projects, 'get_feedback_statistics', return_value='1 review') as stats:
            assert projects._format_persona_feedback(items) == ('- a review', '1 review')
        fmt.assert_called_once_with(items)
        stats.assert_called_once_with(items)
        assert log.info.call_args_list == [
            call('[PERSONA] Formatted context: 10 chars'),
            call('[PERSONA] Stats: 1 review'),
        ]

    def test_a_failing_formatter_is_logged_with_its_traceback_and_re_raised(self, log):
        with patch.object(projects, 'format_feedback_for_llm', side_effect=KeyError('text')), \
                pytest.raises(KeyError):
            projects._format_persona_feedback([{}])
        log.exception.assert_called_once_with('[PERSONA] Failed to format feedback')


class TestLoadingTheCorpus:
    """Steps 1-2 of a generation, with every I/O helper stubbed to a literal."""

    def _load(self, items, *, budget=5000, limit=40, trimmed=('CTX', 1, False)):
        progress = MagicMock()
        with patch.object(projects, 'persona_context_budget', return_value=(budget, limit)), \
                patch.object(projects, 'get_feedback_context', return_value=items), \
                patch.object(projects, 'format_feedback_for_llm', return_value='CTX'), \
                patch.object(projects, 'get_feedback_statistics', return_value='STATS'), \
                patch.object(projects, 'truncate_feedback_context', return_value=trimmed) as trim:
            corpus = projects._load_persona_corpus({'days': 7}, progress)
        return corpus, progress, trim

    def test_the_two_progress_updates_and_the_step_logs(self, log):
        items = [{'feedback_id': 'a'}]
        corpus, progress, trim = self._load(items)
        assert progress.call_args_list == [call(5, 'fetching_feedback'), call(10, 'formatting_data')]
        for message in (
            '[PERSONA] Step 1/6: Fetching feedback data...',
            '[PERSONA] Context budget: 5000 chars, fetch limit: 40 items',
            '[PERSONA] Step 2/6: Formatting feedback data for LLM...',
        ):
            log.info.assert_any_call(message)
        trim.assert_called_once_with('CTX', 5000)
        assert corpus == projects._PersonaCorpus(
            items=items, context='CTX', stats='STATS', context_budget=5000, fetch_limit=40,
            fetch_limit_reached=False, corpus_chars=3, char_cap_applied=False,
        )
        log.warning.assert_not_called()

    @pytest.mark.parametrize(('count', 'reached'), [(39, False), (40, True), (41, True)])
    def test_the_fetch_limit_is_reached_at_exactly_the_limit(self, log, count, reached):
        corpus, _progress, _trim = self._load([{'feedback_id': str(i)} for i in range(count)])
        assert corpus.fetch_limit_reached is reached
        if reached:
            log.warning.assert_called_once_with(
                '[PERSONA] Fetch limit reached — more feedback may match the filters '
                'than one generation reads',
                extra={'fetch_limit': 40, 'items_fetched': count},
            )
        else:
            log.warning.assert_not_called()

    def test_a_trimmed_corpus_keeps_the_trimmed_text_and_reports_the_original_size(self, log):
        corpus, _progress, _trim = self._load(
            [{'feedback_id': 'a'}, {'feedback_id': 'b'}], trimmed=('C', 1, True),
        )
        assert (corpus.context, corpus.corpus_chars, corpus.char_cap_applied) == ('C', 3, True)
        log.warning.assert_called_once_with(
            '[PERSONA] Corpus exceeded the input budget and was trimmed',
            extra={'max_chars': 5000, 'actual_chars': 3, 'items_fetched': 2},
        )


class TestBuildingTheChain:
    STEPS: ClassVar[list[dict]] = [
        {'step_name': RESEARCH_STEP, 'user': 'Research prompt'},
        {'step_name': SYNTHESIS_STEP, 'user': 'Synthesis prompt'},
    ]

    def _build(self, filters, avoid_names, steps=None):
        with patch.object(projects, 'get_persona_generation_steps',
                          return_value=self.STEPS if steps is None else steps) as builder:
            chain = projects._build_persona_chain(_corpus(), filters, 3, avoid_names)
        return chain, builder

    def test_every_filter_reaches_the_prompt_builder(self, log):
        _chain, builder = self._build(
            {'custom_instructions': 'Be brief.', 'response_language': 'ko'}, [],
        )
        builder.assert_called_once_with(
            persona_count=3, feedback_stats='STATS', feedback_context='CTX',
            custom_instructions='Be brief.', response_language='ko', sample_chars=5000,
        )
        log.info.assert_called_once_with('[PERSONA] Built 2 chain steps')

    def test_missing_filters_default_to_no_instructions_and_no_language(self):
        _chain, builder = self._build({}, [])
        assert builder.call_args.kwargs['custom_instructions'] == ''
        assert builder.call_args.kwargs['response_language'] is None

    def test_without_names_to_avoid_the_steps_are_returned_untouched(self):
        chain, _builder = self._build({}, [])
        assert chain == self.STEPS

    def test_the_avoid_block_is_appended_to_the_synthesis_step_only(self):
        chain, _builder = self._build({}, ['Ada Lovelace'])
        assert chain == [
            self.STEPS[0],
            {'step_name': SYNTHESIS_STEP,
             'user': 'Synthesis prompt' + projects._avoid_names_section(['Ada Lovelace'])},
        ]

    def test_a_synthesis_step_with_no_user_prompt_gets_the_block_alone(self):
        chain, _builder = self._build({}, ['Ada'], steps=[{'step_name': SYNTHESIS_STEP}])
        assert chain == [{'step_name': SYNTHESIS_STEP, 'user': projects._avoid_names_section(['Ada'])}]

    def test_a_failing_builder_is_logged_with_its_traceback_and_re_raised(self, log):
        with patch.object(projects, 'get_persona_generation_steps', side_effect=KeyError('tpl')), \
                pytest.raises(KeyError):
            projects._build_persona_chain(_corpus(), {}, 3, [])
        log.exception.assert_called_once_with('[PERSONA] Failed to build chain steps')


class TestNamesToAvoidAreBounded:
    def _names(self, stored: list[object]) -> tuple[list[str], MagicMock]:
        table = MagicMock()
        table.query.return_value = {'Items': [{'name': name} for name in stored]}
        with patch.object(projects, 'projects_table', table):
            return projects._existing_persona_names('proj-1'), table

    def test_the_query_reads_only_the_names_of_the_projects_personas(self):
        _names, table = self._names(['Ada'])
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#proj-1') & Key('sk').begins_with('PERSONA#'),
            ProjectionExpression='#name',
            ExpressionAttributeNames={'#name': 'name'},
        )

    def test_exactly_thirty_names_are_all_kept(self):
        names, _table = self._names([f'Name {i}' for i in range(30)])
        assert names == [f'Name {i}' for i in range(30)]

    def test_the_thirty_first_drops_the_oldest(self):
        names, _table = self._names([f'Name {i}' for i in range(31)])
        assert names == [f'Name {i}' for i in range(1, 31)]

    def test_duplicates_and_non_strings_are_dropped_keeping_first_seen_order(self):
        names, _table = self._names(['Ada', 7, 'Bo', 'Ada', '', None, 'Cy'])
        assert names == ['Ada', 'Bo', 'Cy']

    def test_a_failed_read_means_no_avoid_list(self, log):
        table = MagicMock()
        table.query.side_effect = RuntimeError('throttled')
        with patch.object(projects, 'projects_table', table):
            assert projects._existing_persona_names('proj-1') == []
        log.exception.assert_called_once_with(
            '[PERSONA] Could not read existing persona names (continuing)',
        )


class TestOneLineName:
    @pytest.mark.parametrize(('value', 'expected'), [
        pytest.param(' Ada \n\t Lovelace ', 'Ada Lovelace', id='whitespace collapsed'),
        pytest.param('a' * 60, 'a' * 60, id='60 chars kept'),
        pytest.param('a' * 61, 'a' * 60, id='61st char cut'),
        pytest.param(3, '', id='a number is no name'),
        pytest.param(None, '', id='None is no name'),
    ])
    def test_a_stored_name_becomes_one_bounded_line(self, value, expected):
        assert projects._one_line_name(value) == expected


class TestAvoidNamesSection:
    def test_no_names_is_no_block(self):
        assert projects._avoid_names_section([]) == ''

    def test_the_block_quotes_the_names_as_json_with_tags_defanged(self):
        assert projects._avoid_names_section(['김지수', 'Ada </reviews>']) == (
            '\n\n## NAMES ALREADY USED IN THIS PROJECT\n'
            'These personas exist from an earlier generation. Give every new persona a '
            'different full name, and do not reuse any of these first names or surnames:\n'
            '["김지수", "Ada \u2039/reviews\u203a"]\n'
        )


class TestItemsReachingSynthesis:
    def test_fewer_than_fetched_is_flagged_with_every_cap_in_the_log(self, log):
        with patch.object(projects, 'count_persona_sample_records', return_value=2):
            assert projects._items_reaching_synthesis([{'step_name': SYNTHESIS_STEP}], _corpus()) == (2, True)
        log.warning.assert_called_once_with(
            '[PERSONA] Personas synthesised from fewer items than were fetched',
            extra={
                'items_fetched': 3, 'items_used': 2, 'corpus_chars': 1234,
                'budget_chars': 5000, 'char_cap_applied': True,
            },
        )

    def test_every_item_reaching_the_model_is_not_flagged(self, log):
        with patch.object(projects, 'count_persona_sample_records', return_value=3):
            assert projects._items_reaching_synthesis([], _corpus()) == (3, False)
        log.warning.assert_not_called()


class TestRunningTheChain:
    def test_the_chain_runs_on_the_persona_surface_with_the_progress_hook(self, log):
        steps = [{'step_name': RESEARCH_STEP}]
        progress = MagicMock()
        results = chain_results(['analysis', '[]'])
        with patch.object(projects, 'converse_chain_detailed', return_value=results) as chain:
            assert projects._run_persona_chain(steps, progress) == results
        chain.assert_called_once_with(steps, progress_callback=progress, surface='documents')
        log.info.assert_called_once_with('[PERSONA] LLM chain returned 2 results')

    def test_a_failing_chain_is_logged_with_its_traceback_and_re_raised(self, log):
        with patch.object(projects, 'converse_chain_detailed', side_effect=RuntimeError('bedrock')), \
                pytest.raises(RuntimeError, match='bedrock'):
            projects._run_persona_chain([], MagicMock())
        log.exception.assert_called_once_with('[PERSONA] LLM chain execution failed')


class TestLocatingTheSynthesisResult:
    TWO_STEPS: ClassVar[list[dict]] = [{'step_name': RESEARCH_STEP}, {'step_name': SYNTHESIS_STEP}]

    def test_a_chain_without_the_step_names_what_was_built(self):
        with pytest.raises(ServiceError) as exc:
            projects._persona_synthesis_result([{'step_name': RESEARCH_STEP}], chain_results(['r']))
        assert str(exc.value) == (
            "persona chain has no 'persona_synthesis' step (built: ['research_analysis']) "
            '— cannot locate the persona JSON'
        )

    def test_one_result_short_is_a_named_refusal_not_an_index_error(self):
        with pytest.raises(ServiceError) as exc:
            projects._persona_synthesis_result(self.TWO_STEPS, chain_results(['r']))
        assert str(exc.value) == (
            "persona chain returned 1 result(s) but 'persona_synthesis' is step 2"
        )

    def test_the_synthesis_result_is_returned_and_its_position_logged(self, log):
        results = chain_results(['r', 'abc'])
        assert projects._persona_synthesis_result(self.TWO_STEPS, results) is results[1]
        log.info.assert_called_once_with(
            "[PERSONA] Parsing 'persona_synthesis' output (step 2/2), length: 3 chars",
        )


class TestTheArrayScannerIsStringAware:
    def test_an_escaped_quote_does_not_end_the_string(self):
        text = '[{"a": "x\\"]}y"}]'
        scan = projects._scan_array(text, 0)
        assert (scan.array_end, scan.objects) == (len(text) - 1, [(1, len(text) - 2)])

    def test_a_stray_token_between_objects_is_not_a_bracket(self):
        text = '[{"name": "Ada"}, NEXT {"name": "Bo"}]'
        scan = projects._scan_array(text, 0)
        assert scan.array_end == len(text) - 1
        assert scan.objects == [
            (1, text.index('}')), (text.index('{', 2), text.rindex('}')),
        ]

    def test_a_truncated_nested_object_has_no_end(self):
        scan = projects._scan_array('[{"a": {"b": 1}', 0)
        assert (scan.array_end, scan.objects) == (None, [(1, None)])

    def test_scanning_starts_at_the_given_offset(self):
        text = 'see: [{"a": 1}]'
        scan = projects._scan_array(text, 5)
        assert (scan.array_end, scan.objects) == (len(text) - 1, [(6, len(text) - 2)])


class TestParseTiersAtTheirEdges:
    def _outcome(self, text: str) -> tuple[list[str], str, int]:
        parsed = projects._parse_personas(text)
        return [p['name'] for p in parsed.personas], parsed.tier, parsed.dropped

    def test_a_balanced_array_followed_by_one_more_character_is_still_the_array_tier(self):
        assert self._outcome('[{"name": "Ada"}].') == (['Ada'], 'array', 0)

    def test_an_unterminated_object_in_the_middle_drops_only_itself(self):
        assert self._outcome('[{"name": "Ada"], {"name": "Bo"}]') == (['Bo'], 'salvage', 1)


class TestParsingIsLoggedAndCounted:
    def test_nothing_parsed_is_logged_and_refused_with_the_fixed_text(self, log):
        with pytest.raises(ServiceError) as exc:
            projects._parse_personas('no personas here')
        assert str(exc.value) == 'Failed to parse persona data from LLM response'
        log.error.assert_called_once_with(
            '[PERSONA] No persona could be parsed from the persona_synthesis output',
        )

    def test_a_clean_parse_logs_its_tier_and_emits_no_metric(self, log, metrics):
        projects._parse_personas('[{"name": "Ada"}, {"name": "Bo"}]')
        log.info.assert_called_once_with(
            "[PERSONA] Parsed 2 persona(s) via the 'strict' tier",
            extra={'parse_tier': 'strict', 'personas_dropped': 0},
        )
        metrics.add_metric.assert_not_called()
        log.warning.assert_not_called()

    def test_dropped_personas_are_counted_and_warned_about(self, log, metrics):
        projects._parse_personas('[{"name": "Ada"}, {"name": "Bo",}, {"name": "Cy"}]')
        metrics.add_metric.assert_called_once_with(name='PersonasDroppedAtParse', unit='Count', value=1)
        log.warning.assert_called_once_with(
            '[PERSONA] 1 malformed persona(s) dropped; keeping the 2 that parsed',
        )
        log.info.assert_called_once_with(
            "[PERSONA] Parsed 2 persona(s) via the 'salvage' tier",
            extra={'parse_tier': 'salvage', 'personas_dropped': 1},
        )


# ---------------------------------------------------------------------------
# Project delete: which partitions are swept and which keys are collected
# ---------------------------------------------------------------------------


class TestDeleteProjectSweepsBothPartitionsAndCollectsPersonaIds:
    def _delete(self, project_keys: list[dict], version_keys: list[dict]):
        table, batch = _table_with_batch()
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, '_start_project_deletion'), \
                patch.object(projects, '_iter_partition_keys',
                             side_effect=[iter(project_keys), iter(version_keys)]) as keys, \
                patch.object(projects, '_delete_project_job_rows') as jobs, \
                patch.object(projects, '_sweep_project_objects') as sweep:
            projects.delete_project('proj-1')
        return keys, jobs, sweep, batch

    def test_the_project_partition_then_the_version_partition_are_read(self):
        keys, jobs, _sweep, _batch = self._delete([], [])
        assert keys.call_args_list == [
            call('PROJECT#proj-1'), call(projects.version_partition_key('proj-1')),
        ]
        jobs.assert_called_once_with('proj-1')

    def test_every_row_but_meta_is_deleted_and_the_persona_ids_reach_the_avatar_sweep(self):
        meta = {'pk': 'PROJECT#proj-1', 'sk': 'META'}
        persona = {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_1'}
        doc = {'pk': 'PROJECT#proj-1', 'sk': 'DOC#doc_1'}
        version = {'pk': 'PROJECT#proj-1#VERSIONS', 'sk': 'COUNTER#prd'}
        _keys, _jobs, sweep, batch = self._delete([meta, persona, doc], [version])
        assert batch.delete_item.call_args_list == [
            call(Key=persona), call(Key=doc), call(Key=version),
        ]
        sweep.assert_called_once_with('proj-1', ['persona_1'])


# ---------------------------------------------------------------------------
# Provenance: the model stamp
# ---------------------------------------------------------------------------


class TestThePersonaModelStamp:
    def test_the_model_the_synthesis_step_ran_on_wins(self):
        result = chain_results(['[]'])[0]
        assert result.model_id
        with patch.object(projects, 'get_active_model_id') as picker:
            assert projects._persona_model_id(result) == result.model_id
        picker.assert_not_called()

    def test_a_result_without_a_model_consults_the_picker_for_the_persona_surface(self):
        bare = chain_results(['[]'], model_id='')[0]
        with patch.object(projects, 'get_active_model_id', return_value='picked-model') as picker:
            assert projects._persona_model_id(bare) == 'picked-model'
        picker.assert_called_once_with('documents')


# ---------------------------------------------------------------------------
# Parse tiers: the fenced tier
# ---------------------------------------------------------------------------


class TestTheFencedTier:
    @pytest.mark.parametrize('fence', ['```json', '```JSON', '```'])
    def test_a_multi_line_array_inside_a_fence_is_the_fenced_tier(self, fence):
        text = f'Here are the personas:\n{fence}\n[\n  {{"name": "Ada"}},\n  {{"name": "Bo"}}\n]\n```\nDone.'
        parsed = projects._parse_personas(text)
        assert ([p['name'] for p in parsed.personas], parsed.tier, parsed.dropped) == (['Ada', 'Bo'], 'fenced', 0)

    def test_an_empty_first_fence_is_skipped_for_the_one_holding_the_array(self):
        parsed = projects._parse_persona_tiers('```\n\n```\n```json\n[{"name": "Ada"}]\n```')
        assert parsed == projects._ParsedPersonas([{'name': 'Ada'}], 'fenced')


class TestTheScannerStartsOutsideAString:
    def test_an_empty_key_string_closes_immediately(self):
        text = '[{"": 1}]'
        scan = projects._scan_array(text, 0)
        assert (scan.array_end, scan.objects) == (8, [(1, 7)])


# ---------------------------------------------------------------------------
# Replace semantics: clearing the old personas
# ---------------------------------------------------------------------------


class TestClearingExistingPersonas:
    def _clear(self, items: list[dict]) -> tuple[MagicMock, MagicMock]:
        table, batch = _table_with_batch()
        table.query.return_value = {'Items': items}
        with patch.object(projects, 'projects_table', table):
            projects._clear_existing_personas('proj-1')
        return table, batch

    def test_the_query_projects_only_the_keys_of_the_projects_personas(self):
        table, _batch = self._clear([])
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#proj-1') & Key('sk').begins_with('PERSONA#'),
            ProjectionExpression='pk, sk',
        )

    def test_each_stored_key_is_deleted_and_the_count_logged(self, log):
        rows = [
            {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_1'},
            {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_2'},
        ]
        _table, batch = self._clear(rows)
        assert batch.delete_item.call_args_list == [call(Key=row) for row in rows]
        log.info.assert_called_once_with('[PERSONA] Cleared 2 existing persona(s) before regeneration')

    def test_no_personas_means_no_batch_and_no_log(self, log):
        table, _batch = self._clear([])
        table.batch_writer.assert_not_called()
        log.info.assert_not_called()

    def test_a_failed_read_is_logged_with_its_traceback_and_generation_continues(self, log):
        table = MagicMock()
        table.query.side_effect = RuntimeError('throttled')
        with patch.object(projects, 'projects_table', table):
            assert projects._clear_existing_personas('proj-1') is None
        log.exception.assert_called_once_with('[PERSONA] Failed to clear existing personas (continuing)')


def test_the_source_breakdown_counts_each_platform_and_names_the_missing_one_unknown():
    items = [{'source_platform': 'webscraper'}, {'source_platform': 'webscraper'}, {}]
    assert projects._source_breakdown(items) == {'webscraper': 2, 'unknown': 1}


# ---------------------------------------------------------------------------
# The stored persona item
# ---------------------------------------------------------------------------


NOW_DT = datetime(2026, 3, 4, 5, 6, 7, tzinfo=UTC)


class TestBuildingThePersonaItems:
    FEEDBACK = [{'feedback_id': f'fb-{i}'} for i in range(21)] + [{}]  # 22 items, the last without an id

    def _build(self, personas: list[dict]) -> list[tuple[str, dict, dict]]:
        return projects._build_persona_items(
            'proj-1', personas, self.FEEDBACK, persona_count=3,
            source_breakdown={'webscraper': 22}, llm_time=4321, now_dt=NOW_DT,
            model_id='model-x', date_basis='review',
        )

    def test_a_full_persona_is_stored_field_for_field(self):
        persona = {
            'name': 'AdaLovelace', 'tagline': 'First programmer', 'confidence': 'high',
            'feedback_count': 9, 'identity': {'age': 36}, **PERSONA_SECTIONS, 'supporting_evidence': ['e'],
        }
        [(persona_id, returned, item)] = self._build([persona])
        assert persona_id == 'persona_20260304050607_a1b2c3d4_0'
        assert returned is persona
        assert item == {
            'pk': 'PROJECT#proj-1',
            'sk': 'PERSONA#persona_20260304050607_a1b2c3d4_0',
            'gsi1pk': 'PROJECT#proj-1#PERSONAS',
            'gsi1sk': '2026-03-04T05:06:07+00:00',
            'persona_id': 'persona_20260304050607_a1b2c3d4_0',
            'name': 'Ada Lovelace',
            'tagline': 'First programmer',
            'confidence': 'high',
            'feedback_count': 9,
            'identity': {'age': 36},
            **PERSONA_SECTIONS,
            'research_notes': [],
            'supporting_evidence': ['e'],
            'source_breakdown': {'webscraper': 22},
            'source_feedback_ids': [f'fb-{i}' for i in range(20)],
            'date_basis': 'review',
            'avatar_url': None,
            'avatar_prompt': None,
            'created_at': '2026-03-04T05:06:07+00:00',
            'updated_at': '2026-03-04T05:06:07+00:00',
            'llm_metadata': {
                'model': 'model-x',
                'prompt_version': projects.PERSONA_PROMPT_VERSION,
                'generation_time_ms': 4321,
            },
        }

    def test_an_empty_persona_gets_every_default_and_the_second_id(self):
        _first, (persona_id, _persona, item) = self._build([{}, {}])
        assert persona_id == 'persona_20260304050607_a1b2c3d4_1'
        assert item['name'] == 'Persona 2'
        assert item['tagline'] == ''
        assert item['confidence'] == 'medium'
        assert item['feedback_count'] == 7
        assert isinstance(item['feedback_count'], int)
        for section in ('identity', 'goals_motivations', 'pain_points', 'behaviors',
                        'context_environment', 'scenario'):
            assert item[section] == {}
        assert item['quotes'] == []
        assert item['supporting_evidence'] == []

    def test_the_feedback_id_sample_stops_at_twenty_and_a_missing_id_is_empty(self):
        feedback = [{}] + [{'feedback_id': f'fb-{i}'} for i in range(21)]
        [(_id, _persona, item)] = projects._build_persona_items(
            'proj-1', [{}], feedback, persona_count=1, source_breakdown={}, llm_time=0,
            now_dt=NOW_DT, model_id='m', date_basis='imported',
        )
        assert item['source_feedback_ids'] == [''] + [f'fb-{i}' for i in range(19)]
        assert item['feedback_count'] == 22

    def test_no_personas_is_an_empty_list(self):
        assert self._build([]) == []


# ---------------------------------------------------------------------------
# Avatars
# ---------------------------------------------------------------------------


def test_the_avatar_call_carries_the_persona_id_and_the_project():
    with patch.object(projects, 'generate_persona_avatar', return_value={'avatar_url': 'u'}) as gen:
        assert projects._avatar_for('proj-1', 'persona_1', {'name': 'Ada'}) == {'avatar_url': 'u'}
    gen.assert_called_once_with({'persona_id': 'persona_1', 'name': 'Ada'}, project_id='proj-1')


class TestEveryMissingAvatarIsCountedOnceAndNamed:
    def test_the_failure_counter_and_the_warning(self, log, metrics):
        projects._count_avatar_failure('persona_1', 'the image model timed out')
        metrics.add_metric.assert_called_once_with(name='AvatarGenerationFailed', unit='Count', value=1)
        log.warning.assert_called_once_with(
            '[PERSONA] No avatar for persona_1 (saving persona without one): the image model timed out',
        )

    def test_a_generated_avatar_is_attached_counted_and_logged(self, log, metrics):
        item = {'persona_id': 'persona_1', 'avatar_url': None, 'avatar_prompt': None}
        projects._record_avatar(item, {'avatar_url': 'https://cdn/a.png', 'avatar_prompt': 'a portrait'})
        assert item == {
            'persona_id': 'persona_1', 'avatar_url': 'https://cdn/a.png', 'avatar_prompt': 'a portrait',
        }
        metrics.add_metric.assert_called_once_with(name='AvatarGenerationSucceeded', unit='Count', value=1)
        log.info.assert_called_once_with('[PERSONA] Avatar generated for persona_1: https://cdn/a.png')
        log.warning.assert_not_called()

    def test_a_generator_that_returned_no_url_is_a_counted_failure(self, log, metrics):
        item = {'persona_id': 'persona_2', 'avatar_url': 'stale', 'avatar_prompt': 'stale'}
        projects._record_avatar(item, {'avatar_prompt': 'drafted anyway'})
        assert item == {'persona_id': 'persona_2', 'avatar_url': None, 'avatar_prompt': 'drafted anyway'}
        metrics.add_metric.assert_called_once_with(name='AvatarGenerationFailed', unit='Count', value=1)
        log.warning.assert_called_once_with(
            '[PERSONA] No avatar for persona_2 (saving persona without one): '
            'the generator returned no avatar URL',
        )
        log.info.assert_not_called()


def _persona_items(count: int) -> list[tuple[str, dict, dict]]:
    return [
        (f'persona_{i}', {'name': f'P{i}'}, {'persona_id': f'persona_{i}', 'avatar_url': None, 'avatar_prompt': None})
        for i in range(count)
    ]


class TestAttachingAvatarsConcurrently:
    def test_the_batch_is_announced_once_and_every_item_gets_its_own_avatar(self, log, metrics):
        items = _persona_items(2)
        progress = MagicMock()

        def avatar(_project_id: str, persona_id: str, _persona: dict) -> dict:
            return {'avatar_url': f'https://cdn/{persona_id}.png', 'avatar_prompt': f'prompt {persona_id}'}

        with patch.object(projects, '_avatar_for', side_effect=avatar) as gen:
            projects._attach_avatars('proj-1', items, progress)
        progress.assert_called_once_with(85, 'generating_avatars')
        log.info.assert_any_call('[PERSONA] Generating 2 avatar(s) concurrently...')
        assert sorted(gen.call_args_list, key=lambda c: c.args[1]) == [
            call('proj-1', 'persona_0', {'name': 'P0'}), call('proj-1', 'persona_1', {'name': 'P1'}),
        ]
        assert [item for _id, _p, item in items] == [
            {'persona_id': 'persona_0', 'avatar_url': 'https://cdn/persona_0.png', 'avatar_prompt': 'prompt persona_0'},
            {'persona_id': 'persona_1', 'avatar_url': 'https://cdn/persona_1.png', 'avatar_prompt': 'prompt persona_1'},
        ]
        assert metrics.add_metric.call_args_list == [
            call(name='AvatarGenerationSucceeded', unit='Count', value=1),
        ] * 2

    def test_a_worker_that_raises_keeps_its_persona_and_is_logged_with_its_traceback(self, log, metrics):
        items = _persona_items(1)
        with patch.object(projects, '_avatar_for', side_effect=RuntimeError('image model down')):
            projects._attach_avatars('proj-1', items, MagicMock())
        assert items[0][2] == {'persona_id': 'persona_0', 'avatar_url': None, 'avatar_prompt': None}
        log.exception.assert_called_once_with('[PERSONA] Avatar worker for persona_0 raised')
        metrics.add_metric.assert_called_once_with(name='AvatarGenerationFailed', unit='Count', value=1)
        log.warning.assert_called_once_with(
            '[PERSONA] No avatar for persona_0 (saving persona without one): image model down',
        )

    def test_a_pool_that_cannot_start_a_worker_counts_the_persona_as_avatarless(self, log, metrics):
        items = _persona_items(1)
        pool = MagicMock()
        pool.submit.side_effect = RuntimeError("can't start new thread")
        executor = MagicMock()
        executor.return_value.__enter__ = MagicMock(return_value=pool)
        executor.return_value.__exit__ = MagicMock(return_value=False)
        with patch.object(projects, 'ThreadPoolExecutor', executor):
            projects._attach_avatars('proj-1', items, MagicMock())
        executor.assert_called_once_with(max_workers=1)
        log.warning.assert_called_once_with(
            "[PERSONA] No avatar for persona_0 (saving persona without one): "
            "could not start a worker: can't start new thread",
        )
        metrics.add_metric.assert_called_once_with(name='AvatarGenerationFailed', unit='Count', value=1)
        log.exception.assert_not_called()

    @pytest.mark.parametrize(('count', 'workers'), [
        (1, 1), (projects.AVATAR_MAX_CONCURRENCY, projects.AVATAR_MAX_CONCURRENCY),
        (projects.AVATAR_MAX_CONCURRENCY + 1, projects.AVATAR_MAX_CONCURRENCY),
    ])
    def test_the_pool_is_as_wide_as_the_batch_up_to_the_ceiling(self, count, workers):
        executor = MagicMock()
        executor.return_value.__enter__ = MagicMock(return_value=MagicMock())
        executor.return_value.__exit__ = MagicMock(return_value=False)
        with patch.object(projects, 'ThreadPoolExecutor', executor):
            projects._attach_avatars('proj-1', _persona_items(count), MagicMock())
        executor.assert_called_once_with(max_workers=workers)


# ---------------------------------------------------------------------------
# Saving the personas
# ---------------------------------------------------------------------------


class TestSavingPersonas:
    def test_each_item_is_written_in_order_and_the_count_replaced(self, log):
        table = MagicMock()
        ada = {'persona_id': 'persona_0', 'name': 'Ada'}
        anon = {'persona_id': 'persona_1'}
        items = [('persona_0', {'name': 'Ada'}, ada), ('persona_1', {}, anon)]
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, 'put_project_item') as put:
            assert projects._save_personas('proj-1', items, '2026-03-04T05:06:07+00:00') == [ada, anon]
        assert put.call_args_list == [call(table, 'proj-1', ada), call(table, 'proj-1', anon)]
        assert log.info.call_args_list == [
            call('[PERSONA] Saving persona 1/2: Ada'),
            call('[PERSONA] Saved persona: Ada'),
            call('[PERSONA] Saving persona 2/2: unnamed'),
            call('[PERSONA] Saved persona: None'),
        ]
        table.update_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj-1', 'sk': 'META'},
            UpdateExpression='SET persona_count = :count, updated_at = :now',
            ConditionExpression=projects.PROJECT_WRITABLE_CONDITION,
            ExpressionAttributeNames={'#deleting': 'deletion_started_at', '#status': 'status'},
            ExpressionAttributeValues={
                ':deleting_status': 'deleting', ':deleted_status': 'deleted',
                ':count': 2, ':now': '2026-03-04T05:06:07+00:00',
            },
        )


# ---------------------------------------------------------------------------
# The generation, end to end, with every step stubbed
# ---------------------------------------------------------------------------


def _scripted_clock(readings: list[float]) -> Callable[[], float]:
    """A ``time.time`` whose readings generate_personas sees are scripted.

    Every other caller (the X-Ray SDK stamping segments, the logging module) gets
    the real clock, so the four readings the generation takes — overall start,
    chain start, chain end, overall end — are exactly the four scripted.
    """
    real_time = time.time
    remaining = list(readings)

    def clock() -> float:
        if sys._getframe(1).f_code.co_name == 'generate_personas':
            return remaining.pop(0)
        return real_time()

    return clock


class _Generation:
    """Every step of ``generate_personas`` stubbed to a literal; ``run`` returns the
    result, the stubs (keyed by the patched name, plus ``datetime``) and the
    progress callback, so a test can pin what each step was handed."""

    STEPS: ClassVar[list[dict]] = [{'step_name': RESEARCH_STEP}, {'step_name': SYNTHESIS_STEP}]
    ITEMS: ClassVar[list[tuple[str, dict, dict]]] = [('persona_0', {'name': 'Ada'}, {'persona_id': 'persona_0'})]
    SAVED: ClassVar[list[dict]] = [{'persona_id': 'persona_0', 'name': 'Ada'}]
    CORPUS: ClassVar[projects._PersonaCorpus] = _corpus()
    RESULTS: ClassVar[list[projects.ConverseResult]] = chain_results(['research text', '[{"name": "Ada"}]'])
    PARSED: ClassVar[projects._ParsedPersonas] = projects._ParsedPersonas([{'name': 'Ada'}], 'salvage', 1)

    def run(
        self, filters: dict, *, clock: list[float], items=None, failing_step: Exception | None = None,
    ) -> tuple[dict, dict[str, MagicMock], MagicMock]:
        names = {
            '_load_persona_corpus': self.CORPUS, '_existing_persona_names': ['Old Name'],
            '_build_persona_chain': self.STEPS, '_items_reaching_synthesis': (2, True),
            '_run_persona_chain': self.RESULTS, '_persona_synthesis_result': self.RESULTS[1],
            '_persona_model_id': 'model-x', '_parse_personas': self.PARSED, '_clear_existing_personas': None,
            '_build_persona_items': self.ITEMS if items is None else items, '_attach_avatars': None,
            '_save_personas': self.SAVED,
        }
        patches = [patch.object(projects, name, return_value=value) for name, value in names.items()]
        stubs: dict[str, MagicMock] = {}
        progress = MagicMock()
        with patch.object(projects, 'projects_table', MagicMock()), patch('time.time', _scripted_clock(clock)), \
                patch.object(projects, 'datetime') as dt:
            dt.now.return_value = NOW_DT
            stubs['datetime'] = dt
            for p in patches:
                stubs[p.attribute] = p.start()
            if failing_step:
                stubs['_build_persona_chain'].side_effect = failing_step
            try:
                result = projects.generate_personas('proj-1', filters, progress)
            finally:
                for p in patches:
                    p.stop()
        return result, stubs, progress


class TestGeneratePersonasOrchestration(_Generation):
    FILTERS: ClassVar[dict] = {'days': 7, 'persona_count': 4, 'date_basis': 'REVIEW'}

    def test_every_step_receives_what_the_previous_one_produced(self):
        result, stubs, progress = self.run(self.FILTERS, clock=[100.0, 100.5, 103.25, 107.0])
        corpus, results, parsed = self.CORPUS, self.RESULTS, self.PARSED
        stubs['_load_persona_corpus'].assert_called_once()
        assert stubs['_load_persona_corpus'].call_args.args[0] == self.FILTERS
        update_progress = stubs['_load_persona_corpus'].call_args.args[1]
        stubs['_existing_persona_names'].assert_called_once_with('proj-1')
        stubs['_build_persona_chain'].assert_called_once_with(corpus, self.FILTERS, 4, ['Old Name'])
        stubs['_items_reaching_synthesis'].assert_called_once_with(self.STEPS, corpus)
        stubs['_run_persona_chain'].assert_called_once_with(self.STEPS, update_progress)
        stubs['_persona_synthesis_result'].assert_called_once_with(self.STEPS, results)
        stubs['_persona_model_id'].assert_called_once_with(results[1])
        stubs['_parse_personas'].assert_called_once_with('[{"name": "Ada"}]')
        stubs['_clear_existing_personas'].assert_called_once_with('proj-1')
        stubs['datetime'].now.assert_called_once_with(UTC)
        stubs['_build_persona_items'].assert_called_once_with(
            'proj-1', parsed.personas, corpus.items, persona_count=4,
            source_breakdown={'unknown': 3}, llm_time=2750, now_dt=NOW_DT, model_id='model-x',
            date_basis='review',
        )
        stubs['_attach_avatars'].assert_called_once_with('proj-1', self.ITEMS, update_progress)
        stubs['_save_personas'].assert_called_once_with('proj-1', self.ITEMS, '2026-03-04T05:06:07+00:00')
        assert progress.call_args_list == [
            call(15, 'building_prompts'), call(20, 'executing_llm_chain'), call(80, 'saving_personas'),
        ]
        assert result == {
            'success': True,
            'personas': self.SAVED,
            'analysis': {'research': 'research text'},
            'metadata': {
                'feedback_count': 3,
                'feedback_items_used': 2,
                'context_truncated': True,
                'fetch_limit_reached': False,
                'fetch_limit': 40,
                'parse_tier': 'salvage',
                'personas_dropped': 1,
                'source_breakdown': {'unknown': 3},
                'generation_time_ms': 2750,
            },
        }

    def test_the_operator_log_narrates_every_step_with_its_timings(self, log):
        self.run(self.FILTERS, clock=[100.0, 100.5, 103.25, 107.0])
        assert log.info.call_args_list == [
            call('[PERSONA] ========== STARTING PERSONA GENERATION =========='),
            call('[PERSONA] Project: proj-1'),
            call(f'[PERSONA] Filters: {self.FILTERS}'),
            call('[PERSONA] Config: persona_count=4, generate_avatars=True'),
            call('[PERSONA] Step 3/6: Building LLM chain steps from prompts...'),
            call('[PERSONA] Progress update: 15% - step: building_prompts'),
            call('[PERSONA] Progress callback succeeded'),
            call('[PERSONA] Step 4/6: Executing LLM chain (this may take several minutes)...'),
            call('[PERSONA] Progress update: 20% - step: executing_llm_chain'),
            call('[PERSONA] Progress callback succeeded'),
            call('[PERSONA] LLM chain completed in 2750ms on model-x'),
            call('[PERSONA] Step 5/6: Parsing personas from LLM output...'),
            call('[PERSONA] Step 6/6: Saving personas to database...'),
            call('[PERSONA] Progress update: 80% - step: saving_personas'),
            call('[PERSONA] Progress callback succeeded'),
            call('[PERSONA] ========== PERSONA GENERATION COMPLETE =========='),
            call('[PERSONA] Total time: 7.00s, Personas created: 1'),
        ]
        log.error.assert_not_called()

    def test_three_personas_and_avatars_are_the_defaults(self, log):
        _result, stubs, _progress = self.run({'days': 7}, clock=[0.0, 0.0, 0.0, 0.0])
        assert stubs['_build_persona_chain'].call_args.args[2] == 3
        assert stubs['_build_persona_items'].call_args.kwargs['persona_count'] == 3
        assert stubs['_build_persona_items'].call_args.kwargs['date_basis'] == 'imported'
        stubs['_attach_avatars'].assert_called_once()
        log.info.assert_any_call('[PERSONA] Config: persona_count=3, generate_avatars=True')

    def test_avatars_can_be_switched_off(self):
        _result, stubs, _progress = self.run({'generate_avatars': False}, clock=[0.0, 0.0, 0.0, 0.0])
        stubs['_attach_avatars'].assert_not_called()

    def test_no_persona_items_means_no_avatar_batch(self):
        _result, stubs, _progress = self.run({}, clock=[0.0, 0.0, 0.0, 0.0], items=[])
        stubs['_attach_avatars'].assert_not_called()
        stubs['_save_personas'].assert_called_once_with('proj-1', [], '2026-03-04T05:06:07+00:00')

    def test_without_a_table_the_refusal_is_logged_and_named(self, log):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.generate_personas('proj-1', {})
        assert str(exc.value) == 'Projects table not configured'
        log.error.assert_called_once_with('[PERSONA] Projects table not configured')

    def test_a_failing_step_becomes_the_generic_refusal_with_the_elapsed_time_logged(self, log):
        boom = RuntimeError('boom')
        with pytest.raises(ServiceError) as exc:
            self.run({}, clock=[100.0, 100.5, 103.5], failing_step=boom)
        assert str(exc.value) == 'Failed to generate personas. Please try again.'
        assert exc.value.__cause__ is boom
        log.exception.assert_called_once_with('[PERSONA] FAILED after 3.50s: RuntimeError: boom')


class TestTheFailureMessageNamesTheKnobOnlyForAnOversizedPrompt:
    def test_an_oversized_prompt_tells_the_user_what_to_narrow_and_the_operator_what_to_tune(self, log):
        error = _client_error('ValidationException', 'Input is too long for requested model.')
        refusal = projects._persona_generation_failure(error, _corpus(), 12.345)
        assert isinstance(refusal, ServiceError)
        assert str(refusal) == (
            'The selected feedback was too large for the configured model. '
            'Narrow the filters — a shorter date range, or fewer sources — '
            'or choose a model with a larger context window in Settings.'
        )
        log.exception.assert_called_once_with(
            '[PERSONA] FAILED after 12.35s: ClientError: An error occurred (ValidationException) '
            'when calling the Converse operation: Input is too long for requested model.',
        )
        log.error.assert_called_once_with(
            "[PERSONA] Corpus exceeded the resolved model's context window",
            extra={
                'budget_chars': 5000, 'fetch_limit': 40, 'items_fetched': 3,
                'tuning_env_vars': ['MAX_PERSONA_CONTEXT_CHARS', 'FEEDBACK_LIMIT_PERSONA'],
            },
        )

    def test_anything_else_is_the_generic_retry_message(self, log):
        refusal = projects._persona_generation_failure(KeyError('x'), _corpus(), 0.0)
        assert str(refusal) == 'Failed to generate personas. Please try again.'
        log.error.assert_not_called()


# ---------------------------------------------------------------------------
# The three synchronous AI assists: every prompt byte and every converse argument
# ---------------------------------------------------------------------------


PROJECT_FILTERS = {'days': 30}
SCOPE = {'all': False, 'categories': ['billing']}


class _Assist:
    @staticmethod
    def assert_korean_week_prompt(stubs: dict[str, MagicMock], *, ask: str, system_prompt: str, step_name: str) -> None:
        """A 7-day Korean request: the sample is fetched for the week, counted, and the prompt is built
        byte for byte (product context, statistics, one-review sample, then the assist's own ask)."""
        stubs['feedback'].assert_called_once_with({'days': 7}, 40, SCOPE)
        stubs['stats'].assert_called_once_with([{'text': 'app crashes'}])
        stubs['language'].assert_called_once_with('ko')
        stubs['converse'].assert_called_once_with(
            prompt=(
                "PRODUCT CONTEXT:\nA mobile app.\n\n"
                "FEEDBACK STATISTICS:\n1 review\n\n"
                "CUSTOMER FEEDBACK SAMPLE (1 reviews):\n- app crashes\n\n"
                + ask
            ),
            system_prompt=system_prompt,
            max_tokens=2048, temperature=0.4, surface='documents', step_name=step_name,
        )

    def run(self, name: str, body: dict | None, *, raw: str, items: list[dict] | None = None,
            language: str = '') -> tuple[dict, dict[str, MagicMock]]:
        feedback = [{'text': 'app crashes'}] if items is None else items
        stubs: dict[str, MagicMock] = {}
        patches = {
            'get_project': patch.object(projects, 'get_project', return_value={
                'project': {'project_id': 'proj-1', 'filters': PROJECT_FILTERS},
                'personas': [{'name': 'Kim Jisu'}],
            }),
            'feedback': patch.object(projects, 'get_scoped_feedback_context', return_value=feedback),
            'format': patch.object(projects, 'format_feedback_for_llm',
                                   return_value='- app crashes' if feedback else ''),
            'stats': patch.object(projects, 'get_feedback_statistics', return_value='1 review'),
            'personas': patch.object(projects, 'personas_prompt_context',
                                     return_value='PERSONA BLOCK' if body is not None else ''),
            'product': patch.object(projects, '_product_context_or_placeholder', return_value='A mobile app.'),
            'language': patch('shared.prompts.get_response_language_instruction', return_value=language),
            'converse': patch('shared.converse.converse', return_value=raw),
        }
        with patch.object(projects, 'projects_table', MagicMock()):
            for key, p in patches.items():
                stubs[key] = p.start()
            try:
                result = getattr(projects, name)('proj-1', body, category_scope=SCOPE)
            finally:
                for p in patches.values():
                    p.stop()
        return result, stubs


AUTOFILL_SYSTEM = (
    "You are a senior product manager drafting answers to Amazon's 5 "
    "Working-Backwards customer questions for a PR/FAQ. Use the provided "
    "personas, customer feedback, and product context — DO NOT invent "
    "details that aren't supported. If a question can't be answered from "
    "the available context, return an empty string for that question.\n\n"
    "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
    '{"answers": ["...", "...", "...", "...", "..."]}\n'
    "Each answer should be 2-5 sentences, concrete, and grounded in the inputs."
)
AUTOFILL_QUESTIONS = (
    "Draft answers (in order) for these 5 questions:\n"
    "1. Who is the customer?\n"
    "2. What is the customer problem or opportunity?\n"
    "3. What is the most important customer benefit?\n"
    "4. How do you know what customers need or want? (cite the feedback/personas above)\n"
    "5. What does the customer experience look like?"
)


class TestAutofillPrfaqQuestions(_Assist):
    def test_the_prompt_is_built_from_the_projects_context_byte_for_byte(self):
        result, stubs = self.run(
            'autofill_prfaq_questions',
            {'title': '  Faster sync  ', 'feature_idea': ' Sync in the background ', 'response_language': 'ko'},
            raw='{"answers": ["a", "b", "c", "d", "e"]}', language='Respond in Korean.',
        )
        stubs['get_project'].assert_called_once_with('proj-1')
        stubs['feedback'].assert_called_once_with(PROJECT_FILTERS, 20, SCOPE)
        stubs['format'].assert_called_once_with([{'text': 'app crashes'}])
        stubs['personas'].assert_called_once_with([{'name': 'Kim Jisu'}])
        stubs['product'].assert_called_once_with('proj-1')
        stubs['language'].assert_called_once_with('ko')
        stubs['converse'].assert_called_once_with(
            prompt=(
                "FEATURE TITLE: Faster sync\n"
                "FEATURE IDEA: Sync in the background\n\n"
                "PRODUCT CONTEXT:\nA mobile app.\n\n"
                "PERSONAS:\nPERSONA BLOCK\n\n"
                "CUSTOMER FEEDBACK SAMPLE:\n- app crashes\n\n"
                + AUTOFILL_QUESTIONS
            ),
            system_prompt=AUTOFILL_SYSTEM + '\n\nRespond in Korean.',
            max_tokens=4096, temperature=0.3, surface='documents', step_name='prfaq_autofill',
        )
        assert result == {'answers': ['a', 'b', 'c', 'd', 'e']}

    def test_without_a_body_every_slot_says_so_and_no_language_line_is_appended(self):
        _result, stubs = self.run('autofill_prfaq_questions', None, raw='{}', items=[])
        stubs['language'].assert_called_once_with(None)
        assert stubs['converse'].call_args.kwargs['system_prompt'] == AUTOFILL_SYSTEM
        assert stubs['converse'].call_args.kwargs['prompt'] == (
            "FEATURE TITLE: (unspecified)\n"
            "FEATURE IDEA: (unspecified)\n\n"
            "PRODUCT CONTEXT:\nA mobile app.\n\n"
            "PERSONAS:\n(none)\n\n"
            "CUSTOMER FEEDBACK SAMPLE:\n(none)\n\n"
            + AUTOFILL_QUESTIONS
        )

    def test_a_non_json_answer_is_logged_under_its_own_label_and_padded(self, log):
        result, _stubs = self.run('autofill_prfaq_questions', {}, raw='nope')
        log.warning.assert_called_once_with('Autofill JSON parse failed; returning best-effort. raw=nope')
        assert result == {'answers': ['', '', '', '', '']}

    @pytest.mark.parametrize(('raw', 'answers'), [
        pytest.param('{"answers": "nope"}', ['', '', '', '', ''], id='not a list'),
        pytest.param('{"answers": [1, " a ", null]}', ['', 'a', '', '', ''], id='non-strings blanked, padded'),
        pytest.param('{"answers": ["1", "2", "3", "4", "5"]}', ['1', '2', '3', '4', '5'], id='exactly five kept'),
        pytest.param('{"answers": ["1", "2", "3", "4", "5", "6"]}', ['1', '2', '3', '4', '5'], id='sixth cut'),
    ])
    def test_exactly_five_strings_come_back(self, raw, answers):
        result, _stubs = self.run('autofill_prfaq_questions', {}, raw=raw)
        assert result == {'answers': answers}

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.autofill_prfaq_questions('proj-1', {}, category_scope=None)
        assert str(exc.value) == 'Projects table not configured'


def _brief_system(doc_label: str, language: str = '') -> str:
    text = (
        f"You are a senior product manager about to write a {doc_label}. Based on "
        "the product context and the most salient customer feedback, propose ONE "
        "concrete feature or product improvement worth documenting. The title "
        "should name the feature crisply; the description should explain what it "
        "is and the customer problem it solves, grounded in the feedback. Do not "
        "invent problems that aren't supported by the feedback.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"title": "feature/product title", "feature_idea": "2-4 sentence description"}\n'
        "Title <= 10 words. Description 2-4 sentences."
    )
    return text + ('\n\n' + language if language else '')


class TestSuggestDocumentBrief(_Assist):
    def test_the_prompt_names_the_document_kind_and_the_sample_size(self):
        result, stubs = self.run(
            'suggest_document_brief',
            {'doc_type': 'prfaq', 'filters': {'days': 7}, 'response_language': 'ko'},
            raw='{"title": " Faster sync ", "feature_idea": " Background sync. "}', language='Respond in Korean.',
        )
        self.assert_korean_week_prompt(
            stubs, ask="Propose one feature worth writing a PR-FAQ for.",
            system_prompt=_brief_system('PR-FAQ', 'Respond in Korean.'), step_name='document_brief_suggest',
        )
        assert result == {'title': 'Faster sync', 'feature_idea': 'Background sync.'}

    @pytest.mark.parametrize('body', [None, {}, {'doc_type': 'memo', 'filters': None}])
    def test_a_prd_and_the_projects_filters_are_the_defaults(self, body):
        _result, stubs = self.run('suggest_document_brief', body, raw='{}', items=[])
        stubs['feedback'].assert_called_once_with(PROJECT_FILTERS, 40, SCOPE)
        stubs['stats'].assert_not_called()
        stubs['language'].assert_called_once_with(None)
        assert stubs['converse'].call_args.kwargs['system_prompt'] == _brief_system('PRD')
        assert stubs['converse'].call_args.kwargs['prompt'] == (
            "PRODUCT CONTEXT:\nA mobile app.\n\n"
            "FEEDBACK STATISTICS:\n(no feedback yet)\n\n"
            "CUSTOMER FEEDBACK SAMPLE (0 reviews):\n(none)\n\n"
            "Propose one feature worth writing a PRD for."
        )

    @pytest.mark.parametrize('raw', ['nope', '{}', '{"title": null, "feature_idea": null}'])
    def test_nothing_usable_is_two_empty_strings(self, raw):
        result, _stubs = self.run('suggest_document_brief', {}, raw=raw)
        assert result == {'title': '', 'feature_idea': ''}

    def test_a_non_json_answer_is_logged_under_its_own_label(self, log):
        self.run('suggest_document_brief', {}, raw='nope')
        log.warning.assert_called_once_with('Document-brief JSON parse failed; raw=nope')

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.suggest_document_brief('proj-1', {}, category_scope=None)
        assert str(exc.value) == 'Projects table not configured'


RESEARCH_SYSTEM = (
    "You are a senior UX researcher helping a PM frame a research study on "
    "their product's customer feedback. Propose research questions that are "
    "specific, decision-oriented, and answerable from the customer feedback "
    "provided — favor questions about root causes, priorities, frequency/"
    "severity, and opportunities for new features. Avoid vague questions "
    "like 'what do customers think?'. Ground every suggestion in the actual "
    "feedback themes and product context provided; do not invent topics that "
    "aren't supported by the data.\n\n"
    "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
    '{"suggestions": [{"title": "short report title", "question": "the research question"}, ...]}\n'
    "Provide exactly 3 suggestions. Titles <= 8 words. Questions 1-2 sentences."
)


class TestSuggestResearchQuestions(_Assist):
    def test_the_prompt_is_built_from_the_projects_context_byte_for_byte(self):
        result, stubs = self.run(
            'suggest_research_questions', {'filters': {'days': 7}, 'response_language': 'ko'},
            raw='{"suggestions": [{"title": " Crashes ", "question": " Why does it crash? "}]}',
            language='Respond in Korean.',
        )
        self.assert_korean_week_prompt(
            stubs, ask="Based on the above, propose 3 research questions worth running on this feedback.",
            system_prompt=RESEARCH_SYSTEM + '\n\nRespond in Korean.', step_name='research_suggest',
        )
        assert result == {'suggestions': [{'title': 'Crashes', 'question': 'Why does it crash?'}]}

    @pytest.mark.parametrize('body', [None, {}, {'filters': None}])
    def test_the_projects_filters_and_no_language_line_are_the_defaults(self, body):
        _result, stubs = self.run('suggest_research_questions', body, raw='{}', items=[])
        stubs['feedback'].assert_called_once_with(PROJECT_FILTERS, 40, SCOPE)
        stubs['stats'].assert_not_called()
        stubs['language'].assert_called_once_with(None)
        assert stubs['converse'].call_args.kwargs['system_prompt'] == RESEARCH_SYSTEM
        assert stubs['converse'].call_args.kwargs['prompt'] == (
            "PRODUCT CONTEXT:\nA mobile app.\n\n"
            "FEEDBACK STATISTICS:\n(no feedback yet)\n\n"
            "CUSTOMER FEEDBACK SAMPLE (0 reviews):\n(none)\n\n"
            "Based on the above, propose 3 research questions worth running on this feedback."
        )

    def test_entries_are_cleaned_in_order_and_capped_at_three(self):
        raw = json.dumps({'suggestions': [
            'not a dict',
            {'title': None, 'question': 'Q1'},
            {'question': '   '},
            {'title': 'no question at all'},
            {'title': 'null question', 'question': None},
            {'title': ' T2 ', 'question': ' Q2 '},
            {'question': 'Q3'},
            {'question': 'Q4'},
        ]})
        result, _stubs = self.run('suggest_research_questions', {}, raw=raw)
        assert result == {'suggestions': [
            {'title': '', 'question': 'Q1'}, {'title': 'T2', 'question': 'Q2'}, {'title': '', 'question': 'Q3'},
        ]}

    @pytest.mark.parametrize('raw', ['nope', '{}', '{"suggestions": "nope"}'])
    def test_nothing_usable_is_an_empty_list(self, raw):
        result, _stubs = self.run('suggest_research_questions', {}, raw=raw)
        assert result == {'suggestions': []}

    def test_a_non_json_answer_is_logged_under_its_own_label(self, log):
        self.run('suggest_research_questions', {}, raw='nope')
        log.warning.assert_called_once_with('Research-suggest JSON parse failed; raw=nope')

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.suggest_research_questions('proj-1', {}, category_scope=None)
        assert str(exc.value) == 'Projects table not configured'


# ---------------------------------------------------------------------------
# Custom-document CRUD
# ---------------------------------------------------------------------------


class TestCreateDocument:
    def _create(self, body: dict) -> tuple[dict, MagicMock, MagicMock]:
        table = MagicMock()
        with patch.object(projects, 'projects_table', table), \
                patch.object(project_writes, 'put_project_item_and_increment') as put, \
                patch.object(projects, 'datetime') as dt:
            dt.now.return_value = NOW_DT
            result = projects.create_document('proj-1', body)
        return result, put, table

    def test_the_stored_item_field_for_field_and_the_counter_it_increments(self):
        result, put, table = self._create({'title': 'Notes', 'content': '# Notes'})
        item = {
            'pk': 'PROJECT#proj-1',
            'sk': 'DOC#doc_20260304050607_a1b2c3d4',
            'gsi1pk': 'PROJECT#proj-1#DOCUMENTS',
            'gsi1sk': '2026-03-04T05:06:07+00:00',
            'document_id': 'doc_20260304050607_a1b2c3d4',
            'document_type': 'custom',
            'title': 'Notes',
            'content': '# Notes',
            'created_at': '2026-03-04T05:06:07+00:00',
            'updated_at': '2026-03-04T05:06:07+00:00',
        }
        put.assert_called_once_with(table, 'proj-1', item, 'document_count')
        assert result == {'success': True, 'document': item}

    def test_an_untitled_custom_document_is_the_default(self):
        result, _put, _table = self._create({'content': 'x'})
        assert result['document']['title'] == 'Untitled Document'
        assert result['document']['document_type'] == 'custom'

    @pytest.mark.parametrize('body', [{'title': 'Notes'}, {'title': 'Notes', 'content': ''}])
    def test_missing_content_is_refused_before_any_write(self, body):
        with patch.object(projects, 'projects_table', MagicMock()), \
                patch.object(project_writes, 'put_project_item_and_increment') as put, \
                pytest.raises(ValidationError) as exc:
            projects.create_document('proj-1', body)
        assert str(exc.value) == 'Content is required'
        put.assert_not_called()

    @pytest.mark.parametrize('document_type', ['prd', 'prfaq', 'prototype', 'research'])
    def test_every_other_type_is_sent_to_its_own_route(self, document_type):
        with patch.object(projects, 'projects_table', MagicMock()), pytest.raises(ValidationError) as exc:
            projects.create_document('proj-1', {'content': 'x', 'document_type': document_type})
        assert str(exc.value) == (
            'Only custom documents can be created directly. Every managed or '
            'workflow document type must use its dedicated route.'
        )

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.create_document('proj-1', {'content': 'x'})
        assert str(exc.value) == 'Projects table not configured'


UPDATE_CONDITION = 'attribute_exists(pk) AND attribute_exists(sk) AND document_id = :document_id'


class TestUpdateDocument:
    """The route's own checks; the versioning itself is shared.document_history's
    (moto-backed in lambda/shared/test/test_document_history.py)."""

    def _update(self, document: dict, body: dict) -> tuple[dict, MagicMock]:
        stored = {'pk': 'PROJECT#proj-1', 'document_id': 'd1', **document}
        table = MagicMock()
        table.get_item.return_value = {'Item': stored}
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, '_find_document', return_value=stored) as find, \
                patch.object(projects, 'edit_document', return_value={'success': True}) as edit, \
                patch.object(projects, 'datetime') as dt:
            dt.now.return_value = NOW_DT
            result = projects.update_document('proj-1', 'd1', body)
        find.assert_called_once_with('proj-1', 'd1')
        return result, edit

    def test_a_custom_documents_new_title_is_handed_to_the_edit(self):
        result, edit = self._update({'sk': 'DOC#d1', 'document_type': 'custom', 'title': 'Old'},
                                    {'title': 'New', 'content': '# new'})
        assert result == {'success': True}
        assert edit.call_args.kwargs == {'now': '2026-03-04T05:06:07+00:00', 'title': 'New'}
        assert edit.call_args.args[3] == {'title': 'New', 'content': '# new'}

    @pytest.mark.parametrize('title', ['', '   ', 7])
    def test_a_custom_documents_title_must_be_a_non_empty_string(self, title):
        with pytest.raises(ValidationError) as exc:
            self._update({'sk': 'DOC#d1', 'document_type': 'custom'}, {'title': title})
        assert str(exc.value) == 'title must be a non-empty string'

    @pytest.mark.parametrize('document', [
        pytest.param({'sk': 'DOC#d1', 'document_type': 'prd', 'title': 'Launch'}, id='managed by type'),
        pytest.param({'sk': 'PRD#d1', 'title': 'Launch'}, id='PRD# key'),
        pytest.param({'sk': 'PRFAQ#d1', 'title': 'Launch'}, id='PRFAQ# key'),
        pytest.param({'sk': 'PROTOTYPE#d1', 'title': 'Launch'}, id='PROTOTYPE# key'),
    ])
    def test_a_managed_document_cannot_change_series(self, document):
        with pytest.raises(ValidationError) as exc:
            self._update(document, {'title': 'Other series'})
        assert str(exc.value) == (
            'Managed PRD, PR/FAQ, and prototype titles cannot change '
            'series. Use the dedicated workflow to create a new series.'
        )

    @pytest.mark.parametrize(('document', 'title'), [
        pytest.param({'sk': 'PRD#d1', 'base_title': 'Launch', 'title': 'Other'}, 'launch (v3)',
                     id='base_title wins over title'),
        pytest.param({'sk': 'PRD#d1', 'title': 'Launch (v2)'}, 'Launch', id='title when there is no base'),
        pytest.param({'sk': 'PRD#d1'}, 'Untitled', id='Untitled when there is neither'),
    ])
    def test_the_same_series_hands_no_title_to_the_edit(self, document, title):
        _result, edit = self._update(document, {'title': title})
        assert edit.call_args.kwargs['title'] is None

    @pytest.mark.parametrize('document', [
        pytest.param({'sk': 'DOC#d1', 'document_type': 'prototype'}, id='by type'),
        pytest.param({'sk': 'PROTOTYPE#d1'}, id='by key'),
    ])
    def test_prototype_content_is_refused(self, document):
        with pytest.raises(ValidationError) as exc:
            self._update(document, {'content': '<html>'})
        assert str(exc.value) == (
            'Prototype content is stored in S3 and cannot be updated through '
            'generic document CRUD. Use the prototype revision workflow.'
        )

    def test_a_document_gone_after_the_lookup_is_a_404(self):
        table = MagicMock()
        table.get_item.return_value = {}
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1', 'document_id': 'd1'}), \
                pytest.raises(NotFoundError):
            projects.update_document('proj-1', 'd1', {'content': 'x'})

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.update_document('proj-1', 'd1', {})
        assert str(exc.value) == 'Projects table not configured'


META = {'pk': 'PROJECT#proj-1', 'sk': 'META', 'document_count': 2}
CUSTOM_DOC = {'pk': 'PROJECT#proj-1', 'sk': 'DOC#d1', 'document_id': 'd1', 'document_type': 'custom'}
OTHER_DOC = {'pk': 'PROJECT#proj-1', 'sk': 'RESEARCH#r1', 'document_id': 'r1'}
PERSONA_ROW = {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1', 'persona_id': 'p1'}


def _transaction_cancelled() -> ClientError:
    return ClientError({'Error': {'Code': 'TransactionCanceledException'}}, 'TransactWriteItems')


def _delete_document(
    rows: list[dict], document_id: str = 'd1', *, table: MagicMock | None = None,
) -> tuple[dict, MagicMock, MagicMock, MagicMock]:
    """Run ``delete_document`` over a partition of ``rows``; (result, table, persist stub, preserve stub)."""
    table = table or MagicMock()
    table.name = 'projects-table'
    table.query.return_value = {'Items': rows}
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, 'persist_legacy_document_versions') as persist, \
            patch.object(projects, 'preserve_versioned_document_allocation') as preserve, \
            patch.object(projects, 'datetime') as dt:
        dt.now.return_value = NOW_DT
        result = projects.delete_document('proj-1', document_id)
    return result, table, persist, preserve


class TestDeleteDocument:

    def test_the_transaction_deletes_the_row_and_sets_the_count_it_observed(self):
        result, table, persist, preserve = _delete_document([META, CUSTOM_DOC, OTHER_DOC, PERSONA_ROW])
        assert result == {'success': True}
        persist.assert_not_called()
        preserve.assert_not_called()
        table.meta.client.transact_write_items.assert_called_once_with(TransactItems=[
            {
                'Delete': {
                    'TableName': 'projects-table',
                    'Key': {'pk': 'PROJECT#proj-1', 'sk': 'DOC#d1'},
                    'ConditionExpression': UPDATE_CONDITION,
                    'ExpressionAttributeValues': {':document_id': 'd1'},
                },
            },
            {
                'Update': {
                    'TableName': 'projects-table',
                    'Key': {'pk': 'PROJECT#proj-1', 'sk': 'META'},
                    'UpdateExpression': 'SET document_count = :remaining, updated_at = :now',
                    'ConditionExpression': (
                        f'{projects.PROJECT_WRITABLE_CONDITION} AND document_count = :observed_count'
                    ),
                    'ExpressionAttributeNames': {'#deleting': 'deletion_started_at', '#status': 'status'},
                    'ExpressionAttributeValues': {
                        ':deleting_status': 'deleting', ':deleted_status': 'deleted',
                        ':remaining': 1, ':now': '2026-03-04T05:06:07+00:00', ':observed_count': 2,
                    },
                },
            },
        ])

    def test_a_project_that_never_counted_requires_the_count_to_still_be_absent(self):
        _result, table, _persist, _preserve = _delete_document([{'pk': 'PROJECT#proj-1', 'sk': 'META'}, CUSTOM_DOC])
        update = table.meta.client.transact_write_items.call_args.kwargs['TransactItems'][1]['Update']
        assert update['ConditionExpression'] == (
            f'{projects.PROJECT_WRITABLE_CONDITION} AND attribute_not_exists(document_count)'
        )
        assert update['ExpressionAttributeValues'] == {
            ':deleting_status': 'deleting', ':deleted_status': 'deleted',
            ':remaining': 0, ':now': '2026-03-04T05:06:07+00:00',
        }

    @pytest.mark.parametrize('document', [
        pytest.param({**CUSTOM_DOC, 'document_type': 'prfaq'}, id='managed by type'),
        pytest.param({'pk': 'PROJECT#proj-1', 'sk': 'PRD#d1', 'document_id': 'd1'}, id='PRD# key'),
        pytest.param({'pk': 'PROJECT#proj-1', 'sk': 'PRFAQ#d1', 'document_id': 'd1'}, id='PRFAQ# key'),
        pytest.param({'pk': 'PROJECT#proj-1', 'sk': 'PROTOTYPE#d1', 'document_id': 'd1'}, id='PROTOTYPE# key'),
    ])
    def test_a_managed_document_snapshots_every_document_first(self, document):
        _result, table, persist, preserve = _delete_document([META, document, OTHER_DOC, PERSONA_ROW])
        persist.assert_called_once_with(table, 'proj-1', [document, OTHER_DOC])
        preserve.assert_not_called()

    @pytest.mark.parametrize(('allocation_id', 'preserved'), [
        ('allocation-7', True), ('', False), (7, False),
    ])
    def test_only_a_real_allocation_id_is_preserved(self, allocation_id, preserved):
        document = {**CUSTOM_DOC, 'document_type': 'prd', 'version_allocation_id': allocation_id}
        _result, table, _persist, preserve = _delete_document([META, document])
        if preserved:
            preserve.assert_called_once_with(table, 'proj-1', document)
        else:
            preserve.assert_not_called()

    def test_an_unknown_document_is_a_404_before_any_write(self):
        table = MagicMock()
        table.query.return_value = {'Items': [META, CUSTOM_DOC]}
        with patch.object(projects, 'projects_table', table), pytest.raises(NotFoundError) as exc:
            projects.delete_document('proj-1', 'missing')
        assert str(exc.value) == 'Document not found'
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_table_without_a_name_is_a_configuration_error(self, monkeypatch):
        monkeypatch.delenv('PROJECTS_TABLE', raising=False)
        table = MagicMock()
        table.name = None
        table.query.return_value = {'Items': [META, CUSTOM_DOC]}
        with patch.object(projects, 'projects_table', table), pytest.raises(ConfigurationError) as exc:
            projects.delete_document('proj-1', 'd1')
        assert str(exc.value) == 'Projects table name not configured'
        assert isinstance(exc.value.__cause__, ValueError)

    def test_without_a_table_the_refusal_names_it(self):
        with patch.object(projects, 'projects_table', None), pytest.raises(ConfigurationError) as exc:
            projects.delete_document('proj-1', 'd1')
        assert str(exc.value) == 'Projects table not configured'

    def test_a_non_transaction_client_error_propagates_untouched(self):
        table = MagicMock()
        table.meta.client.transact_write_items.side_effect = _client_error('ProvisionedThroughputExceededException')
        with pytest.raises(ClientError):
            _delete_document([META, CUSTOM_DOC], table=table)
        table.get_item.assert_not_called()


class TestDeleteDocumentRetriesACancelledTransaction:
    def _cancelled(self, current: dict | None, meta: dict | None) -> MagicMock:
        table = MagicMock()
        table.meta.client.transact_write_items.side_effect = _transaction_cancelled()
        table.get_item.side_effect = [{'Item': current} if current else {}, {'Item': meta} if meta else {}] * 4
        return table

    @pytest.mark.parametrize('current', [None, {'document_id': 'someone-else'}])
    def test_a_row_that_is_gone_or_replaced_is_a_404(self, current):
        table = self._cancelled(current, META)
        with pytest.raises(NotFoundError) as exc:
            _delete_document([META, CUSTOM_DOC], table=table)
        assert str(exc.value) == 'Document no longer exists'
        assert isinstance(exc.value.__cause__, ClientError)
        table.get_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj-1', 'sk': 'DOC#d1'}, ConsistentRead=True,
        )

    def test_a_live_project_is_retried_exactly_four_times(self):
        table = self._cancelled(CUSTOM_DOC, META)
        with pytest.raises(ServiceError) as exc:
            _delete_document([META, CUSTOM_DOC], table=table)
        assert str(exc.value) == (
            'Document could not be deleted because the project is being deleted '
            'or its document count changed repeatedly.'
        )
        assert table.meta.client.transact_write_items.call_count == projects.DOCUMENT_DELETE_ATTEMPTS == 4
        assert table.get_item.call_args_list == [
            call(Key={'pk': 'PROJECT#proj-1', 'sk': 'DOC#d1'}, ConsistentRead=True),
            call(Key={'pk': 'PROJECT#proj-1', 'sk': 'META'}, ConsistentRead=True),
        ] * 4

    @pytest.mark.parametrize('meta', [
        pytest.param({'sk': 'META', 'deletion_started_at': '2026-01-01'}, id='fenced'),
        pytest.param({'sk': 'META', 'status': 'deleted'}, id='tombstoned'),
    ])
    def test_a_project_being_deleted_is_not_retried(self, meta):
        table = self._cancelled(CUSTOM_DOC, meta)
        with pytest.raises(ServiceError):
            _delete_document([META, CUSTOM_DOC], table=table)
        assert table.meta.client.transact_write_items.call_count == 1

    def test_a_retry_that_succeeds_returns_success(self):
        table = MagicMock()
        table.meta.client.transact_write_items.side_effect = [_transaction_cancelled(), None]
        table.get_item.side_effect = [{'Item': CUSTOM_DOC}, {'Item': META}]
        assert _delete_document([META, CUSTOM_DOC], table=table)[0] == {'success': True}
        assert table.meta.client.transact_write_items.call_count == 2


# ---------------------------------------------------------------------------
# Document duplication: what a copy never inherits, and the source read
# ---------------------------------------------------------------------------


def test_the_fields_a_copy_never_inherits():
    assert sorted(projects._DUPLICATE_DROPPED_FIELDS) == sorted([
        'pk', 'sk', 'gsi1pk', 'gsi1sk', 'document_id', 'title', 'base_title', 'version',
        'version_allocation_id', 'prototype_etag', 'prototype_version_id', 'prototype_url',
        'created_at', 'updated_at', 'job_id',
    ])
    assert isinstance(projects._DUPLICATE_DROPPED_FIELDS, frozenset)


def test_the_managed_key_prefixes_map_to_their_document_types():
    assert projects._MANAGED_DUPLICATE_TYPES == {'PRD#': 'prd', 'PRFAQ#': 'prfaq', 'PROTOTYPE#': 'prototype'}


class TestSourceDocumentItem:
    def _read(self, stored: object) -> tuple[dict, MagicMock]:
        table = MagicMock()
        table.get_item.return_value = {'Item': stored} if stored is not None else {}
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, '_find_document', return_value={'sk': 'PRD#d1'}) as find:
            item = projects._source_document_item('proj-1', 'd1')
        find.assert_called_once_with('proj-1', 'd1')
        return item, table

    def test_the_full_row_is_read_consistently_by_its_stored_key(self):
        stored = {'sk': 'PRD#d1', 'document_id': 'd1', 'content': '# full'}
        item, table = self._read(stored)
        assert item is stored
        table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj-1', 'sk': 'PRD#d1'}, ConsistentRead=True)

    @pytest.mark.parametrize('stored', [
        pytest.param(None, id='row gone'),
        pytest.param('not a dict', id='malformed row'),
        pytest.param({'sk': 'PRD#d1', 'document_id': 'other'}, id='replaced row'),
    ])
    def test_anything_but_the_named_document_is_a_404(self, stored):
        with pytest.raises(NotFoundError) as exc:
            self._read(stored)
        assert str(exc.value) == 'Document not found'
