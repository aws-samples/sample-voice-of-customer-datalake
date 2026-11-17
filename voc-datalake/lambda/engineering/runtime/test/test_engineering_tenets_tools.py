"""The harness's tenets tools (7.52.00, runtime/harness/tenets_tools.py): the accepted tenets read through the broker
and fenced as data, a draft written once under the agent's own keys, and the hard lock on a triage's tenets."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.runtime.harness import role_tools
from engineering.runtime.harness.tenets_tools import NONE_ACCEPTED
from engineering.runtime.harness.tools import ToolBox
from engineering.runtime.outputs import TENETS_SCHEMA
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID, opened, world

ACCEPTED = {'version': 2, 'summary': '', 'tenets': [
    {'id': 'T1', 'title': 'Fail closed', 'statement': 'An unknown state refuses.'},
    {'id': 'D5', 'title': 'Erase on request', 'statement': 'A person\'s data goes when they ask.'}]}
NONE = {'version': None, 'summary': '', 'tenets': []}
TRIAGE = {'kind': 'bug', 'severity': 'S2', 'priority': 'P2', 'summary': 'divide floors', 'paths': ['calc.py'],
          'acceptance_criteria': ['divide(7, 2) == 3.5']}


def _understander(tmp_path: Any, accepted: dict[str, Any] | None = None) -> Any:
    """The understander's session on its bundled template (7.52.00's card: the tenets tools in its tool policy)."""
    from engineering.skills.templates import bundled
    w = world(tmp_path, role='understander')
    template = bundled().skill('understander')
    assert template is not None
    w.session = type(w.session)(context=w.session.context, tools=ToolBox(w.session.context, skill=template.skill),
                                inbox=w.session.inbox, store=w.session.store)
    w.broker.pages[('tenets', 'accepted')] = json.dumps(ACCEPTED if accepted is None else accepted)
    return w


def test_only_the_understander_reads_and_writes_tenets(tmp_path: Any) -> None:
    assert role_tools.ROLE_TOOLS['read_tenets'] == role_tools.ROLE_TOOLS['write_tenets'] == frozenset({'understander'})
    for role in ('fixer', 'hunter', 'pr-author', 'coordinator', 'mapper'):
        names = {spec.name for spec in world(tmp_path / role, role=role).session.tools.specs}
        assert not names & {'read_tenets', 'write_tenets'}, role
    names = {spec.name for spec in _understander(tmp_path / 'u').session.tools.specs}
    assert {'read_tenets', 'write_tenets'} <= names


def test_the_accepted_tenets_are_read_through_the_broker_fenced_as_data(tmp_path: Any) -> None:
    w = _understander(tmp_path)
    read = w.session.tools.call('read_tenets', {})
    assert not read.error
    assert read.text.startswith(opened('tenets:v2', w.session.context.fence))
    assert '- T1: Fail closed: An unknown state refuses.' in read.text
    none = _understander(tmp_path / 'none', NONE).session.tools.call('read_tenets', {})
    assert none.text == NONE_ACCEPTED


def test_the_tenets_are_written_once_under_the_agents_own_keys(tmp_path: Any) -> None:
    w = _understander(tmp_path)
    tools = w.session.tools
    assert tools.call('write_tenets', {'tenets': []}).error
    assert tools.call('write_tenets', {'tenets': [{'id': 'bad id', 'title': 'x', 'statement': 'y'}]}).error
    written = tools.call('write_tenets', {'tenets': ACCEPTED['tenets'], 'summary': 'What the code holds to.'})
    key = json.loads(written.text)['key']
    assert key == f'ws/default/runs/{RUN_ID}/fixer-1/commits/{HARNESS_COMMIT}/_tenets/attempt-1/tenets.json'
    record = json.loads(w.store.objects[key])
    assert (record['schema'], [t['id'] for t in record['tenets']]) == (TENETS_SCHEMA, ['T1', 'D5'])
    assert key in w.session.context.result_keys
    assert tools.call('write_tenets', {'tenets': ACCEPTED['tenets']}).error   # (written once)


def test_a_triage_cites_only_accepted_tenets(tmp_path: Any) -> None:
    w = _understander(tmp_path)
    refused = w.session.tools.call('write_triage', {**TRIAGE, 'tenets': ['T1', 'T9']})
    assert refused.error
    assert 'T9 are not the repository\'s accepted tenets' in refused.text
    assert 'the accepted ones are D5, T1' in refused.text
    assert not w.store.objects
    done = w.session.tools.call('write_triage', {**TRIAGE, 'tenets': ['T1']})
    assert not done.error


def test_with_no_accepted_tenets_a_triage_cites_none(tmp_path: Any) -> None:
    w = _understander(tmp_path, NONE)
    refused = w.session.tools.call('write_triage', {**TRIAGE, 'tenets': ['T1']})
    assert refused.error
    assert 'none is accepted yet, so a triage cites none' in refused.text
    assert not w.session.tools.call('write_triage', {**TRIAGE, 'tenets': []}).error


@pytest.mark.parametrize('answer', ['not json', '{"tenets": "T1"}'])
def test_a_broker_answer_off_its_shape_never_passes_the_lock(tmp_path: Any, answer: str) -> None:
    w = _understander(tmp_path)
    w.broker.pages[('tenets', 'accepted')] = answer
    assert w.session.tools.call('write_triage', {**TRIAGE, 'tenets': ['T1']}).error
