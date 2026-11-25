"""The approved docs' write (7.52.00, broker.py ``push_approved_docs``, handler.py): voc-engineering-start's alone, the
approved version rendered again and held to the request's and the approval's digest, ``docs/agents/**`` or
``TENETS.md`` only, the requesting administrator's way of working, the CI checks, once per version; and the agents'
read of the accepted tenets."""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any

import pytest

from engineering.connectors import handler
from engineering.connectors.broker import (
    DOCS_HUMAN_DRIVEN,
    MERGE_IS_HUMAN,
    NOT_ATTESTED,
    START_OTHER_REPOSITORY,
    Broker,
    DocsRefused,
    DocsRequest,
    NotNow,
    NotPermitted,
)
from engineering.connectors.hosts import (
    CI_AGENT_BRANCH_PROTECTED,
    WRITE_CLAIMED,
    WRITE_DONE,
    WRITE_UNKNOWN,
    BundleContents,
    CiProtection,
    HostBusy,
    NoConnection,
    OutcomeUnknown,
    RunRecord,
    WriteClaim,
)
from engineering.connectors.identity import AGENT_ROLES, RUNTIME_ROLE, START_ROLE, Caller
from engineering.connectors.patches import AUTHOR
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BASE,
    PATTERN,
    REPOSITORY,
    RUN,
    TREE,
    FakeDial,
    FakeHost,
    FakeRuns,
    FakeWrites,
    connector,
    record,
    role_arn,
    url_event,
)
from engineering.connectors.test.test_broker_head import START_FUNCTION, START_ROLE_NAME, start_arn
from engineering.connectors.write_policy import WriteRefused
from engineering.knowledge.docs import Approved, RecordedRendering
from engineering.knowledge.render_docs import RenderedFile, Rendering, render_knowledge, render_tenets
from engineering.runtime.outputs import tenets_record

START = Caller(role=START_ROLE, run_id='', agent_index=0)
ADMIN = 'admin-sub-1'
PACK = {'schema': 'voc-kpack/1', 'package': '.', 'documents': {'convention': [
    {'claim': 'Two spaces.', 'citations': ['package.json:1'], 'subject': 'indent', 'author': ''}]}, 'packages': []}
KNOWLEDGE = render_knowledge({'.': PACK}, {'.': 4})
TENETS = render_tenets(tenets_record({'tenets': [{'id': 'T1', 'title': 'Fail closed', 'statement': 'Refuse.'}]}), 2)


@dataclass
class FakeDocs:
    """What was approved, by kind (``approved``: None for none), and the accepted tenets the agents read."""

    approved_: dict[str, Approved] = field(default_factory=lambda: {
        'knowledge': Approved(RecordedRendering('knowledge', 3, KNOWLEDGE.digest, {'.': 4}, ADMIN,
                                                '2026-11-17T09:00:00+00:00'), KNOWLEDGE),
        'tenets': Approved(RecordedRendering('tenets', 2, TENETS.digest), TENETS)})
    tenets: dict[str, object] | None = field(default_factory=lambda: {
        'version': 2, 'summary': '', 'tenets': [{'id': 'T1', 'title': 'Fail closed', 'statement': 'Refuse.'}]})
    asked: list[tuple[str, str]] = field(default_factory=list)

    def approved(self, connection_id: str, kind: str) -> Approved | None:
        self.asked.append((connection_id, kind))
        return self.approved_.get(kind)

    def accepted_tenets(self, connection_id: str) -> dict[str, object] | None:
        self.asked.append((connection_id, 'accepted'))
        return self.tenets


@dataclass
class Attestations(FakeRuns):
    """The runs, and the connection's attestation as given (``attested``)."""

    attestation: bool = True
    seen: list[RunRecord] = field(default_factory=list)

    def attested(self, run: RunRecord) -> RunRecord:
        self.seen.append(run)
        return replace(run, ci_attested=self.attestation, ci_attestation=2 if self.attestation else 0)


def request(kind: str = 'knowledge', **overrides: Any) -> DocsRequest:
    digest = KNOWLEDGE.digest if kind == 'knowledge' else TENETS.digest
    return replace(DocsRequest(connection='conn-1', repository=REPOSITORY, default_branch='main', kind=kind,
                               digest=digest, requested_by=ADMIN), **overrides)


