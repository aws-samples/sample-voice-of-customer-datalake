"""The deployment's record of each language's walls (runtime/sandbox.py, 7.50.03), on a fake low-level client."""
from typing import Any

import pytest

from engineering.runtime import sandbox
from engineering.runtime.sandbox import Recorded, Walls


class FakeTable:
    """``put_item`` and ``get_item`` of one table, as a low-level DynamoDB client answers them."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}

    def put_item(self, *, TableName: str, Item: dict[str, Any]) -> None:
        assert TableName == 'voc-engineering'
        self.items[(Item['pk']['S'], Item['sk']['S'])] = Item

    def get_item(self, *, TableName: str, Key: dict[str, Any], ConsistentRead: bool) -> dict[str, Any]:
        assert (TableName, ConsistentRead) == ('voc-engineering', True)
        found = self.items.get((Key['pk']['S'], Key['sk']['S']))
        return {} if found is None else {'Item': found}


NAMESPACES = Walls('namespaces', 'namespaces', ('own_device', 'protected_hardlinks'))


def test_the_last_start_of_a_language_is_what_is_read_back():
    table = FakeTable()
    assert sandbox.read_record(table, 'voc-engineering', 'python') is None
    sandbox.record(table, 'voc-engineering', 'python', Walls('iptables', 'iptables', ('own_device',)),
                   at='2026-11-17T10:00:00Z', runtime='arn:aws:bedrock-agentcore:us-west-2:1:runtime/b_voc_eng_python')
    sandbox.record(table, 'voc-engineering', 'python', NAMESPACES, at='2026-11-17T11:00:00Z')
    assert sandbox.read_record(table, 'voc-engineering', 'python') == Recorded(NAMESPACES, '2026-11-17T11:00:00Z', '')
    assert sandbox.read_record(table, 'voc-engineering', 'rust') is None
    assert list(table.items) == [('WS#default#SANDBOX', 'LANG#python')]


@pytest.mark.parametrize(('walls', 'holds'), [
    (NAMESPACES, True), (Walls('iptables', 'iptables', ('declared',)), True),
    (Walls('namespaces', 'none', ('own_device',)), False), (Walls('namespaces', 'namespaces', ()), False),
], ids=['namespaces', 'the-firewall', 'no-code-wall', 'no-hard-link-guard'])
def test_walls_hold_only_with_both_egress_walls_and_a_hard_link_guard(walls: Walls, holds: bool):
    assert walls.holds is holds


@pytest.mark.parametrize('raw', [None, 'namespaces', {'egress': 'namespaces'},
                                 {'egress': 'vpn', 'code': 'none', 'hardlink_guard': []},
                                 {'egress': 'none', 'code': 'none', 'hardlink_guard': ['trust_me']}],
                         ids=['nothing', 'text', 'partial', 'unknown-wall', 'unknown-guard'])
def test_an_answer_off_its_shape_is_no_walls(raw: object):
    assert Walls.parse(raw) is None


def test_a_row_off_its_shape_reads_as_none_and_a_language_is_a_plain_name():
    table = FakeTable()
    table.items[('WS#default#SANDBOX', 'LANG#java')] = {'egress': {'S': 'namespaces'}}
    assert sandbox.read_record(table, 'voc-engineering', 'java') is None
    with pytest.raises(ValueError, match='plain name'):
        sandbox.record_key('py thon')
