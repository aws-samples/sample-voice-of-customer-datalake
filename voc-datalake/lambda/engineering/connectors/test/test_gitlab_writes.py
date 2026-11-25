"""The GitLab client's writes (gitlab.py): the push through the Commits API held to the checked tree, the CI
definitions it never changes, the outcome-unknown paths, the draft merge request, notes, and the host router."""
from __future__ import annotations

import base64
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest

from engineering.connectors import gitlab
from engineering.connectors.broker import Broker
from engineering.connectors.credentials import GitHubAppCredential, GitLabTokenCredential
from engineering.connectors.github import GitHubHost
from engineering.connectors.gitlab import GitLabHost
from engineering.connectors.gitlab_api import gitlab_transport
from engineering.connectors.gitlab_tree import TreeEntry, blob_id, tree_id
from engineering.connectors.hosts import (
    WRITE_READY_BY,
    WRITE_RESERVE_SECONDS,
    WRITE_UNKNOWN,
    BundleContents,
    Commit,
    Conflict,
    FetchAccess,
    FileChange,
    HostBusy,
    OutcomeUnknown,
    PullRequestRef,
)
from engineering.connectors.identity import Caller
from engineering.connectors.router import HostRouter
from engineering.connectors.test.app_keys import credential as app_credential
from engineering.connectors.test.fakes import (
    BASE,
    BOT,
    BRANCH,
    RUN,
    FakeBundles,
    FakeLedger,
    FakeRuns,
    FakeWrites,
    connector,
    record,
)
from engineering.connectors.test.gitlab_fakes import (
    NOW,
    PROJECT,
    TOKEN,
    Clock,
    FakeGitLab,
    P,
    answer,
    client,
    credential,
)
from engineering.connectors.transport import HttpsTransport, Response
from engineering.connectors.write_policy import WriteRefused

NEW = 'd' * 40
OLD_CODE, NEW_CODE = b'total = 1\n', b'total = round(1, 2)\n'
README = blob_id(b'# Refunds\n', 'sha1')
QUOTED_BRANCH = quote(BRANCH, safe='')
COMMITS = f'{P}/repository/commits'


def _tree(entries: dict[str, TreeEntry]) -> str:
    return tree_id(entries.values(), 'sha1')


def _src(code: bytes) -> dict[str, TreeEntry]:
    return {'refund.py': TreeEntry('refund.py', '100644', blob_id(code, 'sha1'))}


def _root(code: bytes) -> dict[str, TreeEntry]:
    return {'README.md': TreeEntry('README.md', '100644', README),
            'src': TreeEntry('src', '040000', _tree(_src(code)))}


def _listed(entries: dict[str, TreeEntry]) -> list[dict[str, str]]:
    return [{'name': e.name, 'mode': e.mode, 'id': e.object_id, 'type': 'tree' if e.is_tree else 'blob'}
            for e in entries.values()]


TREE = _tree(_root(NEW_CODE))


def bundle(*changes: FileChange, tree: str = TREE, commits: int = 1) -> BundleContents:
    changed = changes or (FileChange('src/refund.py', '100644', NEW_CODE),)
    return BundleContents(heads=(f'refs/heads/{BRANCH}',), tree_hash=tree,
                          changed_paths=tuple(c.path for c in changed),
                          commits=tuple(Commit(f'Fix {n}', BOT, BOT, changed) for n in range(commits)),
                          added_lines=('x',), base=BASE)


def tree_path(ref: str, directory: str = '') -> str:
    return f'{P}/repository/tree?ref={ref}&per_page=100&page=1' + (f'&path={directory}' if directory else '')


#: Each file's last commit at the base, as GitLab's ``X-Gitlab-Last-Commit-Id`` answers it (the partial lease).
LAST = 'f' * 40
CI_TEXT = b'test:\n  script: make test\n'


def raw_path(path: str, ref: str = BASE) -> str:
    return f'{P}/repository/files/{quote(path, safe="")}/raw?ref={ref}'


