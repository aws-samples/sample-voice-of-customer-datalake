"""Model-based property of a run's status (runtime/runs.py ``RunStore``): the run moves only along the ways the docs
allow, whatever order a supervisor, a person and the caps happen in.

The machine in words: an active run waits at a decision point (its reason is kept) or ends; a run at a decision point
for a reason may take another reason, is resumed (unless it waits at the 30-day decision point, which offers only
"stop") or ends; an ended run stays ended and refuses every change. Each case runs a random sequence of these
operations on a moto table and checks the stored status and reason against a model after every step.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import boto3
from hypothesis import given, settings
from hypothesis import strategies as st
from moto import mock_aws

from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import ENDED, RunCaps, RunNotActive, RunStore
from engineering.runtime.test.conftest import RUN, TABLE
from shared.test.properties import PROPERTY

CASES = settings(PROPERTY, max_examples=80)   # (each case builds its own moto table)
THIRTY = 'thirty_days'
REASONS = st.sampled_from(['budget', 'cap', 'tool_error', THIRTY])
OPERATIONS = st.one_of(
    st.tuples(st.just('needs_human'), REASONS),
    st.tuples(st.just('resume'), st.just('')),
    st.tuples(st.just('end'), st.sampled_from(sorted(ENDED))),
    st.tuples(st.just('end'), st.just('active')),   # not an end: refused as a bad status, never a change
)


@dataclass
class Model:
    status: str = 'active'        # active | needs_human | ended
    reason: str = ''              # the decision point's reason while needs_human

    def apply(self, op: str, arg: str) -> bool:
        """Apply one operation; True when it changes or keeps a live run, False when it is refused (RunNotActive)."""
        if op == 'needs_human':
            if self.status == 'active':
                self.status, self.reason = 'needs_human', arg
                return True
            if self.status == 'needs_human':
                if self.reason not in (THIRTY, arg):   # (the 30-day point is kept; the same reason changes nothing)
                    self.reason = arg
                return True   # (asked again for the point it is at: nothing to do, not an error)
            return False
        if op == 'resume':
            if self.status == 'needs_human' and self.reason != THIRTY:
                self.status, self.reason = 'active', ''
                return True
            return False
        if op == 'end':
            if self.status in ('active', 'needs_human'):
                self.status, self.reason = arg, ''
                return True
            return False
        raise AssertionError(op)


@CASES
@given(operations=st.lists(OPERATIONS, min_size=1, max_size=12))
def test_a_run_moves_only_along_the_allowed_ways_whatever_the_order(operations: list[tuple[str, str]]) -> None:
    """After every operation the stored status and decision reason are the model's; an operation the model refuses is
    refused by the store (RunNotActive, or RuntimeRefused for a status that is not an end), and an ended run never
    changes again."""
    model = Model()
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName=TABLE,
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')],
            BillingMode='PAY_PER_REQUEST')
        runs = RunStore(table)
        runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
        for step, (op, arg) in enumerate(operations, start=1):
            expected = model.apply(op, arg) if not (op == 'end' and arg == 'active') else None
            try:
                if op == 'needs_human':
                    runs.needs_human(RUN, arg, now=step)
                elif op == 'resume':
                    runs.resume(RUN, now=step)
                else:
                    runs.end(RUN, arg, now=step)
                observed = True
            except RunNotActive:
                observed = False
            except RuntimeRefused:
                assert expected is None   # only the non-end status is refused as a bad status
                observed = None
            assert observed == expected, (op, arg, model)
            meta: dict[str, Any] = table.get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'META'}).get('Item') or {}
            assert meta, 'the run has a META row'
            assert meta['status'] == model.status
            if model.status == 'needs_human':
                assert meta['needs_human'] == model.reason
            elif model.status == 'active':   # (an ended run keeps the reason it last had: nothing reads it there)
                assert 'needs_human' not in meta
