"""Readiness (engineering/readiness.py): each check's pass, fail and unknown, and what Enable's gate reads."""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from engineering.readiness import (
    CHECK_IDS,
    LEARN,
    REQUIRED,
    Check,
    PreviewRefused,
    ReadFailed,
    SandboxSeen,
    Settings,
    Subject,
    evaluate,
    flow_models,
    flow_requires,
    flow_roles,
    mode_names,
    preview,
)

SONNET, HAIKU, OPUS = ('global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
                       'global.anthropic.claude-opus-5-5')
CARDS = {'coordinator': SONNET, 'hunter': SONNET, 'fixer': SONNET, 'committer': SONNET, 'pr-author': SONNET,
         'commit-reviewer': SONNET, 'gate-runner': HAIKU, 'final-go': OPUS, 'understander': HAIKU}
REPOSITORY = 'example-org/shop'
ROW = {'connection_id': 'shop', 'host': 'github', 'repository': REPOSITORY, 'credential_kind': 'app_reference',
       'app_id': '123', 'installation_id': '456'}


def node(kind: str, **params: Any) -> dict[str, Any]:
    return {'id': kind, 'type': kind, 'data': {'title': kind, 'params': params}}


#: A bug flow: a hunter, a board of fixers, the gate, the committer and the PR author, and Learn on Sonnet.
BUG_FLOW = {'schema': 'voc-workflow/2', 'budget': {'monthly_usd': 50}, 'nodes': [
    node('start', learn={'enabled': True, 'model': SONNET}), node('agent', role='hunter'),
    node('board', posters=['hunter'], claimers=['fixer', 'commit-reviewer']), node('quality_gate'),
    node('agent', role='committer'), node('agent', role='pr-author', model=HAIKU), node('stop_at_pr')]}
TRIAGE_FLOW = {'schema': 'voc-workflow/2', 'nodes': [node('start', learn={'enabled': False}),
                                                     node('agent', role='understander')]}
#: What the live runtime's first 7.50.03 session would record (the probe of 2026-11-17).
NAMESPACES_SEEN = SandboxSeen('namespaces', 'namespaces', ('own_device', 'protected_hardlinks'), '2026-11-17T12:00:00Z')