def pushable(api: FakeGitLab, *, head: str | None = None, includes: list[dict[str, Any]] | None = None,
             ci_config_path: str | None = '', pushed_root: dict[str, TreeEntry] | None = None,
             parent: str = BASE, ci_text: bytes = CI_TEXT) -> FakeGitLab:
    """A project whose base commit has README.md and src/refund.py (``OLD_CODE``), its CI file (``ci_text``) and
    each local include in ``includes`` plain, the agent's branch at ``head`` (none: new), and a commit the push makes
    (``NEW``, on ``parent``) whose root is ``pushed_root``."""
    locals_ = [str(item['location']) for item in (includes or []) if item['type'] == 'local']
    own = (ci_config_path or '.gitlab-ci.yml').removeprefix('./')
    listing = ''.join(f'  - local: {location}\n' for location in locals_)
    api.on('GET', raw_path(own), Response(200, {}, (f'include:\n{listing}'.encode() if locals_ else b'') + ci_text))
    for location in locals_:
        api.on('GET', raw_path(location.lstrip('/')), Response(200, {}, ci_text))
    for path in ('src/refund.py', 'README.md'):
        api.on('HEAD', f'{P}/repository/files/{quote(path, safe="")}?ref={BASE}',
               answer(200, None, {'x-gitlab-last-commit-id': LAST}))
    return (api.on('GET', P, answer(200, {'default_branch': 'main', 'ci_config_path': ci_config_path,
                                          'only_allow_merge_if_pipeline_succeeds': True,
                                          'allow_merge_on_skipped_pipeline': False}))
            .on('GET', f'{P}/ci/lint?content_ref={BASE}', answer(200, {'valid': True, 'includes': includes or []}))
            # (a new branch: none before the push, then at the push's commit, as an undo reads it again)
            .on('GET', f'{P}/repository/branches/{QUOTED_BRANCH}',
                *([answer(404, {}), answer(200, {'commit': {'id': NEW}})] if head is None
                  else [answer(200, {'commit': {'id': head}})]))
            .on('GET', f'{P}/repository/merge_base?refs%5B%5D=main&refs%5B%5D={BASE}', answer(200, {'id': BASE}))
            .on('GET', tree_path(BASE), answer(200, _listed(_root(OLD_CODE))))
            .on('GET', tree_path(BASE, 'src'), answer(200, _listed(_src(OLD_CODE))))
            .on('POST', COMMITS, answer(201, {'id': NEW, 'parent_ids': [parent]}))
            .on('GET', tree_path(NEW), answer(200, _listed(pushed_root if pushed_root is not None
                                                            else _root(NEW_CODE)))))


def writes(api: FakeGitLab) -> list[tuple[str, str]]:
    return [(s.method, s.path) for s in api.sent if s.method not in {'GET', 'HEAD'}]


# --- the push -------------------------------------------------------------------------------------------------------


def test_a_new_branch_is_created_by_its_first_commit_on_the_base_with_the_checked_tree() -> None:
    api = pushable(FakeGitLab())
    client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]
    assert api.bodies('POST', COMMITS) == [{
        'branch': BRANCH, 'commit_message': 'Fix 0', 'start_sha': BASE,
        'actions': [{'action': 'update', 'file_path': 'src/refund.py', 'encoding': 'base64',
                     'content': base64.b64encode(NEW_CODE).decode(), 'last_commit_id': LAST}]}]
    assert all(s.headers['Authorization'] == f'Bearer {TOKEN}' for s in api.sent)


def test_an_existing_branch_at_the_base_takes_the_commit_without_a_start() -> None:
    api = pushable(FakeGitLab(), head=BASE)
    client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert 'start_sha' not in api.bodies('POST', COMMITS)[0]
    assert ('GET', f'{P}/repository/merge_base?refs%5B%5D=main&refs%5B%5D={BASE}') not in api.calls()


def test_a_new_executable_is_created_then_made_executable() -> None:
    tool = FileChange('src/tool.sh', '100755', b'#!/bin/sh\n')
    entries = {**_src(OLD_CODE), 'tool.sh': TreeEntry('tool.sh', '100755', blob_id(b'#!/bin/sh\n', 'sha1'))}
    root = {**_root(OLD_CODE), 'src': TreeEntry('src', '040000', _tree(entries))}
    api = pushable(FakeGitLab(), pushed_root=root)
    client(api).push_bundle('conn-1', BRANCH, bundle(tool, tree=_tree(root)), _tree(root), 'main')
    actions = api.bodies('POST', COMMITS)[0]['actions']
    assert [(a['action'], a.get('execute_filemode')) for a in actions] == [('create', None), ('chmod', True)]


def test_a_deletion_is_a_delete_action() -> None:
    gone = FileChange('README.md', '100644', None)
    root = {'src': _root(OLD_CODE)['src']}
    api = pushable(FakeGitLab(), pushed_root=root)
    client(api).push_bundle('conn-1', BRANCH, bundle(gone, tree=_tree(root)), _tree(root), 'main')
    assert api.bodies('POST', COMMITS)[0]['actions'] == [{'action': 'delete', 'file_path': 'README.md',
                                                          'last_commit_id': LAST}]


def test_a_file_with_no_last_commit_to_read_is_updated_without_a_lease() -> None:
    api = pushable(FakeGitLab()).on('HEAD', f'{P}/repository/files/src%2Frefund.py?ref={BASE}', answer(404, None))
    client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert 'last_commit_id' not in api.bodies('POST', COMMITS)[0]['actions'][0]


def test_a_later_commit_of_a_bundle_builds_on_the_first() -> None:
    api = pushable(FakeGitLab()).on('POST', COMMITS, answer(201, {'id': 'e' * 40, 'parent_ids': [BASE]}),
                                    answer(201, {'id': NEW, 'parent_ids': ['e' * 40]}))
    client(api).push_bundle('conn-1', BRANCH, bundle(commits=2), TREE, 'main')
    first, second = api.bodies('POST', COMMITS)
    assert ('start_sha' in first, 'start_sha' in second, second['actions'][0]['action']) == (True, False, 'update')


