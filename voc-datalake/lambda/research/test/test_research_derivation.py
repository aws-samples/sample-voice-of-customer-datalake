"""A research report records what it was built from.

The inputs are read in the initialize step and the document is written by the
save step, several Lambda invocations later, so the derivation has to travel the
state machine (asserted in lib/stacks/processing-stack-consolidated.test.ts).
These tests cover both ends and the rollout skew in between.

The fixture selects FIVE reference documents while the step consumes three, and
returns them in reverse order, so an implementation that recorded the requested
ids — or a slice of them — could not pass.
"""
import ast
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

SELECTED_IDS = ['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e']

PROJECT_ITEMS = [
    {'sk': f'PRD#{doc_id}', 'document_id': doc_id, 'title': doc_id.upper(), 'content': f'body of {doc_id}'}
    for doc_id in reversed(SELECTED_IDS)
] + [
    {'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1', 'name': 'Ana', 'tagline': 'Busy'},
]

USED_SOURCES = [
    {'document_id': 'doc_e', 'role': 'reference'},
    {'document_id': 'doc_d', 'role': 'reference'},
    {'document_id': 'doc_c', 'role': 'reference'},
]


@pytest.fixture
def mock_tables():
    mock_fb = MagicMock()
    mock_proj = MagicMock()
    mock_proj.name = 'test-projects'
    mock_proj.query.return_value = {'Items': PROJECT_ITEMS}

    def transact_write_items(*, TransactItems):
        for action in TransactItems:
            put = action.get('Put')
            if put:
                mock_proj.put_item(Item=put['Item'])
            update = action.get('Update')
            if update:
                mock_proj.update_item(
                    Key=update['Key'],
                    UpdateExpression=update['UpdateExpression'],
                    ExpressionAttributeValues=update.get(
                        'ExpressionAttributeValues', {},
                    ),
                )
        return {}

    mock_proj.meta.client.transact_write_items.side_effect = transact_write_items
    with patch('research_step_handler._get_feedback_table', return_value=mock_fb), \
         patch('research_step_handler._get_projects_table', return_value=mock_proj):
        yield {'feedback': mock_fb, 'projects': mock_proj}


@pytest.fixture
def mock_job_status():
    with patch('research_step_handler.update_job_status') as m:
        yield m


@pytest.fixture
def config():
    return {
        'question': 'What hurts most?',
        'title': 'Test Research',
        'days': 30,
        'selected_persona_ids': ['persona_1'],
        'selected_document_ids': SELECTED_IDS,
    }


class TestInitializeRecordsInputs:
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='formatted feedback')
    @patch('research_step_handler.get_feedback_statistics', return_value='stats')
    def _run(self, mock_stats, mock_format, mock_get_fb, config=None, feedback_count=7):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = [{'original_text': f'review {i}'} for i in range(feedback_count)]
        return step_initialize({
            'project_id': 'proj_1', 'job_id': 'job_1', 'research_config': config,
        })

    def test_records_the_three_documents_used_not_the_five_selected(
        self, mock_tables, mock_job_status, config,
    ):
        result = self._run(config=config)

        assert result['derivation']['sources'] == USED_SOURCES
        assert result['derivation']['selected_document_count'] == 5

    def test_records_the_feedback_and_personas_used(self, mock_tables, mock_job_status, config):
        result = self._run(config=config)

        assert result['derivation']['feedback_count'] == 7
        assert result['derivation']['persona_ids'] == ['persona_1']

    def test_always_returns_a_derivation_even_when_nothing_was_selected(
        self, mock_tables, mock_job_status,
    ):
        """The state machine's resultSelector references the key unconditionally,
        so an absent key would fail the whole execution."""
        result = self._run(config={'question': 'Q', 'days': 30}, feedback_count=2)

        assert result['derivation'] == {
            'sources': [],
            'selected_document_count': 0,
            'feedback_count': 2,
            'persona_ids': [],
            'visual_document_ids': [],
            'product_context_included': False,
        }


