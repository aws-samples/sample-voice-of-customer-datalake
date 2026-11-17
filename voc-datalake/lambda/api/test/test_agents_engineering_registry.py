"""The Registry, the quality gates and the assertions (shared/agents_engineering_registry_routes.py, 7.52.00).

``GET /agents/engineering/registry`` composes every role's card on the server (its template, the skill the scope runs,
its model, tools, gates, contracts, caps, scorecard and the month's spend by role) and lists the cards made from a
skill; ``POST …/registry/cards`` makes one from an accepted skill version (201), refused for anything off its rules;
``GET …/registry/<card>`` reads one with its versions; ``GET …/gates`` the packs with their steps, messages and
briefs; ``GET …/assertions`` the vocabulary. Administrators acting for themselves only, 404 while the module is off.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import CONN, DELEGATED_ADMIN, OTHER, PERSON, WS, engineering_skills

from engineering.board.test.table import TABLE
from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillRef, SkillStore
from engineering.skills.test.fixtures import SONNET, content, stricter
from engineering.spend import MICROVM, Usage, Where, ledger_updates
from shared import agents_store as store
from shared import engineering_templates
from shared.workflow_engineering import ENGINEERING_ROLES

REGISTRY = '/agents/engineering/registry'
CARDS = f'{REGISTRY}/cards'
BODY: dict[str, Any] = {'from_skill': {'role': 'fixer', 'version': 1}, 'slug': 'python',
                        'purpose': 'Fixes Python bugs with a failing test first.', 'title': 'Python fixer'}
RUN = '01JD0000000000000000000000'
MONTH = '2026-11'


@pytest.fixture
def skills(monkeypatch: pytest.MonkeyPatch) -> Iterator[SkillStore]:
    """The tables on moto with the module on, and the shared Fixer skill's v1, accepted."""
    with engineering_skills(monkeypatch) as (_client, store):
        proposed = store.propose_version(WS, SHARED, 'fixer', content(), proposer=PERSON,
                                         reason=Reason(comment='The first Fixer skill.'), base=None)
        store.accept_version(WS, SHARED, 'fixer', proposed.version.version, PERSON)
        yield store


def _spent(skills: SkillStore, agent: str, usd: str) -> None:
    """A ledger row of the month for ``agent`` (``<role>-<n>``) of a run."""
    from boto3.dynamodb.types import TypeSerializer

    serialize = TypeSerializer().serialize
    for update in ledger_updates(TABLE, datetime(2026, 11, 13, tzinfo=UTC), Where(RUN, agent, 'wf_fix', 'example/app'),
                                 {MICROVM: Usage(usd=Decimal(usd), microvm_seconds=60)}):
        entry = dict(update['Update'])
        entry['Key'] = {key: serialize(value) for key, value in entry['Key'].items()}
        entry['ExpressionAttributeValues'] = {key: serialize(value)
                                              for key, value in entry['ExpressionAttributeValues'].items()}
        skills.client.transact_write_items(TransactItems=[{'Update': entry}])