@pytest.mark.parametrize(('contents', 'said'), [
    (replace(bundle(), commits=()), 'at least one commit'),
    (replace(bundle(), changed_paths=('other.py',)), 'does not list'),
    (bundle(FileChange('link', '120000', b'target')), 'symbolic link'),
    (bundle(FileChange('sub', '160000', b'x')), 'regular file'),
])
def test_a_bundle_off_its_checks_is_refused_before_any_request(contents: BundleContents, said: str) -> None:
    api = FakeGitLab()
    with pytest.raises(WriteRefused, match=said):
        client(api).push_bundle('conn-1', BRANCH, contents, contents.tree_hash, 'main')
    assert api.sent == []


def test_a_bundle_for_another_tree_than_the_checked_one_is_a_conflict() -> None:
    with pytest.raises(Conflict, match='checked'):
        client(FakeGitLab()).push_bundle('conn-1', BRANCH, bundle(), 'f' * 40, 'main')


@pytest.mark.parametrize(('includes', 'ci_config_path', 'path'), [
    ([{'type': 'local', 'location': '/ci/build.yml'}], None, 'ci/build.yml'),
    ([{'type': 'local', 'location': 'templates/deploy.yml'}], None, 'templates/deploy.yml'),
    ([], 'ops/pipeline.yml', 'ops/pipeline.yml'),
    ([], None, '.gitlab-ci.yml'),
])
def test_the_projects_ci_file_and_what_it_includes_from_the_project_are_never_changed(
        includes: list[dict[str, Any]], ci_config_path: str | None, path: str) -> None:
    api = pushable(FakeGitLab(), includes=includes, ci_config_path=ci_config_path)
    with pytest.raises(WriteRefused, match='CI definitions'):
        client(api).push_bundle('conn-1', BRANCH, bundle(FileChange(path, '100644', b'x')), TREE, 'main')
    assert writes(api) == []


def test_a_ci_file_kept_in_another_project_refuses_the_push() -> None:
    api = pushable(FakeGitLab(), ci_config_path='ci.yml@example-org/ci-templates')
    with pytest.raises(WriteRefused, match=r"its CI file from elsewhere .* which the broker can't read and pin"):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == []


def test_a_ci_lint_that_does_not_answer_refuses_the_push() -> None:
    api = pushable(FakeGitLab()).on('GET', f'{P}/ci/lint?content_ref={BASE}', answer(403, {}))
    with pytest.raises(WriteRefused, match='could not be resolved'):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == []


@pytest.mark.parametrize(('change', 'said'), [
    (lambda api: api.on('GET', P, answer(200, {'default_branch': 'main'})), 'could not be resolved'),
    (lambda api: api.on('GET', raw_path('.gitlab-ci.yml'), Response(200, {}, b'include:\n  - local: "ci/*.yml"\n')),
     "can't read and pin"),
    (lambda api: api.on('GET', raw_path('.gitlab-ci.yml'), answer(404, {})), 'could not be resolved'),
], ids=['no ci_config_path', 'a wildcard include', 'no CI file at the base'])
def test_a_ci_configuration_the_broker_cannot_pin_refuses_every_push(change: Any, said: str) -> None:
    api = change(pushable(FakeGitLab()))
    with pytest.raises(WriteRefused, match=said):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == []


@pytest.mark.parametrize('ready_by', [NOW - 1, None], ids=['past', 'never set'])
def test_a_push_past_its_read_time_or_with_none_set_is_refused_with_nothing_written(ready_by: float | None) -> None:
    token = WRITE_READY_BY.set(ready_by)   # (past: the invocation's time for reads before a write is over)
    try:
        api = pushable(FakeGitLab())
        with pytest.raises(WriteRefused, match='read more of the repository host'):
            client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
        assert writes(api) == []
    finally:
        WRITE_READY_BY.reset(token)


#: When the invocation ends, as the push sees it (the ``ready_by`` fixture's deadline plus the write's reserve).
CALL_ENDS = NOW + 600 + WRITE_RESERVE_SECONDS


def _first_commit_ends_at(clock: Clock, left: float) -> Any:
    """The first commit's answer, after which ``left`` seconds of the invocation remain."""
    def reply(_sent: Any) -> Response:
        clock.now = CALL_ENDS - left
        return answer(201, {'id': 'e' * 40, 'parent_ids': [BASE]})
    return reply


