"""7.54.00: the roles that judge a submitted patch without running code read it (``read_patch``, and the reviewers'
checkout with it applied), and a review that could not review is never a pass (``write_review``, the finish).

The first live run's commit reviewer was handed a fixer's patch key in its task's text, could not read it, reviewed
the unchanged files, wrote nothing, and its board step passed on zero findings (01M7QXJN02WSFMG92VWWZ00NKB)."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness import coordinator, review_tools, role_tools
from engineering.runtime.harness.converse_loop import opening
from engineering.runtime.harness.main import PATCH_KEY_ENV, TOOL_ENV, _handed_patch
from engineering.runtime.harness.ports import TaskBrief
from engineering.runtime.harness.tools import ToolBox
from engineering.runtime.outputs import PATCH_READERS, REVIEW_ROLES, REVIEW_SCHEMA
from engineering.runtime.test.harness_fakes import BRIEF, HARNESS_COMMIT, RUN_ID, opened, world
from engineering.runtime.test.test_engineering_coordinator import FakePlanner

PATCH = f'ws/default/runs/{RUN_ID}/fixer-3/commits/{HARNESS_COMMIT}/_patches/attempt-1/task-2-0a1b2c3d.diff'
DIFF = ('diff --git a/calculator/ops.py b/calculator/ops.py\n--- a/calculator/ops.py\n+++ b/calculator/ops.py\n'
        '@@ -20 +20 @@ def divide(a, b):\n-    return a // b\n+    return a / b\n'
        'diff --git a/tests/test_ops.py b/tests/test_ops.py\nnew file mode 100644\n--- /dev/null\n'
        '+++ b/tests/test_ops.py\n@@ -0,0 +1,2 @@\n+def test_divide_returns_a_float():\n+    assert divide(7, 2) == 3.5\n')
BLOCKING = {'file': 'calculator/ops.py', 'line': 20, 'severity': 'blocking', 'rule': 'scope', 'title': 'renames divide',
            'evidence': 'divide is now div'}


def _reader(tmp_path: Path, role: str, *, patch: str = PATCH, body: str | None = DIFF) -> Any:
    """A patch reader's session whose task names ``patch`` (its object ``body`` in the store; None: no object)."""
    w = world(tmp_path, role=role)
    w.session.context.brief = replace(BRIEF, patch=patch)
    if body is not None:
        w.store.objects[PATCH] = body.encode()
    return w


def _review_key() -> str:
    return f'{artifact_prefix(RUN_ID, "fixer-1", HARNESS_COMMIT, 1, "review")}review.json'


@pytest.mark.parametrize('role', sorted(PATCH_READERS))
def test_every_patch_reader_reads_the_submitted_patch_as_data_with_its_files_listed(tmp_path: Path, role: str) -> None:
    w = _reader(tmp_path, role)
    fence = w.session.context.fence
    read = w.session.tools.call('read_patch', {})
    assert not read.error, read.text
    lines = read.text.splitlines()
    assert lines[0] == 'The submitted patch task-2-0a1b2c3d.diff: page 1 of 1.'
    assert opened('patch-files:task-2-0a1b2c3d.diff', fence) in read.text
    assert 'calculator/ops.py (+1 -1)' in read.text
    assert 'tests/test_ops.py (+2 -0, new)' in read.text
    assert opened('patch:task-2-0a1b2c3d.diff:1', fence) in read.text
    assert '+    return a / b' in read.text
    assert lines[-1] == '(the last page)'
    assert (w.session.context.patch_pages, w.session.context.patch_pages_read) == (1, {1})


def test_only_the_patch_readers_have_read_patch_and_only_the_reviewers_write_review(tmp_path: Path) -> None:
    for role in sorted(set(role_tools.ROLE_TOOLS['write_findings']) | {'fixer', 'gate-runner', 'committer',
                                                                       'coordinator', 'final-go'}):
        offered = {spec.name for spec in world(tmp_path / role, role=role).session.tools.specs}
        assert ('read_patch' in offered, 'write_review' in offered) == (role in PATCH_READERS, role in REVIEW_ROLES), role