@dataclass
class Ports:
    """Every port answering ready, each overridable; a value that is an exception is raised."""

    rows: dict[str, Any] = field(default_factory=lambda: {'shop': ROW})
    covered: Any = (frozenset({REPOSITORY}), False)
    attestation: Any = True
    protection: Any = None
    pack: Any = 3
    rendering: Any = 0
    tenets: Any = 0
    issues: Any = True
    #: Whether the Issues source's settings name the repository (7.50.02); None: not deployed here.
    lists: Any = None
    #: The connection's recorded label state (7.50.02: '' none).
    label: Any = ''
    modes: dict[str, Any] = field(default_factory=lambda: {'admin-sub': 'ai_driven'})
    hard_cap: Any = True
    spent: Any = Decimal('12.5')
    access: Any = None
    quota: Any = 5000.0
    probe: Any = True
    walls: Any = field(default_factory=lambda: NAMESPACES_SEEN)
    #: The Kiro key parameter's type (7.53.00; None: not stored).
    kiro: Any = 'SecureString'
    #: A fork's parent on GitHub (7.57.00; '' no fork, None no repository) and whether its owner authorized the App.
    parent: Any = 'upstream-org/shop'
    authorized: Any = True
    asked: list[str] = field(default_factory=list)

    @staticmethod
    def _answer(value: Any) -> Any:
        if isinstance(value, Exception):
            raise value
        return value

    def connection(self, connection_id: str) -> Mapping[str, Any] | None:
        return self._answer(self.rows.get(connection_id))

    def installation_repositories(self, connection: Mapping[str, Any]) -> Any:
        del connection
        return self._answer(self.covered)

    def attested(self, connection_id: str, repository: str) -> bool:
        self.asked.append(f'attested {connection_id} {repository}')
        return self._answer(self.attestation)

    def ci_protection(self, connection: Mapping[str, Any]) -> Any:
        del connection
        return self._answer(self.protection)

    def knowledge_approved(self, connection_id: str) -> int:
        del connection_id
        return self._answer(self.pack)

    def knowledge_rendering(self, connection_id: str) -> int:
        del connection_id
        return self._answer(self.rendering)

    def tenets_accepted(self, connection_id: str) -> int:
        del connection_id
        return self._answer(self.tenets)

    def issues_source_reads(self, repository: str) -> bool:
        self.asked.append(f'issues {repository}')
        return self._answer(self.issues)

    def issues_source_lists(self, repository: str) -> bool | None:
        self.asked.append(f'lists {repository}')
        return self._answer(self.lists)

    def label_state(self, connection_id: str) -> str:
        self.asked.append(f'label {connection_id}')
        return self._answer(self.label)

    def mode(self, person: str) -> str:
        return self._answer(self.modes.get(person, ''))   # ('': nothing saved, connectors/dial.py NOT_SET)

    def hard_cap_on(self) -> bool:
        return self._answer(self.hard_cap)

    def month_spend_usd(self, workflow_id: str) -> Decimal:
        self.asked.append(f'spend {workflow_id}')
        return self._answer(self.spent)

    def models_access(self, model_ids: list[str]) -> Mapping[str, str]:
        self.asked.append(f'models {",".join(model_ids)}')
        answer = self._answer(self.access)
        return dict.fromkeys(model_ids, 'available') if answer is None else answer

    def session_quota(self) -> float:
        return self._answer(self.quota)

    def probe_storage(self) -> bool:
        return self._answer(self.probe)

    def sandbox_walls(self, language: str) -> SandboxSeen | None:
        self.asked.append(f'walls {language}')
        return self._answer(self.walls)

    def kiro_key(self, parameter: str) -> str | None:
        del parameter
        return self._answer(self.kiro)

    def fork_parent(self, connection: Mapping[str, Any]) -> str | None:
        self.asked.append(f'parent {connection.get("repository")}')
        return self._answer(self.parent)

    def user_authorized(self, app_id: str, subject: str) -> bool:
        self.asked.append(f'authorized {app_id} {subject}')
        return self._answer(self.authorized)


SETTINGS =Settings(image_languages=frozenset({'python', 'node'}), network=True, build_memory_mib=0,
                    region='us-west-2', max_sessions=5000, card_models=CARDS)
SUBJECT = Subject(kind='automation', id='agent_1', name='Bug fixer', definition=BUG_FLOW, person='admin-sub',
                  requires=flow_requires(BUG_FLOW), workflow_id='wf_1', connection='shop', language='python',
                  budget_usd=Decimal(50), trigger={'kind': 'github_issue', 'label': 'voc-agent'})


def checks(subject: Subject = SUBJECT, ports: Ports | None = None, settings: Settings = SETTINGS) -> dict[str, Check]:
    report = evaluate(subject, ports or Ports(), settings)
    assert tuple(check.id for check in report.checks) == CHECK_IDS
    return {check.id: check for check in report.checks}


def test_a_set_up_agent_is_ready_and_every_check_answers_its_shape() -> None:
    report = evaluate(SUBJECT, Ports(), SETTINGS)
    assert report.ready
    assert report.failing == ()
    view = report.view()
    assert view['ready'] is True
    assert view['subject'] == {'kind': 'automation', 'id': 'agent_1', 'name': 'Bug fixer', 'connection': 'shop',
                               'language': 'python'}
    for check in view['checks']:
        assert set(check) == {'id', 'status', 'detail', 'fix', 'docs', 'required'}
        assert check['status'] in ('pass', 'fail', 'warn', 'unknown')
        assert check['required'] is (check['id'] in REQUIRED)
    statuses = {check['id']: check['status'] for check in view['checks']}
    # Not read from here: the branch rules (the broker's, with the connection's token) and the label.
    assert (statuses['ci_protection'], statuses['issue_label']) == ('unknown', 'unknown')
    assert all(status == 'pass' for check_id, status in statuses.items()
               if check_id not in ('ci_protection', 'issue_label'))


def test_the_required_checks_are_the_owners_list() -> None:
    owners = frozenset({'connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial'})
    assert owners == REQUIRED
    assert set(CHECK_IDS) >= REQUIRED


