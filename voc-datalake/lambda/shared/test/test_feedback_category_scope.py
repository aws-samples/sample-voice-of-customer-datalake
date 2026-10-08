"""get_feedback_context intersects its category filter with the job starter's scope."""
from datetime import UTC, datetime
from unittest.mock import MagicMock

from shared.category_access import CategoryScope, scope_to_config
from shared.feedback import get_feedback_context

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')
RESTRICTED = scope_to_config(CategoryScope(all=False, categories=frozenset({'delivery'})))


def _table(items):
    table = MagicMock()
    table.query.return_value = {'Items': items}
    return table


def _queried_partitions(table):
    return [str(call.kwargs['KeyConditionExpression'].get_expression()['values'][1])
            for call in table.query.call_args_list]


def test_restricted_scope_queries_only_its_categories():
    table = _table([{'category': 'delivery', 'date': TODAY}])
    items = get_feedback_context(table, {'days': 7, 'category_scope': RESTRICTED})
    assert items == [{'category': 'delivery', 'date': TODAY}]
    assert _queried_partitions(table) == ['CATEGORY#delivery']


def test_requested_categories_outside_the_scope_yield_nothing():
    table = _table([{'category': 'billing'}])
    assert get_feedback_context(
        table, {'days': 7, 'categories': ['billing'], 'category_scope': RESTRICTED}) == []
    table.query.assert_not_called()


def test_items_are_filtered_even_on_the_source_path():
    table = _table([
        {'category': 'billing', 'source_platform': 'web', 'date': TODAY},
        {'category': 'delivery', 'source_platform': 'web', 'date': TODAY},
    ])
    items = get_feedback_context(
        table, {'days': 1, 'sources': ['web'], 'category_scope': RESTRICTED})
    assert [i['category'] for i in items] == ['delivery']


def test_no_scope_key_is_a_legacy_unrestricted_job():
    table = _table([{'category': 'billing', 'date': TODAY}])
    assert len(get_feedback_context(table, {'days': 1})) == 1


def test_malformed_scope_fails_closed():
    table = _table([{'category': 'billing'}])
    assert get_feedback_context(table, {'days': 1, 'category_scope': 'everything'}) == []


def test_a_source_restricted_job_still_gets_its_visible_feedback():
    """Every category, `support_tickets` hidden: the read is not short-cut to empty."""
    scope = scope_to_config(CategoryScope(all=True, source_deny=frozenset({'support_tickets'})))
    table = _table([
        {'category': 'billing', 'source_platform': 'web', 'date': TODAY},
        {'category': 'billing', 'source_platform': 'support_tickets', 'date': TODAY},
    ])
    items = get_feedback_context(table, {'days': 1, 'category_scope': scope})
    assert [i['source_platform'] for i in items] == ['web']
