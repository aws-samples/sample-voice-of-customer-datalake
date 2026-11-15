"""The role skills as benchmark candidates (benchmark/candidate.py): each skill, on the harness's own loop with a
scripted Converse model that answers with the case's known fix (or its expected findings), passes the shipped case
it applies to, and a version that gains on a failure's case passes the benchmark gate."""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from engineering.benchmark.candidate import NO_COMMAND, NO_HOST, SkillCandidate, _Ports, findings_of, tree_diff
from engineering.benchmark.cases import ReviewCheck
from engineering.benchmark.gate import benchmark_run, decide
from engineering.benchmark.runner import CandidateError, CaseView, patch_paths, run_suite
from engineering.benchmark.test.fixtures import CASES, DURATION, MONOREPO, REVIEW, SLUG, needs_node
from engineering.runtime.harness.skills import BUILDER, FIXER, PR_REVIEWER, Skill
from engineering.runtime.test.harness_fakes import FakeBedrock, use


def known_files(case_id: str, scratch: Path) -> dict[str, str]:
    """The files the case's known fix changes, as they read once it is applied (git apply on a copy)."""
    case = CASES[case_id]
    copy = scratch / f'{case_id}-fixed'
    shutil.copytree(case.fixture, copy)
    known = case.directory / 'known-fix.diff'
    subprocess.run(['git', 'apply', str(known)], cwd=copy, check=True, capture_output=True)  # noqa: S603, S607
    return {path: (copy / path).read_text() for path in patch_paths(known.read_text())}


def scripted_fix(case_id: str, scratch: Path) -> list[list[dict[str, Any]]]:
    """A model that reads each file the fix changes, writes it fixed, hands the change in and finishes."""
    files = known_files(case_id, scratch)
    turns = [[use('read_file', path=path)] for path in files]
    turns += [[use('write_file', path=path, text=text)] for path, text in files.items()]
    return [*turns, [use('submit_work', summary='the known fix')], [use('finish', summary='fixed')]]


def scripted_review(case_id: str) -> list[list[dict[str, Any]]]:
    """A model that reports every finding the review case expects, then finishes."""
    check = CASES[case_id].check
    assert isinstance(check, ReviewCheck)
    found = [{'file': f.file, 'line': f.first_line, 'severity': 'blocking', 'rule': f.rule, 'title': f.label}
             for f in check.findings]
    return [[use('write_findings', package='.', shard='review', findings=found)], [use('finish', summary='3 found')]]


def candidate(skill: Skill, turns: dict[str, list[list[dict[str, Any]]]]) -> SkillCandidate:
    """``skill`` answering each case with its scripted turns (none: it gives up at once)."""
    return SkillCandidate(skill, lambda case: FakeBedrock([list(turn) for turn in turns.get(case.id, [])]))


@pytest.mark.parametrize(('skill', 'case_id'), [
    (FIXER, SLUG), pytest.param(FIXER, MONOREPO, marks=needs_node), pytest.param(BUILDER, DURATION, marks=needs_node),
    (PR_REVIEWER, REVIEW)], ids=['fixer-slug', 'fixer-monorepo', 'builder-duration', 'pr-reviewer-pagination'])
def test_each_role_skill_passes_its_shipped_case_with_a_scripted_model(tmp_path: Path, skill: Skill, case_id: str):
    turns = scripted_review(case_id) if case_id == REVIEW else scripted_fix(case_id, tmp_path)
    card = run_suite([CASES[case_id]], candidate(skill, {case_id: turns}))
    result = card.results[0]
    assert (card.candidate, result.passed) == (f'{skill.name}@{skill.version}', True), result.why
    # Its tokens are the loop's own count: 100 in and 20 out a call, one call a turn and one after the finish's.
    assert (result.input_tokens, result.output_tokens) == (100 * len(turns), 20 * len(turns))


def test_a_fixer_that_gives_up_fails_and_a_version_that_fixes_the_case_passes_the_gate(tmp_path: Path):
    suite = [CASES[SLUG]]
    before = run_suite(suite, candidate(FIXER, {}))
    assert (before.results[0].passed, 'the check failed' in before.results[0].why) == (False, True)
    proposed = replace(FIXER, version=2, instructions=f'{FIXER.instructions}\n\nCheck a bound at exactly its limit.')
    after = run_suite(suite, candidate(proposed, {SLUG: scripted_fix(SLUG, tmp_path)}))
    verdict = decide(before, after, failure_case=SLUG)
    assert (verdict.passed, after.candidate) == (True, 'fixer@2')
    run = benchmark_run(before, after, verdict)
    assert (run.before, run.after, run.passed, run.failure_case) == (0.0, 1.0, True, SLUG)


