"""clones_struct.py finds planted renamed / near clones and stays quiet on look-alikes (fixtures in a temp dir)."""
from __future__ import annotations

import json
from pathlib import Path

import clones_struct as cs
import pytest
from audit_common import EXIT_CLEAN, EXIT_ERROR, EXIT_FINDINGS

PAGER = '''
def {name}(table, {kw}):
    """Docstrings never count."""
    {acc} = []
    while True:
        {page} = table.query(**{kw})
        {acc}.extend(i for i in {page}.get('{items}', []) if isinstance(i, dict))
        if not {page}.get('LastEvaluatedKey'):
            return {acc}
        {kw}['ExclusiveStartKey'] = {page}['LastEvaluatedKey']
'''

PLAIN_A = '''
def plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [plain(v) for v in value]
    return value
'''
PLAIN_B = '''
def _plain(raw):
    if isinstance(raw, Decimal):
        return int(raw) if raw == raw.to_integral_value() else float(raw)
    if isinstance(raw, Mapping):
        return {k: _plain(v) for k, v in raw.items()}
    if isinstance(raw, list | tuple):
        return [_plain(v) for v in raw]
    return raw
'''
#: Same vocabulary as the pager, different structure: one page, no loop. Not a clone.
ONE_PAGE = '''
def first_page(table, kwargs):
    page = table.query(**kwargs)
    items = [i for i in page.get('Items', []) if isinstance(i, dict)]
    return items, page.get('LastEvaluatedKey')
'''


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
    return root


def _run(root: Path, *extra: str, allowlist: Path | None = None) -> tuple[int, dict]:
    report = root / 'report.json'
    args = ['pkg', '--root', str(root), '--min-nodes', '25', '--json', str(report),
            '--allowlist', str(allowlist or root / 'none.json'), *extra]
    code = cs.main(args)
    return code, json.loads(report.read_text()) if report.exists() else {}


def _paths(group: dict) -> set[str]:
    return {c['path'] for c in group['copies']}


def test_a_renamed_copy_is_one_exact_function_group(tmp_path):
    root = _tree(tmp_path, {
        'pkg/a.py': PAGER.format(name='list_rows', kw='kwargs', acc='rows', page='page', items='Items'),
        'pkg/b.py': PAGER.format(name='steps', kw='query', acc='out', page='resp', items='Rows'),
    })
    code, report = _run(root)
    assert code == EXIT_FINDINGS
    [group] = report['findings']
    assert group['kind'] == 'function'
    assert _paths(group) == {'pkg/a.py', 'pkg/b.py'}
    assert {c['name'] for c in group['copies']} == {'list_rows', 'steps'}


def test_near_copies_with_small_differences_cluster_as_near_function(tmp_path):
    root = _tree(tmp_path, {'pkg/a.py': PLAIN_A, 'pkg/b.py': PLAIN_B})
    code, report = _run(root)
    assert code == EXIT_FINDINGS
    [group] = report['findings']
    assert group['kind'] == 'near-function'
    assert 0.8 <= group['similarity'] < 1
    code, _ = _run(root, '--similarity', '0.99')
    assert code == EXIT_CLEAN  # the threshold is what admits them


def test_a_same_vocabulary_look_alike_is_not_a_clone(tmp_path):
    root = _tree(tmp_path, {
        'pkg/a.py': PAGER.format(name='list_rows', kw='kwargs', acc='rows', page='page', items='Items'),
        'pkg/b.py': ONE_PAGE,
    })
    assert _run(root)[0] == EXIT_CLEAN


def test_identical_statement_windows_inside_different_functions_are_one_region(tmp_path):
    body = '''
    total = 0
    for row in rows:
        total += row.get('count', 0) * weight
    ratio = total / max(len(rows), 1)
    log.info('ratio %s for %s', ratio, label)
'''
    root = _tree(tmp_path, {
        'pkg/a.py': f'def alpha(rows, weight, log, label, extra):\n    extra.prepare()\n{body}    return extra\n',
        'pkg/b.py': f'def beta(items, w, logger, name):\n    items.sort()\n{body}    return None\n'.replace(
            'rows', 'items').replace('weight', 'w').replace('log.', 'logger.').replace('label', 'name'),
    })
    code, report = _run(root, '--similarity', '1.1')
    assert code == EXIT_FINDINGS
    [group] = report['findings']
    assert group['kind'] == 'statements'
    starts = sorted((c['path'], c['start'], c['end']) for c in group['copies'])
    assert starts == [('pkg/a.py', 4, 8), ('pkg/b.py', 4, 8)]  # the four statements, merged from two windows


def test_copies_in_one_file_need_same_file(tmp_path):
    text = PAGER.format(name='one', kw='kw', acc='a', page='p', items='Items') + PAGER.format(
        name='two', kw='q', acc='b', page='r', items='Items')
    root = _tree(tmp_path, {'pkg/a.py': text})
    assert _run(root)[0] == EXIT_CLEAN
    assert _run(root, '--same-file')[0] == EXIT_FINDINGS


def test_tests_are_skipped_unless_asked(tmp_path):
    root = _tree(tmp_path, {
        'pkg/a.py': PLAIN_A,
        'pkg/test/test_a.py': PLAIN_B,
    })
    assert _run(root)[0] == EXIT_CLEAN
    assert _run(root, '--include-tests')[0] == EXIT_FINDINGS


def test_an_allowlist_entry_silences_a_group_and_needs_a_reason(tmp_path):
    root = _tree(tmp_path, {'pkg/a.py': PLAIN_A, 'pkg/b.py': PLAIN_B})
    allow = tmp_path / 'allow.json'
    allow.write_text(json.dumps({'entries': [{'files': ['pkg/*.py'], 'reason': 'planted pair'}]}))
    code, report = _run(root, allowlist=allow)
    assert (code, report['allowlisted']) == (EXIT_CLEAN, 1)
    allow.write_text(json.dumps({'entries': [{'files': ['pkg/*.py']}]}))
    assert _run(root, allowlist=allow)[0] == EXIT_ERROR


def test_an_allowlist_entry_must_cover_every_copy(tmp_path):
    root = _tree(tmp_path, {'pkg/a.py': PLAIN_A, 'pkg/b.py': PLAIN_B})
    allow = tmp_path / 'allow.json'
    allow.write_text(json.dumps({'entries': [{'files': ['pkg/a.py'], 'reason': 'only one side'}]}))
    assert _run(root, allowlist=allow)[0] == EXIT_FINDINGS


def test_a_scan_below_the_file_floor_is_an_error(tmp_path):
    root = _tree(tmp_path, {'pkg/a.py': PLAIN_A})
    assert _run(root, '--min-files', '5')[0] == EXIT_ERROR


@pytest.mark.parametrize('broken', ['def f(:\n', 'x = "\n'])
def test_an_unparsable_file_is_listed_not_fatal(tmp_path, broken):
    root = _tree(tmp_path, {'pkg/a.py': PLAIN_A, 'pkg/b.py': PLAIN_B, 'pkg/c.py': broken})
    code, report = _run(root)
    assert code == EXIT_FINDINGS
    assert report['unparsed'] == ['pkg/c.py']


def test_the_real_tree_is_a_plausible_scan():
    """Vacuity guard: the default scope parses hundreds of files (a moved tree would make the gate pass empty)."""
    groups, parsed, broken = cs.scan(cs.REPO, cs.DEFAULT_PATHS, cs.Options())
    assert parsed >= cs.DEFAULT_MIN_FILES
    assert not broken
    assert isinstance(groups, list)