@dataclass
class World:
    host: FakeHost = field(default_factory=FakeHost)
    docs: FakeDocs = field(default_factory=FakeDocs)
    runs: Attestations = field(default_factory=Attestations)
    dial: FakeDial = field(default_factory=FakeDial)
    claims: FakeWrites = field(default_factory=FakeWrites)

    @property
    def broker(self) -> Broker:
        return Broker(replace(connector(host=self.host, runs=self.runs, dial=self.dial), docs=self.docs,
                              docs_writes=self.claims))


def _pr(done: Mapping[str, object]) -> Mapping[str, Any]:
    """The pull request a publish answered."""
    pr = done['pr']
    assert isinstance(pr, Mapping)
    return pr


def test_the_knowledge_docs_are_one_commit_on_their_branch_and_a_ready_pull_request() -> None:
    world = World()
    done = world.broker.push_approved_docs(START, request())
    assert done['pr'] == {'number': 7, 'url': 'https://code.example.com/pull/7', 'branch': 'voc-agent/docs-knowledge-v3'}
    assert (done['kind'], done['version'], done['digest'], done['draft'], done['repeated']) == (
        'knowledge', 3, KNOWLEDGE.digest, False, False)
    names = [call[0] for call in world.host.calls]
    assert names == ['head_commit', 'tree_with', 'push_bundle', 'open_or_update_draft_pr']
    tree = next(call for call in world.host.calls if call[0] == 'tree_with')
    assert tree == ('tree_with', 'conn-1', BASE, KNOWLEDGE.paths())
    push = next(call for call in world.host.calls if call[0] == 'push_bundle')
    contents = push[3]
    assert isinstance(contents, BundleContents)
    assert (push[2], push[4], push[5]) == ('voc-agent/docs-knowledge-v3', TREE, 'main')
    assert (contents.heads, contents.base, contents.tree_hash, contents.changed_paths) == (
        ('refs/heads/voc-agent/docs-knowledge-v3',), BASE, TREE, KNOWLEDGE.paths())
    (commit,) = contents.commits
    assert (commit.author, commit.committer) == (AUTHOR, AUTHOR)
    assert [(c.path, c.mode, c.content) for c in commit.changes] == [
        (f.path, '100644', f.content) for f in KNOWLEDGE.files]
    opened = next(call for call in world.host.calls if call[0] == 'open_or_update_draft_pr')
    assert (opened[2], opened[3], opened[6]) == ('voc-agent/docs-knowledge-v3', 'main', TREE)
    assert opened[4] == 'Agent docs: the approved knowledge pack (rendering 3)'
    body = opened[5]
    assert isinstance(body, str)
    assert body.endswith(MERGE_IS_HUMAN)
    assert '`docs/agents/index.md`' in body
    assert world.host.drafts == [False]
    assert world.dial.asked == [ADMIN]   # (the requesting administrator's way of working)
    assert world.runs.seen[0].repository == REPOSITORY


def test_the_tenets_are_tenets_md_and_a_draft_when_asked() -> None:
    world = World()
    done = world.broker.push_approved_docs(START, request('tenets', draft=True))
    assert _pr(done)['branch'] == 'voc-agent/docs-tenets-v2'
    push = next(call for call in world.host.calls if call[0] == 'push_bundle')
    contents = push[3]
    assert isinstance(contents, BundleContents)
    assert contents.changed_paths == ('TENETS.md',)
    assert world.host.drafts == [True]


@pytest.mark.parametrize('role', [*sorted(AGENT_ROLES), RUNTIME_ROLE])
def test_no_agent_role_and_not_the_runtime_may_push_approved_docs(role: str) -> None:
    world = World()
    with pytest.raises(NotPermitted):
        world.broker.push_approved_docs(Caller(role=role, run_id=RUN if role != RUNTIME_ROLE else '', agent_index=1),
                                        request())
    assert (world.host.calls, world.docs.asked) == ([], [])