def test_a_later_commit_with_too_little_time_left_stops_and_removes_the_branch_this_push_made() -> None:
    clock = Clock()
    # (one second short of a later commit, its read-back, and the stop's own delete and answer)
    left = gitlab.LATER_COMMIT_SECONDS + gitlab.DELETE_RESERVE_SECONDS - 1
    api = pushable(FakeGitLab()).on('POST', COMMITS, _first_commit_ends_at(clock, left)).on(
        'GET', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(404, {}), answer(200, {'commit': {'id': 'e' * 40}})
    ).on('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(204, {}))
    with pytest.raises(OutcomeUnknown, match=r'ran out of time.*1 of its 2 commit\(s\) landed.*was deleted'):
        client(api, clock).push_bundle('conn-1', BRANCH, bundle(commits=2), TREE, 'main')
    assert writes(api) == [('POST', COMMITS), ('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}')]


def _first_commit_landing(clock: Clock, left: float) -> FakeGitLab:
    """A new branch's one-commit push whose commit lands with ``left`` seconds of the invocation remaining."""
    def reply(_sent: Any) -> Response:
        clock.now = CALL_ENDS - left
        return answer(201, {'id': NEW, 'parent_ids': [BASE]})
    return pushable(FakeGitLab()).on('POST', COMMITS, reply).on(
        'DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(204, {}))


def test_a_read_back_with_no_time_for_its_next_page_is_cut_short_and_the_branch_undone() -> None:
    clock = Clock()
    api = _first_commit_landing(clock, gitlab.DELETE_RESERVE_SECONDS + gitlab.READ_SECONDS - 1)
    with pytest.raises(OutcomeUnknown, match=r'read-back of the pushed tree was cut short.*was deleted'):
        client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert ('GET', tree_path(NEW)) not in api.calls()


def test_an_undo_that_would_not_fit_is_skipped_and_says_the_branch_was_left() -> None:
    clock = Clock()
    api = _first_commit_landing(clock, gitlab.UNDO_SECONDS + gitlab.ANSWER_SECONDS - 1)
    with pytest.raises(OutcomeUnknown, match='was left: no time remained to delete it'):
        client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]


def test_a_read_back_with_just_the_time_for_its_page_reads_it() -> None:
    clock = Clock()
    api = _first_commit_landing(clock, gitlab.DELETE_RESERVE_SECONDS + gitlab.READ_SECONDS)
    client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert ('GET', tree_path(NEW)) in api.calls()


def test_an_undo_that_just_fits_deletes_the_branch() -> None:
    clock = Clock()
    api = _first_commit_landing(clock, gitlab.UNDO_SECONDS + gitlab.ANSWER_SECONDS)
    with pytest.raises(OutcomeUnknown, match=r'cut short.*was deleted'):
        client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api)[-1] == ('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}')


@pytest.mark.parametrize(('late', 'starts'), [(1, False), (0, True)], ids=['a second short', 'just fits'])
def test_the_first_commit_starts_only_if_it_its_read_back_and_the_stop_fit(late: int, starts: bool) -> None:
    clock = Clock()
    need = gitlab.LATER_COMMIT_SECONDS + gitlab.DELETE_RESERVE_SECONDS

    def lease(_sent: Any) -> Response:   # (the last read before the write ends this late)
        clock.now = CALL_ENDS - need + late
        return answer(200, None, {'x-gitlab-last-commit-id': LAST})

    api = pushable(FakeGitLab()).on('HEAD', f'{P}/repository/files/src%2Frefund.py?ref={BASE}', lease)
    if starts:
        client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    else:
        with pytest.raises(WriteRefused, match='push fewer changes'):
            client(api, clock).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert (('POST', COMMITS) in writes(api)) is starts


@pytest.mark.parametrize(('start', 'refused'), [(0, False), (1, True)], ids=['ends on the line', 'a second over'])
def test_a_read_before_the_write_starts_only_if_it_and_its_retry_end_by_the_line(start: int, refused: bool) -> None:
    budget = gitlab._PreWrite(ends_by=NOW)
    if refused:
        with pytest.raises(WriteRefused, match='push fewer changes'):
            budget.spend(NOW - gitlab.READ_SECONDS + start)
    else:
        budget.spend(NOW - gitlab.READ_SECONDS + start)
    assert budget.used == 1


def test_the_time_models_request_is_the_gitlab_transports_timeout() -> None:
    transport = gitlab_transport()
    assert isinstance(transport, HttpsTransport)
    assert transport._timeout == gitlab.REQUEST_SECONDS


def test_the_write_reserve_holds_a_first_commit_a_page_of_its_read_back_and_the_stop() -> None:
    assert WRITE_RESERVE_SECONDS >= gitlab.WRITE_SECONDS + gitlab.READ_SECONDS + gitlab.DELETE_RESERVE_SECONDS
    assert gitlab.READ_SECONDS == gitlab.REQUEST_SECONDS * 2   # (a read and its one retry: gitlab_api.READ_TRIES)


def test_a_later_commit_starts_when_its_time_and_the_stops_reserve_just_fit() -> None:
    clock = Clock()
    left = gitlab.LATER_COMMIT_SECONDS + gitlab.DELETE_RESERVE_SECONDS
    api = pushable(FakeGitLab()).on('POST', COMMITS, _first_commit_ends_at(clock, left),
                                    answer(201, {'id': NEW, 'parent_ids': ['e' * 40]}))
    client(api, clock).push_bundle('conn-1', BRANCH, bundle(commits=2), TREE, 'main')
    assert writes(api) == [('POST', COMMITS), ('POST', COMMITS)]


def test_a_push_of_more_commits_than_its_cap_is_refused_before_anything_is_written() -> None:
    api = pushable(FakeGitLab())
    with pytest.raises(WriteRefused, match='at most 20 commits'):
        client(api).push_bundle('conn-1', BRANCH, bundle(commits=21), TREE, 'main')
    assert writes(api) == []


@pytest.fixture(autouse=True)
def ready_by() -> Any:
    """The broker's handler sets the reads' deadline from Lambda's context; these tests call the client directly."""
    token = WRITE_READY_BY.set(NOW + 600)
    yield
    WRITE_READY_BY.reset(token)


