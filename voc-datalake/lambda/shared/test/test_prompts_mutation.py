"""Mutation hardening for `shared/prompts.py`.

`test_prompt_utils.py` pins the chain builders' file names, the persona step
order and the sample budget, yet a mutation run left 121 of 220 mutants alive.
Nearly all of them sit in what the builders HAND OVER rather than in what they
return, which the earlier tests checked with `in` or on a single key:

* the context dicts: every slot name (`feature_idea`, `previous`, ...) and the
  literal `'{previous}'` placeholder. format_prompt leaves an unknown slot as
  literal text for the model, so a renamed key is a silent quality regression,
  not an exception;
* the step-name lists of the PRD and research chains, and the per-field
  defaults of `_inference_from_step` (system_prompt `''`, thinking_budget `0`,
  step_name falling back to the key) that the async research handler reads;
* every language name and the wording of the response-language instruction;
  the exact `custom_section` wrapper; the `%Y-%m-%d` launch date;
* every error and log message, the cwd fallback of `get_prompts_dir`, and the
  loader's cache capacity.

Each is pinned here as a literal: the exact dict handed to build_chain_steps
(`assert_called_once_with`), the exact string, the exact number.
"""
import inspect
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

import shared.prompts as prompts_module
from shared.feedback import format_feedback_for_llm
from shared.prompts import (
    AVATAR_GENERATION_PROMPTS,
    DEFAULT_STEP_MAX_TOKENS,
    PERSONA_GENERATION_PROMPTS,
    PERSONA_IMPORT_PROMPTS,
    PRD_GENERATION_PROMPTS,
    PRFAQ_GENERATION_PROMPTS,
    REPO_PROMPTS_DIR,
    RESEARCH_ANALYSIS_PROMPTS,
    build_chain_steps,
    count_persona_sample_records,
    format_prompt,
    get_persona_generation_steps,
    get_prd_generation_steps,
    get_prfaq_generation_steps,
    get_prompts_dir,
    get_research_analysis_steps,
    get_research_step_config,
    get_step_inference_config,
    load_prompt_file,
)

LANGUAGE_INSTRUCTION = (
    'IMPORTANT: You MUST respond entirely in {name} ({code}). '
    'All text, headings, labels, and explanations must be in {name}.'
)

# Every code the instruction knows a display name for, with that name. A code
# missing here, or a name that drifts, reaches the model as a wrong or
# unreadable instruction and nothing else would notice.
EXPECTED_LANGUAGE_NAMES = (
    ('ar', 'Arabic'), ('bg', 'Bulgarian'), ('ca', 'Catalan'), ('cs', 'Czech'),
    ('da', 'Danish'), ('de', 'German'), ('el', 'Greek'), ('es', 'Spanish'),
    ('fi', 'Finnish'), ('fr', 'French'), ('he', 'Hebrew'), ('hi', 'Hindi'),
    ('hr', 'Croatian'), ('hu', 'Hungarian'), ('id', 'Indonesian'), ('it', 'Italian'),
    ('ja', 'Japanese'), ('ko', 'Korean'), ('ms', 'Malay'), ('nl', 'Dutch'),
    ('no', 'Norwegian'), ('pl', 'Polish'), ('pt', 'Portuguese'), ('ro', 'Romanian'),
    ('ru', 'Russian'), ('sk', 'Slovak'), ('sl', 'Slovenian'), ('sr', 'Serbian'),
    ('sv', 'Swedish'), ('th', 'Thai'), ('tl', 'Filipino'), ('tr', 'Turkish'),
    ('uk', 'Ukrainian'), ('vi', 'Vietnamese'), ('zh', 'Chinese'),
)

DEFAULT_PRODUCT_CONTEXT = "(No product context provided.)"


def _write_steps(prompts_dir: Path, steps: dict, filename: str = 'f.json') -> None:
    """Write a prompt file whose ``steps`` block is ``steps``."""
    (prompts_dir / filename).write_text(json.dumps({'steps': steps}), encoding='utf-8')


@pytest.fixture
def repo_prompts(monkeypatch):
    """Route the loader at the repo's prompt files and keep the cache clean on
    both sides, as `test_prompt_utils.py` does."""
    assert REPO_PROMPTS_DIR.is_dir(), f'prompts directory moved? expected it at {REPO_PROMPTS_DIR}'
    monkeypatch.setattr(prompts_module, 'get_prompts_dir', lambda: REPO_PROMPTS_DIR)
    load_prompt_file.cache_clear()
    yield REPO_PROMPTS_DIR
    load_prompt_file.cache_clear()


