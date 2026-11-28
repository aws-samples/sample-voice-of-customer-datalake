"""The CLI end to end on a planted repository: check, baseline, register, brief, accept, reject, the base branch."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import planted
import pytest
from feature_gate import checks, cli, records, registry, resolve, verdict

REF = planted.REF


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ('FEATURE_GATE_SESSION', 'FEATURE_GATE_BASE_REF', 'FEATURE_GATE_ESCALATIONS', 'GITHUB_ACTIONS',
                 'GITHUB_EVENT_NAME'):
        monkeypatch.delenv(name, raising=False)


def run(repo: Path, *argv: str, git: planted.FakeGit | None = None) -> int:
    return cli.main(list(argv), root=repo, git=git or planted.FakeGit(base={}))


def out_of(capsys: pytest.CaptureFixture[str]) -> str:
    captured = capsys.readouterr()
    return captured.out + captured.err


def entry_of(repo: Path, item_id: str, layer: str) -> dict[str, Any]:
    return registry.load(repo).by_id[item_id][layer][0]


def set_item(repo: Path, item_id: str, **change: Any) -> None:
    reg = registry.load(repo)
    reg.by_id[item_id].update(change)
    registry.save(repo, reg)


def test_check_fails_before_the_baseline_and_passes_after_it(repo: Path, capsys: pytest.CaptureFixture[str]):
    assert run(repo, 'check') == 1
    out = out_of(capsys)
    assert '6.05.00: new gap unit (register an accepted test or a reviewed exemption)' in out
    assert 'no docs/feature-tests/allowed-gaps.json: run' in out
    assert run(repo, 'baseline', '--init') == 0
    assert 'allowed gaps: 5' in out_of(capsys)
    assert run(repo, 'check') == 0
    assert out_of(capsys).endswith('3 items, 0 tests registered (0 accepted), 5 gaps: ok\n')


def test_baseline_init_runs_once(repo: Path, capsys: pytest.CaptureFixture[str]):
    assert run(repo, 'baseline', '--init') == 0
    assert run(repo, 'baseline', '--init') == 2
    assert 'already exists: the baseline is written once' in out_of(capsys)


def test_a_release_with_no_registry_item_fails_the_check(repo: Path, capsys: pytest.CaptureFixture[str]):
    planted.write_registry(repo, planted.default_items() | {'phase3-switch': []})
    run(repo, 'baseline', '--init')
    assert run(repo, 'check') == 1
    assert '7.76.00: a CHANGELOG release with no registry item' in out_of(capsys)


def test_an_item_in_the_wrong_slice_file_fails(repo: Path, capsys: pytest.CaptureFixture[str]):
    planted.write_registry(repo, planted.default_items() | {'phase3a-4': [planted.item('6.06.00', 'fix')]})
    run(repo, 'baseline', '--init')
    assert run(repo, 'check') == 1
    assert '6.06.00: belongs in docs/feature-tests/phase1-2.json' in out_of(capsys)


def test_a_released_version_cannot_be_planned(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    set_item(repo, '7.76.00', status='planned')
    assert run(repo, 'check') == 1
    assert '7.76.00: a planned item takes a plan id (lowercase words), never a release number' in out_of(capsys)


def test_a_planned_item_never_takes_a_release_number_even_unreleased(repo: Path, capsys: pytest.CaptureFixture[str]):
    planted.write_registry(repo, planted.default_items() | {
        'phase3-switch': [planted.item('7.76.00', 'feature'), planted.item('7.110.00', 'no-behaviour', status='planned')]})
    run(repo, 'baseline', '--init')
    assert run(repo, 'check') == 1
    assert '7.110.00: a planned item takes a plan id (lowercase words), never a release number' in out_of(capsys)


def test_a_release_first_registered_as_planned_takes_the_new_items_floor(repo: Path,
                                                                        capsys: pytest.CaptureFixture[str]):
    """Step 1 landed a planned 7.75.01 of kind no-behaviour; step 2 ships it done with a "Tooling only:" intro."""
    run(repo, 'baseline', '--init')
    base = planted.base_from(repo)
    step1 = planted.default_items() | {'product-7.5x-7.7x': [planted.item('7.75.01', 'no-behaviour', status='planned')]}
    planted.write_registry(repo, step1)
    base['docs/feature-tests/product-7.5x-7.7x.json'] = (repo / 'docs/feature-tests/product-7.5x-7.7x.json').read_text()
    planted.write_registry(repo, planted.default_items())
    out = check_with(repo, planted.FakeGit(base=base), capsys)[1]
    assert '7.75.01: kind feature -> no-behaviour needs a reviewed decision record' in out


def test_seed_adds_the_missing_releases(repo: Path, capsys: pytest.CaptureFixture[str]):
    planted.write_registry(repo, {})
    assert run(repo, 'seed') == 0
    assert 'seeded 3 item(s)' in out_of(capsys)
    assert [it['id'] for it in registry.load(repo).items] == ['6.05.00', '7.75.01', '7.76.00']
    assert run(repo, 'seed') == 0
    assert 'seeded 0 item(s)' in out_of(capsys)


def register(repo: Path, item_id: str, test_id: str, session: str | None = 'h2/a') -> int:
    return run(repo, 'register', item_id, test_id, *(['--session', session] if session else []))


def test_register_records_a_resolved_test_with_its_digest(repo: Path):
    assert register(repo, '7.76.00', planted.PYTEST_ID) == 0
    got = entry_of(repo, '7.76.00', 'unit')
    assert got == {'runner': 'pytest', 'node': planted.PYTEST_ID, 'written_by': 'h2/a', 'accepted_by': None,
                   'accepted_at': None, 'digest': resolve.resolve(repo, got).digest, 'verdict': None, 'rejections': []}
    assert register(repo, '7.76.00', planted.SPEC_ID) == 0
    assert entry_of(repo, '7.76.00', 'e2e')['runner'] == 'playwright'


def test_the_session_comes_from_the_environment_when_not_given(repo: Path, monkeypatch: pytest.MonkeyPatch,
                                                               capsys: pytest.CaptureFixture[str]):
    assert register(repo, '7.76.00', planted.PYTEST_ID, session=None) == 2
    assert 'no session: pass --session or set FEATURE_GATE_SESSION' in out_of(capsys)
    monkeypatch.setenv('FEATURE_GATE_SESSION', 'h7/x')
    assert register(repo, '7.76.00', planted.PYTEST_ID, session=None) == 0
    assert entry_of(repo, '7.76.00', 'unit')['written_by'] == 'h7/x'


def test_register_refuses_a_skipped_test_and_a_second_copy(repo: Path, capsys: pytest.CaptureFixture[str]):
    skipped = 'voc-datalake/lambda/api/test/test_widget.py::TestWidget::test_skipped'
    assert register(repo, '7.76.00', skipped) == 2
    assert 'test_skipped is marked skip' in out_of(capsys)
    assert register(repo, '7.76.00', planted.PYTEST_ID) == 0
    assert register(repo, '7.76.00', planted.PYTEST_ID) == 2
    assert 'is already registered for 7.76.00' in out_of(capsys)


def test_brief_gives_the_section_the_test_and_the_command_and_nothing_from_the_author(
        repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID, session='author-session-42/x')
    capsys.readouterr()
    assert run(repo, 'brief', '7.76.00', planted.PYTEST_ID) == 0
    out = out_of(capsys)
    for part in ('## [7.76.00] - 2026-11-26', '- The count.', f'Test: {planted.PYTEST_ID}',
                 f'Command (from the repository root): {resolve.command(resolve.entry_from_id(planted.PYTEST_ID))}',
                 'docs/test-verdicts/TEMPLATE.md', f'Verdict file: {verdict.verdict_path("7.76.00", "pytest", planted.PYTEST_ID)}'):
        assert part in out, part
    assert 'author-session-42' not in out


def verdict_for(repo: Path, item_id: str = '7.76.00', test: str = planted.PYTEST_ID, **change: Any) -> str:
    entry = next(e for layer in ('unit', 'e2e') for e in registry.load(repo).by_id[item_id][layer]
                 if resolve.test_id(e) == test)
    args: dict[str, Any] = {'item_id': item_id, 'test': test, 'digest': resolve.resolve(repo, entry).digest,
                            'command': resolve.command(entry)}
    return planted.verdict_file(repo, item_id, entry['runner'], test, planted.verdict_text(**(args | change)))


def accept_setup(repo: Path, **change: Any) -> str:
    """Registers the pytest test as h2/a and writes a verdict for it (ACCEPT unless changed)."""
    register(repo, '7.76.00', planted.PYTEST_ID)
    return verdict_for(repo, **change)


def decide(repo: Path, action: str, path: str, session: str = 'eval-1/a', git: planted.FakeGit | None = None) -> int:
    return run(repo, action, '7.76.00', planted.PYTEST_ID, '--verdict', path, '--session', session, git=git)


def test_accept_records_the_evaluator_the_sha_and_the_verdict(repo: Path):
    path = accept_setup(repo)
    assert decide(repo, 'accept', path) == 0
    got = entry_of(repo, '7.76.00', 'unit')
    assert (got['accepted_by'], got['accepted_at'], got['verdict']) == ('eval-1/a', planted.SHA, path)


@pytest.mark.parametrize(('session', 'change', 'message'), [
    ('h2/a', {'evaluator': 'h2/a'}, "the evaluator h2/a is the author h2/a or the author's own sub-agent"),
    ('h2/sub-agent', {'evaluator': 'h2/sub-agent'}, "the evaluator h2/sub-agent is the author h2/a or the author's own sub-agent"),
    ('eval-2/a', {}, "the verdict's evaluator eval-1/a is not the session eval-2/a"),
    ('eval-1/a', {'author': 'h9/z'}, "the verdict's author h9/z is not the test's author h2/a"),
    ('eval-1/a', {'digest': 'b' * 64}, "the verdict's digest " + 'b' * 64 + " is not the test's"),
    ('eval-1/a', {'outcome': 'REJECT'}, 'the verdict is REJECT; this needs ACCEPT'),
    ('eval-1/a', {'sections': {'Red': ''}}, 'Red: no output of the test failing on the break'),
    ('eval-1/a', {'sha': 'HEAD'}, "sha: 'HEAD' is not a commit sha"),
    ('eval-1/a', {'sha': 'abcdef1'}, 'the sha abcdef1 is not a commit of this repository'),
])
def test_accept_refuses_the_author_and_missing_evidence(repo: Path, capsys: pytest.CaptureFixture[str],
                                                        session: str, change: dict[str, Any], message: str):
    path = accept_setup(repo, **change)
    capsys.readouterr()
    assert decide(repo, 'accept', path, session) == 2
    assert message in out_of(capsys)
    assert entry_of(repo, '7.76.00', 'unit')['accepted_by'] is None


def test_accept_refuses_a_sha_that_is_not_head_or_its_ancestor(repo: Path, capsys: pytest.CaptureFixture[str]):
    path = accept_setup(repo)
    git = planted.FakeGit(base={}, chain=(planted.BASE_SHA, planted.HEAD))
    assert decide(repo, 'accept', path, git=git) == 2
    assert f'the sha {planted.SHA} is not a commit of this repository' in out_of(capsys)


def test_accept_refuses_a_verdict_outside_its_place(repo: Path, capsys: pytest.CaptureFixture[str]):
    path = accept_setup(repo)
    moved = planted.write(repo, 'docs/elsewhere.md', (repo / path).read_text())
    assert decide(repo, 'accept', str(moved.relative_to(repo))) == 2
    assert f'the verdict file must be {path}' in out_of(capsys)


def accepted_and_baselined(repo: Path) -> None:
    assert decide(repo, 'accept', accept_setup(repo)) == 0
    assert run(repo, 'baseline', '--init') == 0


def test_check_holds_an_accepted_test_to_its_verdict_and_its_source(repo: Path, capsys: pytest.CaptureFixture[str]):
    accepted_and_baselined(repo)
    assert run(repo, 'check') == 0
    test_file = repo / 'voc-datalake/lambda/api/test/test_widget.py'
    test_file.write_text(test_file.read_text().replace('1 + 1 == 2', '2 == 2'))
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert "the verdict's digest" in out_of(capsys)


@pytest.mark.parametrize(('change', 'message'), [
    ({'accepted_by': 'h2/b'}, "the evaluator h2/b is the author h2/a or the author's own sub-agent"),
    ({'accepted_at': 'abcdef1234'}, f"accepted_at abcdef1234 is not the verdict's sha {planted.SHA}"),
    ({'written_by': 'eval-1/z'}, "the evaluator eval-1/a is the author eval-1/z or the author's own sub-agent"),
])
def test_check_catches_an_acceptance_edited_by_hand(repo: Path, capsys: pytest.CaptureFixture[str],
                                                    change: dict[str, Any], message: str):
    accepted_and_baselined(repo)
    reg = registry.load(repo)
    reg.by_id['7.76.00']['unit'][0].update(change)
    registry.save(repo, reg)
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert message in out_of(capsys)


def test_an_accepted_unit_shrinks_the_gaps(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    decide(repo, 'accept', accept_setup(repo))
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert '7.76.00: unit is no longer a gap' in out_of(capsys)
    assert run(repo, 'baseline', '--shrink') == 0
    assert 'allowed gaps: 4 (was 5)' in out_of(capsys)
    assert run(repo, 'check') == 0


def reject_file(repo: Path, n: int, **change: Any) -> str:
    """The n-th REJECT verdict of the registered pytest test, at its own path."""
    rel = verdict.reject_path('7.76.00', 'pytest', planted.PYTEST_ID, n)
    entry = entry_of(repo, '7.76.00', 'unit')
    args: dict[str, Any] = {'item_id': '7.76.00', 'test': planted.PYTEST_ID, 'outcome': 'REJECT',
                            'digest': resolve.resolve(repo, entry).digest, 'command': resolve.command(entry)}
    planted.write(repo, rel, planted.verdict_text(**(args | change)))
    return rel


def reject_twice(repo: Path) -> None:
    register(repo, '7.76.00', planted.PYTEST_ID)
    assert decide(repo, 'reject', reject_file(repo, 1, checks={'fails_on_break': False})) == 0
    assert entry_of(repo, '7.76.00', 'unit').get('needs_rewrite') is None
    assert decide(repo, 'reject', reject_file(repo, 2, evaluator='eval-2/b'), 'eval-2/b') == 0


def test_a_reject_goes_to_its_numbered_path(repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID)
    wrong = reject_file(repo, 2)
    assert decide(repo, 'reject', wrong) == 2
    assert f'the verdict file must be {verdict.reject_path("7.76.00", "pytest", planted.PYTEST_ID, 1)}' in out_of(capsys)


def test_check_counts_the_reject_files_against_the_rejections(repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID)
    decide(repo, 'reject', reject_file(repo, 1))
    run(repo, 'baseline', '--init')
    assert run(repo, 'check') == 0
    reject_file(repo, 2)
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert f'7.76.00: {planted.PYTEST_ID}: 2 REJECT verdict file(s), 1 rejection(s) recorded' in out_of(capsys)


def test_a_second_reject_asks_for_a_rewrite_and_records_the_escalation(repo: Path, tmp_path_factory: pytest.TempPathFactory,
                                                                       monkeypatch: pytest.MonkeyPatch,
                                                                       capsys: pytest.CaptureFixture[str]):
    ledger = tmp_path_factory.mktemp('briefs') / 'escalations.md'
    monkeypatch.setenv('FEATURE_GATE_ESCALATIONS', str(ledger))
    reject_twice(repo)
    got = entry_of(repo, '7.76.00', 'unit')
    assert [r['by'] for r in got['rejections']] == ['eval-1/a', 'eval-2/b']
    assert got['needs_rewrite'] is True
    line = ('escalate: voc-datalake/lambda/api/test/test_widget.py::TestWidget::test_counts: rejected twice for '
            '7.76.00; a rewrite session makes the code testable')
    assert line in out_of(capsys)
    assert ledger.read_text() == line + '\n'


REWRITE_REL = f'docs/test-verdicts/7.76.00/{records.rewrite_name(planted.PYTEST_ID)}'


def rewrite_reviewed(repo: Path, reviewer: str = 'eval-9/x') -> int:
    assert run(repo, 'propose-change', '7.76.00', '--rewrite', planted.PYTEST_ID, '--reason', 'The code was split.',
               '--session', 'h2/a') == 0
    return run(repo, 'review-change', '7.76.00', '--rewrite', planted.PYTEST_ID, '--sha', planted.SHA, '--tree',
               planted.TREE, '--session', reviewer)


def test_a_test_rejected_twice_is_accepted_only_after_a_reviewed_rewrite(repo: Path, capsys: pytest.CaptureFixture[str]):
    reject_twice(repo)
    # Changing the test (or the code) is not enough: digests say nothing of who judged the rewrite.
    test_file = repo / 'voc-datalake/lambda/api/test/test_widget.py'
    test_file.write_text(test_file.read_text().replace('1 + 1 == 2', '1 + 1 == 2  # rewritten'))
    path = verdict_for(repo, evaluator='eval-3/c')
    capsys.readouterr()
    assert decide(repo, 'accept', path, 'eval-3/c') == 2
    assert (f'{planted.PYTEST_ID} needs a rewrite: a reviewed `rewrite {planted.PYTEST_ID}` record ({REWRITE_REL}) '
            'clears it') in out_of(capsys)
    assert rewrite_reviewed(repo, reviewer='h2/b') == 2
    assert "the reviewer h2/b shares the proposer h2/a's root" in out_of(capsys)
    assert rewrite_reviewed(repo) == 0
    assert decide(repo, 'accept', path, 'eval-3/c') == 0
    assert 'needs_rewrite' not in entry_of(repo, '7.76.00', 'unit')


def test_check_refuses_an_acceptance_after_two_rejects_without_a_reviewed_rewrite(repo: Path,
                                                                                 capsys: pytest.CaptureFixture[str]):
    reject_twice(repo)
    rewrite_reviewed(repo)
    decide(repo, 'accept', verdict_for(repo, evaluator='eval-3/c'), 'eval-3/c')
    run(repo, 'baseline', '--init')
    assert run(repo, 'check') == 0
    (repo / REWRITE_REL).unlink()
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert (f'7.76.00: {planted.PYTEST_ID}: accepted after 2 REJECTs without a reviewed `rewrite {planted.PYTEST_ID}` '
            f'record ({REWRITE_REL})') in out_of(capsys)


def test_a_rejection_records_who_when_and_on_what(repo: Path):
    reject_twice(repo)
    last = entry_of(repo, '7.76.00', 'unit')['rejections'][-1]
    assert set(last) == {'by', 'at', 'digest', 'reasons'}   # nothing hashed from the break's paths (S-1, Q-5)


def test_reject_refuses_the_author(repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID)
    assert decide(repo, 'reject', reject_file(repo, 1, evaluator='h2/b'), 'h2/b') == 2
    assert "the evaluator h2/b is the author h2/a" in out_of(capsys)


def test_the_escalations_file_is_never_reached_through_a_link(repo: Path, tmp_path_factory: pytest.TempPathFactory,
                                                             monkeypatch: pytest.MonkeyPatch,
                                                             capsys: pytest.CaptureFixture[str]):
    folder = tmp_path_factory.mktemp('briefs')
    (folder / 'escalations.md').symlink_to(folder / 'elsewhere.md')
    monkeypatch.setenv('FEATURE_GATE_ESCALATIONS', str(folder / 'escalations.md'))
    reject_twice(repo)
    assert 'cannot append to' in out_of(capsys)
    assert not (folder / 'elsewhere.md').exists()


# ---- the base branch ----

def based(repo: Path) -> planted.FakeGit:
    """Baselined, and the tree as it is now is the base branch's."""
    assert run(repo, 'baseline', '--init') == 0
    return planted.FakeGit(base=planted.base_from(repo))


