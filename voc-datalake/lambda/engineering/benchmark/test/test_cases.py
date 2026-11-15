"""The voc-bench/1 record: the shipped suite loads, and every field, bound and path is checked."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from engineering.benchmark import cases as cases_module
from engineering.benchmark.cases import (
    MAX_CASE_BYTES,
    BenchmarkError,
    CommandCheck,
    ReviewCheck,
    load_case,
    load_suite,
    plain_path,
)
from engineering.benchmark.test.fixtures import CASES, MONOREPO, REVIEW, SLUG, SUITE, write_case

COMMAND = {'argv': ['python3', 'main.py'], 'cwd': '', 'timeout_seconds': 30, 'protected': []}
REVIEW_FILES = {'main.py': 'one = 1\ntwo = 2\nthree = 3\n'}


def review_check(**finding: Any) -> dict[str, Any]:
    return {'findings': [{'file': 'main.py', 'lines': [1, 2], 'rule': 'off-by-one', **finding}],
            'max_false_positives': 0}


def test_the_shipped_suite_has_each_kind_and_a_monorepo() -> None:
    assert [case.id for case in SUITE] == ['duration-hours-feature', 'monorepo-units-bug', 'pagination-review',
                                           'slug-cut-bug']
    assert {case.kind for case in SUITE} == {'bug', 'feature', 'review'}
    slug = CASES[SLUG]
    assert isinstance(slug.check, CommandCheck)
    assert (slug.check.argv, slug.check.protected, slug.fixture) == (
        ('python3', '-m', 'unittest'), ('test_slugs.py',), slug.directory / 'repo')
    monorepo = CASES[MONOREPO].check
    assert isinstance(monorepo, CommandCheck)
    assert monorepo.cwd == 'packages/units'
    assert monorepo.protects('packages/stock/stock.py')
    assert not monorepo.protects('packages/units/src/convert.js')
    assert not monorepo.protects('packages/stockroom.py')   # a prefix of a name is not the directory
    assert monorepo.protects('Packages/STOCK/stock.py')     # case aside, as a case-insensitive file system sees it
    assert monorepo.allows == ('packages/units/src',)
    assert monorepo.permits('packages/units/src/convert.js')
    assert monorepo.permits('packages/units/SRC/new.js')
    assert not monorepo.permits('packages/units/package.json')   # outside what the case allows
    assert not monorepo.permits('packages/units/test/convert.test.js')
    assert CommandCheck(('node',), '', 1, ('test',)).permits('anything.js')   # no allows: all but protected
    review = CASES[REVIEW].check
    assert isinstance(review, ReviewCheck)
    assert [f.label for f in review.findings] == ['off-by-one in export_pages.py:10-10',
                                                  'off-by-one in export_pages.py:15-16',
                                                  'unit-mismatch in export_pages.py:24-26']
    assert review.max_false_positives == 1


def test_a_review_case_loads_its_expected_findings(tmp_path: Path) -> None:
    case = load_case(write_case(tmp_path, kind='review', check=review_check(), files=REVIEW_FILES))
    assert isinstance(case.check, ReviewCheck)
    assert case.check.findings[0].matches('main.py', 2, 'off-by-one')
    assert not case.check.findings[0].matches('main.py', 3, 'off-by-one')
    assert not case.check.findings[0].matches('main.py', 1, 'unit-mismatch')


@pytest.mark.parametrize(('fields', 'message'), [
    ({'schema': 'voc-bench/2'}, 'not a voc-bench/1 record'),
    ({'id': 'Probe'}, "a case's id"),
    ({'id': 'another'}, "its directory's name"),
    ({'kind': 'chore'}, "a case's kind is one of bug, feature, review"),
    ({'title': ''}, "a case's title is text of 1-200"),
    ({'task': 't' * 8_001}, "a case's task is text of 1-8000"),
    ({'task': 'a\x00b'}, "a case's task"),
    ({'extra': 1}, r"unknown: \['extra'\]"),
    ({'fixture': '../outside'}, 'not a plain relative path'),
    ({'fixture': '/etc'}, 'not a plain relative path'),
    ({'fixture': './repo'}, 'not a plain relative path'),
    ({'fixture': 'missing'}, 'is not in the case'),
    ({'fixture': 'case.json'}, 'the fixture is a directory'),
    ({'fixture': 7}, 'the fixture is a relative path'),
])
def test_a_record_is_checked_field_by_field(tmp_path: Path, fields: dict[str, Any], message: str) -> None:
    with pytest.raises(BenchmarkError, match=message):
        load_case(write_case(tmp_path, **fields))


def test_a_record_holds_exactly_its_fields(tmp_path: Path) -> None:
    directory = write_case(tmp_path)
    record = json.loads((directory / 'case.json').read_text())
    del record['task']
    (directory / 'case.json').write_text(json.dumps(record))
    with pytest.raises(BenchmarkError, match=r"missing: \['task'\]"):
        load_case(directory)


@pytest.mark.parametrize(('check', 'message'), [
    ({**COMMAND, 'argv': ['bash', '-c', 'true']}, 'starts with one of python3, node'),
    ({**COMMAND, 'argv': []}, 'starts with one of'),
    ({**COMMAND, 'argv': ['python3', '']}, '1-512 characters'),
    ({**COMMAND, 'argv': ['python3', 7]}, 'a list of at most 32 texts'),
    ({**COMMAND, 'argv': ['python3'] * 33}, 'a list of at most 32 texts'),
    ({**COMMAND, 'cwd': '../up'}, "the check's cwd"),
    ({**COMMAND, 'cwd': 'main.py'}, 'is a directory of the fixture'),
    ({**COMMAND, 'timeout_seconds': 0}, 'from 1 to 600'),
    ({**COMMAND, 'timeout_seconds': True}, 'from 1 to 600'),
    ({**COMMAND, 'protected': ['.git/config']}, 'names a .git directory'),
    ({**COMMAND, 'protected': ['nowhere.py']}, 'is not in the case'),
    ({**COMMAND, 'shell': True}, r"unknown: \['shell'\]"),
    ({**COMMAND, 'allows': ['../up.py']}, "an allowed path '../up.py' is not a plain relative path"),
    ({**COMMAND, 'allows': 'main.py'}, 'allows is a list of at most 50 texts'),
    ({**COMMAND, 'protected': ['main.py'], 'allows': ['MAIN.py']}, "'MAIN.py' is both allowed and protected"),
    (review_check(), "unknown: \\['findings', 'max_false_positives'\\]"),
])
def test_a_command_check_is_checked(tmp_path: Path, check: dict[str, Any], message: str) -> None:
    with pytest.raises(BenchmarkError, match=message):
        load_case(write_case(tmp_path, check=check))


@pytest.mark.parametrize(('check', 'message'), [
    (review_check(file='other.py'), 'is not in the case'),
    (review_check(file='/etc/passwd'), 'not a plain relative path'),
    (review_check(file='sub'), 'is a file of the fixture'),
    (review_check(lines=[0, 1]), 'first line in main.py is a whole number from 1 to 3'),
    (review_check(lines=[2, 1]), 'last line in main.py is a whole number from 2 to 3'),
    (review_check(lines=[1, 4]), 'last line'),
    (review_check(lines=[1]), r'lines are \[first, last\]'),
    (review_check(rule='Off By One'), "a finding's rule is a short id"),
    (review_check(rule='r' * 41), "a finding's rule is a short id"),
    ({'findings': [], 'max_false_positives': 0}, 'expects 1-50 findings'),
    ({**review_check(), 'max_false_positives': 21}, 'from 0 to 20'),
    (COMMAND, "a review's check has exactly its fields"),
])
def test_a_review_check_is_checked(tmp_path: Path, check: dict[str, Any], message: str) -> None:
    files = {**REVIEW_FILES, 'sub/inner.py': 'x = 1\n'}
    with pytest.raises(BenchmarkError, match=message):
        load_case(write_case(tmp_path, kind='review', check=check, files=files))


def test_no_link_anywhere_in_a_case(tmp_path: Path) -> None:
    outside = tmp_path / 'outside.py'
    outside.write_text('secret = 1\n')
    directory = write_case(tmp_path)
    (directory / 'repo' / 'linked.py').symlink_to(outside)
    with pytest.raises(BenchmarkError, match=r'the fixture holds a link: linked\.py'):
        load_case(directory)
    (directory / 'repo' / 'linked.py').unlink()
    (directory / 'elsewhere').symlink_to(directory / 'repo', target_is_directory=True)
    with pytest.raises(BenchmarkError, match="the fixture 'elsewhere' goes through a link"):
        load_case(write_case(tmp_path, fixture='elsewhere'))
    record = directory / 'case.json'
    (tmp_path / 'record.json').write_text(record.read_text())
    record.unlink()
    record.symlink_to(tmp_path / 'record.json')
    with pytest.raises(BenchmarkError, match='neither of them a link'):
        load_case(directory)


def test_a_review_finding_cannot_reach_outside_through_a_link(tmp_path: Path) -> None:
    directory = write_case(tmp_path, kind='review', check=review_check(file='sub/main.py'), files=REVIEW_FILES)
    (directory / 'repo' / 'sub').symlink_to(directory / 'repo', target_is_directory=True)
    with pytest.raises(BenchmarkError, match='the fixture holds a link: sub'):
        load_case(directory)


def test_a_fixture_holds_no_git_directory(tmp_path: Path) -> None:
    directory = write_case(tmp_path, files={'main.py': 'x = 1\n', '.Git/config': '[core]\n'})
    with pytest.raises(BenchmarkError, match=r'holds a .git entry: .Git'):
        load_case(directory)


def test_a_fixture_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    directory = write_case(tmp_path, files={'main.py': 'x = 1\n', 'b.py': 'y = 2\n'})
    monkeypatch.setattr(cases_module, 'MAX_FIXTURE_FILES', 1)
    with pytest.raises(BenchmarkError, match='at most 1 files'):
        load_case(directory)
    monkeypatch.setattr(cases_module, 'MAX_FILE_BYTES', 3)
    with pytest.raises(BenchmarkError, match='a fixture file is at most 3 bytes'):
        load_case(directory)


def test_a_fixture_holds_only_files_and_directories(tmp_path: Path) -> None:
    directory = write_case(tmp_path)
    os.mkfifo(directory / 'repo' / 'pipe')
    with pytest.raises(BenchmarkError, match='not a file: pipe'):
        load_case(directory)


def test_a_record_is_bounded_and_readable(tmp_path: Path) -> None:
    directory = write_case(tmp_path, task='t' * (MAX_CASE_BYTES + 1))
    with pytest.raises(BenchmarkError, match=f'at most {MAX_CASE_BYTES} bytes'):
        load_case(directory)
    (directory / 'case.json').write_text('{not json')
    with pytest.raises(BenchmarkError, match='not readable JSON'):
        load_case(directory)
    (directory / 'case.json').write_text('[]')
    with pytest.raises(BenchmarkError, match='a voc-bench/1 record is an object'):
        load_case(directory)
    (directory / 'case.json').unlink()
    with pytest.raises(BenchmarkError, match=r'a directory with its case\.json'):
        load_case(directory)


def test_a_suite_is_bounded_and_every_directory_is_a_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(BenchmarkError, match='a suite holds 1-100 cases'):
        load_suite(tmp_path)
    write_case(tmp_path, 'one')
    write_case(tmp_path, 'two')
    (tmp_path / 'notes.md').write_text('a file beside the cases is not one\n')
    assert [case.id for case in load_suite(tmp_path)] == ['one', 'two']
    monkeypatch.setattr(cases_module, 'MAX_BENCHMARK_CASES', 1)
    with pytest.raises(BenchmarkError, match='a suite holds 1-1 cases'):
        load_suite(tmp_path)
    monkeypatch.undo()
    (tmp_path / 'three').mkdir()
    with pytest.raises(BenchmarkError, match=r'a directory with its case\.json'):
        load_suite(tmp_path)


@pytest.mark.parametrize('path', ['', '..', 'a/../b', '/abs', '-flag', 'a//b', 'a/./b', '.git', 'x/.GIT/y', 'a*b',
                                  'back\\slash'])
def test_a_plain_path_stays_inside(path: str) -> None:
    with pytest.raises(BenchmarkError):
        plain_path(path, 'a path')


def test_a_plain_path_is_kept_as_it_is() -> None:
    assert plain_path('packages/units/', 'a path') == 'packages/units'
    assert plain_path('.github/workflows/ci.yml', 'a path') == '.github/workflows/ci.yml'
