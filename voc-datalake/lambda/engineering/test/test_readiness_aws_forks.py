"""The readiness ports a fork connection's checks read (7.57.00, engineering/readiness_aws.py): the fork's parent on
GitHub through the token function's ``public_repository``, and the connection's row and the CI protection (which the
broker reads, never this role); every failed read is ``ReadFailed``."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.connectors.connections import ConnectionRefused
from engineering.readiness import ReadFailed
from engineering.test.test_readiness_aws import Table, ports, refused

FORK = {'credential_kind': 'app_reference', 'app_id': '123', 'installation_id': '456', 'repository': 'casey/lint-kit'}


def _answering(answer: dict[str, Any], asked: list[dict[str, Any]]) -> Any:
    def inspect(request: dict[str, Any]) -> dict[str, Any]:
        asked.append(request)
        return answer
    return inspect


def test_a_forks_parent_is_read_with_its_installations_read_only_token() -> None:
    asked: list[dict[str, Any]] = []
    answer = {'repository': {'repository': 'casey/lint-kit', 'fork': True, 'parent': 'open-tools/lint-kit',
                             'private': False}}
    assert ports(inspect=_answering(answer, asked)).fork_parent(FORK) == 'open-tools/lint-kit'
    assert asked == [{'action': 'public_repository', 'app_id': '123', 'installation_id': 456,
                      'repository': 'casey/lint-kit', 'details': False}]


def test_a_repository_that_is_no_longer_a_fork_has_no_parent_and_a_missing_one_none() -> None:
    not_fork = {'repository': {'repository': 'casey/lint-kit', 'fork': False, 'parent': '', 'private': False}}
    assert ports(inspect=_answering(not_fork, [])).fork_parent(FORK) == ''
    assert ports(inspect=_answering({'repository': None}, [])).fork_parent(FORK) is None


def test_a_connection_through_no_app_installation_is_not_read() -> None:
    asked: list[dict[str, Any]] = []
    assert ports(inspect=_answering({}, asked)).fork_parent({**FORK, 'installation_id': ''}) is None
    assert asked == []


def test_a_refused_fork_read_is_read_failed() -> None:
    def busy(_request: dict[str, Any]) -> dict[str, Any]:
        raise ConnectionRefused('unavailable', 'try again')

    with pytest.raises(ReadFailed):
        ports(inspect=busy).fork_parent(FORK)


def test_the_connections_row_is_read_and_the_ci_protection_is_left_to_the_broker() -> None:
    row = {'connection_id': 'shop', 'repository': 'example-org/shop'}
    agents = Table(items={'CONNECTIONS#default#CONNECTION#shop': row})
    assert ports(agents=agents).connection('shop') == row
    assert ports(agents=agents).ci_protection(row) is None
    with pytest.raises(ReadFailed):
        ports(agents=Table(error=refused('InternalServerError'))).connection('shop')
