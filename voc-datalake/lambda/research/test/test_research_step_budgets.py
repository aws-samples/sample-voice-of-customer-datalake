"""The async research path must take its budgets and system prompts from the
shared prompt config, not from inlined copies.

Background: research-analysis.json declared max_tokens 9000 per step while this
Lambda hardcoded 4000/3000/3000 and duplicated the system prompts, so editing
the config had no effect on the async Step Functions path — it looked
authoritative but was never read. These tests fail if that decoy returns.

The expected values are read from the JSON with a plain json.load rather than
through shared.prompts, so the config is an INDEPENDENT oracle: a bug in the
loader can't make the handler and the expectation drift together.
"""
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# lambda/research/test/ -> lambda/
LAMBDA_DIR = Path(__file__).resolve().parents[2]
RESEARCH_PROMPTS = LAMBDA_DIR / 'api' / 'prompts' / 'research-analysis.json'

# The budgets this Lambda used to hardcode. Kept as explicit literals (not read
# from anywhere) so re-introducing them fails loudly, while still leaving the
# config free to be re-tuned above them.
PRE_FIX_ANALYSIS_BUDGET = 4000
PRE_FIX_SYNTHESIS_BUDGET = 3000
PRE_FIX_VALIDATION_BUDGET = 3000


def _step(step_name: str) -> dict:
    return json.loads(RESEARCH_PROMPTS.read_text(encoding='utf-8'))['steps'][step_name]


@pytest.fixture
def mock_tables():
    mock_fb = MagicMock()
    mock_proj = MagicMock()
    with patch('research_step_handler._get_feedback_table', return_value=mock_fb), \
         patch('research_step_handler._get_projects_table', return_value=mock_proj):
        yield {'feedback': mock_fb, 'projects': mock_proj}


@pytest.fixture
def mock_job_status():
    with patch('research_step_handler.update_job_status') as m:
        yield m


@pytest.fixture
def mock_converse():
    with patch('research_step_handler.converse', return_value='result') as m:
        yield m


def _analyze_event(**config):
    return {
        'project_id': 'p1', 'job_id': 'j1',
        'research_config': {'question': 'Q?', **config},
        'feedback_context': 'fb', 'feedback_stats': 's',
    }


def _synthesize_event(**config):
    return {
        'project_id': 'p1', 'job_id': 'j1',
        'research_config': {'question': 'Q?', **config},
        'analysis': 'prior analysis',
    }


def _validate_event(**config):
    return {
        'project_id': 'p1', 'job_id': 'j1',
        'research_config': {'question': 'Q?', **config},
        'analysis': 'prior analysis', 'synthesis': 'prior synthesis',
    }


class TestBudgetsComeFromConfig:
    """Each step's max_tokens must equal what the shared config declares."""

    def test_analysis_uses_the_configured_budget(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(_analyze_event())
        assert mock_converse.call_args.kwargs['max_tokens'] == _step('data_analysis')['max_tokens']

    def test_synthesis_uses_the_configured_budget(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_synthesize

        step_synthesize(_synthesize_event())
        assert mock_converse.call_args.kwargs['max_tokens'] == _step('synthesis')['max_tokens']

    def test_validation_uses_the_configured_budget(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_validate

        step_validate(_validate_event())
        assert mock_converse.call_args.kwargs['max_tokens'] == _step('validation')['max_tokens']

    def test_each_step_identifies_itself_in_bedrock_logs(self, mock_tables, mock_job_status, mock_converse):
        """converse() logs step_name; all three research steps used to log
        'unknown', so live logs could not tell which step made a call.
        (Raised in review of PR #228.)"""
        from research_step_handler import step_analyze, step_synthesize, step_validate

        step_analyze(_analyze_event())
        assert mock_converse.call_args.kwargs['step_name'] == 'data_analysis'

        step_synthesize(_synthesize_event())
        assert mock_converse.call_args.kwargs['step_name'] == 'synthesis'

        step_validate(_validate_event())
        assert mock_converse.call_args.kwargs['step_name'] == 'validation'

    def test_step_name_matches_the_sync_chain_for_the_same_step(self, mock_tables, mock_job_status, mock_converse):
        """Both research paths must report the SAME step name to Bedrock.

        The sync path resolves it from the config's 'name' field; this path used
        the raw dict key, so a config where the two differ would emit different
        labels for the same step and defeat the purpose. (Raised in review of
        PR #228.)
        """
        from research_step_handler import step_analyze

        step_analyze(_analyze_event())
        emitted = mock_converse.call_args.kwargs['step_name']
        assert emitted == _step('data_analysis').get('name', 'data_analysis')

    def test_configured_thinking_budget_reaches_bedrock(self, mock_tables, mock_job_status, mock_converse):
        """data_analysis declares a thinking budget; it must be forwarded.

        converse() drops it for adaptive-thinking models on its own, so passing
        it is safe — but silently discarding it here would make the config lie.
        """
        from research_step_handler import step_analyze

        step_analyze(_analyze_event())
        assert mock_converse.call_args.kwargs['thinking_budget'] == _step('data_analysis')['thinking_budget']


class TestBudgetsDoNotRegressToTheOldHardcodes:
    """Fail-on-revert: the point of the change was to stop running the research
    chain on budgets small enough to force continuation loops and empty-text
    retries. Asserted as a floor, so re-tuning the config stays possible."""

    def test_analysis_budget_exceeds_the_old_hardcode(self):
        assert _step('data_analysis')['max_tokens'] > PRE_FIX_ANALYSIS_BUDGET

    def test_synthesis_budget_exceeds_the_old_hardcode(self):
        assert _step('synthesis')['max_tokens'] > PRE_FIX_SYNTHESIS_BUDGET

    def test_validation_budget_exceeds_the_old_hardcode(self):
        assert _step('validation')['max_tokens'] > PRE_FIX_VALIDATION_BUDGET


class TestSystemPromptsComeFromConfig:
    """The system prompts were duplicated between this module and the config.
    Pin them to the config so the two paths can't drift."""

    def test_analysis_system_prompt_matches_config(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(_analyze_event())
        assert mock_converse.call_args.kwargs['system_prompt'] == _step('data_analysis')['system_prompt']

    def test_synthesis_system_prompt_matches_config(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_synthesize

        step_synthesize(_synthesize_event())
        assert mock_converse.call_args.kwargs['system_prompt'] == _step('synthesis')['system_prompt']

    def test_validation_system_prompt_matches_config(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_validate

        step_validate(_validate_event())
        assert mock_converse.call_args.kwargs['system_prompt'] == _step('validation')['system_prompt']


class TestLanguageInstructionStillApplies:
    """Sourcing the prompt from config must not drop the per-request language
    instruction, which is appended on top of it."""

    def test_analysis_appends_language_instruction(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(_analyze_event(response_language='es'))
        system_prompt = mock_converse.call_args.kwargs['system_prompt']
        assert system_prompt.startswith(_step('data_analysis')['system_prompt'])
        assert 'Spanish' in system_prompt

    def test_synthesis_appends_language_instruction(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_synthesize

        step_synthesize(_synthesize_event(response_language='ko'))
        assert 'Korean' in mock_converse.call_args.kwargs['system_prompt']

    def test_validation_appends_language_instruction(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_validate

        step_validate(_validate_event(response_language='ja'))
        assert 'Japanese' in mock_converse.call_args.kwargs['system_prompt']

    def test_no_language_leaves_the_config_prompt_untouched(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(_analyze_event())
        assert mock_converse.call_args.kwargs['system_prompt'] == _step('data_analysis')['system_prompt']