class TestEveryExitCarriesTheDerivation:
    """Structural, not behavioural: EVERY return out of step_initialize must
    carry the key, not just the ones a test happens to drive.

    The state machine's resultSelector references `$.Payload.derivation`
    unconditionally, and a JSONPath miss there raises `States.Runtime` — which a
    `States.ALL` catch does NOT intercept. So a future early return that omits
    the key would fail OUTSIDE the error handler and leave the job stuck at
    `running` rather than `failed`: no report, no failure, no diagnosis. Reading
    the function's returns out of its AST is the only check that covers the paths
    nobody has written yet.
    """

    @staticmethod
    def _step_initialize() -> ast.FunctionDef:
        # lambda/research/test/ -> lambda/research/
        source = (Path(__file__).resolve().parents[1] / 'research_step_handler.py').read_text(encoding='utf-8')
        functions = [
            node for node in ast.walk(ast.parse(source))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'step_initialize'
        ]
        assert len(functions) == 1, f'Expected one step_initialize; found {len(functions)}.'
        return functions[0]

    def test_it_contains_no_nested_function_whose_returns_this_test_would_miss(self):
        """Guards the guard: `ast.walk` would collect a nested function's returns
        as if they were the step's own, so this test only means what it says
        while there is no nested function."""
        fn = self._step_initialize()
        nested = [
            node.name for node in ast.walk(fn)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node is not fn
        ]
        assert nested == [], (
            f'step_initialize now defines nested function(s) {nested}. Scope the '
            f'return collection below to the step body before trusting it again.'
        )

    def test_every_return_is_a_dict_literal_declaring_derivation(self):
        returns = [node for node in ast.walk(self._step_initialize()) if isinstance(node, ast.Return)]
        assert returns, 'step_initialize has no return statement at all.'

        for node in returns:
            assert isinstance(node.value, ast.Dict), (
                f'The return at research_step_handler.py:{node.lineno} is not a dict '
                f'literal, so this test can no longer tell whether it declares '
                f'derivation. Keep the returns literal, or assert the key another way.'
            )
            keys = [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
            assert 'derivation' in keys, (
                f"The return at research_step_handler.py:{node.lineno} omits "
                f"'derivation'. The state machine's resultSelector references "
                f"$.Payload.derivation unconditionally and a JSONPath miss raises "
                f"States.Runtime, which the States.ALL catch does not intercept — "
                f"the execution would die outside handleError, leaving the job at "
                f"'running'. Add the key (build_derivation() is the empty value)."
            )


class TestSaveWritesDerivation:
    def _save(self, mock_tables, event_extra):
        from research_step_handler import step_save
        step_save({
            'project_id': 'proj_1',
            'job_id': 'job_1',
            'research_config': {'question': 'Q', 'title': 'T'},
            'feedback_count': 7,
            'analysis': 'A',
            'synthesis': 'S',
            'validation': 'V',
            **event_extra,
        })
        return mock_tables['projects'].put_item.call_args.kwargs['Item']

    def test_persists_the_derivation_it_was_handed(self, mock_tables, mock_job_status):
        derivation = {
            'sources': USED_SOURCES,
            'selected_document_count': 5,
            'feedback_count': 7,
            'persona_ids': ['persona_1'],
            'product_context_included': False,
        }

        item = self._save(mock_tables, {'derivation': derivation})

        assert item['derivation'] == derivation

    def test_an_execution_pinned_to_the_previous_definition_still_saves(
        self, mock_tables, mock_job_status,
    ):
        """In-flight executions keep the state machine definition they started
        with, which does not forward the derivation. That must read as "no
        lineage" rather than failing the save."""
        item = self._save(mock_tables, {})

        assert item['derivation'] == {
            'sources': [],
            'selected_document_count': 0,
            'feedback_count': 0,
            'persona_ids': [],
            'visual_document_ids': [],
            'product_context_included': False,
        }
        # The report itself is unaffected.
        assert item['document_type'] == 'research'
        assert item['feedback_count'] == 7
