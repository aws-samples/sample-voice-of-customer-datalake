"""The morning-brief card contract (shared.brief_cards)."""
from datetime import UTC, datetime

from shared.brief_cards import (
    MAX_ACTIONS,
    SEVERITIES,
    BriefCard,
    BriefContext,
    CardAction,
    CardProvider,
    card_id,
)
from shared.category_access import CategoryScope


def test_card_id_is_stable_per_fact_and_day():
    first = card_id('spike', '2026-10-07', 'billing')
    assert first == card_id('spike', '2026-10-07', 'billing')
    assert first != card_id('spike', '2026-10-08', 'billing')
    assert first.startswith('spike_')
    assert len(first) == len('spike_') + 16


def test_to_item_caps_actions_and_evidence():
    card = BriefCard(id='x_1', kind='x', layer='org', severity='warn', title='T',
                     actions=tuple(CardAction(f'a{i}', f'p{i}') for i in range(5)),
                     feedback_ids=tuple(f'f{i}' for i in range(20)))
    item = card.to_item()
    assert len(item['actions']) == MAX_ACTIONS
    assert item['actions'][0] == {'label': 'a0', 'prompt': 'p0'}
    assert len(item['feedback_ids']) == 10
    assert (item['urls'], item['facts'], item['body']) == ([], {}, '')


def test_a_provider_is_a_plain_function():
    def provider(ctx: BriefContext) -> list[BriefCard]:
        return [BriefCard(id=card_id('k', ctx.now.date().isoformat()), kind='k', layer='personal',
                          severity=SEVERITIES[0], title=ctx.language)]

    typed: CardProvider = provider
    ctx = BriefContext(feedback_table=None, aggregates_table=None, scope=CategoryScope(all=True),
                       now=datetime(2026, 10, 7, tzinfo=UTC), language='es')
    cards = typed(ctx)
    assert [(c.title, c.severity) for c in cards] == [('es', 'info')]
