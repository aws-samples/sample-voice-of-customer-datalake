"""The line's releases from package.json's history (a real git repository in a temp dir, isolated git config)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from feature_gate import gitio


@pytest.fixture(autouse=True)
def _isolated_git(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GIT_CONFIG_GLOBAL', '/dev/null')
    monkeypatch.setenv('GIT_CONFIG_NOSYSTEM', '1')


def git(repo: Path, *args: str) -> None:
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@example.com', *args],  # noqa: S603, S607 — git from PATH, fixed words
                   check=True, capture_output=True)


def commit_all(repo: Path, message: str) -> None:
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)


def bump(repo: Path, version: str, text: str | None = None) -> None:
    (repo / 'package.json').write_text(text or (json.dumps({'name': 'x', 'version': version}, indent=2) + '\n'))
    commit_all(repo, version)


def bootstrap(repo: Path, version: str = '7.105.0') -> None:
    """The commit that brings the gate: the allowed list appears, and the version moves."""
    (repo / 'docs/feature-tests').mkdir(parents=True)
    (repo / 'docs/feature-tests/allowed-gaps.json').write_text('{"gaps": {}}\n')
    bump(repo, version)


@pytest.fixture
def history(tmp_path: Path) -> Path:
    git(tmp_path, 'init', '-q', '-b', 'main')
    for version in ('6.04.8', '6.5.0', '7.103.0'):      # before the gate: not the gate's to judge
        bump(tmp_path, version)
    bootstrap(tmp_path)
    bump(tmp_path, '7.107.0')                           # 7.106 was skipped: it never existed
    (tmp_path / 'other.txt').write_text('x\n')
    commit_all(tmp_path, 'no bump')
    return tmp_path


def releases(repo: Path, limit: int = gitio.HISTORY_LIMIT, tip: str = 'HEAD') -> list[str]:
    return gitio.package_history(gitio.run_git(repo), limit=limit, tip=tip)


def test_the_releases_are_the_bumps_since_the_gate_came_newest_first(history: Path):
    assert releases(history) == ['7.107.00', '7.105.00']


def test_a_skipped_version_is_no_release(history: Path):
    assert '7.106.00' not in releases(history)


def test_before_the_gate_there_is_no_history_to_judge(tmp_path: Path):
    git(tmp_path, 'init', '-q', '-b', 'main')
    bump(tmp_path, '7.103.0')
    assert releases(tmp_path) == []


def test_a_release_just_before_the_gate_stays_outside_it(tmp_path: Path):
    """This line's own order: 7.104.0 (another release) is bumped, then the bootstrap commit adds the list and bumps to
    7.105.0 (the gate's release)."""
    git(tmp_path, 'init', '-q', '-b', 'main')
    bump(tmp_path, '7.103.0')
    bump(tmp_path, '7.104.0')
    bootstrap(tmp_path, '7.105.0')
    assert gitio.package_history_report(gitio.run_git(tmp_path)) == (['7.105.00'], [])


def test_the_history_is_bounded(history: Path):
    assert releases(history, limit=1) == ['7.107.00']


@pytest.mark.parametrize('text', ['{\n\t"name": "x",\n\t"version": "7.108.0"\n}\n',
                                  '{"name": "x", "version": "7.108.0"}\n',
                                  '{\n    "version"  :   "7.108.0",\n    "name": "x"\n}\n'])
def test_any_formatting_of_package_json_is_read(history: Path, text: str):
    bump(history, '7.108.0', text)
    assert releases(history)[0] == '7.108.00'


def test_git_settings_cannot_hide_a_bump(history: Path):
    (history / '.gitattributes').write_text('package.json -diff\n')
    git(history, 'config', 'color.ui', 'always')
    git(history, 'config', 'log.showSignature', 'true')
    git(history, 'config', 'log.follow', 'true')
    git(history, 'config', 'log.diffMerges', 'separate')
    bump(history, '7.108.0')
    assert releases(history)[0] == '7.108.00'
    assert gitio.package_history_report(gitio.run_git(history))[1] == []


def head_of(repo: Path, rev: str = 'HEAD') -> str:
    return subprocess.run(['git', '-C', str(repo), 'rev-parse', rev], check=True, capture_output=True,  # noqa: S603, S607 — git from PATH, fixed words
                          text=True).stdout.strip()


def test_the_gate_arriving_by_a_merge_bounds_the_walk(tmp_path: Path):
    """The gate lands on the line by a merge on its first parent: the merge is the bootstrap commit."""
    git(tmp_path, 'init', '-q', '-b', 'main')
    bump(tmp_path, '7.103.0')
    git(tmp_path, 'switch', '-q', '-c', 'gate')
    bootstrap(tmp_path)
    git(tmp_path, 'switch', '-q', 'main')
    (tmp_path / 'other.txt').write_text('x\n')
    commit_all(tmp_path, 'the line moves meanwhile')
    git(tmp_path, 'merge', '-q', '--no-ff', '-m', 'merge the gate', 'gate')
    merge = head_of(tmp_path)
    bump(tmp_path, '7.106.0')
    run = gitio.run_git(tmp_path)
    assert gitio.bootstrap_commit(run) == merge
    assert gitio.package_history_report(run) == (['7.106.00', '7.105.00'], [])


def test_a_bump_below_the_one_before_is_a_problem(history: Path):
    """A pushed release is never renumbered: 7.60.0 after 7.107.0 is no release of its own."""
    bump(history, '7.60.0')
    versions, problems = gitio.package_history_report(gitio.run_git(history))
    assert versions == ['7.60.00', '7.107.00', '7.105.00']
    assert problems == [(f"{head_of(history)[:12]}: package.json's version 7.60.00 is not above the bump before it "
                         '(7.107.00): a pushed bump is never renumbered')]


def test_the_first_bump_of_the_gate_is_not_before_it(tmp_path: Path):
    git(tmp_path, 'init', '-q', '-b', 'main')
    bootstrap(tmp_path, '7.103.0')
    problems = gitio.package_history_report(gitio.run_git(tmp_path))[1]
    assert problems == [f"{head_of(tmp_path)[:12]}: package.json's version 7.103.00 is before the gate's (7.105.00)"]


def test_a_merged_branchs_own_bumps_are_not_this_lines(history: Path):
    git(history, 'switch', '-q', '-c', 'side')
    bump(history, '7.107.1')
    bump(history, '7.107.2')
    git(history, 'switch', '-q', 'main')
    bump(history, '7.108.0')
    git(history, 'merge', '-q', '--no-ff', '-X', 'ours', '-m', 'merge side', 'side')
    got = releases(history)
    assert '7.107.01' not in got
    assert got[0] == '7.108.00'


def test_a_pr_into_another_line_walks_the_prs_own_line(history: Path):
    """A PR's merge ref: HEAD^1 is the target (main, with bumps of its own), HEAD^2 the PR's head (this line)."""
    git(history, 'switch', '-q', '-c', 'line')
    bump(history, '7.108.0')
    git(history, 'switch', '-q', 'main')
    git(history, 'reset', '-q', '--hard', 'HEAD~4')       # main before the gate, with a bump of its own
    bump(history, '7.05.1')
    git(history, 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge the PR', 'line')
    assert releases(history, tip='HEAD^2') == ['7.108.00', '7.107.00', '7.105.00']
    assert '7.05.01' not in releases(history, tip='HEAD^2')


def test_a_re_added_allowed_list_keeps_the_oldest_bound(history: Path):
    (history / 'docs/feature-tests/allowed-gaps.json').unlink()
    commit_all(history, 'drop the list')
    (history / 'docs/feature-tests/allowed-gaps.json').write_text('{"gaps": {}}\n')
    bump(history, '7.108.0')
    assert releases(history) == ['7.108.00', '7.107.00', '7.105.00']


def test_a_bootstrap_commit_that_does_not_bump_bounds_the_walk(tmp_path: Path):
    git(tmp_path, 'init', '-q', '-b', 'main')
    bump(tmp_path, '7.103.0')
    (tmp_path / 'docs/feature-tests').mkdir(parents=True)
    (tmp_path / 'docs/feature-tests/allowed-gaps.json').write_text('{"gaps": {}}\n')
    commit_all(tmp_path, 'the gate, no bump')
    bump(tmp_path, '7.105.0')
    assert releases(tmp_path) == ['7.105.00']   # 7.103 is before the gate, even with no bump in the bootstrap commit


def test_a_version_that_is_not_plain_is_reported_not_skipped(history: Path):
    bump(history, '7.108.0-rc.1')
    versions, problems = gitio.package_history_report(gitio.run_git(history))
    assert versions == ['7.107.00', '7.105.00']
    assert len(problems) == 1
    assert problems[0].endswith(": package.json's version '7.108.0-rc.1' is not MAJOR.MINOR.PATCH")


def test_no_history_is_an_empty_list():
    assert gitio.package_history(lambda _args: None) == []
