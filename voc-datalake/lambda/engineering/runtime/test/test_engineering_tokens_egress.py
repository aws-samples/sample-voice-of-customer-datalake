"""Auth tokens are never stored; egress is an allowlist of plain hosts, and no MicroVM reaches the host."""
import json
import pickle

import pytest

from engineering.connectors.identity import ROLE_PLACEHOLDER, Caller, caller_from_event
from engineering.runtime import egress
from engineering.runtime.interface import ROLES, AgentSpec, CacheMount, Command, RuntimeRefused, agent_index
from engineering.runtime.launcher import session_name
from engineering.runtime.tokens import (
    MAX_TOKEN_SECONDS,
    REFRESH_MARGIN_SECONDS,
    AuthToken,
    TokenNotStorable,
    TokenSource,
    bounded_expiry,
)


def test_a_token_hides_its_value_and_cannot_be_pickled_or_dumped():
    token = AuthToken(value='fake-token-value', expires_at=1000.0)
    assert 'fake-token-value' not in repr(token)
    with pytest.raises(TokenNotStorable):
        pickle.dumps(token)
    with pytest.raises(TypeError):
        json.dumps({'t': token})


def test_a_token_source_cannot_be_pickled():
    with pytest.raises(TokenNotStorable):
        pickle.dumps(TokenSource(lambda: AuthToken('x', 0.0)))


def test_expiry_is_cut_to_sixty_minutes():
    assert bounded_expiry(100.0, 100.0 + 3 * MAX_TOKEN_SECONDS) == 100.0 + MAX_TOKEN_SECONDS
    assert bounded_expiry(100.0, 200.0) == 200.0


def test_the_source_mints_once_then_again_only_near_expiry():
    now = [0.0]
    minted: list[int] = []

    def mint() -> AuthToken:
        minted.append(1)
        return AuthToken(value=f'fake-{len(minted)}', expires_at=now[0] + MAX_TOKEN_SECONDS)

    source = TokenSource(mint, clock=lambda: now[0])
    first = source.current()
    now[0] = MAX_TOKEN_SECONDS - REFRESH_MARGIN_SECONDS - 1
    assert source.current() is first
    now[0] = MAX_TOKEN_SECONDS - REFRESH_MARGIN_SECONDS + 1
    assert source.current().value == 'fake-2'
    assert len(minted) == 2


def test_an_agent_reaches_the_workspace_buckets_own_endpoint_too():
    hosts = egress.egress_allowlist(role='hunter', language='python', region='eu-west-1', bucket='voc-raw-test',
                                    workspace_bucket='voc-eng-workspace-test')
    assert {'voc-raw-test.s3.eu-west-1.amazonaws.com', 'voc-eng-workspace-test.s3.eu-west-1.amazonaws.com'} <= set(hosts)
    with pytest.raises(RuntimeRefused, match='bucket name'):
        egress.egress_allowlist(role='hunter', language='python', region='eu-west-1', bucket='voc-raw-test',
                                workspace_bucket='Not_A_Bucket')


def test_an_agent_that_runs_code_reaches_its_registries_bedrock_and_the_bucket_only():
    hosts = egress.egress_allowlist(role='fixer', language='python', region='eu-west-1', bucket='voc-raw-test')
    # The bucket's own endpoint only: the regional path-style one reaches every bucket in the region.
    assert hosts == ('bedrock-runtime.eu-west-1.amazonaws.com', 'files.pythonhosted.org', 'pypi.org',
                     'sqs.eu-west-1.amazonaws.com', 'voc-raw-test.s3.eu-west-1.amazonaws.com')


def test_an_agent_that_runs_no_code_gets_no_registry_and_no_extra_host():
    hosts = egress.egress_allowlist(role='committer', language='rust', region='us-east-1', bucket='voc-raw-test',
                                    extra_hosts=['mirror.example.org'])
    assert not {'crates.io', 'mirror.example.org', 'github.com'} & set(hosts)


def test_no_allowlist_holds_a_repository_host():
    for role in ('fixer', 'committer', 'pr-author'):
        hosts = egress.egress_allowlist(role=role, language='node', region='us-east-1', bucket='voc-raw-test')
        assert not [host for host in hosts if 'github' in host or 'gitlab' in host]


@pytest.mark.parametrize('host', ['https://github.com', 'github.com:443', 'github.com/org', '*.example.org',
                                  '10.0.0.1', 'localhost', ''],
                         ids=['scheme', 'port', 'path', 'wildcard', 'ip', 'single-label', 'empty'])
def test_anything_but_a_plain_dns_name_is_refused(host):
    with pytest.raises(RuntimeRefused):
        egress.check_host(host)


@pytest.mark.parametrize(('language', 'region', 'bucket', 'extras'), [
    ('cobol', 'us-east-1', 'voc-raw-test', []), ('java', 'us-east-1.evil.example', 'voc-raw-test', []),
    ('java', 'us-east-1', 'Bad_Bucket', []), ('java', 'us-east-1', 'voc-raw-test', [f'm{i}.example.org' for i in range(11)]),
], ids=['language', 'region', 'bucket', 'too-many-extras'])
def test_bad_configuration_is_refused(language, region, bucket, extras):
    with pytest.raises(RuntimeRefused):
        egress.egress_allowlist(role='fixer', language=language, region=region, bucket=bucket, extra_hosts=extras)


