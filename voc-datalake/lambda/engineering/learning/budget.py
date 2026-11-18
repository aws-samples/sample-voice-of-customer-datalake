"""Learn's spend (7.50.00): its coach's calls count in the run's spend, within its flow's ``learn.budget_share``.

One row in the run's partition, ``LEARN#spend``, whose numbers only grow by ADD (``tokens_in``, ``tokens_out``,
``cost_usd``), written in the same transaction as the spend ledger's rows for them (``spend.ledger_updates``, under
the agent ``learn`` and the coach's model), so the ledger, the flow's month total and the run's own spend
(``RunStore.spend``, which adds this row to its agents') never drift.

Before a coach's call, ``allows`` asks whether its worst case (``WORST_TOKENS_IN`` in, the coach's whole answer out, at
the model's price) still fits Learn's share of the run's cost cap, what Learn spent already counted; a run with no
cost cap bounds nothing here (its tokens are still counted). A cost record (D5): never deleted.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from engineering.coach.model import MAX_ANSWER_TOKENS, CoachModel, CoachReply
from engineering.runtime.runs import LEARN_SPEND_SK, RunStore, run_pk
from engineering.spend import Usage, Where, ledger_updates

#: The spend ledger's agent for Learn's calls.
LEARN_AGENT: Final = 'learn'
#: A coach prompt's input at most, in tokens (its evidence is at most 40,000 characters, the skill at most 64 KB).
WORST_TOKENS_IN: Final = 40_000
WRITER: Final = 'learning/budget'

#: What a model's tokens cost: ``(model, tokens_in, tokens_out) -> USD`` (runtime/caps.py's prices).
Price = Callable[[str, int, int], Decimal]


@dataclass(frozen=True)
class LearnBudget:
    """Learn's share of a run's spend, on the run's partition (a resource table) and its META (``runs``)."""

    table: Any
    runs: RunStore
    price: Price
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    def spent(self, run_id: str) -> Decimal:
        item = self.table.get_item(Key={'pk': run_pk(run_id), 'sk': LEARN_SPEND_SK}, ConsistentRead=True).get('Item')
        return Decimal(str((item or {}).get('cost_usd', 0)))

    def allows(self, run_id: str, share: float, model: str) -> str:
        """'' when a coach's call on ``model`` fits Learn's share of the run's cost cap, else why not."""
        run = self.runs.get(run_id)
        cap = None if run is None else run.caps.max_cost_usd
        if cap is None:
            return ''
        allowance = Decimal(str(cap)) * Decimal(str(share))
        worst = self.price(model, WORST_TOKENS_IN, MAX_ANSWER_TOKENS)
        spent = self.spent(run_id)
        if spent + worst <= allowance:
            return ''
        return (f'learn budget: a call may cost up to ${worst:.4f}, and Learn has ${max(allowance - spent, 0):.4f} '
                f'left of its {share:.0%} of the run\'s ${cap:.2f} cap')

    def record(self, run_id: str, model: str, tokens_in: int, tokens_out: int) -> Decimal:
        """A coach's call's tokens, priced, in the run's spend and the ledger (one transaction); the dollars."""
        usd = self.price(model, tokens_in, tokens_out)
        at = self.clock()
        run = self.runs.get(run_id)
        where = Where(run_id=run_id, agent_id=LEARN_AGENT, flow=run.flow if run else '', repo=run.repo if run else '')
        spent_with_ledger(self.table, {
            'Key': {'pk': run_pk(run_id), 'sk': LEARN_SPEND_SK},
            'UpdateExpression': 'ADD tokens_in :in, tokens_out :out, cost_usd :usd SET updated_at = :at, '
                                'updated_by = :by, kind = :kind',
            'ExpressionAttributeValues': {':in': tokens_in, ':out': tokens_out, ':usd': usd,
                                          ':at': at.isoformat(), ':by': WRITER, ':kind': 'learn_spend'}},
            at, where, {model: Usage(usd=usd, tokens_in=tokens_in, tokens_out=tokens_out)})
        return usd


def spent_with_ledger(table: Any, spend_update: Mapping[str, Any], at: datetime, where: Where,
                      usage: Mapping[str, Usage]) -> None:
    """``spend_update`` (the ``Update`` of a Learn call's own spend row, without its table) and the spend ledger's
    rows for ``usage``, in one transaction."""
    table.meta.client.transact_write_items(TransactItems=[
        {'Update': {'TableName': table.name, **spend_update}}, *ledger_updates(table.name, at, where, usage)])


@dataclass(frozen=True)
class MeteredCoachModel:
    """A coach's model whose every reply's tokens are recorded (``on_reply``) before the reply is read, so a reply the
    coach then refuses is counted too."""

    model: CoachModel
    on_reply: Callable[[CoachReply], object]

    def __call__(self, system: str, prompt: str) -> CoachReply:
        reply = self.model(system, prompt)
        self.on_reply(reply)
        return reply