def test_a_push_reads_at_most_its_cap_before_writing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gitlab, 'MAX_PREWRITE_REQUESTS', 3)
    api = pushable(FakeGitLab())
    with pytest.raises(WriteRefused, match='read more of the repository host'):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert (writes(api), len(api.sent)) == ([], 3)


@pytest.mark.parametrize(('change', 'said'), [
    (lambda api: pushable(api, head='e' * 40), 'has moved'),
    (lambda api: pushable(api).on('GET', f'{P}/repository/merge_base?refs%5B%5D=main&refs%5B%5D={BASE}',
                                  answer(200, {'id': 'e' * 40})), 'starts on the default branch'),
    (lambda api: pushable(api).on('GET', f'{P}/repository/merge_base?refs%5B%5D=main&refs%5B%5D={BASE}',
                                  answer(404, {})), 'starts on the default branch'),
    (lambda api: pushable(api).on('GET', tree_path(BASE), answer(200, _listed(
        {**_root(OLD_CODE), 'extra.md': TreeEntry('extra.md', '100644', README)}))), 'another tree'),
    (lambda api: pushable(api).on('POST', COMMITS, answer(400, {'message': 'A branch called x already exists'})),
     'nothing was pushed'),
])
def test_a_push_the_host_is_not_ready_for_is_a_conflict_with_nothing_written(change: Any, said: str) -> None:
    api = change(FakeGitLab())
    with pytest.raises(Conflict, match=said):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')


def test_a_directory_too_large_to_read_refuses_the_push() -> None:
    api = pushable(FakeGitLab())
    for page in range(1, 21):
        api.on('GET', f'{P}/repository/tree?ref={BASE}&per_page=100&page={page}&path=src',
               answer(200, [], {'x-next-page': str(page + 1)}))
    with pytest.raises(WriteRefused, match='more than 2000 entries'):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')


def test_a_commit_that_landed_on_another_head_is_unknown_and_never_deleted_as_the_pushs_own() -> None:
    api = pushable(FakeGitLab(), parent='e' * 40)
    with pytest.raises(OutcomeUnknown, match=r'another head.*was not deleted'):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]


def test_a_pushed_commit_with_another_tree_is_unknown_and_an_existing_branch_is_left() -> None:
    api = pushable(FakeGitLab(), head=BASE, pushed_root=_root(b'surprise\n'))
    with pytest.raises(OutcomeUnknown, match='another tree'):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]


