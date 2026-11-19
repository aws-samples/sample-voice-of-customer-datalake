"""The run's issue and pull request on its record, read back (7.09.00, ``engineering/run_links.py``): each only when its
address is the run's own repository's on its host's own domain, over https; and the run monitor's overview answers
them (``issue``, ``pull_request``, each None for none)."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.connectors.gitlab_api import GITLAB_HOST
from engineering.monitor import RunMonitor
from engineering.rows import run_pk
from engineering.run_links import (
    HOSTS,
    MAX_CLAIMS_READ,
    MAX_NUMBER,
    PULL_REQUEST_SK,
    IssueLink,
    issue_link,
    issue_of,
    own_url,
    pull_request_link,
    pull_request_of,
    run_links,
    writes_pk,
)
from engineering.runtime.sessions import AgentSession

REPO = 'example-org/shop'
PULL = f'https://github.com/{REPO}/pull/7'
BRANCH = f'voc-agent/{RUN}/fix-paging'
#: Not ASCII: the Kelvin sign (U+212A) lower-cases to "k", so it would pass a case-blind compare with ``…/kit/…``.
KELVIN_URL = f'https://github.com/example-org/{chr(0x212A)}it/pull/7'


def test_the_hosts_domains_are_the_clients_own() -> None:
    assert HOSTS == {'github': 'github.com', 'gitlab': GITLAB_HOST}


@pytest.mark.parametrize(('host', 'kind', 'url'), [
    ('github', 'issue', f'https://github.com/{REPO}/issues/7'),
    ('github', 'pull_request', PULL),
    ('gitlab', 'issue', f'https://gitlab.com/{REPO}/-/issues/7'),
    ('gitlab', 'pull_request', f'https://gitlab.com/{REPO}/-/merge_requests/7'),
    # (the host's own casing of the repository's path)
    ('github', 'pull_request', 'https://github.com/Example-Org/Shop/pull/7'),
])
def test_an_address_of_the_runs_own_repository_on_its_hosts_domain_is_its_own(host: str, kind: Any, url: str) -> None:
    assert own_url(host, REPO, kind, 7, url)


@pytest.mark.parametrize(('host', 'repository', 'number', 'url'), [
    ('github', REPO, 7, PULL.replace('https:', 'http:')),
    ('github', REPO, 7, f'https://github.com.example.net/{REPO}/pull/7'),
    ('github', REPO, 7, f'https://github.com/{REPO}/pull/7#comment'),
    ('github', REPO, 8, PULL),
    ('github', 'other-org/shop', 7, PULL),
    ('gitlab', REPO, 7, PULL),
    ('code-host', REPO, 7, PULL),
    ('github', '../shop', 7, 'https://github.com/../shop/pull/7'),
    ('github', REPO, 0, f'https://github.com/{REPO}/pull/0'),
    ('github', REPO, True, f'https://github.com/{REPO}/pull/1'),
    ('github', REPO, MAX_NUMBER + 1, f'https://github.com/{REPO}/pull/{MAX_NUMBER + 1}'),
    ('github', 'example-org/kit', 7, KELVIN_URL),
    # (GitHub's repositories are owner/name exactly; only GitLab's have subgroups)
    ('github', 'example-org/payments/shop', 7, 'https://github.com/example-org/payments/shop/pull/7'),
], ids=['scheme', 'domain', 'fragment', 'number', 'repository', 'host', 'unknown-host', 'path', 'zero', 'bool',
        'too-large', 'non-ascii', 'github-subgroup'])
def test_any_other_address_is_not(host: str, repository: str, number: Any, url: str) -> None:
    assert not own_url(host, repository, 'pull_request', number, url)


def test_a_link_is_kept_only_with_its_branches() -> None:
    assert pull_request_link('github', REPO, 7, PULL, BRANCH, 'main') is not None
    assert pull_request_link('github', REPO, 7, PULL, '', 'main') is None
    assert pull_request_link('github', REPO, 7, PULL, BRANCH, 'has space') is None
    assert issue_link('github', REPO, 0) is None


@pytest.mark.parametrize('result', [None, '', 'not json', '[]', json.dumps({'host': 'github', 'number': '7'}),
                                    json.dumps({'host': 'github', 'number': 7, 'url': 'https://code.example.net/7',
                                                'head': BRANCH, 'base': 'main'})])
def test_a_pull_request_row_off_its_shape_or_not_the_runs_reads_as_none(result: str | None) -> None:
    item = None if result is None else {'result': {'S': result}}
    assert pull_request_of(item, REPO) is None


@pytest.mark.parametrize('issue', [None, {'S': 'x'}, {'M': {'host': {'S': 'github'}, 'number': {'N': 'x'},
                                                            'url': {'S': f'https://github.com/{REPO}/issues/7'}}}])
def test_an_issue_off_its_shape_reads_as_none(issue: Any) -> None:
    meta: dict[str, Any] = {'repo': {'S': REPO}}
    if issue is not None:
        meta['issue'] = issue
    assert issue_of(meta) is None


def test_a_fork_runs_issue_is_read_on_its_upstream() -> None:
    # (7.57.00: META's issue_repo, the fork's upstream, names the repository the issue's address is of)
    url = 'https://github.com/upstream-org/shop/issues/7'
    meta: dict[str, Any] = {'repo': {'S': REPO}, 'issue_repo': {'S': 'upstream-org/shop'},
                            'issue': {'M': {'host': {'S': 'github'}, 'number': {'N': '7'}, 'url': {'S': url}}}}
    found = issue_of(meta)
    assert found is not None
    assert (found.number, found.url) == (7, url)
    assert issue_of({**meta, 'issue_repo': {'S': ''}}) is None   # (on the fork itself it is no issue of the run's)


class _NoSessions:
    def of_run(self, run_id: str) -> list[AgentSession]:  # noqa: ARG002 - the protocol's signature
        return []


def _meta(client: Any, expression: str, values: dict[str, Any]) -> None:
    names = {'#repo': 'repo', **({'#issue': 'issue'} if '#issue' in expression else {})}
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression=expression, ExpressionAttributeValues=values, ExpressionAttributeNames=names)


def _pull_request(client: Any, url: str = PULL, closed_at: int = 1_000) -> None:
    result = json.dumps({'host': 'github', 'number': 7, 'url': url, 'head': BRANCH, 'base': 'main'})
    client.put_item(TableName=TABLE, Item={'pk': {'S': writes_pk('default', RUN)}, 'sk': {'S': PULL_REQUEST_SK},
                                           'op': {'S': 'pull_request'}, 'at': {'N': '1000'},
                                           'closed_at': {'N': str(closed_at)}, 'result': {'S': result}})


def test_the_overview_answers_the_runs_issue_and_pull_request() -> None:
    issue = IssueLink(host='github', number=12, url=f'https://github.com/{REPO}/issues/12')
    with engineering_table() as client:
        _meta(client, 'SET #repo = :r, #issue = :i', {':r': {'S': REPO}, ':i': {'M': {
            'host': {'S': 'github'}, 'number': {'N': '12'}, 'url': {'S': issue.url}, 'verified': {'BOOL': False}}}})
        _pull_request(client)
        view = RunMonitor(client, TABLE, _NoSessions(), signaller=None, publisher=None).overview(RUN)
    assert view is not None
    assert (view['run']['issue'], view['run']['pull_request']) == (issue.view(), {
        'host': 'github', 'number': 7, 'url': PULL, 'head': BRANCH, 'base': 'main', 'superseded': []})


def _claim(client: Any, number: int, closed_at: int, head: str = BRANCH, state: str = 'done', agent: int = 4) -> None:
    """A done open or update of the pull request author's, as the broker's claim keeps it."""
    result = json.dumps({'host': 'github', 'number': number, 'url': f'https://github.com/{REPO}/pull/{number}',
                         'head': head, 'base': 'main', 'ci': {}})
    client.put_item(TableName=TABLE, Item={
        'pk': {'S': writes_pk('default', RUN)},
        'sk': {'S': f'WRITE#pr-author-{agent}#{number}#open_or_update_draft_pr#d'},
        'op': {'S': 'open_or_update_draft_pr'}, 'state': {'S': state}, 'at': {'N': str(closed_at)},
        'closed_at': {'N': str(closed_at)}, 'result': {'S': result}})


def _links(client: Any) -> Any:
    return run_links(client, TABLE, 'default', RUN, {'repo': {'S': REPO}})['pull_request']


def test_a_record_never_written_is_read_from_the_newest_done_claim() -> None:
    with engineering_table() as client:
        _claim(client, 7, 1_000)
        _claim(client, 9, 2_000)
        _claim(client, 11, 3_000, state='unknown')                          # (its outcome not known: not read)
        _claim(client, 13, 4_000, head='voc-agent/another-run/fix-paging')   # (not the run's branch)
        assert (_links(client)['number'], _links(client)['superseded']) == (9, [])


def test_a_claim_newer_than_the_row_names_the_pull_request_and_an_older_one_does_not() -> None:
    with engineering_table() as client:
        _pull_request(client)    # (7, last written at 1000)
        _claim(client, 7, 1_000)
        assert _links(client)['number'] == 7
        # A new draft on the same branch whose record failed: read from its claim, 7 superseded.
        _claim(client, 9, 2_000)
        assert (_links(client)['number'], _links(client)['superseded']) == (9, [7])


def test_the_newest_claim_is_read_first_past_more_than_a_hundred_earlier_ones() -> None:
    with engineering_table() as client:
        for attempt in range(1, 121):   # (an earlier pull request author's many attempts, all older)
            _claim(client, attempt, attempt, agent=1)
        _claim(client, 500, 10_000, agent=2)
        sent: list[dict[str, Any]] = []
        real = client.query

        def query(**request: Any) -> Any:
            sent.append(request)
            return real(**request)

        client.query = query
        assert _links(client)['number'] == 500
    # One bounded Query, newest in key order first.
    assert [(r['ScanIndexForward'], r['Limit']) for r in sent] == [(False, MAX_CLAIMS_READ)]


def test_a_rebuild_is_a_warning_once_per_row_and_claim_and_debug_after(caplog: pytest.LogCaptureFixture) -> None:
    with engineering_table() as client:
        _claim(client, 31, 2_000)
        for _ in range(3):
            assert _links(client)['number'] == 31
    warned = [entry for entry in caplog.records if entry.getMessage().startswith("engineering: the run's pull request")
              and entry.levelname == 'WARNING']
    assert len(warned) == 1


def test_a_claim_no_newer_than_the_row_leaves_the_row() -> None:
    with engineering_table() as client:
        _pull_request(client, closed_at=5_000)
        _claim(client, 9, 2_000)
        assert _links(client)['number'] == 7


def test_a_row_naming_another_repository_is_read_as_none() -> None:
    with engineering_table() as client:
        _meta(client, 'SET #repo = :r', {':r': {'S': REPO}})
        _pull_request(client, url='https://github.com/other-org/shop/pull/7')
        meta = client.get_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}})['Item']
        assert run_links(client, TABLE, 'default', RUN, meta) == {'issue': None, 'pull_request': None,
                                                                  'upstream_pull_request': None}
