"""shared/web_review_methods.py: the learned record of which method reads a site, per workspace (docs/web-reviews.md →
Learning which method works): its key, its stored shape, the plan it gives a run, what a run teaches it."""
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from shared.web_review_methods import (
    CASCADE,
    DEPLOYMENT_PARTITION,
    MAX_LISTED,
    Attempt,
    MethodRecord,
    StepStats,
    clear_record,
    is_site_domain,
    learned,
    list_records,
    methods_partition,
    plan_for,
    public_record,
    read_record,
    record_from_item,
    record_item,
    site_domain,
    write_record,
)
from shared.ws_repo import OutOfScopeError, WorkspaceScope, ws_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
DAY = timedelta(days=1)


def at(ago: timedelta) -> str:
    return (NOW - ago).isoformat()


def stats(outcome: str, ago: timedelta, successes: int = 1, failures: int = 0) -> StepStats:
    return StepStats(outcome, at(ago), successes, failures, 4)


def record(best: str, **steps: StepStats) -> MethodRecord:
    return MethodRecord('g2.com', best, at(DAY), steps)


class TestTheKey:
    def test_a_workspace_has_its_own_partition_and_the_deployment_its_own(self):
        assert methods_partition(WorkspaceScope(WS)) == f'WS#{WS}#WEB_REVIEWS#METHODS'
        assert methods_partition(None) == DEPLOYMENT_PARTITION == 'WEB_REVIEWS#METHODS'

    @pytest.mark.parametrize(('url', 'domain'), [
        ('https://www.g2.com/products/x/reviews', 'g2.com'), ('https://uk.Trustpilot.com/review/a', 'uk.trustpilot.com'),
        ('https://clutch.co/profile/x', 'clutch.co'),
    ])
    def test_a_pages_site_is_its_host_without_www(self, url, domain):
        assert site_domain(url) == domain

    @pytest.mark.parametrize(('value', 'ok'), [
        ('g2.com', True), ('uk.trustpilot.com', True), ('G2.com', False), ('g2.com/x', False), ('', False),
        ('-g2.com', False), ('a' * 254, False), (None, False), ('WS#x', False),
    ])
    def test_a_domain_is_a_lower_case_dns_name(self, value, ok):
        assert is_site_domain(value) is ok


class TestThePlan:
    """The decision table: no record, a fresh success, a stale one, a recorded block, a re-probe due."""

    def test_no_record_is_the_whole_cascade(self):
        plan = plan_for(None, NOW)
        assert (plan.order, plan.kind, plan.known_method) == (CASCADE, 'cascade', None)

    def test_a_fresh_best_goes_first_then_the_cascade_from_the_top(self):
        plan = plan_for(record('agentcore_web_search', agentcore_web_search=stats('readable', DAY),
                               browser=stats('blocked:Cloudflare', 10 * DAY)), NOW)
        assert (plan.order, plan.kind, plan.known_method) == (
            ('agentcore_web_search', 'browser', 'bedrock_web_search'), 'known', 'agentcore_web_search')

    def test_a_recent_block_is_left_out(self):
        plan = plan_for(record('bedrock_web_search', bedrock_web_search=stats('readable', DAY),
                               browser=stats('blocked:DataDome', 6 * DAY)), NOW)
        assert (plan.order, plan.kind, plan.skipped) == (
            ('bedrock_web_search', 'agentcore_web_search'), 'known', ('browser',))

    def test_the_browser_is_re_checked_once_its_last_try_is_old(self):
        plan = plan_for(record('bedrock_web_search', bedrock_web_search=stats('readable', DAY),
                               browser=stats('blocked:Cloudflare', 15 * DAY)), NOW)
        assert (plan.order, plan.kind) == (('browser', 'bedrock_web_search', 'agentcore_web_search'), 'reprobe')

    def test_the_browser_never_tried_is_re_checked_too(self):
        plan = plan_for(record('bedrock_web_search', bedrock_web_search=stats('readable', DAY)), NOW)
        assert plan.kind == 'reprobe'

    def test_a_browser_best_is_known_not_re_checked(self):
        plan = plan_for(record('browser', browser=stats('readable', 20 * DAY)), NOW)
        assert (plan.order, plan.kind) == (CASCADE, 'known')

    @pytest.mark.parametrize('best', [
        record('bedrock_web_search', bedrock_web_search=stats('readable', 31 * DAY)),  # stale
        record('bedrock_web_search', bedrock_web_search=stats('error', DAY)),  # it failed last time
        record('none', browser=stats('no_reviews', DAY)),
        MethodRecord('g2.com', 'bedrock_web_search', None, {}),  # no stats for it
    ])
    def test_a_stale_failed_or_unknown_best_is_the_cascade(self, best):
        assert plan_for(best, NOW).kind == 'cascade'

    def test_a_stale_record_still_leaves_a_recent_block_out(self):
        plan = plan_for(record('none', browser=stats('blocked:Cloudflare', DAY)), NOW)
        assert (plan.order, plan.skipped) == (('bedrock_web_search', 'agentcore_web_search'), ('browser',))

    def test_an_unreadable_time_counts_as_long_ago(self):
        plan = plan_for(MethodRecord('g2.com', 'browser', None, {'browser': StepStats('readable', 'yesterday')}), NOW)
        assert plan.kind == 'cascade'