@pytest.mark.parametrize('role', sorted(PATCH_READERS))
def test_a_large_patch_is_paged_at_line_ends_and_every_page_is_read_in_turn(tmp_path: Path, role: str) -> None:
    lines = ''.join(f'+line {n} {"x" * 80}\n' for n in range(1200))
    big = f'diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n@@ -0,0 +1,1200 @@\n{lines}'
    w = _reader(tmp_path, role, body=big)
    first = w.session.tools.call('read_patch', {'page': 1})
    pages = int(first.text.splitlines()[0].rsplit(' of ', 1)[1].rstrip('.'))
    assert pages == len(review_tools.pages(big)) > 1
    assert first.text.endswith('(read_patch with page 2 for the next)')
    assert 'big.py (+1200 -0)' in first.text
    texts = [first.text] + [w.session.tools.call('read_patch', {'page': page}).text for page in range(2, pages + 1)]
    fence = w.session.context.fence
    bodies = [text.split(f'{opened(f"patch:task-2-0a1b2c3d.diff:{page}", fence)}\n', 1)[1].split(
        f'\n<<<END DATA patch:task-2-0a1b2c3d.diff:{page} {fence}>>>', 1)[0] for page, text in enumerate(texts, 1)]
    assert all(len(body) <= review_tools.PAGE_CHARS for body in bodies)
    assert ''.join(bodies).count('+line ') == 1200   # (every line once: no line is cut between two pages)
    assert w.session.context.patch_pages_read == set(range(1, pages + 1))
    for page in (0, pages + 1, '2', True):
        assert w.session.tools.call('read_patch', {'page': page}).error, page


def test_pages_cut_at_line_ends_and_a_line_longer_than_a_page_on_pages_of_its_own() -> None:
    text = 'a' * 25 + '\n' + 'b' * 10 + '\n'
    assert review_tools.pages(text, size=20) == ['a' * 20, 'a' * 5 + '\n' + 'b' * 10 + '\n']
    assert review_tools.pages('', size=20) == ['']
    assert ''.join(review_tools.pages(DIFF, size=60)) == DIFF


@pytest.mark.parametrize('role', sorted(PATCH_READERS))
@pytest.mark.parametrize(('patch', 'body', 'why'), [
    ('', DIFF, 'names no submitted patch'),
    (f'ws/default/runs/{RUN_ID}/fixer-3/commits/{HARNESS_COMMIT}/_checkpoints/attempt-1/x.diff', DIFF,
     'is not a patch a fixer or builder of this run submitted'),
    (PATCH, None, 'could not be read (KeyError)'),
    (PATCH, '   \n', 'is empty'),
])
def test_a_missing_or_unreadable_patch_is_a_refusal_that_says_so(tmp_path: Path, role: str, patch: str,
                                                                 body: str | None, why: str) -> None:
    w = _reader(tmp_path, role, patch=patch, body=body)
    read = w.session.tools.call('read_patch', {})
    assert (read.error, why in read.text) == (True, True), read.text
    assert read.text.startswith('read_patch refused: ')
    assert w.session.context.patch_pages_read == set()


def test_an_s3_error_names_its_code() -> None:
    class Refused(Exception):
        def __init__(self) -> None:
            super().__init__('denied')
            self.response = {'Error': {'Code': 'AccessDenied'}}
    assert review_tools._error_code(Refused()) == 'AccessDenied'
    assert review_tools._error_code(KeyError('k')) == 'KeyError'


def test_a_reviewers_checkout_has_the_patch_applied_and_its_opening_says_how_to_read_it(tmp_path: Path) -> None:
    w = _reader(tmp_path, 'commit-reviewer')
    review_tools.show_submitted_patch(w.session.context)
    applied = [call['argv'] for call in w.runner.calls if 'apply' in call['argv']]
    assert len(applied) == 1
    assert applied[0][-3:-1] == ['--index', '--binary']
    assert Path(applied[0][-1]).read_bytes() == DIFF.encode()
    assert all(not call['repository_code'] for call in w.runner.calls)   # (the harness's own git, never repository code)
    text = opening(w.session)
    assert 'Your task names the submitted patch task-2-0a1b2c3d.diff. Read it with read_patch' in text
    assert 'It is applied to your checkout: read_file shows each changed file as the patch leaves it.' in text