def check_with(repo: Path, git: planted.FakeGit, capsys: pytest.CaptureFixture[str], *extra: str) -> tuple[int, str]:
    capsys.readouterr()
    code = run(repo, 'check', *extra, git=git)
    return code, out_of(capsys)


def test_a_missing_base_ref_is_told_apart_from_an_absent_file(repo: Path, capsys: pytest.CaptureFixture[str],
                                                              monkeypatch: pytest.MonkeyPatch):
    run(repo, 'baseline', '--init')
    code, out = check_with(repo, planted.FakeGit(base={}), capsys)
    assert (code, 'WARNING' in out) == (0, False)
    code, out = check_with(repo, planted.FakeGit(base=None), capsys)
    assert code == 0
    assert f'WARNING: the base ref {REF} does not exist here' in out
    code, out = check_with(repo, planted.FakeGit(base=None), capsys, '--strict-base')
    assert code == 1
    assert f'the base ref {REF} does not exist (--strict-base or CI): fetch it' in out
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    assert check_with(repo, planted.FakeGit(base=None), capsys)[0] == 1


@pytest.mark.parametrize('ref', ['-x', '--upload-pack=x', 'a b', 'a..b'])
def test_a_base_ref_that_could_be_an_option_is_refused(repo: Path, monkeypatch: pytest.MonkeyPatch,
                                                       capsys: pytest.CaptureFixture[str], ref: str):
    monkeypatch.setenv('FEATURE_GATE_BASE_REF', ref)
    assert run(repo, 'check') == 2
    assert 'is not a branch or ref name' in out_of(capsys)


