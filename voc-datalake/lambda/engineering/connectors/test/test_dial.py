"""The dial the broker reads (dial.py): the starter's way of working from shared/ai_mode.py, failing closed."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.connectors.broker import Broker, NotNow
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.hosts import Unavailable
from engineering.connectors.identity import Caller
from engineering.connectors.test.fakes import BRANCH, RUN, STARTER, TREE, FakeHost, FakeLedger, connector
from shared.ai_mode import set_ai_mode
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        yield create_pk_sk_table('voc-aggregates')


@pytest.mark.parametrize('mode', ['human_driven', 'ai_assisted', 'ai_driven'])
def test_the_starters_way_of_working_as_an_administrator_set_it(table: Any, mode: str) -> None:
    set_ai_mode(table, sub='person-sub-1', changes={'ai_mode': mode}, actor_sub='admin-sub')
    assert WaysOfWorking(table).mode('person-sub-1') == mode


def test_a_person_with_no_saved_way_of_working_pushes_nothing(table: Any) -> None:
    """Stricter than shared/ai_mode.py's reading (no row: AI-driven, for documents): for a repository, no row is
    Human-driven, the coordinator's decision."""
    assert WaysOfWorking(table).mode('person-sub-2') == 'human_driven'


@pytest.mark.parametrize('stored', ['ai_first', 'AI_DRIVEN', '', None])
def test_a_stored_mode_outside_the_modes_is_human_driven(table: Any, stored: str | None) -> None:
    item = {'pk': 'USERFLAGS#person-sub-3', 'sk': 'ai_mode'}
    if stored is not None:
        item['mode'] = stored
    table.put_item(Item=item)
    assert WaysOfWorking(table).mode('person-sub-3') == 'human_driven'


@pytest.mark.parametrize(('stored', 'pushes'), [(None, False), ('ai_first', False), ('human_driven', False),
                                                ('ai_assisted', True), ('ai_driven', True)])
def test_the_broker_pushes_only_for_an_explicit_ai_assisted_or_ai_driven_row(table: Any, stored: str | None,
                                                                             pushes: bool) -> None:
    if stored is not None:
        table.put_item(Item={'pk': f'USERFLAGS#{STARTER}', 'sk': 'ai_mode', 'mode': stored})
    host = FakeHost()
    broker = Broker(connector(host=host, dial=WaysOfWorking(table), ledger=FakeLedger({(RUN, TREE)}, {RUN})))
    if pushes:
        assert broker.push_bundle(Caller('committer', RUN, 1), BRANCH, 'patch-key', TREE, 'Fix') == TREE
    else:
        with pytest.raises(NotNow, match='Human-driven'):
            broker.push_bundle(Caller('committer', RUN, 1), BRANCH, 'patch-key', TREE, 'Fix')
    assert host.writes() == (['push_bundle'] if pushes else [])


def test_only_the_mode_attribute_is_read() -> None:
    asked: list[dict[str, Any]] = []

    class Recording:
        def get_item(self, **request: Any) -> Any:
            asked.append(request)
            return {'Item': {'mode': 'ai_assisted'}}

    assert WaysOfWorking(Recording()).mode('person-sub-1') == 'ai_assisted'
    assert asked == [{'Key': {'pk': 'USERFLAGS#person-sub-1', 'sk': 'ai_mode'}, 'ConsistentRead': True,
                      'ProjectionExpression': '#mode', 'ExpressionAttributeNames': {'#mode': 'mode'}}]


@pytest.mark.parametrize('person', ['', 'agent:fixer-1', 'mcp:tok_1', 'plan:p-1', 'human:admin-sub', 'x' * 129])
def test_no_person_or_something_else_is_human_driven_without_a_read(person: str) -> None:
    class Unread:
        def get_item(self, **_: Any) -> Any:
            raise AssertionError('no read for something that is not a person')

    assert WaysOfWorking(Unread()).mode(person) == 'human_driven'


def test_a_read_that_fails_is_unavailable_never_a_pass() -> None:
    class Down:
        def get_item(self, **_: Any) -> Any:
            raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'later'}}, 'GetItem')

    with pytest.raises(Unavailable):
        WaysOfWorking(Down()).mode('person-sub-1')