def test_only_asks_just_the_checks_named() -> None:
    ports = Ports()
    report = evaluate(SUBJECT, ports, SETTINGS, REQUIRED)
    assert [check.id for check in report.checks] == [check_id for check_id in CHECK_IDS if check_id in REQUIRED]
    assert not any(asked.startswith(('issues', 'spend')) for asked in ports.asked)


@pytest.mark.parametrize(('change', 'reason'), [
    ({'connection': ''}, 'No repository connection is named'),
    ({'connection': 'gone'}, 'is not stored'),
])
def test_a_connection_not_named_or_not_stored_fails_and_blocks(change: dict[str, Any], reason: str) -> None:
    found = checks(replace(SUBJECT, **change))
    assert found['connection'].status == 'fail'
    assert reason in found['connection'].detail
    assert found['connection'].blocking
    assert found['ci_attestation'].status == 'fail'


def test_a_connection_read_that_fails_is_unknown_and_still_blocks() -> None:
    found = checks(ports=Ports(rows={'shop': ReadFailed('throttled')}))
    assert found['connection'].status == 'unknown'
    assert 'throttled' in found['connection'].detail
    assert found['connection'].blocking   # (never assumed ready)


@pytest.mark.parametrize(('covered', 'status'), [
    ((frozenset({'Example-Org/Shop'}), False), 'pass'),
    ((frozenset({'example-org/other'}), False), 'fail'),
    ((frozenset({'example-org/other'}), True), 'unknown'),
    (None, 'unknown'),
    (ReadFailed('busy'), 'unknown'),
])
def test_the_app_installation_must_cover_the_repository(covered: Any, status: str) -> None:
    assert checks(ports=Ports(covered=covered))['app_installation'].status == status


def test_a_gitlab_connection_has_no_app_installation_to_check() -> None:
    found = checks(ports=Ports(rows={'shop': {**ROW, 'host': 'gitlab'}}))
    assert found['app_installation'].status == 'pass'
    assert found['app_installation'].detail.startswith('Not needed')


def test_the_ci_attestation_holds_or_blocks_and_a_flow_that_pushes_nothing_needs_none() -> None:
    assert checks(ports=Ports(attestation=False))['ci_attestation'].blocking
    assert checks(ports=Ports(attestation=ReadFailed('x')))['ci_attestation'].status == 'unknown'
    triage = replace(SUBJECT, definition=TRIAGE_FLOW, requires=flow_requires(TRIAGE_FLOW))
    ports = Ports(attestation=False)
    found = checks(triage, ports)
    assert found['ci_attestation'].status == 'pass'
    assert not any(asked.startswith('attested') for asked in ports.asked)


@pytest.mark.parametrize(('protection', 'status'), [(True, 'pass'), (False, 'fail'), (None, 'unknown')])
def test_the_branch_rules_when_a_reader_is_wired(protection: Any, status: str) -> None:
    assert checks(ports=Ports(protection=protection))['ci_protection'].status == status


def test_an_image_for_the_language() -> None:
    assert checks(replace(SUBJECT, language='rust'))['image'].status == 'fail'
    assert 'python' in checks(replace(SUBJECT, language='rust'))['image'].detail
    assert checks(replace(SUBJECT, language=''))['image'].blocking


def test_the_pack_and_tenets_only_where_the_flow_requires_them() -> None:
    assert checks()['pack'].detail.startswith('Not needed')
    asks = replace(SUBJECT, requires={**SUBJECT.requires, 'knowledge_pack': True, 'tenets': True})
    assert checks(asks)['pack'].status == 'pass'
    assert checks(asks, Ports(pack=0))['pack'].status == 'fail'
    assert checks(asks, Ports(pack=ReadFailed('x')))['pack'].status == 'unknown'
    assert checks(asks)['tenets'].status == 'warn'
    assert not checks(asks, Ports(pack=0))['pack'].blocking   # (advice: Enable is not refused for it)