def test_a_patch_that_does_not_apply_or_cannot_be_read_is_told_to_the_reviewer_never_a_crash(tmp_path: Path) -> None:
    w = _reader(tmp_path / 'conflict', 'pr-reviewer')
    w.runner.apply_exit = 1
    review_tools.show_submitted_patch(w.session.context)
    assert w.session.context.patch_unapplied.startswith('git apply exited 1')
    assert 'It could not be put on your checkout' in opening(w.session)
    assert not w.session.tools.call('read_patch', {}).error   # (the diff is still read)
    gone = _reader(tmp_path / 'gone', 'commit-reviewer', body=None)
    review_tools.show_submitted_patch(gone.session.context)
    assert 'could not be read' in gone.session.context.patch_unapplied
    assert not [call for call in gone.runner.calls if 'apply' in call['argv']]


def test_a_commit_reviewer_whose_task_names_no_patch_is_told_it_can_only_say_so(tmp_path: Path) -> None:
    w = world(tmp_path, role='commit-reviewer')
    review_tools.show_submitted_patch(w.session.context)
    assert w.runner.calls == []
    assert 'Your task names no submitted patch: there is no change to read.' in opening(w.session)
    assert 'submitted patch' not in opening(world(tmp_path / 'fixer', role='fixer').session)
    approve = w.session.tools.call('write_review', {'verdict': 'approve', 'reasons': ['looks right']})
    assert (approve.error, 'names no submitted patch' in approve.text) == (True, True)


@pytest.mark.parametrize('role', sorted(REVIEW_ROLES))
def test_an_approval_needs_every_page_read_and_no_blocking_finding(tmp_path: Path, role: str) -> None:
    w = _reader(tmp_path, role)
    tools = w.session.tools
    unread = tools.call('write_review', {'verdict': 'approve', 'reasons': ['fine']})
    assert (unread.error, 'read it with read_patch' in unread.text) == (True, True)
    assert not tools.call('read_patch', {}).error
    tools.call('write_findings', {'package': '.', 'shard': 'review', 'findings': [BLOCKING]})
    blocked = tools.call('write_review', {'verdict': 'approve', 'reasons': ['fine']})
    assert (blocked.error, 'that is request_changes' in blocked.text) == (True, True)
    assert w.store.objects.get(_review_key()) is None
    changes = tools.call('write_review', {'verdict': 'request_changes', 'reasons': ['the rename is beyond the bug']})
    assert not changes.error, changes.text
    record = json.loads(w.store.objects[_review_key()])
    assert record == {'schema': REVIEW_SCHEMA, 'verdict': 'request_changes', 'reasons': ['the rename is beyond the bug'],
                      'patch': PATCH, 'pages': 1, 'pages_read': [1], 'applied': True, 'blocking': 1}
    assert _review_key() in w.session.context.result_keys
    assert tools.call('write_review', {'verdict': 'approve', 'reasons': ['again']}).error   # (written once)


def test_a_request_for_changes_names_a_blocking_finding_and_the_verdict_is_closed(tmp_path: Path) -> None:
    w = _reader(tmp_path, 'commit-reviewer')
    tools = w.session.tools
    tools.call('read_patch', {})
    for arguments in ({'verdict': 'request_changes', 'reasons': ['nits']}, {'verdict': 'lgtm', 'reasons': ['x']},
                      {'verdict': 'approve', 'reasons': []}, {'verdict': 'approve', 'reasons': ['x' * 401]},
                      {'verdict': 'approve'}):
        assert tools.call('write_review', arguments).error, arguments
    assert not tools.call('write_review', {'verdict': 'approve', 'reasons': ['the one-line fix, tested']}).error
    assert json.loads(w.store.objects[_review_key()])['verdict'] == 'approve'


@pytest.mark.parametrize('role', sorted(REVIEW_ROLES))
def test_a_reviewer_finishes_only_with_its_review_and_could_not_review_goes_to_a_person(tmp_path: Path,
                                                                                          role: str) -> None:
    w = _reader(tmp_path, role, body=None)
    tools = w.session.tools
    early = tools.call('finish', {'summary': 'no findings'})
    assert (early.error, 'write your review first' in early.text, w.board.moves) == (True, True, [])
    assert tools.call('read_patch', {}).error
    assert not tools.call('write_review', {'verdict': 'could_not_review',
                                           'reasons': ['the submitted patch could not be read']}).error
    done = tools.call('finish', {'summary': 'could not review'})
    assert done.finished == 'could not review'
    assert 'your task goes to a person' in done.text
    assert (w.board.moves[-1][2], w.board.results[-1]) == ('needs_human', (_review_key(),))
    assert w.board.progress_seen[-1][3] == ('could not review the change (the submitted patch could not be read): a '
                                            'person decides')
    assert w.session.context.finished