def test_every_role_has_its_card_composed_on_the_server(lambda_context: Any, skills: SkillStore) -> None:
    _spent(skills, 'fixer-1', '1.25')
    _spent(skills, 'fixer-2', '0.50')
    _spent(skills, 'gate-runner-1', '0.10')
    status, body = _call(lambda_context, 'GET', REGISTRY, query={'month': MONTH})
    assert (status, body['month'], body['connection']) == (200, MONTH, '')
    roles = {card['id']: card for card in body['cards'] if card['kind'] == 'role'}
    # (the contract: a card whose id is the role, for every role, so a step that names only a role resolves)
    assert list(roles) == list(ENGINEERING_ROLES)
    assert [template['id'] for template in engineering_templates.bundle()['agents']] == list(ENGINEERING_ROLES)
    fixer = roles['fixer']
    # (the shared scope's heads, and what each stored connection runs: none is stored here)
    assert fixer['heads_by_connection'] == {}
    # (the scope runs the shared v1 a person accepted: its label, model and tools, not the template's)
    assert fixer['skill'] == {'source': 'store', 'label': 'fixer@1', 'connection': '', 'version': 1,
                              'status': 'accepted', 'provenance': 'person', 'template_version': 0,
                              'template_newer': True}
    assert (fixer['model'], fixer['tools']) == (SONNET, list(content().tool_policy))
    assert fixer['spend'] == {'month': MONTH, 'usd': 1.75, 'tokens_in': 0, 'tokens_out': 0, 'microvm_seconds': 120}
    assert fixer['node'] == {'type': 'agent', 'data': {'title': 'fixer', 'params': {'role': 'fixer',
                                                                                     'skill_version': 'latest'}}}
    template = next(item for item in engineering_templates.bundle()['agents'] if item['id'] == 'hunter')
    hunter = roles['hunter']
    assert (hunter['skill']['source'], hunter['skill']['label'], hunter['model']) == (
        'template', template['label'], template['model'])
    assert (hunter['caps'], hunter['inputs'], hunter['outputs']) == (template['caps'], template['inputs'],
                                                                      template['outputs'])
    # (the gate runner and the final go run the gate packs; the coach, Learn's card, is never launched)
    packs = [pack['id'] for pack in engineering_templates.bundle()['gates']['packs']]
    assert (roles['gate-runner']['gates'], roles['final-go']['gates'], fixer['gates']) == (
        {'packs': packs}, {'packs': packs}, None)
    assert roles['gate-runner']['spend']['usd'] == 0.1
    assert (roles['coach']['launchable'], roles['coach']['node']) == (False, None)
    # (the scorecards are a connection's: none for the shared scope)
    assert fixer['scorecard'] is None


def test_a_cards_skill_head_is_the_connections_or_each_connections_beside_the_shared_one(
        lambda_context: Any, skills: SkillStore) -> None:
    store.get_agents_table().put_item(Item={'pk': 'CONNECTIONS#default', 'sk': f'CONNECTION#{CONN}',
                                            'connection_id': CONN})
    store.get_agents_table().put_item(Item={'pk': 'CONNECTIONS#default', 'sk': f'CONNECTION#{OTHER}',
                                            'connection_id': OTHER, 'removed': True})
    proposed = skills.propose_version(WS, CONN, 'fixer', stricter(), proposer=PERSON, base=SkillRef(SHARED, 1),
                                      reason=Reason(comment='Stricter for the harbour.'))
    skills.accept_version(WS, CONN, 'fixer', proposed.version.version, PERSON)
    fixer = next(card for card in _call(lambda_context, 'GET', REGISTRY)[1]['cards'] if card['id'] == 'fixer')
    assert fixer['skill']['label'] == 'fixer@1'
    assert fixer['heads_by_connection'] == {CONN: {'source': 'store', 'own': True, 'label': f'fixer@{CONN}/1',
                                                   'connection': CONN, 'version': 1}}
    hunter = next(card for card in _call(lambda_context, 'GET', REGISTRY)[1]['cards'] if card['id'] == 'hunter')
    assert hunter['heads_by_connection'][CONN]['own'] is False
    status, scoped = _call(lambda_context, 'GET', f'{REGISTRY}/fixer', query={'connection': CONN})
    assert (status, scoped['card']['skill']['label'], 'heads_by_connection' in scoped['card']) == (
        200, f'fixer@{CONN}/1', False)
    assert scoped['card']['scorecard']['label'] == f'fixer@{CONN}/1'