@pytest.fixture
def prompts_dir(monkeypatch, tmp_path):
    """Route the loader at an empty temporary prompts directory."""
    monkeypatch.setattr(prompts_module, 'get_prompts_dir', lambda: tmp_path)
    load_prompt_file.cache_clear()
    yield tmp_path
    load_prompt_file.cache_clear()


class TestEveryPromptFileConstantNamesARealFile:
    @pytest.mark.parametrize(('constant', 'filename'), [
        (PERSONA_GENERATION_PROMPTS, 'persona-generation.json'),
        (PERSONA_IMPORT_PROMPTS, 'persona-import.json'),
        (PRD_GENERATION_PROMPTS, 'prd-generation.json'),
        (PRFAQ_GENERATION_PROMPTS, 'prfaq-generation.json'),
        (RESEARCH_ANALYSIS_PROMPTS, 'research-analysis.json'),
        (AVATAR_GENERATION_PROMPTS, 'avatar-generation.json'),
    ])
    def test_constant_is_the_filename_and_the_file_exists(self, constant, filename):
        assert constant == filename
        assert (REPO_PROMPTS_DIR / constant).is_file()

    @pytest.mark.usefixtures('repo_prompts')
    def test_the_import_prompts_carry_what_the_importer_subscripts(self):
        config = load_prompt_file(PERSONA_IMPORT_PROMPTS)
        assert set(config['user_prompts']) >= {'text', 'image'}


class TestGetPromptsDirFallsBackToTheWorkingDirectory:
    @pytest.fixture
    def only_cwd_candidate(self, monkeypatch, tmp_path):
        # The test host is not a Lambda container; the repo branch is pointed at
        # a directory that does not exist so only the cwd branch can answer.
        assert not Path('/var/task/prompts').exists()
        monkeypatch.setattr(prompts_module, 'REPO_PROMPTS_DIR', tmp_path / 'absent')
        monkeypatch.chdir(tmp_path)
        return tmp_path

    def test_returns_cwd_slash_prompts_when_it_exists(self, only_cwd_candidate):
        (only_cwd_candidate / 'prompts').mkdir()
        assert get_prompts_dir() == only_cwd_candidate / 'prompts'

    @pytest.mark.usefixtures('only_cwd_candidate')
    def test_names_the_failure_when_no_candidate_exists(self):
        with pytest.raises(FileNotFoundError) as exc:
            get_prompts_dir()
        assert str(exc.value) == 'Could not locate prompts directory'


class TestLoadPromptFile:
    def test_cache_holds_thirty_two_files(self):
        assert load_prompt_file.cache_info().maxsize == 32

    def test_missing_file_error_names_the_full_path(self, prompts_dir):
        with pytest.raises(FileNotFoundError) as exc:
            load_prompt_file('nope.json')
        assert str(exc.value) == f'Prompt file not found: {prompts_dir / "nope.json"}'

    def test_logs_the_loaded_filename_once(self, prompts_dir):
        (prompts_dir / 't.json').write_text('{"k": "v"}', encoding='utf-8')
        with patch.object(prompts_module, 'logger') as logger:
            assert load_prompt_file('t.json') == {'k': 'v'}
        logger.debug.assert_called_once_with('Loaded prompt file: t.json')


class TestFormatPromptPartialSubstitution:
    def test_substitutes_the_known_slots_and_keeps_the_unknown_one_verbatim(self):
        assert format_prompt('{a}-{b}-{c}', a='X', c=3) == 'X-{b}-3'