def test_a_branch_removal_that_fails_is_logged_and_the_outcome_still_unknown() -> None:
    api = pushable(FakeGitLab(), pushed_root=_root(b'surprise\n')).on(
        'DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(500, {}))
    with pytest.raises(OutcomeUnknown):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')


@pytest.mark.parametrize(('route', 'commits', 'said'), [
    (('GET', tree_path(NEW), answer(429, {}, {'retry-after': '7'})), 1, 'rate limiting'),
    (('GET', tree_path(NEW), HostBusy('lost', retry_after=60)), 1, r'\(lost\)'),
    (('POST', COMMITS, answer(201, {'id': NEW, 'parent_ids': [BASE]}), answer(400, {})), 2,
     'refused a later commit'),
], ids=['read-back rate-limited', 'read-back lost', 'later commit refused'])
def test_whatever_fails_after_the_first_commit_landed_is_unknown_never_nothing_written(
        route: tuple[Any, ...], commits: int, said: str) -> None:
    api = pushable(FakeGitLab()).on(*route).on('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(204, {}))
    with pytest.raises(OutcomeUnknown, match=f'wrote its first commit.*{said}'):
        client(api).push_bundle('conn-1', BRANCH, bundle(commits=commits), TREE, 'main')
    assert writes(api)[-1] == ('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}')


# --- through the broker: a write made once, an unknown outcome kept unknown -------------------------------------------


def gitlab_broker(api: FakeGitLab, claims: FakeWrites) -> Broker:
    rules = [{'name': 'main', 'allow_force_push': False, 'push_access_levels': [{'access_level': 40}],
              'merge_access_levels': [{'access_level': 40}]}]
    api.on('GET', f'{P}/protected_branches?per_page=100&page=1', answer(200, rules)).on(
        'GET', f'{P}/push_rule', answer(404, {}))
    return Broker(connector(host=client(api), bundles=FakeBundles(bundle()), writes=claims,
                            runs=FakeRuns({RUN: record(repository=PROJECT, default_branch='')}),
                            ledger=FakeLedger({(RUN, TREE)})))


def test_a_push_through_the_broker_is_made_once() -> None:
    api, claims = pushable(FakeGitLab()), FakeWrites()
    committer = Caller('committer', RUN, 2)
    broker = gitlab_broker(api, claims)
    assert broker.push_bundle(committer, BRANCH, 'patch-key', TREE, 'Fix') == TREE
    assert broker.push_bundle(committer, BRANCH, 'patch-key', TREE, 'Fix') == TREE
    assert writes(api) == [('POST', COMMITS)]


def test_a_push_whose_outcome_is_unknown_is_never_made_again() -> None:
    api, claims = pushable(FakeGitLab(), parent='e' * 40), FakeWrites()
    api.on('DELETE', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(204, {}))
    committer = Caller('committer', RUN, 2)
    broker = gitlab_broker(api, claims)
    for _ in range(2):
        with pytest.raises(OutcomeUnknown):
            broker.push_bundle(committer, BRANCH, 'patch-key', TREE, 'Fix')
    assert writes(api).count(('POST', COMMITS)) == 1
    assert [claim.state for claim in claims.claims.values()] == [WRITE_UNKNOWN]


# --- the draft merge request and notes ------------------------------------------------------------------------------


MR_LOOKUP = f'{P}/merge_requests?state=opened&source_branch={QUOTED_BRANCH}&target_branch=main&per_page=20&page={{page}}'


def test_the_runs_merge_request_is_found_on_a_later_page() -> None:
    fork = {**OURS_OPEN, 'iid': 99, 'source_project_id': 77}
    api = draftable(FakeGitLab(), open_mrs=[fork]).on('GET', MR_LOOKUP.format(page=1),
                                                      answer(200, [fork], {'x-next-page': '2'}))
    api.on('GET', MR_LOOKUP.format(page=2), answer(200, [OURS_OPEN]))
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert writes(api) == [('PUT', f'{P}/merge_requests/8')]


def test_more_merge_request_pages_than_it_reads_refuse_rather_than_open_a_second() -> None:
    api = draftable(FakeGitLab(), open_mrs=[])
    for page in range(1, 6):
        api.on('GET', MR_LOOKUP.format(page=page), answer(200, [], {'x-next-page': str(page + 1)}))
    with pytest.raises(WriteRefused, match='more than the broker reads'):
        client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert writes(api) == []


def test_a_commit_on_a_head_someone_pushed_meanwhile_is_not_this_pushs_and_nothing_is_deleted() -> None:
    # Commit 1 creates the branch; a person pushes H on it; commit 2 lands on H. H's descendant is not the push's.
    person = 'a' * 40
    api = pushable(FakeGitLab()).on('POST', COMMITS, answer(201, {'id': 'e' * 40, 'parent_ids': [BASE]}),
                                    answer(201, {'id': NEW, 'parent_ids': [person]}))
    with pytest.raises(OutcomeUnknown, match="was not deleted: its head is no longer one of this push's commits"):
        client(api).push_bundle('conn-1', BRANCH, bundle(commits=2), TREE, 'main')
    assert writes(api) == [('POST', COMMITS), ('POST', COMMITS)]


#: The run's own open merge request: from this project's agent branch into the default branch.
OURS_OPEN = {'iid': 8, 'web_url': 'https://gitlab.com/x/-/merge_requests/8', 'source_project_id': 4242,
             'target_branch': 'main'}


def test_a_forks_merge_request_of_the_same_branch_name_is_not_the_runs() -> None:
    fork = {**OURS_OPEN, 'iid': 99, 'source_project_id': 77}
    elsewhere = {**OURS_OPEN, 'iid': 98, 'target_branch': 'release'}
    api = draftable(FakeGitLab(), open_mrs=[fork, elsewhere])
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert writes(api) == [('POST', f'{P}/merge_requests')]


def test_a_branch_someone_moved_since_the_push_is_never_deleted() -> None:
    api = pushable(FakeGitLab(), parent='e' * 40).on(
        'GET', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(404, {}), answer(200, {'commit': {'id': 'a' * 40}}))
    with pytest.raises(OutcomeUnknown, match="was not deleted: its head is no longer one of this push's commits"):
        client(api).push_bundle('conn-1', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]


def draftable(api: FakeGitLab, open_mrs: list[dict[str, Any]], mr_root: dict[str, TreeEntry] | None = None,
              check: Any = None) -> FakeGitLab:
    """The agent's branch at ``NEW`` (tree ``TREE``), ``open_mrs`` from it, and merge request 8's head."""
    return (api.on('GET', f'{P}/repository/branches/{QUOTED_BRANCH}', answer(200, {'commit': {'id': NEW}}))
            .on('GET', tree_path(NEW), answer(200, _listed(_root(NEW_CODE))))
            .on('GET', MR_LOOKUP.format(page=1), answer(200, open_mrs))
            .on('POST', f'{P}/merge_requests', answer(201, {'iid': 8, 'web_url': 'https://gitlab.com/x/-/merge_requests/8'}))
            .on('PUT', f'{P}/merge_requests/8', answer(200, {}))
            .on('GET', f'{P}/merge_requests/8', check if check is not None else answer(200, {'sha': 'f' * 40}))
            .on('GET', tree_path('f' * 40), answer(200, _listed(mr_root if mr_root is not None else _root(NEW_CODE)))))


def test_a_draft_merge_request_is_opened_with_a_draft_title_when_the_branch_has_the_tree() -> None:
    api = draftable(FakeGitLab(), open_mrs=[])
    ref = client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix the total', 'Body', TREE)
    assert ref == PullRequestRef(8, 'https://gitlab.com/x/-/merge_requests/8', host='gitlab')
    assert api.bodies('POST', f'{P}/merge_requests') == [{
        'title': 'Draft: Fix the total', 'description': 'Body', 'source_branch': BRANCH, 'target_branch': 'main',
        'remove_source_branch': False}]


@pytest.mark.parametrize('title', ['Fix the total', 'Draft: Fix the total', '[Draft] (draft) Fix the total'])
def test_a_merge_request_ready_for_review_is_opened_without_any_draft_marker(title: str) -> None:
    api = draftable(FakeGitLab(), open_mrs=[])
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', title, 'Body', TREE, draft=False)
    assert [body['title'] for body in api.bodies('POST', f'{P}/merge_requests')] == ['Fix the total']


def test_an_open_merge_request_gets_its_text_updated_and_stays_a_draft() -> None:
    api = draftable(FakeGitLab(), open_mrs=[{**OURS_OPEN, 'draft': True}])
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE, draft=False)
    assert writes(api) == [('PUT', f'{P}/merge_requests/8')]
    assert api.bodies('PUT', f'{P}/merge_requests/8') == [{'title': 'Draft: Fix', 'description': 'Body'}]


@pytest.mark.parametrize('title', ['Fix', 'Draft: Fix'])
def test_an_open_merge_request_ready_for_review_stays_ready_whatever_the_agents_title(title: str) -> None:
    api = draftable(FakeGitLab(), open_mrs=[{**OURS_OPEN, 'draft': False}])
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', title, 'Body', TREE, draft=True)
    assert api.bodies('PUT', f'{P}/merge_requests/8') == [{'title': 'Fix', 'description': 'Body'}]


def test_an_open_merge_request_whose_draft_state_gitlab_does_not_say_keeps_its_title() -> None:
    api = draftable(FakeGitLab(), open_mrs=[OURS_OPEN])
    client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)
    # (neither marked ready nor made a draft: only the description is written)
    assert api.bodies('PUT', f'{P}/merge_requests/8') == [{'description': 'Body'}]