class TestWhatARunTeaches:
    def test_the_first_step_that_read_is_the_new_best(self):
        after = learned(None, 'g2.com', [Attempt('browser', 'blocked:Cloudflare'), Attempt('bedrock_web_search',
                                                                                          'readable', 11)], at(0 * DAY))
        assert after is not None
        assert (after.best_method, after.learned_at) == ('bedrock_web_search', at(0 * DAY))
        assert after.steps['browser'] == StepStats('blocked:Cloudflare', at(0 * DAY), 0, 1, 0)
        assert after.steps['bedrock_web_search'] == StepStats('readable', at(0 * DAY), 1, 0, 11)

    def test_counts_add_up(self):
        before = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY, successes=3, failures=1))
        after = learned(before, 'g2.com', [Attempt('bedrock_web_search', 'readable', 2)], at(0 * DAY))
        assert after is not None
        assert (after.steps['bedrock_web_search'].successes, after.steps['bedrock_web_search'].failures) == (4, 1)

    def test_a_known_best_that_fails_with_nothing_else_reading_is_none(self):
        before = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY))
        after = learned(before, 'g2.com', [Attempt('bedrock_web_search', 'error'),
                                           Attempt('agentcore_web_search', 'no_reviews')], at(0 * DAY))
        assert after is not None
        assert (after.best_method, after.learned_at) == ('none', None)

    def test_a_failure_of_another_step_keeps_the_best(self):
        before = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY))
        after = learned(before, 'g2.com', [Attempt('browser', 'blocked:Cloudflare')], at(0 * DAY))
        assert after is not None
        assert (after.best_method, after.learned_at) == ('bedrock_web_search', before.learned_at)

    def test_no_step_ran_teaches_nothing(self):
        before = record('browser', browser=stats('readable', DAY))
        assert learned(before, 'g2.com', [], at(0 * DAY)) is before


class TestTheStoredShape:
    def test_an_item_holds_no_content_and_reads_back(self):
        kept = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY),
                      browser=stats('blocked:Cloudflare', DAY, 0, 2))
        item = record_item(WorkspaceScope(WS), kept, at(0 * DAY))
        assert set(item) == {'pk', 'sk', 'best_method', 'learned_at', 'updated_at', 'methods'}
        assert set(item['methods']['browser']) == {'last_outcome', 'last_at', 'successes', 'failures', 'last_reviews'}
        assert record_from_item(item) == kept

    def test_numbers_read_back_from_dynamodb_as_decimals(self):
        item = {'sk': 'g2.com', 'best_method': 'browser', 'methods': {
            'browser': {'last_outcome': 'readable', 'last_at': at(DAY), 'successes': Decimal(3), 'failures': Decimal(0),
                        'last_reviews': Decimal(20)}}}
        parsed = record_from_item(item)
        assert parsed is not None
        assert parsed.steps['browser'].successes == 3

    @pytest.mark.parametrize('item', [None, {}, {'sk': 'NOT A DOMAIN'}])
    def test_something_else_is_no_record(self, item):
        assert record_from_item(item) is None

    def test_an_unknown_step_or_a_broken_one_is_left_out(self):
        parsed = record_from_item({'sk': 'g2.com', 'best_method': 'telepathy', 'methods': {
            'telepathy': {'last_outcome': 'readable', 'last_at': at(DAY)}, 'browser': {'last_outcome': 'readable'},
            'bedrock_web_search': 'x'}})
        assert parsed == MethodRecord('g2.com', 'none', None, {})

    def test_the_api_shape(self):
        kept = record('browser', browser=stats('readable', DAY))
        assert public_record(kept) == {'domain': 'g2.com', 'best_method': 'browser', 'learned_at': at(DAY),
                                       'browser_recheck_due_at': None, 'methods': {
            'browser': {'last_outcome': 'readable', 'last_at': at(DAY), 'successes': 1, 'failures': 0,
                        'last_reviews': 4}}}

    def test_when_the_browser_is_re_checked(self):
        known = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY),
                       browser=stats('blocked:Cloudflare', 3 * DAY))
        assert public_record(known)['browser_recheck_due_at'] == at(3 * DAY - timedelta(days=14))
        never = record('bedrock_web_search', bedrock_web_search=stats('readable', DAY))
        assert public_record(never)['browser_recheck_due_at'] == never.learned_at
        assert public_record(record('none'))['browser_recheck_due_at'] is None


class Table:
    def __init__(self):
        self.items: dict[tuple[str, str], dict] = {}
        self.queries: list[dict] = []

    def get_item(self, Key, **_kwargs):
        item = self.items.get((Key['pk'], Key['sk']))
        return {'Item': item} if item else {}

    def put_item(self, Item, **_kwargs):
        self.items[(Item['pk'], Item['sk'])] = Item

    def delete_item(self, Key, **kwargs):
        old = self.items.pop((Key['pk'], Key['sk']), None)
        return {'Attributes': old} if old and kwargs.get('ReturnValues') == 'ALL_OLD' else {}

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return {'Items': list(self.items.values())}


class TestThroughTheWorkspaceView:
    def test_write_read_list_and_clear_in_one_workspace(self):
        table, scope = Table(), WorkspaceScope(WS)
        view = ws_table(scope, table)
        kept = record('browser', browser=stats('readable', DAY))
        write_record(view, scope, kept, at(0 * DAY))
        assert read_record(view, scope, 'g2.com') == kept
        assert list_records(view, scope) == [kept]
        assert table.queries[0]['Limit'] == MAX_LISTED
        assert clear_record(view, scope, 'g2.com') is True
        assert clear_record(view, scope, 'g2.com') is False
        assert read_record(view, scope, 'g2.com') is None

    def test_another_workspaces_record_is_out_of_reach(self):
        view = ws_table(WorkspaceScope(WS), Table())
        with pytest.raises(OutOfScopeError):
            read_record(view, WorkspaceScope(OTHER), 'g2.com')
        with pytest.raises(OutOfScopeError):
            clear_record(view, WorkspaceScope(OTHER), 'g2.com')