def test_an_approved_review_finishes_done(tmp_path: Path) -> None:
    w = _reader(tmp_path, 'commit-reviewer')
    w.session.tools.call('read_patch', {})
    w.session.tools.call('write_review', {'verdict': 'approve', 'reasons': ['the one-line fix, tested']})
    assert w.session.tools.call('finish', {'summary': 'approved'}).text == 'finished'
    assert w.board.moves[-1][2] == 'done'


def test_a_continuation_reads_its_review_back_from_its_recorded_outputs(tmp_path: Path) -> None:
    w = _reader(tmp_path, 'commit-reviewer')
    w.session.tools.call('read_patch', {})
    w.session.tools.call('write_review', {'verdict': 'approve', 'reasons': ['fine']})
    # A continuation's fresh toolbox has nothing of the session before but its recorded outputs.
    w.session.context.patch_pages_read = set()
    again = ToolBox(w.session.context)
    assert again.call('finish', {'summary': 'approved'}).text == 'finished'


def test_the_tool_server_is_handed_only_a_submitted_patch_of_its_run() -> None:
    assert PATCH_KEY_ENV in TOOL_ENV
    assert _handed_patch({PATCH_KEY_ENV: PATCH}, RUN_ID, HARNESS_COMMIT) == PATCH
    for key in ('', PATCH.replace(RUN_ID, '01JD3R4NZXQ7Y2W8K4M6P9T0ZZ'), PATCH.replace('_patches', '_checkpoints')):
        assert _handed_patch({PATCH_KEY_ENV: key}, RUN_ID, HARNESS_COMMIT) == ''
    assert _handed_patch({}, RUN_ID, HARNESS_COMMIT) == ''


def test_a_commit_reviewers_task_must_name_the_patch_it_reviews(tmp_path: Path) -> None:
    w = world(tmp_path, role='coordinator')
    planner = FakePlanner()
    w.session.context.planner = planner
    tools = ToolBox(w.session.context)
    post = {'role': 'commit-reviewer', 'title': 'Review the fix', 'instructions': 'Review the divide fix.',
            'step': 'board'}
    refused = tools.call('post_task', post)
    assert (refused.error, 'names the patch it reviews' in refused.text) == (True, True)
    for role in ('commit-reviewer', 'pr-reviewer'):
        assert not tools.call('post_task', {**post, 'role': role, 'patch': PATCH}).error, role
    assert [posted['patch'] for posted in planner.posted] == [PATCH, PATCH]
    assert coordinator.REVIEWS_A_PATCH == 'commit-reviewer'


def test_a_gate_runners_stopped_record_sends_its_task_to_a_person(tmp_path: Path) -> None:
    w = world(tmp_path, role='gate-runner')
    context = w.session.context
    key = f'{artifact_prefix(RUN_ID, "fixer-1", HARNESS_COMMIT, 1, "gate")}record.json'
    w.store.objects[key] = json.dumps({'verdict': 'STOPPED', 'stop_reason': 'setup_failed'}).encode()
    context.result_keys.append(key)
    done = w.session.tools.call('finish', {'summary': 'the dependency step failed'})
    assert 'the gate stopped (setup_failed), so it judged no code' in done.text
    assert (w.board.moves[-1][2], w.board.results[-1]) == ('needs_human', (key,))
    other = world(tmp_path / 'go', role='gate-runner')
    other.store.objects[key] = json.dumps({'verdict': 'NO-GO'}).encode()
    other.session.context.result_keys.append(key)
    assert other.session.tools.call('finish', {'summary': 'pytest failed'}).text == 'finished'
    assert other.board.moves[-1][2] == 'done'
    assert review_tools.ending(replace(context, brief=TaskBrief('task-1', '', ''), result_keys=[])) == ('done', '')