def test_the_tenets_and_the_docs_read_their_stores() -> None:
    """7.52.00: the accepted tenets version passes, none warns (a triage cites none), an unreadable store is
    unknown; never blocking. The pack names its docs' rendering once there is one."""
    asks = replace(SUBJECT, requires={**SUBJECT.requires, 'knowledge_pack': True, 'tenets': True})
    accepted = checks(asks, Ports(tenets=2))['tenets']
    assert (accepted.status, accepted.detail) == ('pass', 'Tenets version 2 is accepted: a triage cites its ids.')
    none = checks(asks)['tenets']
    assert none.status == 'warn'
    assert 'cites none' in none.detail
    assert not none.blocking
    assert checks(asks, Ports(tenets=ReadFailed('x')))['tenets'].status == 'unknown'
    assert 'rendering 4' in checks(asks, Ports(rendering=4))['pack'].detail
    assert 'rendering' not in checks(asks)['pack'].detail


def test_the_issues_source_and_label_for_an_issue_trigger() -> None:
    ports = Ports(issues=False)
    found = checks(ports=ports)
    assert found['issues_source'].status == 'fail'
    assert f'issues {REPOSITORY}' in ports.asked
    assert checks(ports=Ports(issues=ReadFailed('x')))['issues_source'].status == 'unknown'
    no_trigger = replace(SUBJECT, trigger=None)
    assert checks(no_trigger)['issues_source'].detail.startswith('Not needed')
    assert checks(no_trigger)['issue_label'].detail.startswith('Not needed')
    unlabelled = replace(SUBJECT, trigger={'kind': 'github_issue', 'label': ''})
    assert checks(unlabelled)['issue_label'].status == 'fail'
    private = Ports(rows={'shop': {**ROW, 'repository_private': True}})
    assert checks(unlabelled, private)['issue_label'].status == 'warn'
    # A flow that requires the Issues source checks it with no trigger too.
    asks = replace(no_trigger, requires={**SUBJECT.requires, 'issues_source': True})
    assert checks(asks, Ports(issues=False))['issues_source'].status == 'fail'


def test_the_dial_reads_the_stored_mode_and_tells_nothing_saved_from_human_driven() -> None:
    found = checks(ports=Ports(modes={}))
    assert found['dial'].status == 'fail'
    assert found['dial'].detail.startswith('Not set yet: choose AI-assisted or AI-driven for the administrator who '
                                           'enables the agent.')
    assert found['dial'].blocking
    human = checks(ports=Ports(modes={'admin-sub': 'human_driven'}))['dial']
    assert (human.status, 'Human-driven' in human.detail, human.detail.startswith('Not set')) == ('fail', True, False)
    assert checks(ports=Ports(modes={'admin-sub': 'ai_assisted'}))['dial'].status == 'pass'
    assert checks(ports=Ports(modes={'admin-sub': 'ai_driven'}))['dial'].status == 'pass'
    assert checks(replace(SUBJECT, person=''))['dial'].status == 'fail'
    assert checks(ports=Ports(modes={'admin-sub': ReadFailed('x')}))['dial'].status == 'unknown'
    # A flow that runs Human-driven (triage pushes nothing) passes with no stored mode, and with Human-driven saved.
    triage = replace(SUBJECT, definition=TRIAGE_FLOW, requires=flow_requires(TRIAGE_FLOW))
    assert checks(triage, Ports(modes={}))['dial'].status == 'pass'
    assert checks(triage, Ports(modes={'admin-sub': 'human_driven'}))['dial'].status == 'pass'
    declared = replace(SUBJECT, requires={'dial': ['ai_driven']})
    assert checks(declared, Ports(modes={'admin-sub': 'ai_assisted'}))['dial'].status == 'fail'
    assert checks(declared, Ports(modes={}))['dial'].detail.startswith('Not set yet: choose AI-driven for ')


