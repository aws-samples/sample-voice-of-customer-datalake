"""The issue a run is started from, on its META (7.09.00, ``RunStore.start``, ``engineering/run_links.py``): its host,
number and address, written once with the run, as given (``verified`` False); refused before anything is written
when it is not a number of the run's repository on a known host."""
from typing import Any

import pytest
from boto3.dynamodb.types import TypeSerializer

from engineering.run_links import issue_of
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunCaps, RunStore
from engineering.runtime.test.conftest import RUN

META = {'pk': f'WS#default#RUN#{RUN}', 'sk': 'META'}


@pytest.mark.parametrize(('host', 'repo', 'url'), [
    ('github', 'example-org/shop', 'https://github.com/example-org/shop/issues/12'),
    ('gitlab', 'example-org/payments/shop', 'https://gitlab.com/example-org/payments/shop/-/issues/12'),
])
def test_a_run_started_from_an_issue_records_it_once_as_given(aws: Any, host: str, repo: str, url: str) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, repo=repo, issue=12, host=host)
    meta = aws[1].get_item(Key=META)['Item']
    assert meta['issue'] == {'host': host, 'number': 12, 'url': url, 'verified': False}
    # Read back by the run monitor and the reports (a low-level item), its address checked again against META's repo.
    found = issue_of({name: TypeSerializer().serialize(value) for name, value in meta.items()})
    assert found is not None
    assert (found.url, found.verified) == (url, False)


def test_a_run_started_from_no_issue_has_none(aws: Any) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, repo='example-org/shop', host='github')
    assert 'issue' not in aws[1].get_item(Key=META)['Item']


@pytest.mark.parametrize(('issue', 'host', 'repo'), [
    (-3, 'github', 'example-org/shop'),
    (2_147_483_648, 'github', 'example-org/shop'),
    (12, 'code-host', 'example-org/shop'),
    (12, 'github', ''),
    (12, 'github', 'https://example.net/x'),
], ids=['negative', 'too-large', 'unknown-host', 'no-repository', 'not-a-path'])
def test_an_issue_off_the_rules_is_refused_before_anything_is_written(aws: Any, issue: int, host: str,
                                                                      repo: str) -> None:
    with pytest.raises(RuntimeRefused, match='an issue is a number from 1'):
        RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, repo=repo, issue=issue, host=host)
    assert 'Item' not in aws[1].get_item(Key=META)
