"""The six default engineering flows (shared/engineering_flow_templates.json): each valid under the server's own rules,
each as the validator keeps it, none able to merge, and every flow that pushes code ending at a stop at PR."""
from __future__ import annotations

from typing import Any

import pytest

from shared import engineering_templates, workflow_engineering
from shared.workflow_schema import MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, SCHEMA_V2, V2_NODE_TYPES, validate_definition

TEMPLATES = engineering_templates.list_templates()
IDS = [template['template_id'] for template in TEMPLATES]


def _by_id(template_id: str) -> dict[str, Any]:
    return next(template for template in TEMPLATES if template['template_id'] == template_id)


def _types(template_id: str) -> list[str]:
    return [node['type'] for node in _by_id(template_id)['definition']['nodes']]


def _ends(definition: dict[str, Any]) -> list[tuple[str, str | None]]:
    """Each way the flow ends: a stop at PR, or an end with its status."""
    return [(node['type'], node['data']['params'].get('status')) for node in definition['nodes']
            if node['type'] in ('end', workflow_engineering.NODE_STOP_AT_PR)]


def test_the_six_default_flows_in_the_docs_order() -> None:
    assert IDS == ['understand-repository', 'issue-triage', 'bug-hunt-and-fix', 'feature', 'pr-review',
                   'self-improvement']
    assert [template['name'] for template in TEMPLATES] == [
        'Understand the repository', 'Issue triage', 'Bug hunt and fix', 'Feature from an issue or a PRD',
        'PR review', 'Self-improvement']


@pytest.mark.parametrize('template_id', IDS)
def test_each_template_is_valid_and_kept_as_written(template_id: str) -> None:
    template = _by_id(template_id)
    definition = template['definition']
    result = validate_definition(definition)
    assert result.valid, result.to_dict()
    # Nothing is normalised away: what the editor opens is what the server saves.
    assert result.definition == definition
    assert definition['schema'] == SCHEMA_V2
    assert (definition['name'], definition['description']) == (template['name'], template['description'])
    assert 0 < len(template['name']) <= MAX_NAME_CHARS
    assert 0 < len(template['description']) <= MAX_DESCRIPTION_CHARS
    assert '\n' not in template['description']   # one line


@pytest.mark.parametrize('template_id', IDS)
def test_no_template_merges_and_a_pushing_flow_stops_at_a_pr_or_a_person(template_id: str) -> None:
    definition = _by_id(template_id)['definition']
    # The guarantee is structural: every step is an engineering flow's own, and there is no merge step to take
    # (an agent's instructions are guidance, not a rule, so no text check stands in for this).
    assert all(node['type'] in V2_NODE_TYPES for node in definition['nodes'])
    pushes = any((node['type'] == 'agent' and node['data']['params'].get('role') in workflow_engineering.PUSHING_ROLES)
                 or (node['type'] == 'board'
                     and workflow_engineering.PUSHING_ROLES & set(node['data']['params'].get('claimers', ())))
                 for node in definition['nodes'])
    ends = _ends(definition)
    if pushes:
        assert set(ends) <= {('stop_at_pr', None), ('end', 'needs_human')}
        assert ('stop_at_pr', None) in ends
    else:
        assert ('stop_at_pr', None) not in ends


@pytest.mark.parametrize(('template_id', 'ends'), [
    ('understand-repository', [('end', 'needs_human')]),
    ('issue-triage', [('end', 'completed')]),
    ('bug-hunt-and-fix', [('stop_at_pr', None), ('end', 'needs_human')]),
    ('feature', [('stop_at_pr', None), ('end', 'needs_human')]),
    ('pr-review', [('end', 'completed')]),
    ('self-improvement', [('end', 'needs_human')]),
])
def test_each_flow_stops_where_the_docs_say(template_id: str, ends: list[tuple[str, str | None]]) -> None:
    assert _ends(_by_id(template_id)['definition']) == ends


def test_the_steps_the_docs_name() -> None:
    assert {'map', 'reduce', 'memory'} <= set(_types('understand-repository'))
    assert {'map', 'reduce'} <= set(_types('pr-review'))
    assert 'quality_gate' in _types('bug-hunt-and-fix')
    assert 'quality_gate' in _types('feature')
    assert 'self_improvement' in _types('self-improvement')


def test_each_pr_author_says_what_its_own_flow_made() -> None:
    """Bug hunt's PR describes the bug and its fix; Feature's what was built from what, and the steps it skipped."""
    said = {template_id: next(node['data']['instructions'] for node in _by_id(template_id)['definition']['nodes']
                              if node['data']['params'].get('role') == 'pr-author')
            for template_id in ('bug-hunt-and-fix', 'feature')}
    assert 'the bug it fixes' in said['bug-hunt-and-fix']
    assert 'the issue or the PRD' in said['feature']
    assert said['bug-hunt-and-fix'] != said['feature']


def test_a_list_is_a_copy() -> None:
    first = engineering_templates.list_templates()
    first[0]['definition']['name'] = 'Changed'
    assert engineering_templates.list_templates()[0]['definition']['name'] == 'Understand the repository'