@pytest.mark.usefixtures('skills')
def test_a_card_made_from_an_accepted_skill_version_is_listed_and_read(lambda_context: Any) -> None:
    status, made = _call(lambda_context, 'POST', CARDS, body=BODY)
    assert status == 201
    card = made['card']
    assert (card['kind'], card['id'], card['version'], card['base_role'], card['title']) == (
        'card', 'fixer-python', 1, 'fixer', 'Python fixer')
    assert (card['model'], card['skill']['label'], card['created_by']) == (SONNET, 'fixer@1', 'alice')
    assert card['node']['data']['params'] == {'role': 'fixer', 'skill_version': 'v1', 'model': SONNET,
                                              'card': 'fixer-python@v1'}
    listed = [item for item in _call(lambda_context, 'GET', REGISTRY)[1]['cards'] if item['kind'] == 'card']
    assert listed == [card]
    status, read = _call(lambda_context, 'GET', f'{REGISTRY}/fixer-python')
    assert (status, read['card'], [item['version'] for item in read['versions']]) == (200, card, [1])
    assert [(event['event'], event['by']) for event in read['events']] == [('created', 'alice')]
    # (the same slug again is refused; its next version names the one it follows)
    assert _call(lambda_context, 'POST', CARDS, body=BODY)[0] == 409
    status, second = _call(lambda_context, 'POST', CARDS, body={**BODY, 'purpose': 'Smaller fixes.',
                                                                'expected_version': 1})
    assert (status, second['card']['version'], second['card']['node']['data']['params']['card']) == (
        201, 2, 'fixer-python@v2')
    assert _call(lambda_context, 'POST', CARDS, body={**BODY, 'expected_version': 1})[0] == 409
    # (a role's own card reads too; a card the Registry has not, 404)
    status, role = _call(lambda_context, 'GET', f'{REGISTRY}/fixer')
    assert (status, role['card']['kind'], role['versions']) == (200, 'role', [])
    assert _call(lambda_context, 'GET', f'{REGISTRY}/fixer-rust')[0] == 404
    assert _call(lambda_context, 'GET', f'{REGISTRY}/Not_A_Card')[0] == 404


def test_a_card_is_refused_off_its_rules(lambda_context: Any, skills: SkillStore) -> None:
    skills.propose_version(WS, SHARED, 'fixer', content(model='global.anthropic.claude-haiku-5-5'), proposer=PERSON,
                           reason=Reason(comment='A cheaper model.'), base=None)
    refused = [
        ({**BODY, 'from_skill': {'role': 'fixer', 'version': 2}}, 409),                 # (proposed, not accepted)
        ({**BODY, 'from_skill': {'role': 'fixer', 'version': 7}}, 404),                 # (no such version)
        ({**BODY, 'from_skill': {'role': 'coach', 'version': 1}}, 400),                 # (Learn's card: no skill)
        ({**BODY, 'model': 'global.anthropic.claude-haiku-5-5'}, 400),                  # (not its skill version's)
        ({**BODY, 'caps': {'max_turns': 10_000}}, 400),                                 # (over the template's)
        ({**BODY, 'slug': 'Python'}, 400),
    ]
    for body, expected in refused:
        assert _call(lambda_context, 'POST', CARDS, body=body)[0] == expected, body
    assert [item for item in _call(lambda_context, 'GET', REGISTRY)[1]['cards'] if item['kind'] == 'card'] == []