@pytest.mark.parametrize('case', ['request', 'stored'])
def test_a_digest_that_is_not_the_approvals_is_refused(case: str) -> None:
    world = World()
    if case == 'stored':   # (the stored records render to another digest than the approval recorded)
        approved = world.docs.approved_['knowledge']
        world.docs.approved_['knowledge'] = replace(approved, recorded=replace(approved.recorded, digest='0' * 64))
        asked = request(digest='0' * 64)
    else:
        asked = request(digest='f' * 64)
    with pytest.raises(DocsRefused) as caught:
        world.broker.push_approved_docs(START, asked)
    assert caught.value.code == 'digest_mismatch'
    assert world.host.writes() == []


def test_nothing_approved_is_refused() -> None:
    world = World()
    world.docs.approved_.clear()
    with pytest.raises(DocsRefused) as caught:
        world.broker.push_approved_docs(START, request())
    assert caught.value.code == 'not_approved'


@pytest.mark.parametrize('mode', ['human_driven', 'ai_first', ''])
def test_human_driven_gets_the_patch_and_no_push(mode: str) -> None:
    world = World(dial=FakeDial({ADMIN: mode}))
    with pytest.raises(DocsRefused) as caught:
        world.broker.push_approved_docs(START, request())
    assert (caught.value.code, caught.value.reason) == ('human_driven', DOCS_HUMAN_DRIVEN)
    assert world.host.writes() == []


def test_ai_assisted_goes_on_since_the_request_is_the_persons_go() -> None:
    world = World(dial=FakeDial({ADMIN: 'ai_assisted'}))
    assert world.broker.push_approved_docs(START, request())['repeated'] is False


def test_the_ci_attestation_and_the_branch_rules_hold_as_for_a_push() -> None:
    world = World(runs=Attestations(attestation=False))
    with pytest.raises(NotNow) as caught:
        world.broker.push_approved_docs(START, request())
    assert caught.value.reason == NOT_ATTESTED
    guarded = World(host=FakeHost(protection=CiProtection(True, ('ci / test',), True, 1.0)))
    with pytest.raises(NotNow) as refused:
        guarded.broker.push_approved_docs(START, request())
    assert refused.value.reason == CI_AGENT_BRANCH_PROTECTED
    assert guarded.host.ci_checks == [('conn-1', 'main', 'voc-agent/docs-knowledge-v3')]
    assert world.host.writes() == guarded.host.writes() == []


@pytest.mark.parametrize(('kind', 'path'), [
    ('knowledge', 'docs/agentsX/index.md'), ('knowledge', '../docs/agents/x.md'), ('knowledge', '/docs/agents/x.md'),
    ('knowledge', 'docs/agents/../../.github/workflows/ci.yml'), ('knowledge', 'TENETS.md'),
    ('tenets', 'docs/agents/index.md'), ('tenets', 'tenets.md'), ('knowledge', 'README.md'),
])
def test_a_path_outside_the_kinds_own_is_refused(kind: str, path: str) -> None:
    world = World()
    stray = Rendering(kind, (RenderedFile(path, b'x\n'),))
    world.docs.approved_[kind] = Approved(RecordedRendering(kind, 1, stray.digest), stray)
    with pytest.raises(WriteRefused):
        world.broker.push_approved_docs(START, request(kind, digest=stray.digest))
    assert world.host.writes() == []


def test_a_credential_for_another_repository_is_refused() -> None:
    world = World(host=FakeHost(credential_repository='example-org/other'))
    with pytest.raises(NotNow) as caught:
        world.broker.push_approved_docs(START, request())
    assert caught.value.reason == START_OTHER_REPOSITORY
    assert world.docs.asked == []


def test_a_second_publish_of_the_version_answers_the_first_pull_request_and_writes_nothing() -> None:
    world = World()
    first = world.broker.push_approved_docs(START, request())
    writes = len(world.host.writes())
    again = world.broker.push_approved_docs(START, request())
    assert again == {**first, 'repeated': True}
    assert len(world.host.writes()) == writes


def test_a_pull_request_whose_open_failed_is_opened_on_a_retry_from_the_branch_pushed() -> None:
    world = World()
    failing = world.host.open_or_update_draft_pr

    def busy(*_args: Any, **_kwargs: Any) -> Any:
        raise HostBusy('The host is rate limiting.', 30)

    world.host.open_or_update_draft_pr = busy   # type: ignore[method-assign]
    with pytest.raises(HostBusy):
        world.broker.push_approved_docs(START, request())
    world.host.open_or_update_draft_pr = failing   # type: ignore[method-assign]
    done = world.broker.push_approved_docs(START, request())
    assert _pr(done)['number'] == 7
    assert [call[0] for call in world.host.calls].count('push_bundle') == 1


