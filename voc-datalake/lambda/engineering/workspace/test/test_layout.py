"""The workspace layout: an agent's own keys parse to their parts; anything off the layout parses to nothing."""
from __future__ import annotations

import pytest

from engineering.workspace.layout import AgentKey, LayoutError, parse_agent_key, report_key

RUN = '01JD0000000000000000000000'
PREFIX = f'ws/default/runs/{RUN}/fixer-1/commits/a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'


@pytest.mark.parametrize(('segment', 'package'), [
    ('core', 'core'), ('crates=2Fcore', 'crates/core'), ('=2E', '.'), ('=5Finternal', '_internal'),
    ('=40scope=2Fpkg', '@scope/pkg'), ('caf=C3=A9', 'café'),
])
def test_a_finding_shard_names_its_package(segment: str, package: str) -> None:
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