def decision(repo: Path, item_id: str, change: str, **kw: Any) -> None:
    planted.write(repo, verdict.record_path(item_id, 'decision.md'), planted.record_text(item_id=item_id, change=change, **kw))


def test_a_lower_kind_needs_a_reviewed_decision(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    set_item(repo, '7.76.00', kind='plumbing')
    code, out = check_with(repo, git, capsys)
    assert code == 1
    assert '7.76.00: kind feature -> plumbing needs a reviewed decision record (docs/test-verdicts/7.76.00/decision.md)' in out
    decision(repo, '7.76.00', 'kind feature -> plumbing', proposed_by='h2/a', reviewer='h2/b')
    assert "the reviewer h2/b shares the proposer h2/a's root" in check_with(repo, git, capsys)[1]
    decision(repo, '7.76.00', 'kind feature -> plumbing')
    code, out = check_with(repo, git, capsys)
    assert 'decision' not in out
    assert '7.76.00: e2e is no longer a gap' in out
    run(repo, 'baseline', '--shrink', git=git)
    assert check_with(repo, git, capsys)[0] == 0


def test_a_higher_kind_needs_no_decision(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    set_item(repo, '7.75.01', kind='plumbing')
    code, out = check_with(repo, git, capsys)
    assert 'decision' not in out
    assert '7.75.01: new gap unit' in out
    assert code == 1


def test_a_removed_item_needs_a_reviewed_decision(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    planted.write_registry(repo, planted.default_items() | {'phase1-2': []})
    out = check_with(repo, git, capsys)[1]
    assert '6.05.00: removed needs a reviewed decision record' in out


def test_a_refined_item_carries_its_gaps_to_its_slices(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    slices = [planted.item('6.05.00/admins', 'feature'), planted.item('6.05.00/group', 'feature')]
    planted.write_registry(repo, planted.default_items() | {'phase1-2': slices})
    code, out = check_with(repo, git, capsys)
    assert code == 1
    assert '6.05.00: refine -> 6.05.00/admins (feature), 6.05.00/group (feature) needs a reviewed decision record' in out
    decision(repo, '6.05.00', 'refine -> 6.05.00/admins (feature), 6.05.00/group (feature)')
    code, out = check_with(repo, git, capsys)
    assert (code, out.splitlines()[-1]) == (0, 'feature_gate check: 4 items, 0 tests registered (0 accepted), 7 gaps: ok')
    assert run(repo, 'baseline', '--shrink', git=git) == 0
    assert set(planted.load_json(repo / 'docs/feature-tests/allowed-gaps.json')['gaps']) == {
        '6.05.00/admins', '6.05.00/group', '7.75.01', '7.76.00'}


def rejected_once_and_based(repo: Path) -> planted.FakeGit:
    register(repo, '7.76.00', planted.PYTEST_ID)
    decide(repo, 'reject', reject_file(repo, 1))
    return based(repo)


def edit_entry(repo: Path, item_id: str = '7.76.00', **change: Any) -> None:
    reg = registry.load(repo)
    reg.by_id[item_id]['unit'][0].update(change)
    registry.save(repo, reg)


@pytest.mark.parametrize(('change', 'message'), [
    ({'rejections': []}, "0 rejection(s), fewer than the base branch's 1"),
    ('reasons', "its rejections are not the base branch's followed by new ones (a REJECT is never rewritten)"),
    ({'written_by': 'h7/z'}, "written_by h7/z is not the base branch's h2/a (the author of a test never changes)"),
])
def test_an_entry_keeps_its_history_against_the_base_branch(repo: Path, capsys: pytest.CaptureFixture[str],
                                                            change: Any, message: str):
    git = rejected_once_and_based(repo)
    if change == 'reasons':
        rejections = entry_of(repo, '7.76.00', 'unit')['rejections']
        change = {'rejections': [rejections[0] | {'reasons': 'Fine after all.'}]}
    edit_entry(repo, **change)
    assert f'7.76.00: {planted.PYTEST_ID}: {message}' in check_with(repo, git, capsys)[1]


def test_a_refined_items_rejections_are_found_in_its_slices(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = rejected_once_and_based(repo)
    entry = entry_of(repo, '7.76.00', 'unit')
    slices = [planted.item('7.76.00/a', 'feature', unit=[entry]), planted.item('7.76.00/b', 'feature')]
    planted.write_registry(repo, planted.default_items() | {'phase3-switch': slices})
    decision(repo, '7.76.00', 'refine -> 7.76.00/a (feature), 7.76.00/b (feature)')
    out = check_with(repo, git, capsys)[1]
    assert 'rejection' not in out
    # A reviewed refine also lets the rejected test go; without that record it is refused.
    slices[0]['unit'] = []
    planted.write_registry(repo, planted.default_items() | {'phase3-switch': slices})
    assert 'rejection' not in check_with(repo, git, capsys)[1]
    (repo / 'docs/test-verdicts/7.76.00/decision.md').unlink()
    out = check_with(repo, git, capsys)[1]
    assert f'7.76.00: {planted.PYTEST_ID}: its 1 rejection(s) left the registry' in out


# ---- the seeded kind ----

def test_a_kind_below_the_seeded_one_needs_a_decision_without_any_base(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    set_item(repo, '7.76.00', kind='plumbing')
    out = check_with(repo, planted.FakeGit(base={}), capsys)[1]
    assert '7.76.00: kind feature -> plumbing needs a reviewed decision record (docs/test-verdicts/7.76.00/decision.md)' in out


def test_a_slice_item_takes_its_versions_seeded_kind(repo: Path, capsys: pytest.CaptureFixture[str]):
    planted.write_registry(repo, planted.default_items() | {'phase1-2': [planted.item('6.05.00/x', 'fix')]})
    run(repo, 'baseline', '--init')
    out = check_with(repo, planted.FakeGit(base={}), capsys)[1]
    assert '6.05.00/x: kind feature -> fix needs a reviewed decision record (docs/test-verdicts/6.05.00/x/decision.md)' in out


def test_a_refine_names_its_slices_kinds_and_covers_them(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    slices = [planted.item('6.05.00/a', 'feature'), planted.item('6.05.00/b', 'plumbing')]
    planted.write_registry(repo, planted.default_items() | {'phase1-2': slices})
    decision(repo, '6.05.00', 'refine -> 6.05.00/a (feature), 6.05.00/b (feature)')
    out = check_with(repo, git, capsys)[1]
    assert ("6.05.00: refine -> 6.05.00/a (feature), 6.05.00/b (plumbing) needs a reviewed decision record "
            "(docs/test-verdicts/6.05.00/decision.md): the record docs/test-verdicts/6.05.00/decision.md says") in out
    decision(repo, '6.05.00', 'refine -> 6.05.00/a (feature), 6.05.00/b (plumbing)')
    out = check_with(repo, git, capsys)[1]
    assert 'decision' not in out


# ---- propose-change / review-change ----

def propose(repo: Path, change: str = 'kind feature -> plumbing', session: str = 'h2/a') -> int:
    return run(repo, 'propose-change', '7.76.00', '--change', change, '--reason', 'It adds no route.', '--session', session)


def review_change(repo: Path, session: str = 'eval-1/a', sha: str = planted.SHA,
                  git: planted.FakeGit | None = None) -> int:
    return run(repo, 'review-change', '7.76.00', '--sha', sha, '--tree', planted.TREE, '--session', session, git=git)


def test_a_change_is_proposed_by_one_session_and_reviewed_by_another(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    set_item(repo, '7.76.00', kind='plumbing')
    assert propose(repo) == 0
    record = verdict.parse((repo / 'docs/test-verdicts/7.76.00/decision.md').read_text())
    assert (record.front['change'], record.front['proposed_by'], record.front['reviewer']) == (
        'kind feature -> plumbing', 'h2/a', '')
    assert 'decision' in check_with(repo, git, capsys)[1]   # proposed, not reviewed
    assert review_change(repo, session='h2/b') == 2
    assert "the reviewer h2/b shares the proposer h2/a's root" in out_of(capsys)
    assert review_change(repo) == 0
    assert 'decision' not in check_with(repo, git, capsys)[1]


def test_a_reviewed_sha_must_descend_from_the_base_branch(repo: Path, capsys: pytest.CaptureFixture[str]):
    old = 'a' * 40
    git = planted.FakeGit(base=planted.base_from(planted.plant(repo)), chain=(old, planted.BASE_SHA, planted.SHA, planted.HEAD))
    run(repo, 'baseline', '--init', git=git)
    set_item(repo, '7.76.00', kind='plumbing')
    propose(repo)
    assert review_change(repo, sha=old, git=git) == 2
    assert f"the sha {old} does not descend from the base branch's commit {planted.BASE_SHA}" in out_of(capsys)


def lowered_and_reviewed(repo: Path) -> planted.FakeGit:
    """Based, 7.76.00 lowered to plumbing, and that change proposed by h2/a and reviewed by eval-1/a."""
    git = based(repo)
    set_item(repo, '7.76.00', kind='plumbing')
    propose(repo)
    review_change(repo)
    return git


def test_a_decision_is_not_reused_after_the_base_moved(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = lowered_and_reviewed(repo)
    assert 'decision' not in check_with(repo, git, capsys)[1]
    # Raised again, which lands as a later base; then lowered once more: the old record no longer holds.
    set_item(repo, '7.76.00', kind='feature')
    newer = 'c' * 40
    moved = planted.FakeGit(base=planted.base_from(repo), chain=(planted.BASE_SHA, planted.SHA, newer, planted.HEAD),
                            ref=newer)
    set_item(repo, '7.76.00', kind='plumbing')
    out = check_with(repo, moved, capsys)[1]
    assert f"the sha {planted.SHA} does not descend from the base branch's commit {newer}" in out


# ---- which base ----

def test_a_base_ref_at_head_compares_against_heads_parent(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    parent = planted.SHA
    git = planted.FakeGit(base={}, chain=(planted.BASE_SHA, parent, planted.HEAD), ref=planted.HEAD,
                          files={parent: planted.base_from(repo)})
    set_item(repo, '7.75.01', kind='no-behaviour', status='done')
    set_item(repo, '7.76.00', kind='fix')
    out = check_with(repo, git, capsys)[1]
    assert f"the base ref {REF} is HEAD: comparing against HEAD's first parent {parent}" in out
    assert '7.76.00: kind feature -> fix needs a reviewed decision record' in out
    assert ['show', f'{parent}:docs/feature-tests/phase3-switch.json'] in git.calls


def test_base_takes_a_sha_for_the_batch_gate(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    git = planted.FakeGit(base=None, files={planted.BASE_SHA: planted.base_from(repo)})
    set_item(repo, '7.76.00', kind='fix')
    code, out = check_with(repo, git, capsys, '--base', planted.BASE_SHA)
    assert 'WARNING' not in out
    assert '7.76.00: kind feature -> fix needs a reviewed decision record' in out
    assert code == 1
    assert run(repo, 'check', '--base', 'not-a-sha', git=git) == 2


# ---- exemptions ----

def exempt(repo: Path, kind: str = 'no-user-flow', layer: str = 'e2e', session: str = 'h2/a') -> int:
    return run(repo, 'exempt', '7.76.00', '--layer', layer, '--kind', kind, '--reason', 'No page shows it.',
               '--session', session)


def review(repo: Path, session: str = 'eval-1/a', change: str | None = None, **kw: Any) -> int:
    rel = verdict.record_path('7.76.00', 'exemption.md')
    change = change or records.exemption_change(registry.load(repo).by_id['7.76.00']['exemption'])
    planted.write(repo, rel, planted.record_text(item_id='7.76.00', change=change, reviewer=session, **kw))
    return run(repo, 'review-exemption', '7.76.00', '--record', rel, '--session', session)


def test_an_exemption_counts_once_another_session_reviewed_it(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    assert exempt(repo) == 0
    assert registry.load(repo).by_id['7.76.00']['exemption'] == {
        'layer': 'e2e', 'kind': 'no-user-flow', 'reason': 'No page shows it.', 'proposed_by': 'h2/a',
        'reviewed_by': None, 'reviewed_at': None}
    assert run(repo, 'check') == 0   # proposed only: the gap stays
    assert review(repo, session='h2/b') == 2
    assert "the reviewer h2/b shares the proposer h2/a's root" in out_of(capsys)
    assert review(repo) == 0
    assert registry.load(repo).by_id['7.76.00']['exemption']['reviewed_by'] == 'eval-1/a'
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert '7.76.00: e2e is no longer a gap' in out_of(capsys)


REASON = hashlib.sha256(b'No page shows it.').hexdigest()[:12]
ANOTHER = hashlib.sha256(b'Another reason.').hexdigest()[:12]


@pytest.mark.parametrize(('field', 'value', 'now'), [
    ('kind', 'live-only', f'exemption e2e live-only {REASON}'),
    ('reason', 'Another reason.', f'exemption e2e no-user-flow {ANOTHER}'),
])
def test_an_exemption_changed_after_its_review_fails(repo: Path, capsys: pytest.CaptureFixture[str],
                                                     field: str, value: str, now: str):
    run(repo, 'baseline', '--init')
    exempt(repo)
    review(repo)
    reg = registry.load(repo)
    reg.by_id['7.76.00']['exemption'][field] = value
    registry.save(repo, reg)
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert (f"7.76.00: exemption: the record docs/test-verdicts/7.76.00/exemption.md says 'exemption e2e no-user-flow "
            f"{REASON}', not '{now}'") in out_of(capsys)


def test_checked_elsewhere_closes_no_gap_and_is_listed(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    exempt(repo, kind='platform-only', layer='all')
    assert review(repo) == 0
    assert run(repo, 'check') == 0
    capsys.readouterr()
    run(repo, 'stats')
    rows = {line.split()[0]: line.split()[1:] for line in out_of(capsys).splitlines()}
    assert rows['kind'] == ['items', 'proven', 'gaps', 'exempt', 'elsewhere', 'uncertain']
    assert rows['feature'] == ['2', '0', '4', '0', '1', '0']


def test_stats_counts_items_proven_and_gaps_per_kind(repo: Path, capsys: pytest.CaptureFixture[str]):
    assert run(repo, 'stats', '--section', 'docs/feature-tests/phase1-2.json') == 0
    lines = out_of(capsys).splitlines()
    assert lines[1].split() == ['feature', '1', '0', '2', '0', '0', '0']
    assert lines[-1].split() == ['total', '1', '0', '2', '0', '0', '0']


def test_run_is_a_stub_that_says_what_it_would_run(repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID)
    assert run(repo, 'run', '--sha', planted.SHA) == 3
    out = out_of(capsys)
    assert 'not built yet' in out
    assert '  pytest: 1\n  vitest: 0\n  playwright: 0' in out


# ---- cycle 2, round 2: the backstop ----

NO_SECTION = 'release {v} has no CHANGELOG section in the form the gate reads'


def with_inserted(repo: Path, text: str) -> None:
    """``text`` placed just above the newest release heading."""
    changelog = repo / 'CHANGELOG.md'
    changelog.write_text(changelog.read_text().replace('## [7.76.00]', f'{text}\n\n## [7.76.00]', 1))


@pytest.mark.parametrize('trick', [
    '  ## [7.80.00] - 2026-11-28\n\nTooling only: hidden.',
    '##  [7.80.00] - 2026-11-28\n\nTooling only: hidden.',
    '[7.80.00] - 2026-11-28\n----------------------\n\nTooling only: hidden.',
    '<h2>[7.80.00] - 2026-11-28</h2>\n\nTooling only: hidden.',
    '- a list\n  ```\n## [7.80.00] - 2026-11-28\n  ```',
    '## v7.80.00 - 2026-11-28\n\nTooling only: hidden.',
    '## _7.80.00_ - 2026-11-28\n\nTooling only: hidden.',
])
def test_a_bumped_release_whose_section_the_reader_cannot_find_fails(repo: Path, capsys: pytest.CaptureFixture[str],
                                                                     trick: str):
    run(repo, 'baseline', '--init')
    with_inserted(repo, trick)
    git = planted.FakeGit(base={}, history=('7.80.0', '7.76.0', '6.5.0'))
    out = check_with(repo, git, capsys)[1]
    assert NO_SECTION.format(v='7.80.00') in out


@pytest.mark.parametrize('top', ['## [Unreleased] (voc-wiki)', '## [Unreleased]\n\n## [7.99.00] - 2026-11-28 (voc-wiki)'])
def test_a_suffix_at_the_top_cannot_switch_the_releases_off(repo: Path, capsys: pytest.CaptureFixture[str], top: str):
    run(repo, 'baseline', '--init')
    changelog = repo / 'CHANGELOG.md'
    changelog.write_text(changelog.read_text().replace('## [Unreleased]', top))
    git = planted.FakeGit(base={}, history=('7.76.0', '6.5.0'))
    code, out = check_with(repo, git, capsys)
    if '7.99.00' in top:   # it ends the line above every section: each bumped release has none
        assert NO_SECTION.format(v='7.76.00') in out
        assert NO_SECTION.format(v='6.05.00') in out
    else:                  # a suffixed [Unreleased] is still skipped: nothing changes
        only_the_pre_gate_history(code, out)


def only_the_pre_gate_history(code: int, out: str) -> None:
    """The planted line's numbers are all before the real gate (7.105.00): its first bump says so, and nothing else."""
    assert code == 1
    assert "is before the gate's (7.105.00)" in out
    assert out.rstrip().endswith('FAILED, 1 problem(s)')


def test_every_bumped_release_has_its_section(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    code, out = check_with(repo, planted.FakeGit(base={}, history=('7.76.0', '7.75.1', '6.5.0', '6.4.8')), capsys)
    only_the_pre_gate_history(code, out)
    assert 'no CHANGELOG section' not in out


def test_a_bump_with_no_section_and_a_skipped_version(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    # 7.77 was bumped and has no section; 7.78 was never bumped, so it is no release at all.
    out = check_with(repo, planted.FakeGit(base={}, history=('7.79.0', '7.77.0', '7.76.0')), capsys)[1]
    assert NO_SECTION.format(v='7.77.00') in out
    assert NO_SECTION.format(v='7.79.00') in out
    assert '7.78.00' not in out


@pytest.mark.parametrize('heading', ['## [7.105.00a] - 2026-11-28', '## [v7.105.00] - 2026-11-28',
                                     '## [7.105.000] - 2026-11-28', '## [07.105.00] - 2026-11-28'])
def test_a_malformed_bracketed_version_is_a_problem_not_a_crash(repo: Path, capsys: pytest.CaptureFixture[str],
                                                                heading: str):
    run(repo, 'baseline', '--init')
    with_inserted(repo, f'{heading}\n\nTooling only: x.')
    out = check_with(repo, planted.FakeGit(base={}), capsys)[1]
    assert f"CHANGELOG.md line 5: {heading!r} is not a release number (MAJOR.MM.PP)" in out


REJECT_REL = verdict.reject_path('7.76.00', 'pytest', planted.PYTEST_ID, 1)


@pytest.mark.parametrize(('where', 'change', 'message'), [
    # the rejection's own shape (q-1)
    ('entry', {'by': 'not a session'}, "rejection 1: by 'not a session' is not a session id"),
    ('entry', {'at': 'yesterday'}, "rejection 1: at 'yesterday' is not a commit sha"),
    ('entry', {'at': 'abcdef12'}, 'rejection 1: the sha abcdef12 is not a commit of this repository'),
    ('entry', {'digest': 'short'}, "rejection 1: digest 'short' is not a sha256"),
    ('entry', {'code': {'../../etc/passwd': 'x'}}, "rejection 1: unknown key 'code'"),
    # its REJECT file says REJECT and names its by, at and digest (q-2)
    ('file', {'outcome': 'ACCEPT'}, f'{REJECT_REL} says ACCEPT, not REJECT'),
    ('file', {'evaluator': 'eval-7/q'}, f"{REJECT_REL} names the evaluator eval-7/q, not the rejection's eval-1/a"),
    ('file', {'sha': 'abcdef1'}, f"{REJECT_REL} names the sha abcdef1, not the rejection's {planted.SHA}"),
    ('file', {'digest': 'c' * 64}, f"{REJECT_REL} names the digest {'c' * 64}, not the rejection's"),
])
def test_each_rejection_and_its_reject_file_hold(repo: Path, capsys: pytest.CaptureFixture[str], where: str,
                                                 change: dict[str, Any], message: str):
    register(repo, '7.76.00', planted.PYTEST_ID)
    decide(repo, 'reject', reject_file(repo, 1))
    run(repo, 'baseline', '--init')
    if where == 'file':
        reject_file(repo, 1, **change)
    else:
        reg = registry.load(repo)
        reg.by_id['7.76.00']['unit'][0]['rejections'][0].update(change)
        registry.save(repo, reg)
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert f'7.76.00: {planted.PYTEST_ID}: {message}' in out_of(capsys)


# ---- cycle 2, round 2 ----

@pytest.mark.parametrize(('event', 'side'), [('pull_request', 'pr'), ('push', 'HEAD'), (None, 'HEAD')])
def test_the_fork_uses_head2_only_for_a_pull_request(repo: Path, capsys: pytest.CaptureFixture[str],
                                                     monkeypatch: pytest.MonkeyPatch, event: str | None, side: str):
    run(repo, 'baseline', '--init')
    if event:
        monkeypatch.setenv('GITHUB_EVENT_NAME', event)
    pr_head = 'd' * 40
    git = planted.FakeGit(base=planted.base_from(repo), head2=pr_head, forks={pr_head: planted.SHA})
    check_with(repo, git, capsys)
    assert ['merge-base', planted.BASE_SHA, pr_head if side == 'pr' else 'HEAD'] in git.calls


@pytest.mark.parametrize(('files', 'message'), [
    ({'package.json': '{"version": "7.105.0"}\n'},
     f'the base {REF} has no registry, but its package.json version 7.105.0 is not before the gate (7.105.0)'),
    ({'docs/feature-tests/README.md': '# x\n'},
     f'the base {REF} has no registry, but it has docs/feature-tests/ (docs/feature-tests/README.md)'),
])
def test_bootstrap_only_from_a_base_before_the_gate(repo: Path, capsys: pytest.CaptureFixture[str],
                                                    files: dict[str, str], message: str):
    run(repo, 'baseline', '--init')
    code, out = check_with(repo, planted.FakeGit(base=files), capsys)
    assert code == 1
    assert message in out


def test_verdicts_and_records_are_never_read_through_a_link(repo: Path, capsys: pytest.CaptureFixture[str],
                                                            tmp_path_factory: pytest.TempPathFactory):
    path = accept_setup(repo)
    real = tmp_path_factory.mktemp('elsewhere') / 'verdict.md'
    real.write_text((repo / path).read_text())
    (repo / path).unlink()
    (repo / path).symlink_to(real)
    assert decide(repo, 'accept', path) == 2
    assert f'{path} is a link: the gate never reads a verdict or a record through one' in out_of(capsys)


# ---- cycle 2 ----

@pytest.mark.parametrize(('version', 'message'), [
    ('7.77.0', "package.json's version 7.77.00 is not a release of this line's CHANGELOG"),
    ('7.75.1', "package.json's version 7.75.01 is not this line's newest release (7.76.00)"),
    ('7.76', "package.json's version '7.76' is not MAJOR.MINOR.PATCH"),
])
def test_the_package_version_is_the_newest_release(repo: Path, capsys: pytest.CaptureFixture[str], version: str,
                                                   message: str):
    run(repo, 'baseline', '--init')
    planted.write(repo, 'package.json', f'{{"version": "{version}"}}\n')
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert message in out_of(capsys)


def test_a_release_hidden_from_the_line_fails_on_the_package_version(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    changelog = repo / 'CHANGELOG.md'
    changelog.write_text(changelog.read_text().replace(
        '## [Unreleased]\n', '## [Unreleased]\n\n## [7.77.00] - 2026-11-27 (voc-wiki)\n\nHidden.\n'))
    planted.write(repo, 'package.json', '{"version": "7.77.0"}\n')
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert "package.json's version 7.77.00 is not a release of this line's CHANGELOG" in out_of(capsys)


def test_a_new_items_lower_seed_needs_a_decision_once_the_base_has_a_registry(repo: Path,
                                                                              capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    base = planted.base_from(repo)
    without = planted.default_items() | {'product-7.5x-7.7x': []}
    planted.write_registry(repo, without)
    base['docs/feature-tests/product-7.5x-7.7x.json'] = (repo / 'docs/feature-tests/product-7.5x-7.7x.json').read_text()
    planted.write_registry(repo, planted.default_items())
    out = check_with(repo, planted.FakeGit(base=base), capsys)[1]
    assert ('7.75.01: kind feature -> no-behaviour needs a reviewed decision record '
            '(docs/test-verdicts/7.75.01/decision.md)') in out
    # Bootstrap: a base without a registry yet takes the seeded kinds as they are.
    assert 'decision' not in check_with(repo, planted.FakeGit(base={}), capsys)[1]


def test_a_base_without_a_registry_compares_against_heads_parent_when_it_has_one(repo: Path,
                                                                                 capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    git = planted.FakeGit(base={}, files={planted.BASE_SHA: {}, planted.SHA: planted.base_from(repo)})
    set_item(repo, '7.76.00', kind='fix')
    out = check_with(repo, git, capsys)[1]
    assert (f'the base {REF} has no registry yet; comparing against HEAD\'s first parent {planted.SHA}, '
            'which has one') in out
    assert '7.76.00: kind feature -> fix needs a reviewed decision record' in out


@pytest.mark.parametrize(('env', 'strict'), [
    ({'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'push'}, False),
    ({'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'pull_request'}, True),
    ({}, False),
])
def test_all_zeros_is_no_base_only_on_a_ci_push(repo: Path, capsys: pytest.CaptureFixture[str],
                                                monkeypatch: pytest.MonkeyPatch, env: dict[str, str], strict: bool):
    run(repo, 'baseline', '--init')
    monkeypatch.setenv('FEATURE_GATE_BASE_REF', '0' * 40)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    code, out = check_with(repo, planted.FakeGit(base=None), capsys)
    if env.get('GITHUB_EVENT_NAME') == 'push':
        assert (code, 'no base commit (the first push of a new branch)' in out) == (0, True)
    elif strict:
        assert code == 1
        assert 'the base ref is all zeros outside a push: no base to compare against' in out
    else:
        assert code == 0
        assert 'WARNING: the base ref is all zeros outside a push' in out


def test_a_rejected_test_leaves_only_with_a_reviewed_retire_record(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = rejected_once_and_based(repo)
    reg = registry.load(repo)
    reg.by_id['7.76.00']['unit'] = []
    registry.save(repo, reg)
    rel = verdict.record_path('7.76.00', records.retire_name(planted.PYTEST_ID))
    out = check_with(repo, git, capsys)[1]
    assert (f'7.76.00: {planted.PYTEST_ID}: its 1 rejection(s) left the registry: a reviewed '
            f'`retire {planted.PYTEST_ID}` record ({rel}) lets a rejected test go') in out
    planted.write(repo, rel, planted.record_text(item_id='7.76.00', change=f'retire {planted.PYTEST_ID}'))
    out = check_with(repo, git, capsys)[1]
    assert 'rejection' not in out


def test_a_removed_items_decision_lets_its_rejected_tests_go(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = rejected_once_and_based(repo)
    planted.write_registry(repo, planted.default_items() | {'phase3-switch': []})
    decision(repo, '7.76.00', 'removed')
    out = check_with(repo, git, capsys)[1]
    assert 'rejection' not in out


def test_propose_and_review_a_retire(repo: Path):
    rejected_once_and_based(repo)
    assert run(repo, 'propose-change', '7.76.00', '--retire', planted.PYTEST_ID, '--reason', 'Replaced.',
               '--session', 'h2/a') == 0
    rel = verdict.record_path('7.76.00', records.retire_name(planted.PYTEST_ID))
    assert verdict.parse((repo / rel).read_text()).front['change'] == f'retire {planted.PYTEST_ID}'
    assert run(repo, 'review-change', '7.76.00', '--retire', planted.PYTEST_ID, '--sha', planted.SHA, '--tree',
               planted.TREE, '--session', 'eval-1/a') == 0


def test_writes_never_go_through_a_linked_folder(repo: Path, tmp_path_factory: pytest.TempPathFactory):
    elsewhere = tmp_path_factory.mktemp('elsewhere')
    folder = repo / 'docs/test-verdicts/7.76.00'
    folder.parent.mkdir(parents=True, exist_ok=True)
    folder.symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError, match='is a link'):
        records.write(repo, 'docs/test-verdicts/7.76.00/decision.md', {'item': '7.76.00'}, 'x')
    assert list(elsewhere.iterdir()) == []


# ---- cycle 3, round 2 ----

def after_the_gate(repo: Path, kind: str = 'no-behaviour') -> None:
    """A 7.106.00 release ("Tooling only:" seeds no-behaviour), its item and package.json at it."""
    with_inserted(repo, '## [7.106.00] - 2026-11-28\n\nTooling only: a release after the gate.')
    planted.write(repo, 'package.json', '{"version": "7.106.0"}\n')
    planted.write_registry(repo, planted.default_items() | {
        'phase3-switch': [planted.item('7.76.00', 'feature'), planted.item('7.106.00', kind)]})


def test_after_the_gate_an_item_takes_the_feature_floor_whatever_the_base(repo: Path, capsys: pytest.CaptureFixture[str]):
    after_the_gate(repo)
    run(repo, 'baseline', '--init')
    pre_gate = planted.FakeGit(base={})   # a base from before the gate: no registry, package.json 7.103.0
    out = check_with(repo, pre_gate, capsys)[1]
    assert '7.106.00: kind feature -> no-behaviour needs a reviewed decision record' in out


def test_after_the_gate_an_item_never_holds_an_allowed_gap(repo: Path, capsys: pytest.CaptureFixture[str]):
    after_the_gate(repo, kind='feature')
    run(repo, 'baseline', '--init')
    out = check_with(repo, planted.FakeGit(base={}), capsys)[1]
    assert ('7.106.00: an item after the gate (7.105.00) never holds an allowed gap (unit, e2e): it lands with its '
            'tests accepted') in out


def test_a_base_with_a_registry_but_no_allowed_list_is_a_problem(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    base = planted.base_from(repo)
    del base['docs/feature-tests/allowed-gaps.json']
    out = check_with(repo, planted.FakeGit(base=base), capsys)[1]
    assert f'the base {REF} has a registry but no docs/feature-tests/allowed-gaps.json' in out


def test_the_lines_bootstrap_commit_is_the_bases(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    git.boots = {'HEAD': 'a' * 40, planted.BASE_SHA: 'c' * 40}
    out = check_with(repo, git, capsys)[1]
    assert (f"the line's bootstrap commit {'a' * 40} is not the base's ({'c' * 40}): the allowed list was added again "
            'or the line was rewritten') in out


@pytest.mark.parametrize(('event', 'tip'), [('pull_request', 'HEAD^2'), ('push', 'HEAD'), (None, 'HEAD')])
def test_the_history_follows_the_prs_head_only_on_a_pull_request(monkeypatch: pytest.MonkeyPatch, event: str | None,
                                                                 tip: str):
    if event:
        monkeypatch.setenv('GITHUB_EVENT_NAME', event)
    assert checks.history_tip(planted.FakeGit(base={}, head2='d' * 40)) == tip
    assert checks.history_tip(planted.FakeGit(base={})) == 'HEAD'   # no merge ref: HEAD, even on a pull_request


def test_a_history_version_that_is_not_plain_fails_the_check(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    out = check_with(repo, planted.FakeGit(base={}, history=('7.76.0', '7.76.0-hotfix')), capsys)[1]
    assert "package.json's version '7.76.0-hotfix' is not MAJOR.MINOR.PATCH" in out


# ---- cycle 3, round 3 ----

def test_a_line_without_the_bases_bootstrap_commit_is_a_problem(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = based(repo)
    git.boots = {planted.BASE_SHA: 'c' * 40}   # the base has the gate's bootstrap commit; HEAD's line has none
    out = check_with(repo, git, capsys)[1]
    assert f"the line has no bootstrap commit, but the base does ({'c' * 40})" in out


def test_package_json_never_goes_back_below_the_lines_last_release(repo: Path, capsys: pytest.CaptureFixture[str]):
    """7.60.0 after 7.106, with a rewritten 7.60.00 section moved to the top: no release of its own."""
    with_inserted(repo, '## [7.60.00] - 2026-11-28\n\nTooling only: moved to the top.\n\n'
                        '## [7.106.00] - 2026-11-28\n\nTooling only: x.\n\n## [7.105.00] - 2026-11-27\n\nTooling only: y.')
    planted.write(repo, 'package.json', '{"version": "7.60.0"}\n')
    run(repo, 'baseline', '--init')
    out = check_with(repo, planted.FakeGit(base={}, history=('7.106.0', '7.105.0')), capsys)[1]
    assert ("package.json's version 7.60.00 is not above the line's last release 7.106.00: a pushed bump is never "
            'renumbered') in out


def test_a_base_after_the_lines_bootstrap_commit_is_never_pre_gate(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    git = planted.FakeGit(base={})            # no registry, package.json 7.103.0: it would pass for pre-gate
    git.boots = {'HEAD': planted.BASE_SHA}     # but the line's bootstrap commit is the base itself
    out = check_with(repo, git, capsys)[1]
    assert (f"the base {REF} has no registry, but it descends from the line's bootstrap commit {planted.BASE_SHA}: "
            'a base after the gate is never the bootstrap') in out


def test_the_gate_version_is_defined_once():
    from feature_gate import gitio
    derived = gitio.GATE_VERSION
    assert derived == registry.parse_version(registry.GATE)


# ---- cycle 3 ----

def test_the_registry_lock_is_never_taken_through_a_link(repo: Path, tmp_path_factory: pytest.TempPathFactory):
    elsewhere = tmp_path_factory.mktemp('elsewhere')
    (repo / '.cache').symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(cli.Refused, match='is a link'), cli.registry_lock(repo):
        pass
    assert list(elsewhere.iterdir()) == []


@pytest.mark.parametrize(('command', 'flag'), [('propose-change', '--change'), ('propose-change', '--reason'),
                                               ('review-change', '--tree')])
def test_record_words_take_no_newline_or_control_character(repo: Path, capsys: pytest.CaptureFixture[str],
                                                           command: str, flag: str):
    args = {'propose-change': {'--change': 'kind feature -> plumbing', '--reason': 'It adds no route.'},
            'review-change': {'--sha': planted.SHA, '--tree': planted.TREE}}[command]
    args[flag] = 'x\nreviewer: eval-9/z'
    flat = [word for pair in args.items() for word in pair]
    assert run(repo, command, '7.76.00', *flat, '--session', 'h2/a') == 2
    assert f'{flag} holds a newline or a control character' in out_of(capsys)


def test_propose_change_never_overwrites_a_reviewed_record(repo: Path, capsys: pytest.CaptureFixture[str]):
    git = lowered_and_reviewed(repo)
    assert propose(repo, change='kind feature -> no-behaviour') == 2
    assert ('docs/test-verdicts/7.76.00/decision.md is reviewed: remove it in its own reviewed change (git rm) '
            'before proposing another') in out_of(capsys)
    assert 'decision' not in check_with(repo, git, capsys)[1]


# ---- round 3 ----

def test_a_release_headed_twice_is_a_problem_and_its_first_copy_sets_the_floor(repo: Path,
                                                                               capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    changelog = repo / 'CHANGELOG.md'
    changelog.write_text(changelog.read_text().replace(
        '## [6.05.00] - 2026-11-11', '## [7.76.00] - 2026-11-26\n\nTooling only: a planted copy.\n\n## [6.05.00] - 2026-11-11'))
    set_item(repo, '7.76.00', kind='no-behaviour')
    out = check_with(repo, planted.FakeGit(base={}), capsys)[1]
    assert '7.76.00: the CHANGELOG holds 2 headings for this release (the first is read; remove the others)' in out
    assert '7.76.00: kind feature -> no-behaviour needs a reviewed decision record' in out


def test_an_accepted_entrys_digest_must_be_the_tests_current_one(repo: Path, capsys: pytest.CaptureFixture[str]):
    accepted_and_baselined(repo)
    edit_entry(repo, digest='d' * 64)
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert f"7.76.00: {planted.PYTEST_ID}: the entry's digest {'d' * 64} is not the test's current one" in out_of(capsys)


def test_two_entries_naming_the_same_test_are_refused(repo: Path, capsys: pytest.CaptureFixture[str]):
    register(repo, '7.76.00', planted.PYTEST_ID)
    other = 'voc-datalake/lambda/api/test/test_widget.py::TestWidget::test_counts[x]'
    reg = registry.load(repo)
    reg.by_id['7.76.00']['unit'].append(dict(reg.by_id['7.76.00']['unit'][0], node=other))
    registry.save(repo, reg)
    run(repo, 'baseline', '--init')
    capsys.readouterr()
    assert run(repo, 'check') == 1
    assert f'7.76.00: {other}: names the same test as {planted.PYTEST_ID}' in out_of(capsys)


def test_a_record_descends_from_where_the_branch_left_the_base_not_its_newest_commit(
        repo: Path, capsys: pytest.CaptureFixture[str]):
    # The branch left the base at BASE_SHA and reviewed its change at SHA; the base moved on to `tip` meanwhile.
    tip = 'c' * 40
    branch = planted.FakeGit(base=planted.base_from(repo), chain=(planted.BASE_SHA, planted.SHA, planted.HEAD),
                             ref=tip, forks={tip: planted.BASE_SHA})
    run(repo, 'baseline', '--init', git=branch)
    branch.files = {tip: planted.base_from(repo)}
    set_item(repo, '7.76.00', kind='plumbing')
    propose(repo)
    assert review_change(repo, git=branch) == 0
    assert 'decision' not in check_with(repo, branch, capsys)[1]


def test_a_base_at_head_without_a_parent_is_loud_and_fails_strict(repo: Path, capsys: pytest.CaptureFixture[str]):
    run(repo, 'baseline', '--init')
    lonely = planted.FakeGit(base={}, chain=(planted.HEAD,), ref=planted.HEAD)
    code, out = check_with(repo, lonely, capsys)
    assert code == 0
    assert f'WARNING: the base ref {REF} is HEAD and HEAD has no parent here (a shallow clone?)' in out
    code, out = check_with(repo, lonely, capsys, '--strict-base')
    assert code == 1
    assert f'the base ref {REF} is HEAD and HEAD has no parent here (a shallow clone?)' in out


def test_an_exemption_review_descends_from_the_base_branch(repo: Path, capsys: pytest.CaptureFixture[str]):
    old = 'a' * 40
    git = planted.FakeGit(base=planted.base_from(repo), chain=(old, planted.BASE_SHA, planted.SHA, planted.HEAD))
    run(repo, 'baseline', '--init', git=git)
    exempt(repo)
    rel = verdict.record_path('7.76.00', 'exemption.md')
    change = records.exemption_change(registry.load(repo).by_id['7.76.00']['exemption'])
    planted.write(repo, rel, planted.record_text(item_id='7.76.00', change=change, sha=old))
    assert run(repo, 'review-exemption', '7.76.00', '--record', rel, '--session', 'eval-1/a', git=git) == 2
    assert f"the sha {old} does not descend from the base branch's commit {planted.BASE_SHA}" in out_of(capsys)


def test_every_break_file_exists_at_the_verdicts_sha(repo: Path, capsys: pytest.CaptureFixture[str]):
    path = accept_setup(repo)
    git = planted.FakeGit(base={}, missing=('voc-datalake/lambda/api/widget.py',))
    assert decide(repo, 'accept', path, git=git) == 2
    assert f'Break: voc-datalake/lambda/api/widget.py does not exist at {planted.SHA}' in out_of(capsys)


def test_the_registry_and_records_are_never_written_through_a_link(repo: Path, tmp_path_factory: pytest.TempPathFactory):
    target = tmp_path_factory.mktemp('elsewhere') / 'x.json'
    slice_file = repo / 'docs/feature-tests/phase1-2.json'
    slice_file.unlink()
    slice_file.symlink_to(target)
    with pytest.raises(ValueError, match='is a link'):
        registry.save(repo, registry.load(repo))
    assert not target.exists()
    record = repo / 'docs/test-verdicts/7.76.00/decision.md'
    record.parent.mkdir(parents=True)
    record.symlink_to(target)
    with pytest.raises(ValueError, match='is a link'):
        records.write(repo, 'docs/test-verdicts/7.76.00/decision.md', {'item': '7.76.00'}, 'x')
    assert not target.exists()


def test_review_change_refuses_an_item_id_that_is_not_one(repo: Path, capsys: pytest.CaptureFixture[str]):
    assert run(repo, 'review-change', '../../x', '--sha', planted.SHA, '--tree', planted.TREE,
               '--session', 'eval-1/a') == 2
    assert "'../../x' is not an item id" in out_of(capsys)


def test_a_write_holds_the_registry_lock(repo: Path):
    with cli.registry_lock(repo):
        assert (repo / '.cache/feature-gate/registry.lock').exists()
    assert json.loads((repo / 'docs/feature-tests/phase1-2.json').read_text())['slice'] == 'phase1-2'