def test_the_dial_says_who_the_runs_follow_and_each_way_of_working_by_its_name() -> None:
    named = replace(SUBJECT, person_name='alice')
    found = checks(named, Ports(modes={'admin-sub': 'human_driven'}))['dial']
    assert found.detail == ('The runs follow alice, whose way of working is Human-driven, so a run would push nothing. '
                            'This flow needs AI-assisted or AI-driven.')
    assert found.fix == ('An administrator sets the way of working of alice to AI-assisted or AI-driven in '
                         'Administration → People (/admin/people); with AI-assisted, each push '
                         'waits for a person\'s go on the run.')
    unset = checks(named, Ports(modes={}))['dial']
    assert unset.detail == ('Not set yet: choose AI-assisted or AI-driven for alice. With nothing saved, a run pushes '
                            'nothing (documents default to AI-driven).')
    assert unset.fix == found.fix
    assert checks(named)['dial'].detail == ('The runs follow alice, whose way of working is AI-driven, which this flow '
                                            'runs in.')
    # A pushing way of working the flow does not run in pushes, so nothing is said of pushing nothing.
    declared = replace(named, requires={'dial': ['ai_driven']})
    found = checks(declared, Ports(modes={'admin-sub': 'ai_assisted'}))['dial']
    assert found.detail == 'The runs follow alice, whose way of working is AI-assisted. This flow needs AI-driven.'
    assert found.fix.endswith('to AI-driven in Administration → People (/admin/people).')
    # No name known: who it would be, never an id.
    assert checks(ports=Ports(modes={'admin-sub': 'human_driven'}))['dial'].detail.startswith(
        'The runs follow the administrator who enables the agent, whose way of working is Human-driven')
    for raw in ('human_driven', 'ai_assisted', 'ai_driven', 'ai-assisted, ai-driven'):
        assert raw not in found.detail + found.fix + unset.detail
    assert mode_names(['ai_driven', 'human_driven', 'ai_assisted']) == 'Human-driven, AI-assisted or AI-driven'


def test_the_issues_source_fix_names_the_connection_switch_and_the_card() -> None:
    fix = checks(ports=Ports(issues=False))['issues_source'].fix
    assert fix.startswith('Agents → Connections: turn on "Read this repository\'s issues" on its connection')
    assert ('Administration → Data sources → GitHub Issues (Deployment) '
            '(/admin/sources/github_issues?scope=deployment)') in fix
    assert 'Settings' not in fix


def test_a_repository_its_connection_added_to_the_source_passes_before_its_first_read() -> None:
    """7.50.02: the managed state passes without any manual step (no watermark yet: the first read follows)."""
    ports = Ports(issues=False, lists=True)
    found = checks(ports=ports)['issues_source']
    assert found.status == 'pass'
    assert found.detail == f'Issues: read automatically from {REPOSITORY} by the deployment\'s GitHub Issues source.'
    assert f'issues {REPOSITORY}' not in ports.asked   # (no watermark read once listed)
    assert checks(ports=Ports(issues=False, lists=False))['issues_source'].status == 'fail'
    assert checks(ports=Ports(issues=True, lists=False))['issues_source'].status == 'pass'
    assert checks(ports=Ports(lists=ReadFailed('x')))['issues_source'].status == 'unknown'


def test_the_voc_agent_label_its_connection_created_passes() -> None:
    created = checks(ports=Ports(label='created'))['issue_label']
    assert created.status == 'pass'
    assert created.detail == 'Label voc-agent: created (issues labelled voc-agent start a run).'
    assert checks(ports=Ports(label='present'))['issue_label'].detail.startswith('Label voc-agent: on the repository')
    failed = checks(ports=Ports(label='failed'))['issue_label']
    assert (failed.status, 'Check installation' in failed.detail) == ('unknown', True)
    assert checks(ports=Ports(label=ReadFailed('x')))['issue_label'].status == 'unknown'
    # Another label's presence is not known from here.
    other = replace(SUBJECT, trigger={'kind': 'github_issue', 'label': 'agent-go'})
    ports = Ports(label='created')
    assert checks(other, ports)['issue_label'].status == 'unknown'
    assert 'label shop' not in ports.asked