@pytest.mark.usefixtures('skills')
def test_the_quality_gates_are_the_packs_steps_messages_and_briefs(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', '/agents/engineering/gates')
    assert status == 200
    bundled = engineering_templates.bundle()['gates']
    assert [pack['id'] for pack in body['packs']] == [pack['id'] for pack in bundled['packs']]
    python = next(pack for pack in body['packs'] if pack['id'] == 'python')
    assert (python['image'], python['briefs']) == ({'python': '3.12', 'node': '24'}, ['python-ts'])
    install = next(step for step in python['steps'] if step['id'] == 'py.install')
    # (what the gate record says when the step does not pass: the gate's own words, quality_gate/checks.py)
    assert {'status': 'timeout', 'reason': 'still running after 1200 s'} in install['messages']
    assert {'status': 'fail', 'reason': 'not run: setup step "install dependencies" failed',
            'of': 'later_steps'} in install['messages']
    briefs = {brief['id']: brief for brief in body['briefs']}
    assert set(briefs) == {'java', 'python-ts', 'rust-ts'}
    assert briefs['python-ts']['packs'] == ['python', 'typescript']
    assert briefs['java']['text'].startswith('#')
    assert briefs['java']['digest'].startswith('sha256:')
    assert (body['own_gate']['file'], body['runners']) == ('scripts/validate.sh', ['final-go', 'gate-runner'])
    # (who runs a gate that names nobody; the tools whose versions a gate records, never a version of its own)
    assert body['defaults'] == {'runner': 'gate-runner@latest', 'final_go': 'final-go@latest'}
    assert python['tools'] == next(pack for pack in bundled['packs'] if pack['id'] == 'python')['tools']
    # (each step's vacuous-pass rule in words, and the gate's stop reasons with their codes and text keys)
    with_rule = [step for pack in body['packs'] for step in pack['steps'] if step['looked_at_nothing']]
    assert with_rule
    assert all('fails' in step['looked_at_nothing'] for step in with_rule)
    assert install['looked_at_nothing'] is None
    assert [(stop['code'], stop['text_key']) for stop in body['stops']] == [
        ('check_failed', 'gates.stops.check_failed'), ('looked_at_nothing', 'gates.stops.looked_at_nothing'),
        ('own_gate_changed', 'gates.stops.own_gate_changed'), ('review_blocked', 'gates.stops.review_blocked'),
        ('rounds_used_up', 'gates.stops.rounds_used_up')]
    assert next(stop for stop in body['stops'] if stop['code'] == 'rounds_used_up')['actions'] == [
        'accept', 'another_round', 'stop']


@pytest.mark.usefixtures('skills')
def test_the_assertions_are_the_closed_vocabulary(lambda_context: Any) -> None:
    from shared.workflow_engineering import ASSERTION_ARGS

    status, body = _call(lambda_context, 'GET', '/agents/engineering/assertions')
    assert status == 200
    assert {check['check']: [arg['name'] for arg in check['args']] for check in body['checks']} == {
        check: list(args) for check, args in ASSERTION_ARGS.items()}
    posted = next(check for check in body['checks'] if check['check'] == 'tasks.posted')
    assert posted['args'] == [{'name': 'role', 'type': 'role'},
                              {'name': 'min', 'type': 'integer', 'minimum': 1, 'maximum': 100}]
    assert posted['args_schema'] == {
        'type': 'object', 'additionalProperties': False, 'required': ['role', 'min'],
        'properties': {'role': {'type': 'string', 'enum': list(ENGINEERING_ROLES)},
                       'min': {'type': 'integer', 'minimum': 1, 'maximum': 100}}}
    assert (posted['label_key'], posted['kinds'], posted['on_fail']) == (
        'assertions.checks.tasks_posted.label', ['agent', 'board'], ['block', 'warn'])
    passed = next(check for check in body['checks'] if check['check'] == 'gate.passed')
    assert (passed['kinds'], passed['on_fail']) == (['quality_gate'], ['block', 'fail_arrow', 'warn'])
    learn = next(check for check in body['checks'] if check['check'] == 'learn.proposals_name_case')
    assert learn['kinds'] == ['learn']
    assert ([choice['id'] for choice in body['on_fail']], body['default_on_fail'], body['max']) == (
        ['block', 'fail_arrow', 'warn'], 'block', 10)


PATHS = (('GET', REGISTRY), ('GET', f'{REGISTRY}/fixer'), ('POST', CARDS), ('GET', '/agents/engineering/gates'),
         ('GET', '/agents/engineering/assertions'))


@pytest.mark.usefixtures('skills')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_registry_is_an_administrators_alone(lambda_context: Any, claims: dict[str, Any]) -> None:
    for method, path in PATHS:
        assert _call(lambda_context, method, path, claims=claims, body=BODY if method == 'POST' else None)[0] == 403


@pytest.mark.usefixtures('skills')
def test_the_registry_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    for method, path in PATHS:
        assert _call(lambda_context, method, path, body=BODY if method == 'POST' else None)[0] == 404


@pytest.mark.usefixtures('skills')
def test_a_query_off_its_shape_is_a_400(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', REGISTRY, query={'month': '2026-13'})[0] == 400
    assert _call(lambda_context, 'GET', REGISTRY, query={'connection': 'Not A Connection'})[0] == 400