class TestStepInferenceConfig:
    def test_missing_step_error_names_step_and_file(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {}})
        with pytest.raises(KeyError) as exc:
            get_step_inference_config('f.json', 'bad')
        assert exc.value.args[0] == "Step 'bad' not found in f.json"

    def test_a_file_without_steps_reports_the_step_as_missing(self, prompts_dir):
        (prompts_dir / 'f.json').write_text('{}', encoding='utf-8')
        with pytest.raises(KeyError) as exc:
            get_step_inference_config('f.json', 's1')
        assert exc.value.args[0] == "Step 's1' not found in f.json"

    def test_an_empty_step_resolves_to_exactly_the_defaults(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {}})
        assert DEFAULT_STEP_MAX_TOKENS == 4096
        assert get_step_inference_config('f.json', 's1') == {
            'system_prompt': '',
            'max_tokens': 4096,
            'thinking_budget': 0,
            'step_name': 's1',
        }

    def test_every_configured_field_is_read(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {
            'system_prompt': 'SYS', 'max_tokens': 1234, 'thinking_budget': 777, 'name': 'Named',
        }})
        assert get_step_inference_config('f.json', 's1') == {
            'system_prompt': 'SYS',
            'max_tokens': 1234,
            'thinking_budget': 777,
            'step_name': 'Named',
        }

    @pytest.mark.usefixtures('repo_prompts')
    def test_research_step_config_reads_the_real_file(self):
        """The async research handler reads these four keys for data_analysis;
        the budgets are the file's literals, the step name the file's `name`."""
        step = load_prompt_file(RESEARCH_ANALYSIS_PROMPTS)['steps']['data_analysis']
        assert get_research_step_config('data_analysis') == {
            'system_prompt': step['system_prompt'],
            'max_tokens': 9000,
            'thinking_budget': 5000,
            'step_name': 'data_analysis',
        }
        assert step['system_prompt'].startswith('You are a senior user researcher')


class TestBuildChainStepsEmitsExactSteps:
    def test_an_empty_step_builds_the_default_step(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {}})
        assert build_chain_steps('f.json', ['s1'], {}) == [{
            'system': '',
            'user': '',
            'max_tokens': 4096,
            'thinking_budget': 0,
            'step_name': 's1',
        }]

    def test_a_full_step_is_copied_field_for_field(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {
            'system_prompt': 'SYS', 'user_prompt_template': 'Hi {who}',
            'max_tokens': 1234, 'thinking_budget': 777, 'name': 'Named',
        }})
        assert build_chain_steps('f.json', ['s1'], {'who': 'you'}) == [{
            'system': 'SYS',
            'user': 'Hi you',
            'max_tokens': 1234,
            'thinking_budget': 777,
            'step_name': 'Named',
        }]

    def test_language_instruction_is_appended_after_a_blank_line(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {'system_prompt': 'SYS', 'user_prompt_template': '{x}'}})
        steps = build_chain_steps('f.json', ['s1'], {'x': 'D', 'response_language': 'es'})
        expected = 'SYS\n\n' + LANGUAGE_INSTRUCTION.format(name='Spanish', code='es')
        assert steps[0]['system'] == expected
        # response_language is an instruction, not a slot: it is popped before
        # formatting so an `{response_language}` slot would stay literal.
        assert steps[0]['user'] == 'D'

    def test_english_appends_nothing(self, prompts_dir):
        _write_steps(prompts_dir, {'s1': {'system_prompt': 'SYS'}})
        steps = build_chain_steps('f.json', ['s1'], {'response_language': 'en'})
        assert steps[0]['system'] == 'SYS'


class TestResponseLanguageInstructionWording:
    def test_the_display_name_table_is_exactly_the_expected_one(self):
        assert dict(EXPECTED_LANGUAGE_NAMES) == prompts_module.LANGUAGE_NAMES
        assert len(EXPECTED_LANGUAGE_NAMES) == len(dict(EXPECTED_LANGUAGE_NAMES))   # no code listed twice

    @pytest.mark.parametrize(('code', 'name'), EXPECTED_LANGUAGE_NAMES)
    def test_each_known_code_names_its_language(self, code, name):
        expected = LANGUAGE_INSTRUCTION.format(name=name, code=code)
        assert prompts_module.get_response_language_instruction(code) == expected

    def test_an_unknown_code_is_used_as_its_own_name(self):
        expected = LANGUAGE_INSTRUCTION.format(name='xx', code='xx')
        assert prompts_module.get_response_language_instruction('xx') == expected

    @pytest.mark.parametrize('code', [None, '', 'en'])
    def test_english_and_absent_codes_yield_the_empty_string(self, code):
        assert prompts_module.get_response_language_instruction(code) == ''