def test_the_candidate_runs_no_repository_command_and_writes_nothing_to_a_host(tmp_path: Path):
    ports = _Ports()
    assert ports.run(['make'], timeout_seconds=1)['stderr_tail'] == NO_COMMAND
    assert (ports.submit('r', 'a', 't', 'k', 's'), ports.comment('r', 'a', number=1, body='b')['benchmark']) == (
        NO_HOST, NO_HOST)
    assert ports.push('r', 'a', branch='b', patch_key='k', tree_hash='t', message='m')['benchmark'] == NO_HOST
    assert ports.open_draft_pr('r', 'a', branch='b', title='t', body='b')['benchmark'] == NO_HOST
    with pytest.raises(CandidateError, match='the candidate gives it'):
        ports.brief(run_id='r', task_id='t')
    ports.heartbeat(run_id='r', task_id='t', agent_id='a')
    ports.done(['e1'])
    ports.resume({'after': 3})
    assert ports.said == ['heartbeat r/t a', 'done e1', "resumed at {'after': 3}"]
    # A fixer that tries to run the tests is told so, and its fix still reaches the check.
    turns = [[use('run', argv=['python3', '-m', 'unittest'])], *scripted_fix(SLUG, tmp_path)]
    model = FakeBedrock(turns)
    card = run_suite([CASES[SLUG]], SkillCandidate(FIXER, lambda _case: model))
    told = model.requests[1]['messages'][2]['content'][0]['toolResult']
    assert (card.results[0].passed, told['status'], NO_COMMAND in told['content'][0]['text']) == (True, 'error', True)
    # Its submit_work hands the patch in as in a session (the harness's own git answered from the two trees).
    submitted = [block['toolResult'] for message in model.requests[-1]['messages'] for block in message['content']
                 if 'toolResult' in block and 'broker' in block['toolResult']['content'][0]['text']]
    assert [(result['status'], NO_HOST in result['content'][0]['text']) for result in submitted] == [('success', True)]


def test_the_patch_is_the_difference_of_the_two_trees_as_git_reads_it(tmp_path: Path):
    before, after = tmp_path / 'before', tmp_path / 'after'
    for root in (before, after):
        (root / 'src').mkdir(parents=True)
    (before / 'src' / 'a.py').write_text('one\ntwo')
    (after / 'src' / 'a.py').write_text('one\nthree')
    (before / 'gone.txt').write_text('bye\n')
    (after / 'new.txt').write_text('hello\n')
    (after / 'empty.txt').write_text('')
    diff = tree_diff(before, after)
    assert patch_paths(diff) == ('empty.txt', 'gone.txt', 'new.txt', 'src/a.py')
    assert '\\ No newline at end of file' in diff
    subprocess.run(['git', 'apply', '--check', '-'], cwd=before, input=diff.encode(), check=True,  # noqa: S607
                   capture_output=True)
    (after / 'blob.bin').write_bytes(b'\xff\xfe')
    with pytest.raises(CandidateError, match='binary'):
        tree_diff(before, after)


def test_only_findings_on_a_line_are_reported(tmp_path: Path):
    del tmp_path
    shard = (b'{"schema": "voc-finding/1", "file": "a.py", "line": 3, "rule": ""}\n'
             b'{"schema": "voc-finding/1", "file": "a.py", "line": 0, "rule": "x"}\n'
             b'{"schema": "voc-note/1", "file": "a.py", "line": 4}\n')
    found = findings_of({'k/s.jsonl': shard, 'k/record.json': b'{}'})
    assert [(f.file, f.line, f.rule) for f in found] == [('a.py', 3, 'other')]


def test_a_case_view_is_solved_in_its_own_copy(tmp_path: Path):
    repository = tmp_path / 'view'
    shutil.copytree(CASES[SLUG].fixture, repository)
    view = CaseView(SLUG, 'bug', 'title', 'task', repository)
    attempt = candidate(FIXER, {SLUG: scripted_fix(SLUG, tmp_path)}).solve(view)
    assert patch_paths(attempt.diff) == ('slugs.py',)
    assert '+        if len(candidate) > max_length:' in attempt.diff