def test_an_issue_gets_its_triage_labels_added() -> None:
    api = FakeGitLab().on('PUT', f'{P}/issues/42', answer(200, {}))
    assert client(api).label_issue('conn-1', 42, ('voc-triage/bug', 'voc-severity/s2')) == (
        'voc-triage/bug', 'voc-severity/s2')
    assert api.bodies('PUT', f'{P}/issues/42') == [{'add_labels': 'voc-triage/bug,voc-severity/s2'}]


def test_the_gitlab_client_has_no_merge_approve_or_ready_method() -> None:
    public = {name for name in dir(GitLabHost) if not name.startswith('_')}
    assert not {name for name in public if any(word in name for word in ('merge', 'approve', 'ready'))}
    # Nor any request path that would (the source's paths): a merge, an approval, a merge when the pipeline passes.
    source = Path(gitlab.__file__).read_text()
    for forbidden in ("/merge'", '/merge"', '/merge?', '/approve', '/unapprove', 'merge_when_pipeline_succeeds',
                      'auto_merge'):
        assert forbidden not in source, forbidden


def test_a_branch_without_the_checked_tree_gets_no_merge_request() -> None:
    api = draftable(FakeGitLab(), open_mrs=[])
    with pytest.raises(Conflict):
        client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', 'f' * 40)
    assert writes(api) == []


@pytest.mark.parametrize('check', [answer(429, {}, {'retry-after': '7'}), answer(200, {'sha': 'f' * 40})],
                         ids=['rate-limited', 'moved'])
def test_a_merge_request_whose_check_fails_after_it_is_opened_is_closed_and_unknown(check: Any) -> None:
    api = draftable(FakeGitLab(), open_mrs=[], mr_root=_root(b'moved\n'), check=check)
    with pytest.raises(OutcomeUnknown, match='opened'):
        client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert writes(api) == [('POST', f'{P}/merge_requests'), ('PUT', f'{P}/merge_requests/8')]
    assert api.bodies('PUT', f'{P}/merge_requests/8') == [{'state_event': 'close'}]


def test_a_close_that_fails_is_logged_and_the_outcome_still_unknown() -> None:
    api = draftable(FakeGitLab(), open_mrs=[], mr_root=_root(b'moved\n')).on('PUT', f'{P}/merge_requests/8',
                                                                             answer(500, {}))
    with pytest.raises(OutcomeUnknown):
        client(api).open_or_update_draft_pr('conn-1', BRANCH, 'main', 'Fix', 'Body', TREE)


@pytest.mark.parametrize(('on', 'kind'), [('issue', 'issues'), ('pull_request', 'merge_requests')])
def test_a_note_is_posted_and_answered_with_its_link(on: Any, kind: str) -> None:
    api = FakeGitLab().on('POST', f'{P}/{kind}/42/notes', answer(201, {'id': 99}))
    url = client(api).post_comment('conn-1', on, 42, 'Thanks')
    assert url == f'https://gitlab.com/{PROJECT}/-/{kind}/42#note_99'
    assert api.bodies('POST', f'{P}/{kind}/42/notes') == [{'body': 'Thanks'}]


