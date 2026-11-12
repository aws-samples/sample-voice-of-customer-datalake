"""Finding shards are agent output: lines off voc-finding/1 are skipped and counted; kept text is cut and redacted."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.workspace.findings import MAX_EVIDENCE, Finding, parse_shard


def line(**changes: Any) -> str:
    base: dict[str, Any] = {'schema': 'voc-finding/1', 'file': 'src/paging.py', 'line': 12, 'severity': 'blocking',
                            'rule': 'off-by-one', 'title': 'The last page is dropped', 'evidence': 'range(n - 1)'}
    return json.dumps({**base, **changes})


def test_a_shard_reads_its_findings_most_severe_first() -> None:
    text = '\n'.join([line(severity='nit', line=3), '', line()]) + '\n'
    findings, skipped = parse_shard(text)
    assert skipped == 0
    assert sorted(findings, key=lambda f: f.rank)[0] == Finding(
        'src/paging.py', 12, 'blocking', 'off-by-one', 'The last page is dropped', 'range(n - 1)')


@pytest.mark.parametrize('bad', [
    'not json', '[1]', line(schema='voc-finding/2'), line(severity='critical'), line(line=-1), line(line='12'),
    line(line=True), line(file='/etc/passwd'), line(file='a/../../b'), line(file=''), line(file='x' * 301),
    line(title='  '), line(rule=3), line(evidence='x' * 9000), line(file='src/jo@example.com.py'),
    line(file='src/a b.py'),
])
def test_a_line_off_the_schema_is_skipped_and_counted(bad: str) -> None:
    assert parse_shard(f'{line()}\n{bad}\n') == (parse_shard(line())[0], 1)


def test_kept_text_is_cut_and_has_no_secret_or_personal_data() -> None:
    token = 'ghp_' + 'z' * 36
    [finding], _ = parse_shard(line(title=f'leaks {token}', evidence='mail jo@example.com ' + 'x' * 900))
    assert token not in finding.title
    assert 'jo@example.com' not in finding.evidence
    assert len(finding.evidence) == MAX_EVIDENCE
