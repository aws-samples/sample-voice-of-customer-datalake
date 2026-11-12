"""The workspace layout: an agent's own keys parse to their parts; anything off the layout parses to nothing."""
from __future__ import annotations

import pytest

from engineering.workspace.layout import (
    AgentKey,
    LayoutError,
    agent_shard_key,
    encode_package,
    knowledge_key,
    parse_agent_key,
    report_key,
)

RUN = '01JD0000000000000000000000'
PREFIX = f'ws/default/runs/{RUN}/fixer-1/commits/a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'


@pytest.mark.parametrize(('segment', 'package'), [
    ('core', 'core'), ('crates=2Fcore', 'crates/core'), ('=2E', '.'), ('=5Finternal', '_internal'),
    ('=40scope=2Fpkg', '@scope/pkg'), ('caf=C3=A9', 'café'),
])
def test_a_finding_shard_names_its_package(segment: str, package: str) -> None:
    assert encode_package(package) == segment
    assert parse_agent_key(f'{PREFIX}/{segment}/attempt-2/shard-0.jsonl') == AgentKey(
        'default', RUN, 'fixer-1', 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', 2, 'shard-0.jsonl', package=package)


@pytest.mark.parametrize('kind', ['gate', 'logs', 'patches', 'checkpoints'])
def test_an_artifact_names_its_kind(kind: str) -> None:
    parsed = parse_agent_key(f'{PREFIX}/_{kind}/attempt-1/out.txt')
    assert parsed is not None
    assert (parsed.kind, parsed.package, parsed.name) == (kind, '', 'out.txt')


@pytest.mark.parametrize('key', [
    f'{PREFIX}/core/attempt-1',                                  # too short
    f'{PREFIX}/core/attempt-1/x/y.jsonl',                       # too long
    f'ws/default/run/{RUN}/fixer-1/commits/a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4/core/attempt-1/s.jsonl',
    f'{PREFIX}/core/attempt-0/s.jsonl', f'{PREFIX}/core/try-1/s.jsonl',
    f'ws/Default/runs/{RUN}/fixer-1/commits/a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4/core/attempt-1/s.jsonl',
    f'ws/default/runs/{RUN}/fixer-1/commits/ABC/core/attempt-1/s.jsonl',
    f'{PREFIX}/core/attempt-1/s.txt',                           # a finding shard is .jsonl
    f'{PREFIX}/gate/attempt-1/out.txt',                         # an artifact kind has its underscore
    f'{PREFIX}/_secrets/attempt-1/s.jsonl', f'{PREFIX}/_core/attempt-1/s.jsonl',
    f'{PREFIX}/=FF/attempt-1/s.jsonl',                          # not UTF-8
    f'{PREFIX}/a=2/attempt-1/s.jsonl', f'{PREFIX}/core/attempt-1/.hidden.jsonl',
    f'{PREFIX}/../attempt-1/s.jsonl',
])
def test_anything_off_the_layout_is_none(key: str) -> None:
    assert parse_agent_key(key) is None


def test_a_report_key() -> None:
    assert report_key('default', RUN, 'pr', '42', 3) == f'ws/default/reports/{RUN}/pr/42/v0003.json'
    assert report_key('default', RUN, 'goal', RUN, 1, 'md').endswith('/goal/' + RUN + '/v0001.md')
    with pytest.raises(LayoutError, match='a report is one of'):
        report_key('default', RUN, 'weekly', '42', 1)
    with pytest.raises(LayoutError, match='not a valid run id'):
        report_key('default', '../x', 'pr', '42', 1)


def test_a_knowledge_key() -> None:
    assert knowledge_key('default', 'conn-1', 'crates/core', 7, 'pack.json') == (
        'ws/default/knowledge/conn-1/crates=2Fcore/v000007/pack.json')
    for args, message in [(('default', 'a/b', 'core', 1, 'x.md'), 'connection id'),
                          (('default', 'conn-1', 'core', 0, 'x.md'), '1 to 999999'),
                          (('default', 'conn-1', 'core', 1_000_000, 'x.md'), '1 to 999999'),
                          (('default', 'conn-1', 'core', 1, '../x.md'), 'name'),
                          (('default', 'conn-1', '', 1, 'x.md'), 'package'),
                          (('default', 'conn-1', 'a' * 301, 1, 'x.md'), 'package')]:
        with pytest.raises(LayoutError, match=message):
            knowledge_key(*args)


def test_an_agent_shard_key_is_one_parse_agent_key_reads() -> None:
    key = agent_shard_key('default', RUN, 'mapper-0', 'a1b2c3d4' * 5, 'packages/web', 3, 'files-0123.jsonl')
    assert key == f'ws/default/runs/{RUN}/mapper-0/commits/{"a1b2c3d4" * 5}/packages=2Fweb/attempt-3/files-0123.jsonl'
    assert parse_agent_key(key) == AgentKey('default', RUN, 'mapper-0', 'a1b2c3d4' * 5, 3, 'files-0123.jsonl',
                                            package='packages/web')
    for args, message in [((RUN, 'mapper-0', 'abc', 'core', 1, 's.jsonl'), 'commit sha'),
                          ((RUN, 'mapper-0', 'a1b2c3d4' * 5, 'core', 0, 's.jsonl'), '1 to 9999'),
                          ((RUN, 'mapper-0', 'a1b2c3d4' * 5, 'core', 1, 's.txt'), 'not a shard key'),
                          (('../x', 'mapper-0', 'a1b2c3d4' * 5, 'core', 1, 's.jsonl'), 'run id')]:
        with pytest.raises(LayoutError, match=message):
            agent_shard_key('default', *args)
