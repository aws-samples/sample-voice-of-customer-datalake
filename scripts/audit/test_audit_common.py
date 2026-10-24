"""audit_common.py: the shared CLI / report / allowlist contract of the Python detectors (mirrors audit_common.test.mjs)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from audit_common import (
    EXIT_CLEAN,
    EXIT_FINDINGS,
    AllowEntry,
    AuditError,
    Finding,
    apply_allowlist,
    glob_regex,
    is_test_path,
    load_allowlist,
    print_report,
    read_allowlist,
    split_allowlisted,
)


def test_the_text_report_starts_with_the_summary_and_json_goes_to_stdout_or_a_file(tmp_path: Path, capsys) -> None:
    findings = [{'kind': 'dead', 'key': 'a'}]
    assert print_report('tool', findings, ['  a'], as_json=None, summary='saw 3') == EXIT_FINDINGS
    assert capsys.readouterr().out.splitlines() == ['tool: 1 finding(s); saw 3', '  a']
    print_report('tool', findings, ['  a'], as_json='-')
    assert json.loads(capsys.readouterr().out)['findings'] == findings
    target = tmp_path / 'deep' / 'r.json'
    assert print_report('tool', [], [], as_json=str(target), extra={'files': 2}) == EXIT_CLEAN
    assert capsys.readouterr().out == 'tool: 0 finding(s)\n'
    assert json.loads(target.read_text())['files'] == 2


def test_one_loader_for_every_shape_reason_mandatory_shape_keys_required(tmp_path: Path) -> None:
    (tmp_path / 'ok.json').write_text(json.dumps({'entries': [{'files': ['src/**'], 'reason': 'kept'},
                                                              {'files': ['gone/*'], 'reason': 'old'}]}))
    (tmp_path / 'no-reason.json').write_text(json.dumps({'entries': [{'files': ['x'], 'reason': ' '}]}))
    (tmp_path / 'no-shape.json').write_text(json.dumps({'entries': [{'reason': 'r'}]}))
    entries = read_allowlist(tmp_path / 'ok.json', ('files',))
    with pytest.raises(AuditError, match='no reason'):
        read_allowlist(tmp_path / 'no-reason.json', ('files',))
    with pytest.raises(AuditError, match='lacks files'):
        read_allowlist(tmp_path / 'no-shape.json', ('files',))
    assert read_allowlist(tmp_path / 'missing.json', ('key',)) == []
    kept, excused, stale = split_allowlisted(['src/a/b.py', 'lib/c.py'], entries,
                                             lambda e, rel: bool(glob_regex(e['files'][0]).match(rel)))
    assert (kept, excused, [e['reason'] for e in stale]) == (['lib/c.py'], ['src/a/b.py'], ['old'])


def test_key_entries_glob_kind_and_stale(tmp_path: Path) -> None:
    (tmp_path / 'tool.json').write_text('{"entries": [{"key": "a::*", "reason": "r"}, {"key": "kind:k2", "reason": "r"},'
                                        ' {"key": "gone", "reason": "r"}]}', encoding='utf-8')
    left = apply_allowlist([Finding('k1', 'a::x/y'), Finding('k2', 'b::y'), Finding('k1', 'c::z')],
                           load_allowlist('tool', tmp_path))
    assert [(f.kind, f.key) for f in left] == [('k1', 'c::z'), ('stale-allowlist', 'gone')]
    assert not AllowEntry('a::*', 'r', kind='k2').matches(Finding('k1', 'a::x'))


@pytest.mark.parametrize(('rel', 'test'), [
    ('lambda/api/test/test_x.py', True), ('scripts/audit/conftest.py', True), ('src/a.test.tsx', True),
    ('lib/test-support/x.ts', True), ('src/x-fixtures.ts', True), ('frontend/mock-server.js', True),
    ('lambda/api/testing_handler.py', False), ('lib/latest/x.py', False),
])
def test_one_test_path_rule(rel: str, test: bool) -> None:
    assert is_test_path(rel) is test
    assert is_test_path(Path(rel)) is test