#: (7.71.04) A docs branch of 7.52.00-7.71.03, two levels under ``voc-agent/``.
TWO_LEVEL = 'voc-agent/docs/knowledge-v3'


def _claim_key(operation: str) -> tuple[str, str]:
    return 'conn-1', f'docs-knowledge-v3#1#{operation}#{KNOWLEDGE.digest[:32]}'


def test_a_pull_request_recorded_from_a_two_level_branch_is_still_answered() -> None:
    world = World()
    recorded = {'pr': {'number': 5, 'url': 'https://code.example.com/pull/5', 'branch': TWO_LEVEL},
                'kind': 'knowledge', 'version': 3, 'digest': KNOWLEDGE.digest, 'tree_hash': TREE, 'draft': False}
    world.claims.claims[_claim_key('open_or_update_draft_pr')] = WriteClaim(WRITE_DONE, recorded)
    assert world.broker.push_approved_docs(START, request()) == {**recorded, 'repeated': True}
    assert world.host.calls == []


def test_docs_pushed_on_a_two_level_branch_open_their_pull_request_from_it() -> None:
    # A push of 7.71.03 or before made, its pull request not: the retry opens it from the branch the docs are on, the
    # one its push claim names, and pushes nothing again.
    world = World()
    world.claims.claims[_claim_key('push_bundle')] = WriteClaim(WRITE_DONE, {
        'branch': TWO_LEVEL, 'tree_hash': TREE, 'base': BASE, 'ci': {}})
    done = world.broker.push_approved_docs(START, request())
    assert (_pr(done)['branch'], [call[0] for call in world.host.calls]) == (TWO_LEVEL, ['open_or_update_draft_pr'])
    assert world.host.ci_checks == [('conn-1', 'main', TWO_LEVEL)]


def test_a_write_whose_outcome_is_unknown_is_never_made_again() -> None:
    world = World()
    world.broker.push_approved_docs(START, request())
    for key in list(world.claims.claims):
        if '#open_or_update_draft_pr#' in key[1]:
            world.claims.claims[key] = WriteClaim(WRITE_UNKNOWN)
    with pytest.raises(OutcomeUnknown):
        world.broker.push_approved_docs(START, request())
    world.claims.claims = {key: WriteClaim(WRITE_CLAIMED) for key in world.claims.claims}
    with pytest.raises(OutcomeUnknown):
        world.broker.push_approved_docs(START, request())


def test_the_claims_are_the_connections_own_once_per_kind_and_version() -> None:
    world = World()
    world.broker.push_approved_docs(START, request())
    world.broker.push_approved_docs(START, request('tenets'))
    assert sorted(world.claims.claims) == sorted([
        ('conn-1', f'docs-knowledge-v3#1#push_bundle#{KNOWLEDGE.digest[:32]}'),
        ('conn-1', f'docs-knowledge-v3#1#open_or_update_draft_pr#{KNOWLEDGE.digest[:32]}'),
        ('conn-1', f'docs-tenets-v2#1#push_bundle#{TENETS.digest[:32]}'),
        ('conn-1', f'docs-tenets-v2#1#open_or_update_draft_pr#{TENETS.digest[:32]}')])


def test_no_docs_store_is_no_connection() -> None:
    with pytest.raises(NoConnection):
        Broker(connector()).push_approved_docs(START, request())


# --- the agents' read of the accepted tenets ---------------------------------------------------------------------


def test_every_agent_reads_its_runs_accepted_tenets_from_the_store() -> None:
    world = World()
    page = world.broker.tenets(Caller(role='understander', run_id=RUN, agent_index=1))
    assert json.loads(page.content) == {'version': 2, 'summary': '', 'tenets': [
        {'id': 'T1', 'title': 'Fail closed', 'statement': 'Refuse.'}]}
    assert (page.next_cursor, world.host.calls) == (None, [])
    world.docs.tenets = None
    assert json.loads(world.broker.tenets(Caller('hunter', RUN, 2)).content) == {
        'version': None, 'summary': '', 'tenets': []}


