"""An imported custom model's id is an ARN that names the account (7.65.00, shared/custom_models.py): what every
reader of a row sees stores its registry key instead (S2, 7.71.00). A persona's and a revised document's
``llm_metadata.model``; the form Report's summary and the assistant's RUN_FINISHED usage have their own tests
(api/test/test_settings_form_reports.py, shared/test/test_forms_v2_report.py, the stream's helpers spec)."""
from datetime import UTC, datetime

import pytest

import projects
from shared import document_revision
from shared.custom_models import CUSTOM_MODELS_ENV, stored_id
from shared.test.repo_paths import repo_root

#: The CDK specs' registry: `mine` is an imported model, `nova` a Bedrock one (lib/test-support/custom-models-env.json).
REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
IMPORTED_ARN = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'
NOVA = 'amazon.nova-pro-v1:0'


@pytest.fixture(autouse=True)
def _registry(monkeypatch):
    monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)


def test_an_imported_model_is_stored_by_its_key_and_any_other_by_its_id():
    assert [stored_id(IMPORTED_ARN), stored_id(NOVA), stored_id('global.anthropic.claude-sonnet-5-5')] == [
        'mine', NOVA, 'global.anthropic.claude-sonnet-5-5']


def test_a_generated_persona_names_an_imported_model_by_its_key():
    [(_pid, _persona, item)] = projects._build_persona_items(
        'proj-1', [{'name': 'Ada Moreno'}], [{'feedback_id': 'fb-1', 'source_platform': 'web'}],
        persona_count=1, source_breakdown={'web': 1}, llm_time=1, now_dt=datetime(2026, 11, 22, tzinfo=UTC),
        model_id=IMPORTED_ARN, date_basis='imported', input_ids=['fb-1'], items_seen=1,
    )
    assert item['llm_metadata']['model'] == 'mine'
    assert '111111111111' not in repr(item)


def test_a_revised_document_names_an_imported_model_by_its_key():
    assert document_revision.pass_llm_metadata(IMPORTED_ARN) == {
        'model': 'mine', 'prompt_version': document_revision.REVISE_PROMPT_VERSION}
