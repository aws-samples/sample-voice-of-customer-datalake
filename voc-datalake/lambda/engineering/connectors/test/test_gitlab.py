"""The GitLab client (gitlab.py), its reads and the CI check: files, history, issues and merge requests, bounded
pages, the default branch, and the project's branch rules as the broker holds a push to them."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.connectors.gitlab import (
    CI_CHECK_SECONDS,
    GITLAB_FORCE_PUSH,
    GITLAB_MERGE_OPEN,
    GITLAB_NO_PIPELINE,
    GITLAB_PUSH_OPEN,
    GITLAB_PUSH_RULE,
    GITLAB_RULES_UNREAD,
    GITLAB_SKIPPED_PIPELINE,
    GITLAB_TOO_MANY_RULES,
    MAX_PROTECTED_PAGES,
    PIPELINE_CHECK,
    GitLabHost,
    draft_title,
    wildcard_match,
)
from engineering.connectors.hosts import (
    CI_AGENT_BRANCH_PROTECTED,
    CI_DEFAULT_UNPROTECTED,
    InvalidTarget,
    NotFound,
    StoredBranchMissing,
    ci_refusal,
)
from engineering.connectors.test.fakes import BRANCH
from engineering.connectors.test.gitlab_fakes import (
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

COMMIT = 'c' * 40


# --- reads ----------------------------------------------------------------------------------------------------------


def test_a_file_is_read_raw_on_the_runs_branch_with_the_token_in_its_header() -> None:
    api = FakeGitLab().on('GET', f'{P}/repository/files/src%2Frefund.py/raw?ref=develop', answer(200, 'x'))
    page = client(api).read('conn-1', 'file', 'src/refund.py', None, 'develop')
    assert (page.content, page.next_cursor) == ('"x"', None)
    assert api.sent[0].headers['Authorization'] == f'Bearer {TOKEN}'


def test_a_file_on_the_projects_own_branch_reads_head() -> None:
    api = FakeGitLab().on('GET', f'{P}/repository/files/README.md/raw?ref=HEAD', answer(200, '# hi'))
    assert client(api).read('conn-1', 'file', 'README.md', None).content == '"# hi"'


@pytest.mark.parametrize(('reply', 'raised'), [(answer(404, {}), NotFound),
                                               (Response(200, {}, b'\xff\xfe'), InvalidTarget)])
def test_a_missing_or_binary_file_is_refused(reply: Response, raised: type[Exception]) -> None:
    api = FakeGitLab().on('GET', f'{P}/repository/files/a.bin/raw?ref=HEAD', reply)
    with pytest.raises(raised):
        client(api).read('conn-1', 'file', 'a.bin', None)


@pytest.mark.parametrize(('target', 'cursor'), [('../etc', None), ('a//b', None), ('README.md', '2')])
def test_a_file_outside_the_repository_or_with_a_page_is_refused_before_any_request(target: str,
                                                                                    cursor: str | None) -> None:
    api = FakeGitLab()
    with pytest.raises(InvalidTarget):
        client(api).read('conn-1', 'file', target, cursor)
    assert api.sent == []


def test_a_base_file_is_read_at_the_runs_commit_and_none_when_missing() -> None:
    api = FakeGitLab().on('GET', f'{P}/repository/files/a.py/raw?ref={COMMIT}', answer(404, {}))
    assert client(api).file_at('conn-1', COMMIT, 'a.py') is None
    with pytest.raises(InvalidTarget):
        client(api).file_at('conn-1', 'main', 'a.py')


def test_history_is_a_page_of_commits_on_the_branch_with_gitlabs_next_page() -> None:
    commits = [{'id': COMMIT, 'committed_date': '2026-11-01T10:00:00Z', 'message': 'Fix'}]
    api = FakeGitLab().on('GET', f'{P}/repository/commits?per_page=30&page=2&ref_name=main&path=src%2Fa.py',
                          answer(200, commits, {'x-next-page': '3'}))
    page = client(api).read('conn-1', 'history', 'src/a.py', '2', 'main')
    assert json.loads(page.content) == {'commits': [{'sha': COMMIT, 'date': '2026-11-01T10:00:00Z', 'message': 'Fix'}]}
    assert page.next_cursor == '3'


def test_a_cursor_the_broker_did_not_hand_out_is_refused() -> None:
    with pytest.raises(InvalidTarget, match='cursor'):
        client(FakeGitLab()).read('conn-1', 'history', '.', 'page-2')


def test_an_issue_is_read_with_its_own_notes_not_the_systems() -> None:
    notes = [{'id': 1, 'author': {'username': 'dana'}, 'created_at': 't', 'body': 'Seen it', 'system': False},
             {'id': 2, 'author': {'username': 'bot'}, 'body': 'changed the label', 'system': True}]
    api = (FakeGitLab().on('GET', f'{P}/issues/42', answer(200, {'iid': 42, 'title': 'T', 'state': 'opened',
                                                                  'description': 'D'}))
           .on('GET', f'{P}/issues/42/notes?per_page=30&page=1&sort=asc&order_by=created_at', answer(200, notes)))
    content = json.loads(client(api).read('conn-1', 'issue', '42', None).content)
    assert content['issue'] == {'number': 42, 'title': 'T', 'state': 'opened', 'body': 'D'}
    assert content['comments'] == [{'id': 1, 'author': 'dana', 'created_at': 't', 'body': 'Seen it'}]


def test_a_merge_request_is_read_with_its_notes_diff_notes_and_approvals() -> None:
    notes = [{'id': 1, 'author': {'username': 'dana'}, 'created_at': 't', 'body': 'Looks fine', 'type': None},
             {'id': 2, 'author': {'username': 'eli'}, 'created_at': 't', 'body': 'Rename this', 'type': 'DiffNote',
              'position': {'new_path': 'src/a.py', 'new_line': 7}}]
    base = f'{P}/merge_requests/7'
    api = (FakeGitLab().on('GET', base, answer(200, {'iid': 7, 'title': 'Draft: Fix', 'state': 'opened', 'draft': True,
                                                     'description': 'B'}))
           .on('GET', f'{base}/notes?per_page=30&page=1&sort=asc&order_by=created_at',
               answer(200, notes, {'x-next-page': '2'}))
           .on('GET', f'{base}/approvals', answer(200, {'approved_by': [{'user': {'username': 'fay'}}]})))
    page = client(api).read('conn-1', 'pull_request', '7', None)
    content = json.loads(page.content)
    assert content['pull_request']['draft'] is True
    assert content['review_comments'] == [{'id': 2, 'author': 'eli', 'created_at': 't', 'body': 'Rename this',
                                           'path': 'src/a.py', 'line': 7}]
    assert (content['reviews'], len(content['comments'])) == ([{'author': 'fay', 'state': 'approved'}], 1)
    assert page.next_cursor == '2'


def test_a_later_page_of_a_merge_request_is_its_notes_alone() -> None:
    api = FakeGitLab().on('GET', f'{P}/merge_requests/7/notes?per_page=30&page=2&sort=asc&order_by=created_at',
                          answer(200, []))
    content = json.loads(client(api).read('conn-1', 'pull_request', '7', '2').content)
    assert content == {'comments': [], 'review_comments': []}


def test_a_missing_issue_is_not_found() -> None:
    api = FakeGitLab().on('GET', f'{P}/issues/9', answer(404, {}))
    with pytest.raises(NotFound):
        client(api).read('conn-1', 'issue', '9', None)


# --- the default branch and the repository --------------------------------------------------------------------------


def test_the_projects_own_default_branch_is_kept_five_minutes() -> None:
    clock = Clock()
    api = FakeGitLab().on('GET', P, answer(200, {'default_branch': 'main'}), answer(200, {'default_branch': 'trunk'}))
    host = client(api, clock)
    assert (host.default_branch('conn-1'), host.default_branch('conn-1')) == ('main', 'main')
    clock.now += 301
    assert host.default_branch('conn-1') == 'trunk'


def test_a_stored_default_branch_is_served_once_the_project_has_it() -> None:
    api = (FakeGitLab().on('GET', f'{P}/repository/branches/develop', answer(200, {'commit': {'id': COMMIT}}))
           .on('GET', f'{P}/repository/branches/gone', answer(404, {})))
    host = client(api)
    assert (host.default_branch('conn-1', 'develop'), host.default_branch('conn-1', 'develop')) == ('develop',) * 2
    assert len(api.sent) == 1
    with pytest.raises(StoredBranchMissing):
        host.default_branch('conn-1', 'gone')


def test_the_repository_and_the_fetch_token_are_the_credentials_own() -> None:
    host = client(FakeGitLab())
    assert host.repository('conn-1') == PROJECT
    assert host.fetch_token('conn-1') == (PROJECT, TOKEN)


def test_the_default_transport_is_gitlab_coms() -> None:
    transport = GitLabHost(lambda _: credential())._transport
    assert isinstance(transport, HttpsTransport)
    assert transport._host == 'gitlab.com'


# --- the branch rules (the CI attestation's check) --------------------------------------------------------------------


def rule(name: str = 'main', *, force: bool = False, push: list[dict[str, Any]] | None = None,
         merge: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {'name': name, 'allow_force_push': force,
            'push_access_levels': push if push is not None else [{'access_level': 40}],
            'merge_access_levels': merge if merge is not None else [{'access_level': 40}]}


def rules_api(rules: list[dict[str, Any]], *, pipeline: bool = True, push_rule: Any = None,
              skipped: Any = False) -> FakeGitLab:
    settings = {'only_allow_merge_if_pipeline_succeeds': pipeline, 'allow_merge_on_skipped_pipeline': skipped}
    return (FakeGitLab().on('GET', f'{P}/protected_branches?per_page=100&page=1', answer(200, rules))
            .on('GET', P, answer(200, {key: value for key, value in settings.items() if value is not None}))
            .on('GET', f'{P}/push_rule', push_rule if push_rule is not None else answer(404, {})))


def test_the_guides_rules_pass_with_the_pipeline_as_the_required_check() -> None:
    found = client(rules_api([rule(), rule('release/*', push=[{'access_level': 0}])])).ci_protection(
        'conn-1', 'main', BRANCH)
    assert (found.passes, found.required_checks, found.agent_branch_protected) == (True, (PIPELINE_CHECK,), False)


@pytest.mark.parametrize(('rules', 'pipeline', 'refusal'), [
    ([], True, CI_DEFAULT_UNPROTECTED),
    ([rule('dev*')], True, CI_DEFAULT_UNPROTECTED),
    ([rule(force=True)], True, GITLAB_FORCE_PUSH),
    ([rule(push=[{'access_level': 30}])], True, GITLAB_PUSH_OPEN),
    ([rule(push=[])], True, GITLAB_PUSH_OPEN),
    ([rule(push=[{'access_level': 40}, {'access_level': None, 'user_id': 5}])], True, GITLAB_PUSH_OPEN),
    ([rule(merge=[{'access_level': 30}])], True, GITLAB_MERGE_OPEN),
    ([rule(), rule('ma*', push=[{'access_level': 30}])], True, GITLAB_PUSH_OPEN),   # (the most permissive applies)
    ([rule()], False, GITLAB_NO_PIPELINE),
    ([rule(), rule('voc-agent/*')], True, CI_AGENT_BRANCH_PROTECTED),
    ([rule(), rule('*')], True, CI_AGENT_BRANCH_PROTECTED),
])
def test_rules_off_the_guide_refuse_saying_what_to_change(rules: list[dict[str, Any]], pipeline: bool,
                                                          refusal: str) -> None:
    found = client(rules_api(rules, pipeline=pipeline)).ci_protection('conn-1', 'main', BRANCH)
    assert ci_refusal(found) == refusal


@pytest.mark.parametrize(('push_rule', 'refused'), [
    (answer(200, {'branch_name_regex': '^voc-agent/'}), False),
    (answer(200, {'branch_name_regex': '^feature/'}), True),
    (answer(200, {'branch_name_regex': '('}), True),   # (a pattern it cannot read: failing closed)
    (answer(200, {'branch_name_regex': None}), False),
    (answer(403, {}), False),   # (not shown to a Developer: the attestation's)
])
def test_a_push_rule_shown_to_the_token_must_take_the_agents_branch(push_rule: Any, refused: bool) -> None:
    found = client(rules_api([rule()], push_rule=push_rule)).ci_protection('conn-1', 'main', BRANCH)
    assert (ci_refusal(found) == GITLAB_PUSH_RULE) is refused


@pytest.mark.parametrize('skipped', [True, None], ids=['on', 'not said'])
def test_a_merge_on_a_skipped_pipeline_refuses_failing_closed(skipped: Any) -> None:
    found = client(rules_api([rule()], skipped=skipped)).ci_protection('conn-1', 'main', BRANCH)
    assert ci_refusal(found) == GITLAB_SKIPPED_PIPELINE


def test_rules_the_token_cannot_read_refuse_failing_closed() -> None:
    api = FakeGitLab().on('GET', f'{P}/protected_branches?per_page=100&page=1', answer(403, {}))
    found = client(api).ci_protection('conn-1', 'main', BRANCH)
    assert (found.passes, ci_refusal(found)) == (False, GITLAB_RULES_UNREAD)


def test_more_rule_pages_than_it_reads_refuse_failing_closed() -> None:
    api = FakeGitLab()
    for page in range(1, MAX_PROTECTED_PAGES + 1):
        api.on('GET', f'{P}/protected_branches?per_page=100&page={page}',
               answer(200, [rule(f'r{page}')], {'x-next-page': str(page + 1)}))
    assert ci_refusal(client(api).ci_protection('conn-1', 'main', BRANCH)) == GITLAB_TOO_MANY_RULES
    assert len(api.sent) == MAX_PROTECTED_PAGES


def test_a_pass_is_kept_five_minutes_and_a_failure_is_read_again() -> None:
    clock = Clock()
    api = rules_api([rule()])
    host = client(api, clock)
    host.ci_protection('conn-1', 'main', BRANCH)
    host.ci_protection('conn-1', 'main', BRANCH)
    assert len(api.sent) == 3
    clock.now += CI_CHECK_SECONDS + 1
    api.on('GET', P, answer(200, {'only_allow_merge_if_pipeline_succeeds': False}))
    host.ci_protection('conn-1', 'main', BRANCH)
    host.ci_protection('conn-1', 'main', BRANCH)
    assert len(api.sent) == 9


@pytest.mark.parametrize(('pattern', 'branch', 'matched'), [
    ('main', 'main', True), ('main', 'maintenance', False), ('voc-agent/*', BRANCH, True), ('*', 'x/y', True),
    ('re.ease', 'release', False), ('v*-stable', 'v1.2-stable', True)])
def test_a_rules_wildcard_matches_as_gitlabs_does(pattern: str, branch: str, matched: bool) -> None:
    assert wildcard_match(pattern, branch) is matched


def test_a_draft_title_says_so_once() -> None:
    assert (draft_title('Fix'), draft_title('Draft: Fix')) == ('Draft: Fix', 'Draft: Fix')