def test_a_preview_answers_as_if_set_up_with_the_selected_connection_and_language() -> None:
    sandbox = {**ROW, 'connection_id': 'sandbox', 'repository': 'example-org/sandbox'}
    ports = Ports(rows={'shop': ROW, 'sandbox': sandbox, 'removed': None})
    blank = replace(SUBJECT, connection='', language='')
    seen = preview(blank, ports, ('python', 'node', 'java'), connection='sandbox', language='java')
    assert (seen.connection, seen.language) == ('sandbox', 'java')
    assert (blank.connection, blank.language) == ('', '')   # (read-only: the subject itself is unchanged)
    report = evaluate(seen, ports, SETTINGS)
    found = {check.id: check for check in report.checks}
    assert found['ci_attestation'].status == 'pass'
    assert 'attested sandbox example-org/sandbox' in ports.asked
    assert found['image'].status == 'fail'   # (java is an image language, but this deployment has none)
    # '' keeps the subject's own.
    assert preview(SUBJECT, ports, ('python',)) == SUBJECT
    assert preview(SUBJECT, ports, ('python',), language='python').connection == 'shop'


@pytest.mark.parametrize(('asked', 'reason'), [
    ({'connection': 'gone'}, 'no stored repository connection'),
    ({'connection': 'removed'}, 'no stored repository connection'),
    ({'language': 'cobol'}, 'language is one of node, python'),
])
def test_a_preview_names_a_stored_connection_and_a_language_with_an_image(asked: dict[str, str], reason: str) -> None:
    with pytest.raises(PreviewRefused, match=reason):
        preview(SUBJECT, Ports(rows={'shop': ROW, 'removed': None}), ('python', 'node'), **asked)


def test_a_previews_connection_that_cannot_be_read_raises() -> None:
    with pytest.raises(ReadFailed):
        preview(SUBJECT, Ports(rows={'shop': ReadFailed('x')}), ('python',), connection='shop')


def test_the_budget_and_the_hard_cap() -> None:
    assert checks(replace(SUBJECT, budget_usd=None))['budget'].blocking
    assert checks(ports=Ports(hard_cap=False))['hard_cap'].status == 'warn'
    assert checks(ports=Ports(spent=Decimal(50)))['hard_cap'].status == 'fail'
    assert checks(ports=Ports(spent=ReadFailed('x')))['hard_cap'].status == 'unknown'
    assert checks(ports=Ports(hard_cap=ReadFailed('x')))['hard_cap'].status == 'unknown'
    # A template has no month spend of its own.
    ports = Ports()
    assert checks(replace(SUBJECT, workflow_id=''), ports)['hard_cap'].status == 'pass'
    assert not any(asked.startswith('spend') for asked in ports.asked)


def test_every_model_of_the_flows_roles_and_learn_is_checked() -> None:
    models = flow_models(BUG_FLOW, CARDS)
    assert models == {HAIKU: ('gate-runner', 'pr-author'), OPUS: ('final-go',),
                      SONNET: ('commit-reviewer', 'committer', 'coordinator', 'fixer', 'hunter', LEARN)}
    # Learn off: its model is not called; a gate's own final go model is.
    gate = {'nodes': [node('start', learn={'enabled': False, 'model': OPUS}), node('quality_gate', final_go_model=HAIKU)]}
    assert flow_models(gate, CARDS) == {HAIKU: ('final-go', 'gate-runner'), SONNET: ('coordinator',)}
    ports = Ports(access={SONNET: 'available', HAIKU: 'not_subscribed', OPUS: 'available'})
    found = checks(ports=ports)['bedrock_models']
    assert found.status == 'fail'
    assert f'{HAIKU} (not_subscribed, for gate-runner, pr-author)' in found.detail
    assert checks(ports=Ports(access={SONNET: 'available'}))['bedrock_models'].status == 'unknown'
    assert checks(ports=Ports(access=ReadFailed('x')))['bedrock_models'].blocking


def test_the_agentcore_quota_the_memory_setting_the_network_and_the_probe() -> None:
    assert checks(ports=Ports(quota=100.0))['agentcore_quota'].status == 'fail'
    assert checks(ports=Ports(quota=ReadFailed('x')))['agentcore_quota'].status == 'unknown'
    assert checks(settings=replace(SETTINGS, build_memory_mib=8192))['memory_setting'].status == 'fail'
    assert checks(settings=replace(SETTINGS, build_memory_mib=8192, region='us-east-2'))['memory_setting'].status \
        == 'warn'
    assert checks(settings=replace(SETTINGS, network=False))['network'].status == 'fail'
    assert checks(ports=Ports(probe=False))['session_storage'].status == 'fail'
    assert checks(ports=Ports(probe=ReadFailed('x')))['session_storage'].status == 'unknown'