#: (7.71.03) The run's marker, and the look for its note: newest first, a hundred a page; (7.71.04) only the token's
#: own user's (``BOT_USER``, ``GET /user``).
MARKER = '<!-- voc-engineering-run:01JD3R4NZXQ7Y2W8K4M6P9T0AB -->'
NOTES = f'{P}/issues/42/notes?per_page=100&sort=desc&order_by=created_at&page='
BOT_USER = 7001
OWN = {'author': {'id': BOT_USER, 'username': 'project_4242_bot_ab12'}, 'system': False}


def _with_user(api: FakeGitLab) -> FakeGitLab:
    return api.on('GET', '/api/v4/user', answer(200, {'id': BOT_USER, 'username': 'project_4242_bot_ab12'}))


def test_the_runs_note_on_its_issue_is_found_by_its_marker_newest_first_ten_pages_at_most() -> None:
    # (7.71.03) The look for the run's own comment whose call never heard back (``broker.issue_marker``).
    api = _with_user(FakeGitLab().on('GET', f'{NOTES}1', answer(200, [{'id': 5, 'body': 'Me too.', **OWN}],
                                                                {'x-next-page': '2'}))
                     .on('GET', f'{NOTES}2', answer(200, [{'id': 3, 'body': f'Triage\n\n{MARKER}\n', **OWN}])))
    assert client(api).issue_comment('conn-1', 42, MARKER, 1) == f'https://gitlab.com/{PROJECT}/-/issues/42#note_3'
    for page in range(1, 12):
        api.on('GET', f'{NOTES}{page}', answer(200, [{'id': 5, 'body': 'Me too.', **OWN}],
                                               {'x-next-page': str(page + 1)}))
    assert client(api).issue_comment('conn-1', 42, MARKER, 1) is None
    assert [path for _, path in api.calls()].count(f'{NOTES}11') == 0


@pytest.mark.parametrize('note', [
    {'body': f'Triage\n\n{MARKER}', 'author': {'id': BOT_USER + 1}},   # (another account's)
    {'body': f'Triage\n\n{MARKER}', 'author': {'id': str(BOT_USER)}},   # (an id that is no number)
    {'body': f'Triage\n\n{MARKER}', **OWN, 'system': True},   # (a system note, written as the token's user)
    {'body': f'Quoting {MARKER} here.', **OWN},   # (the marker inside, not at the end)
], ids=['outsider', 'text-id', 'system', 'inside'])
def test_a_note_with_the_marker_is_the_runs_only_when_the_tokens_users_own_and_ending_with_it(
        note: dict[str, object]) -> None:
    # (7.71.04) Anyone who reads the issue may copy the marker into a note: only the token's own user's note, never a
    # system note, that ends with it is the run's.
    api = _with_user(FakeGitLab().on('GET', f'{NOTES}1', answer(200, [{'id': 3, **note}])))
    assert client(api).issue_comment('conn-1', 42, MARKER, 1) is None
    assert [path for _, path in api.calls()] == ['/api/v4/user', f'{NOTES}1']


# --- the router: each connection on its own host's client ------------------------------------------------------------


def test_the_router_sends_each_connection_to_its_hosts_client() -> None:
    stored: dict[str, GitHubAppCredential | GitLabTokenCredential] = {'gl': credential(), 'gh': app_credential()}
    gitlab = GitLabHost(lambda _c: credential(), FakeGitLab())
    github = GitHubHost(lambda _c: app_credential())
    router = HostRouter(stored.__getitem__, github, gitlab)
    assert (router.repository('gl'), router.repository('gh')) == (PROJECT, 'example-org/refund-service')
    assert router.fetch_access('gl') == FetchAccess(PROJECT, TOKEN, host='gitlab', revocable=False)


def test_the_router_hands_an_issues_labels_and_a_pull_requests_draft_flag_to_the_hosts_client() -> None:
    api = draftable(FakeGitLab(), open_mrs=[]).on('PUT', f'{P}/issues/42', answer(200, {}))
    router = HostRouter(lambda _c: credential(), GitHubHost(lambda _c: app_credential()), client(api))
    assert router.label_issue('gl', 42, ('voc-triage/bug',)) == ('voc-triage/bug',)
    _with_user(api).on('GET', f'{NOTES}1', answer(200, []))
    assert router.issue_comment('gl', 42, MARKER, 1) is None
    router.open_or_update_draft_pr('gl', BRANCH, 'main', 'Fix', 'Body', TREE, draft=False)
    assert [body['title'] for body in api.bodies('POST', f'{P}/merge_requests')] == ['Fix']


def test_the_router_delegates_every_operation_to_the_hosts_client() -> None:
    api = pushable(FakeGitLab())
    api.on('GET', f'{P}/repository/files/a.py/raw?ref={BASE}', answer(200, 'x'))
    router = HostRouter(lambda _c: credential(), GitHubHost(lambda _c: app_credential()), client(api))
    assert router.default_branch('gl') == 'main'
    assert router.file_at('gl', BASE, 'a.py') == b'"x"'
    router.push_bundle('gl', BRANCH, bundle(), TREE, 'main')
    assert writes(api) == [('POST', COMMITS)]