@pytest.mark.parametrize('field', ['agent_id', 'task_id', 'connection'])
@pytest.mark.parametrize('value', ['', 'a/b', '../x', 'x' * 64, 'a_b'],
                         ids=['empty', 'slash', 'dots', 'long', 'underscore'])
def test_a_spec_refuses_ids_that_are_not_safe_keys(field, value):
    # A valid spec but for ``field``, so each case is refused for its own field (the message names it).
    fields = {'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1', 'role': 'fixer', 'task_id': 't-1',
              'language': 'python', 'egress': (), 'connection': 'repo-1', field: value}
    AgentSpec(**{**fields, field: {'agent_id': 'fixer-1', 'task_id': 't-1', 'connection': 'repo-1'}[field]})
    with pytest.raises(RuntimeRefused, match=field):
        AgentSpec(**fields)


RUN = '01JCZQ3N8K4V7R2T6W9Y0XB5MD'


@pytest.mark.parametrize(('run_id', 'agent_id', 'refused'), [
    ('run-1', 'fixer-1', 'ULID'), (RUN.lower(), 'fixer-1', 'ULID'), (RUN, 'fixer', 'fixer-<index>'),
    (RUN, 'hunter-1', 'fixer-<index>'), (RUN, 'fixer-01', 'fixer-<index>'), (RUN, 'fixer-1000', 'fixer-<index>'),
], ids=['not-a-ulid', 'lower-case', 'no-index', 'another-role', 'leading-zero', 'index-too-big'])
def test_a_spec_takes_only_a_ulid_run_and_an_agent_of_its_own_role(run_id, agent_id, refused):
    with pytest.raises(RuntimeRefused, match=refused):
        AgentSpec(run_id=run_id, agent_id=agent_id, role='fixer', task_id='t', language='python', egress=(),
                  connection='k')


def test_a_ulid_run_id_and_a_short_agent_index_fit_one_session_name():
    # A run id is a 26-character ULID; an agent is its role and a short index: well within STS's 64 characters.
    for role, agent_id, index in (('fixer', 'fixer-1', 1), ('gate-runner', 'gate-runner-12', 12),
                                  ('commit-reviewer', 'commit-reviewer-999', 999)):
        spec = AgentSpec(run_id=RUN, agent_id=agent_id, role=role, task_id='t', language='python', egress=(),
                         connection='k')
        name = session_name(spec.run_id, agent_index(spec.agent_id, spec.role))
        assert name == f'{RUN}.{index}'
        assert len(name) <= 64
    for index in (-1, 1000):
        with pytest.raises(RuntimeRefused, match='0-999'):
            session_name(RUN, index)


#: The broker's and the board's reading of a caller (connectors/identity.py), with the stack's role naming.
ACCOUNT = '123456789012'
ROLE_NAME_PATTERN = 'voc-eng-{role}-123456789012-eu-west-1'


def _caller_event(role: str, session: str) -> dict[str, object]:
    role_name = ROLE_NAME_PATTERN.replace(ROLE_PLACEHOLDER, role)
    arn = f'arn:aws:sts::{ACCOUNT}:assumed-role/{role_name}/{session}'
    return {'requestContext': {'authorizer': {'iam': {'userArn': arn}}}}


def test_the_launchers_session_is_one_the_broker_and_the_board_read_as_that_agent():
    for role, index in [(role, 3) for role in sorted(ROLES)] + [('fixer', 0), ('gate-runner', 999)]:
        assert agent_index(f'{role}-{index}', role) == index
        read = caller_from_event(_caller_event(role, session_name(RUN, index)), ROLE_NAME_PATTERN, ACCOUNT)
        assert read == Caller(role=role, run_id=RUN, agent_index=index)


def test_a_spec_refuses_an_unknown_role_and_its_environment_holds_no_credential():
    with pytest.raises(RuntimeRefused, match='role'):
        AgentSpec(run_id=RUN, agent_id='admin-1', role='admin', task_id='t', language='python', egress=(),
                  connection='k')
    env = AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='t', language='python', egress=(),
                    connection='k', restore_key='ws/default/runs/r/a/commits/c/_checkpoints/attempt-1/000001-x.json',
                    commit='c' * 40, attempt=2, workspace_bucket='voc-eng-workspace-test').environment()
    assert env['VOC_RESTORE_KEY'] == 'ws/default/runs/r/a/commits/c/_checkpoints/attempt-1/000001-x.json'
    assert (env['VOC_COMMIT'], env['VOC_ATTEMPT'], env['VOC_WORKSPACE_BUCKET']) == ('c' * 40, '2', 'voc-eng-workspace-test')
    assert not [name for name in env if 'TOKEN' in name or 'SECRET' in name or name.startswith('AWS_')]
    assert CacheMount(bucket='b', connection='k').prefix == 'engineering/cache/k/'


@pytest.mark.parametrize(('argv', 'timeout'), [((), 5), (('ok', ''), 5), (('ok',), 0)],
                         ids=['empty', 'empty-arg', 'zero-timeout'])
def test_a_command_refuses_an_empty_argv_or_timeout(argv, timeout):
    with pytest.raises(RuntimeRefused):
        Command(argv=argv, timeout_seconds=timeout)
