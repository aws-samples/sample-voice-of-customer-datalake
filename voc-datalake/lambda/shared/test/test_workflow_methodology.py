"""shared/workflow_methodology.py: a valid workflow that skips a methodology step gets a warning (M3)."""
import itertools

from shared import workflow_schema
from shared.workflow_methodology import methodology_warnings


def _graph(*chain: tuple[str, str]) -> dict:
    """A linear workflow: start → each (id, type) → end."""
    nodes = [{'id': 'start', 'type': 'start'}, *({'id': i, 'type': t} for i, t in chain), {'id': 'end', 'type': 'end'}]
    ids = [n['id'] for n in nodes]
    return {'nodes': nodes, 'edges': [{'source': a, 'target': b} for a, b in itertools.pairwise(ids)]}


def _codes(definition: dict) -> list[tuple[str, str]]:
    return [(w['node_id'], w['code']) for w in methodology_warnings(definition)]


def test_a_prd_alone_skips_evidence_personas_and_the_prfaq():
    assert _codes(_graph(('prd', 'write_prd'))) == [
        ('prd', 'no_upstream_evidence'), ('prd', 'no_upstream_personas'), ('prd', 'no_upstream_prfaq'),
    ]


def test_the_methodology_path_has_no_warning():
    assert _codes(_graph(
        ('reviews', 'aggregate_reviews'), ('personas', 'generate_personas'),
        ('prfaq', 'write_prfaq'), ('prd', 'write_prd'), ('proto', 'build_prototype'),
    )) == []


def test_a_prototype_with_no_document_before_it():
    assert _codes(_graph(('proto', 'build_prototype'))) == [('proto', 'no_upstream_document')]


def test_a_step_after_the_writer_does_not_count():
    assert ('prfaq', 'no_upstream_personas') in _codes(_graph(
        ('reviews', 'aggregate_reviews'), ('prfaq', 'write_prfaq'), ('personas', 'select_personas'),
    ))


def test_the_built_in_template_has_no_warning():
    assert methodology_warnings(workflow_schema.default_template()) == []
