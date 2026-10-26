"""The shared ``voc-plan/1`` fixtures (``fixtures/plans/*.json``) as plans, for the Python plan suites."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared import plans_store

FIXTURES = Path(__file__).with_name('fixtures') / 'plans'


def fixture_plan(name: str = 'valid-small-non-admin') -> dict:
    """The ``plan`` of one fixture file (a fresh copy each call)."""
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))['plan']


def active_slots(table: Any, sub: str) -> int:
    """The approver's ``PLANCAP`` counter (the value the create transaction checks)."""
    item = table.get_item(Key=plans_store.cap_key(sub)).get('Item') or {}
    return int(item.get('active') or 0)