class TestBuildersHandOverExactContexts:
    """Each builder is pinned on the exact (filename, step list, context) it
    passes to build_chain_steps: a slot renamed here is literal text in the
    prompt, not an error."""

    @pytest.fixture
    def chain(self):
        with patch.object(prompts_module, 'build_chain_steps', return_value=[]) as mocked:
            yield mocked

    def test_persona_chain(self, chain):
        get_persona_generation_steps(3, 'STATS', 'FB', 'be brief', 'es')
        chain.assert_called_once_with(
            'persona-generation.json',
            ['research_analysis', 'persona_synthesis'],
            {
                'persona_count': 3,
                'feedback_stats': 'STATS',
                'feedback_context': 'FB',
                'feedback_sample': 'FB',
                'custom_section': '\n\n## ADDITIONAL INSTRUCTIONS:\nbe brief\n',
                'previous': '{previous}',
                'response_language': 'es',
            },
        )

    def test_persona_chain_without_options(self, chain):
        get_persona_generation_steps(2, 'STATS', 'FB')
        chain.assert_called_once_with(
            'persona-generation.json',
            ['research_analysis', 'persona_synthesis'],
            {
                'persona_count': 2,
                'feedback_stats': 'STATS',
                'feedback_context': 'FB',
                'feedback_sample': 'FB',
                'custom_section': '',
                'previous': '{previous}',
                'response_language': None,
            },
        )

    def test_prd_chain(self, chain):
        get_prd_generation_steps('IDEA', 'PERSONAS', 'FB', 'fr', 'PRODUCT')
        chain.assert_called_once_with(
            'prd-generation.json',
            ['problem_analysis', 'solution_design', 'prd_document'],
            {
                'feature_idea': 'IDEA',
                'personas_context': 'PERSONAS',
                'feedback_context': 'FB',
                'product_context': 'PRODUCT',
                'previous': '{previous}',
                'response_language': 'fr',
            },
        )

    def test_prfaq_chain(self, chain):
        before = (datetime.now(UTC) + timedelta(days=90)).strftime('%Y-%m-%d')
        get_prfaq_generation_steps('IDEA', 'PERSONAS', 'FB', 'ko', 'PRODUCT')
        after = (datetime.now(UTC) + timedelta(days=90)).strftime('%Y-%m-%d')

        filename, step_names, context = chain.call_args.args
        assert filename == 'prfaq-generation.json'
        assert step_names == ['customer_thinking', 'press_release', 'customer_faq', 'internal_faq']
        launch_date = context.pop('launch_date')
        # Sampled on both sides of the call so a UTC midnight cannot flake it.
        assert launch_date in {before, after}
        assert re.fullmatch(r'\d{4}-\d{2}-\d{2}', launch_date)
        assert context == {
            'feature_idea': 'IDEA',
            'personas_context': 'PERSONAS',
            'feedback_context': 'FB',
            'product_context': 'PRODUCT',
            'previous': '{previous}',
            'response_language': 'ko',
        }

    def test_research_chain(self, chain):
        get_research_analysis_steps('Q?', 'STATS', 'FB', 50, 'ko')
        chain.assert_called_once_with(
            'research-analysis.json',
            ['data_analysis', 'synthesis', 'validation'],
            {
                'research_question': 'Q?',
                'feedback_stats': 'STATS',
                'feedback_context': 'FB',
                'feedback_count': 50,
                'previous': '{previous}',
                'response_language': 'ko',
            },
        )

    @pytest.mark.parametrize('builder', [get_prd_generation_steps, get_prfaq_generation_steps])
    def test_document_builders_default_product_context_to_the_same_sentence(self, chain, builder):
        default = inspect.signature(builder).parameters['product_context'].default
        assert default == DEFAULT_PRODUCT_CONTEXT
        builder('IDEA', 'PERSONAS', 'FB')
        assert chain.call_args.args[2]['product_context'] == DEFAULT_PRODUCT_CONTEXT


class TestCountPersonaSampleRecords:
    @staticmethod
    def _items(count: int) -> list[dict]:
        return [
            {
                'feedback_id': f'fb-{i}',
                'source_platform': 'test',
                'original_text': f'Review {i} body',
                'sentiment_label': 'neutral',
                'sentiment_score': 0.0,
                'source_created_at': '2025-01-01T00:00:00',
            }
            for i in range(count)
        ]

    def test_counts_the_records_in_the_synthesis_step_only(self):
        steps = [
            {'step_name': 'research_analysis', 'user': format_feedback_for_llm(self._items(5))},
            {'step_name': 'persona_synthesis', 'user': format_feedback_for_llm(self._items(3))},
        ]
        assert count_persona_sample_records(steps) == 3

    def test_zero_when_no_step_is_the_synthesis_step(self):
        steps = [{'step_name': 'research_analysis', 'user': format_feedback_for_llm(self._items(5))}]
        assert count_persona_sample_records(steps) == 0

    def test_zero_for_an_empty_chain(self):
        assert count_persona_sample_records([]) == 0