def test_the_tenets_read_is_an_active_runs_and_no_starts() -> None:
    world = World(runs=Attestations({RUN: record(status='done')}))
    with pytest.raises(NotNow):
        world.broker.tenets(Caller('understander', RUN, 1))
    with pytest.raises(NotPermitted):
        World().broker.tenets(START)


# --- through the function URL ------------------------------------------------------------------------------------


ARGS = {'connection': 'conn-1', 'repository': REPOSITORY, 'default_branch': 'main', 'kind': 'knowledge',
        'digest': KNOWLEDGE.digest, 'requested_by': ADMIN}


def _call(user_arn: str, args: object, world: World | None = None, operation: str = 'push_approved_docs'
          ) -> tuple[int, Any]:
    response = handler.handle(url_event(user_arn, {'operation': operation, 'args': args}), PATTERN, ACCOUNT,
                              (world or World()).broker, start=(START_ROLE_NAME, START_FUNCTION))
    return response['statusCode'], json.loads(response['body'])


def test_the_start_publishes_through_the_function_url_and_an_agent_never_does() -> None:
    status, body = _call(start_arn(), {**ARGS, 'draft': False})
    assert (status, body['result']['pr']['branch'], body['result']['repeated']) == (
        200, 'voc-agent/docs-knowledge-v3', False)
    assert _call(role_arn('pr-author'), ARGS)[0] == 403
    assert _call(role_arn('committer'), ARGS)[0] == 403


def test_a_docs_refusal_names_its_code_beside_its_reason() -> None:
    status, body = _call(start_arn(), ARGS, World(dial=FakeDial({ADMIN: 'human_driven'})))
    assert (status, body) == (409, {'error': DOCS_HUMAN_DRIVEN, 'code': 'human_driven'})
    status, body = _call(start_arn(), {**ARGS, 'digest': 'e' * 64})
    assert (status, body['code']) == (409, 'digest_mismatch')


@pytest.mark.parametrize('args', [
    {**ARGS, 'kind': 'code'}, {**ARGS, 'digest': 'abc'}, {**ARGS, 'requested_by': ''},
    {**ARGS, 'draft': 'yes'}, {**ARGS, 'connection': 'Conn 1'}, {key: ARGS[key] for key in list(ARGS)[:-1]},
    {**ARGS, 'paths': ['README.md']},
])
def test_400_for_args_that_are_not_a_docs_publish(args: dict[str, object]) -> None:
    assert _call(start_arn(), args)[0] == 400


def test_the_docs_paths_and_branches_are_the_write_policys() -> None:
    from engineering.connectors.write_policy import docs_branch, docs_path_refusal, docs_paths
    assert docs_path_refusal('docs/agents/index.md', 'knowledge') is None
    assert docs_path_refusal('docs/agents/packages/web.md', 'knowledge') is None
    assert docs_path_refusal('TENETS.md', 'tenets') is None
    for path in ('docs/agents', 'docs/agents/', 'docs/agents//x.md', 'docs/agents/./x.md', 'docs/agents/a b.md'):
        assert docs_path_refusal(path, 'knowledge') is not None
    with pytest.raises(WriteRefused):
        docs_paths([], 'knowledge')
    # (7.71.04) One level under voc-agent/, the only level a ruleset excluding refs/heads/voc-agent/* leaves unprotected.
    assert (docs_branch('knowledge', 12), docs_branch('tenets', 1)) == ('voc-agent/docs-knowledge-v12',
                                                                       'voc-agent/docs-tenets-v1')
    for kind, version in (('code', 1), ('knowledge', 0), ('tenets', -1)):
        with pytest.raises(WriteRefused):
            docs_branch(kind, version)


def test_an_agent_reads_the_tenets_through_the_read_operation() -> None:
    status, body = _call(role_arn('understander'), {'kind': 'tenets', 'target': 'accepted'}, operation='read')
    assert status == 200
    assert json.loads(body['result']['content'])['version'] == 2
    assert _call(role_arn('understander'), {'kind': 'tenets', 'target': 'TENETS.md'}, operation='read')[0] == 400
