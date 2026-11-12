"""Auth tokens are never stored; egress is an allowlist of plain hosts, and no MicroVM reaches the host."""
import json
import pickle

import pytest

from engineering.runtime import egress
from engineering.runtime.interface import AgentSpec, CacheMount, Command, RuntimeRefused
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
    for role in ('fixer', 'committer', 'pr_author'):
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
    fields = {'run_id': 'run-1', 'agent_id': 'a-1', 'role': 'fixer', 'task_id': 't-1', 'language': 'python',
              'egress': (), 'connection': 'repo-1', field: value}
    with pytest.raises(RuntimeRefused):
        AgentSpec(**fields)


def test_a_run_and_agent_id_too_long_for_one_session_name_are_refused_never_cut():
    with pytest.raises(RuntimeRefused, match='session name'):
        AgentSpec(run_id='r' * 40, agent_id='a' * 30, role='fixer', task_id='t', language='python', egress=(),
                  connection='k')
    with pytest.raises(RuntimeRefused, match='over 64'):
        session_name('r' * 40, 'a' * 30)
    assert session_name('run-1', 'fixer-1') == 'run-1.fixer-1'


def test_a_spec_refuses_an_unknown_role_and_its_environment_holds_no_credential():
    with pytest.raises(RuntimeRefused, match='role'):
        AgentSpec(run_id='r', agent_id='a', role='admin', task_id='t', language='python', egress=(), connection='k')
    env = AgentSpec(run_id='r', agent_id='a', role='fixer', task_id='t', language='python', egress=(),
                    connection='k', restore_key='engineering/runs/r/a/checkpoints/000001-x.json').environment()
    assert env['VOC_RESTORE_KEY'] == 'engineering/runs/r/a/checkpoints/000001-x.json'
    assert not [name for name in env if 'TOKEN' in name or 'SECRET' in name or name.startswith('AWS_')]
    assert CacheMount(bucket='b', connection='k').prefix == 'engineering/cache/k/'


@pytest.mark.parametrize(('argv', 'timeout'), [((), 5), (('ok', ''), 5), (('ok',), 0)],
                         ids=['empty', 'empty-arg', 'zero-timeout'])
def test_a_command_refuses_an_empty_argv_or_timeout(argv, timeout):
    with pytest.raises(RuntimeRefused):
        Command(argv=argv, timeout_seconds=timeout)