def test_the_sandbox_passes_only_on_a_session_s_recorded_walls_never_before_one() -> None:
    ports = Ports()
    found = checks(ports=ports)['sandbox']
    assert (found.status, found.required) == ('pass', False)
    assert found.detail == ('Verified on the live runtime (2026-11-17): user and network namespaces; hard-link guard '
                            'own_device, protected_hardlinks.')
    assert 'walls python' in ports.asked
    firewall = SandboxSeen('iptables', 'iptables', ('declared',), '2026-11-18T09:00:00Z')
    assert checks(ports=Ports(walls=firewall))['sandbox'].detail.startswith(
        'Verified on the live runtime (2026-11-18): the egress firewall (iptables)')


def test_the_sandbox_is_unknown_until_the_first_session_and_says_what_to_rebuild() -> None:
    unknown = checks(ports=Ports(walls=None))['sandbox']
    assert unknown.status == 'unknown'
    assert unknown.detail.startswith('Unknown until the first session: no python session has said')
    assert '2026-11-17' in unknown.detail
    assert 'Rebuild all four engineering images (python, node, java, rust)' in unknown.fix
    assert 'docs/deployment.md' in unknown.fix
    assert unknown.docs.endswith('#runtime-one-agentcore-session-per-agent')
    # (advice, never Enable's gate: a deployment before its first session can still be set up)
    assert not unknown.blocking
    assert checks(ports=Ports(walls=ReadFailed('throttled')))['sandbox'].status == 'unknown'
    assert checks(replace(SUBJECT, language='rust'))['sandbox'].status == 'unknown'   # (no rust image here)


@pytest.mark.parametrize(('seen', 'missing'), [
    (SandboxSeen('none', 'namespaces', ('own_device',), '2026-11-17T12:00:00Z'), 'had no egress wall for the agent'),
    (SandboxSeen('namespaces', 'none', ('own_device',), '2026-11-17T12:00:00Z'), 'had no wall for repository code'),
    (SandboxSeen('namespaces', 'namespaces', (), '2026-11-17T12:00:00Z'), 'had no hard-link guard'),
], ids=['no-egress-wall', 'no-code-wall', 'no-hard-link-guard'])
def test_a_recorded_session_without_a_wall_fails_the_sandbox(seen: SandboxSeen, missing: str) -> None:
    found = checks(ports=Ports(walls=seen))['sandbox']
    assert found.status == 'fail'
    assert missing in found.detail
    assert 'Rebuild all four engineering images' in found.fix


def test_the_flows_requires_is_its_templates_else_what_its_roles_need() -> None:
    assert flow_requires(BUG_FLOW) == {'dial': ['ai_assisted', 'ai_driven'], 'ci_attestation': True, 'image': True}
    assert flow_requires(TRIAGE_FLOW) == {'dial': ['human_driven', 'ai_assisted', 'ai_driven'],
                                          'ci_attestation': False, 'image': True}
    declared = {'dial': ['ai_driven'], 'image': True, 'knowledge_pack': True}
    assert flow_requires(BUG_FLOW, declared) == declared
    in_start = {'nodes': [node('start', requires={'image': False})]}
    assert flow_requires(in_start) == {'image': False}
    assert flow_roles(BUG_FLOW) == {'coordinator', 'hunter', 'fixer', 'commit-reviewer', 'gate-runner', 'final-go',
                                    'committer', 'pr-author'}


def test_every_docs_link_names_a_heading_of_the_doc() -> None:
    doc = Path(__file__).resolve().parents[4] / 'docs' / 'autonomous-engineering.md'
    headings = {re.sub(r'[^a-z0-9 -]', '', line.lstrip('#').strip().lower()).replace(' ', '-')
                for line in doc.read_text(encoding='utf-8').splitlines() if line.startswith('#')}
    report = evaluate(SUBJECT, Ports(attestation=False, issues=False, modes={}), SETTINGS)
    for check in report.checks:
        path, _, anchor = check.docs.partition('#')
        assert path == 'docs/autonomous-engineering.md'
        assert anchor in headings, check.docs
