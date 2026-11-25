"""A person's Resume at a flow step whose task went to a person tries the step again (7.71.04), end to end on the Bug
hunt and fix template, the local fake runtime and the broker behind its function URL
(``test_engineering_bug_hunt_flow``).

The live state on b- (run 01M86YEPB6VFP9XEG1M9HTHABV): the run waited at ``flow:commit``, its coordinate task done (its
coordinator had finished at the decision point) and its committer's task ``needs_human`` (its push refused). A Resume
of the whole run reopened the coordinate task for a new coordinator, which read the committer's task as "the
person's", posted nothing and finished, and the run went straight back to a person. Now the Resume, deciding the step,
posts its task again as a new task the person posted; the new coordinator launches its committer, which pushes, the PR
author opens the pull request, and the run ends done.
"""
from __future__ import annotations

import json
from dataclasses import replace

import pytest

from engineering.board.store import COORDINATE_TASK
from engineering.runtime import handler
from engineering.runtime.outputs import run_branch
from engineering.runtime.test.harness_fakes import use
from engineering.runtime.test.test_engineering_bug_hunt_flow import (
    RUN,
    STARTER,
    BugHunt,
    _done,
    _post_and_launch,
    bug_hunt,
    coordinate,
    ends_done_at_the_next_tick,
    opened_by,
    pushed_by,
    statuses,
    through_the_gate,
)

__all__ = ['bug_hunt']   # (the fixture this module's test takes)


def _at_the_commit_step_with_its_committer_at_a_person(flow: BugHunt,
                                                       monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """The live state: the gate said GO, the committer finished without a push (its task at a person), the coordinator
    read the flow at the person and finished, and the next tick sent the run to ``flow:commit``. The fixer's patch and
    the tree the gate judged."""
    coordinator, patch, tree = through_the_gate(flow, monkeypatch)
    coordinate(coordinator, _post_and_launch('committer', 'commit', 'task-6', 'Commit the slug fix', patch=patch))
    flow.run_agent('committer-7', [_done('the push was refused')], monkeypatch)
    assert coordinate(coordinator, [[use('read_flow')], _done('the flow waits at a person at commit')]) == 'done'
    sessions = handler._supervisor().sessions
    for agent_id in ['coordinator-1', *flow.launcher.launched]:
        session = sessions.get(RUN, agent_id)
        assert session is not None
        sessions.save(replace(session, status='needs_human' if agent_id == 'committer-7' else 'done', exec_id=None))
    handler.lambda_handler({'action': 'tick'}, None)
    store = flow.api.store
    run = handler._runs().get(RUN)
    assert run is not None
    assert (run.status, run.waiting_at, store.task('default', RUN, COORDINATE_TASK).state,
            store.task('default', RUN, 'task-6').state) == ('needs_human', 'flow:commit', 'done', 'needs_human')
    return patch, tree


def test_a_resume_at_the_commit_step_posts_a_new_committer_task_and_the_run_ends_done_at_its_pull_request(
        bug_hunt: BugHunt, monkeypatch: pytest.MonkeyPatch):
    flow = bug_hunt
    patch, tree = _at_the_commit_step_with_its_committer_at_a_person(flow, monkeypatch)
    handler.lambda_handler({'action': 'signal', 'run_id': RUN, 'signal': 'resume', 'actor': STARTER}, None)
    # The Resume posted the committer's task again, the person's, the same patch named, and reopened the coordinate
    # task for a new coordinator, launched at its next attempt.
    store = flow.api.store
    [retried] = [task for task in store.tasks('default', RUN) if task.role == 'committer' and task.state == 'open']
    first = store.task('default', RUN, 'task-6')
    assert (retried.flow_step, retried.posted_by, json.loads(retried.spec), retried.title) == (
        'commit', f'human:{STARTER}', json.loads(first.spec), first.title)
    task = store.task('default', RUN, COORDINATE_TASK)
    assert (task.state, task.attempt, task.launched_agent) == ('open', 2, 'coordinator-8')
    assert statuses(flow.plan('coordinator-8'))['commit'] == 'running'

    # The new coordinator launches it; the committer pushes, the PR author opens the pull request from the branch.
    coordinator = flow.coordinator('coordinator-8', attempt=2)
    coordinate(coordinator, [[use('read_flow')], [use('read_board')],
                             [use('launch_agent', task_id=retried.task_id, role='committer', language='python')]])
    pushed_by(flow, 'committer-9', patch, tree, monkeypatch, coordinator='coordinator-8')
    opened_by(flow, coordinator, 'task-7', 'pr-author-10', tree, monkeypatch)
    # (7.71.04) The flow's end says how the pull request opened, as the run's META says: ready for review.
    plan = flow.plan('coordinator-8')
    assert (plan['outcome'], plan['reason']) == ('finished', 'the flow ends at the pull request, ready for review')
    assert coordinate(coordinator, [[use('read_flow')], _done('the pull request is open, ready for review')]) == 'done'
    assert flow.host.writes == [('push_bundle', run_branch(RUN), tree), ('open_or_update_draft_pr', run_branch(RUN),
                                                                         tree)]
    ends_done_at_the_next_tick(flow, coordinators=('coordinator-1', 'coordinator-8'))

