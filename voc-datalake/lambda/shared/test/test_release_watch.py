"""Release watch (shared.release_watch): windows, regression rules, the brief card provider."""
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from shared import release_watch as rw
from shared.brief_cards import BriefContext, card_id
from shared.category_access import CategoryScope
from shared.time_budget import WalkBudget

TODAY = '2026-10-20'
RELEASE_DAY = '2026-10-10'


def _day(offset: int, base: str = RELEASE_DAY) -> str:
    return (date.fromisoformat(base) + timedelta(days=offset)).isoformat()


def fb(fid, day, *, score=0.0, label='neutral', category='billing', version=None, text='', source=None):
    item = {'feedback_id': fid, 'date': day, 'source_created_at': f'{day}T10:00:00Z',
            'sentiment_score': Decimal(str(score)), 'sentiment_label': label, 'category': category,
            'original_text': text}
    if version:
        item['source_platform'] = 'github_issues'
        item['issue_attributes'] = {'software_version': version}
    elif source:
        item['source_platform'] = source
    return item


def many(prefix, n, day, **kw):
    return [fb(f'{prefix}{i}', day, **kw) for i in range(n)]


RELEASE = rw.Release('github:1.2.0', '1.2.0', RELEASE_DAY, rw.KIND_GITHUB)


def test_the_regression_constants_are_pinned():
    assert (rw.SENTIMENT_DROP_THRESHOLD, rw.NEGATIVE_RISE_THRESHOLD) == (0.15, 0.5)
    assert (rw.MIN_NEGATIVE_ITEMS, rw.MIN_SENTIMENT_ITEMS, rw.DEFAULT_WINDOW_DAYS) == (10, 5, 14)
    assert rw.thresholds() == {'sentiment_drop': 0.15, 'negative_rise_pct': 50,
                               'min_negative_items': 10, 'min_sentiment_items': 5}


class TestWindows:
    def test_items_split_at_the_release_day_and_after_stops_at_today(self):
        items = [fb('old', _day(-15)), fb('b', _day(-14)), fb('b2', _day(-1)), fb('a', _day(0)), fb('a2', _day(10))]
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert (watch['before']['count'], watch['after']['count']) == (2, 2)
        assert (watch['before']['days'], watch['after']['days']) == (14, 11)

    def test_review_date_wins_over_import_date(self):
        item = fb('x', _day(-1))
        item['date'] = _day(2)
        watch = rw.watch_release([item], RELEASE, window_days=14, today=TODAY)
        assert (watch['before']['count'], watch['after']['count']) == (1, 0)

    def test_top_categories_and_complaint_deltas(self):
        items = (many('b', 2, _day(-3), label='negative', category='billing')
                 + many('a', 4, _day(1), label='negative', category='login')
                 + many('p', 3, _day(1), label='positive', category='ui'))
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert watch['after']['top_categories'][0] == {'name': 'login', 'count': 4}
        assert watch['complaint_deltas'] == [{'name': 'login', 'before': 0, 'after': 4}]
        assert watch['feedback_ids'][0].startswith('a')

    def test_only_complaints_that_actually_grew_are_listed(self):
        # Live finding: "Growing complaints: Other (1→1)". Flat, shrinking and +1 rows are not growth.
        items = [fb('o1', _day(-3), label='negative', category='other'), fb('o2', _day(1), label='negative', category='other'),
                 *many('sb', 3, _day(-2), label='negative', category='shipping'),
                 *many('sa', 4, _day(2), label='negative', category='shipping'),
                 *many('db', 5, _day(-2), label='negative', category='delivery'),
                 *many('da', 2, _day(2), label='negative', category='delivery'),
                 *many('lb', 1, _day(-2), label='negative', category='login'),
                 *many('la', 3, _day(2), label='negative', category='login')]
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert watch['complaint_deltas'] == [{'name': 'login', 'before': 1, 'after': 3}]
        assert rw.MIN_COMPLAINT_GROWTH == 2

    def test_evidence_links_carry_the_review_title_or_its_first_words(self):
        titled = fb('t', _day(1), score=-0.9, label='negative', text='ignored')
        titled['title'] = 'App crashes  on login'
        long_text = fb('w', _day(1), score=-0.5, label='negative', text='one two three four five six seven eight nine ten')
        watch = rw.watch_release([titled, long_text], RELEASE, window_days=14, today=TODAY)
        assert watch['evidence'] == [
            {'feedback_id': 't', 'title': 'App crashes on login'},
            {'feedback_id': 'w', 'title': 'one two three four five six seven eight…'},
        ]
        assert watch['feedback_ids'] == ['t', 'w']


class TestRegressionRules:
    def test_a_sentiment_drop_of_exactly_the_threshold_is_flagged(self):
        items = many('b', 5, _day(-2), score=0.4) + many('a', 5, _day(2), score=0.25)
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert watch['deltas']['sentiment'] == -0.15
        assert watch['reasons'] == [rw.REASON_SENTIMENT_DROP]

    def test_a_smaller_drop_is_not(self):
        items = many('b', 5, _day(-2), score=0.4) + many('a', 5, _day(2), score=0.26)
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert watch['regression'] is False

    def test_too_few_scored_items_say_nothing_about_sentiment(self):
        items = many('b', 4, _day(-2), score=0.9) + many('a', 5, _day(2), score=-0.9)
        watch = rw.watch_release(items, RELEASE, window_days=14, today=TODAY)
        assert watch['deltas']['sentiment'] is None
        assert watch['regression'] is False

    def test_negative_rise_needs_ten_items_after(self):
        before = many('b', 4, _day(-2), label='negative', score=0)
        flagged = rw.watch_release(before + many('a', 10, _day(1), label='negative', score=0),
                                   RELEASE, window_days=14, today=TODAY)
        unflagged = rw.watch_release(before + many('a', 9, _day(1), label='negative', score=0),
                                     RELEASE, window_days=14, today=TODAY)
        assert rw.REASON_NEGATIVE_RISE in flagged['reasons']
        assert rw.REASON_NEGATIVE_RISE not in unflagged['reasons']

    def test_negative_rise_compares_per_day_rates(self):
        # 10 negatives over 14 days before, 10 over the 11 observed days after: +27 % per day.
        before = many('b', 10, _day(-3), label='negative', score=0)
        after = many('a', 10, _day(1), label='negative', score=0)
        watch = rw.watch_release(before + after, RELEASE, window_days=14, today=TODAY)
        assert watch['deltas']['negative_pct'] == 27
        assert rw.REASON_NEGATIVE_RISE not in watch['reasons']

    def test_exactly_fifty_percent_more_per_day_is_flagged(self):
        before = rw._side(many('b', 10, _day(-1), label='negative'), 14)
        after = rw._side(many('a', 15, _day(1), label='negative'), 14)
        assert rw.negative_rise(before, after) is True

    def test_no_negatives_before_is_an_unbounded_rise(self):
        before = rw._side([], 14)
        after = rw._side(many('a', 10, _day(1), label='negative'), 3)
        assert rw.negative_rise(before, after) is True
        assert rw._rate_change_pct(0, 14, 10, 3) is None


class TestReleases:
    def test_github_releases_use_the_first_day_a_version_was_seen(self):
        items = [fb('1', '2026-10-02', version='1.1.0'), fb('2', '2026-10-05', version='1.2.0'),
                 fb('3', '2026-10-03', version='1.2.0'), fb('4', '2026-10-04')]
        releases = rw.github_releases(items, since='2026-10-01')
        assert [(r.label, r.day) for r in releases] == [('1.1.0', '2026-10-02'), ('1.2.0', '2026-10-03')]

    def test_versions_first_seen_before_since_are_not_new_releases(self):
        items = [fb('1', '2026-09-01', version='1.0.0'), fb('2', '2026-10-05', version='1.0.0')]
        assert rw.github_releases(items, since='2026-10-01') == []

    def test_only_the_latest_releases_are_kept(self):
        items = [fb(str(i), '2026-10-05', version=f'1.{i}.0') for i in range(8)]
        assert [r.label for r in rw.github_releases(items, since='2026-10-01', limit=2)] == ['1.6.0', '1.7.0']

    def test_future_releases_are_skipped_and_the_newest_comes_first(self):
        releases = [rw.launch_release('d1', 'A', '2026-10-01'), rw.launch_release('d2', 'B', '2026-10-15'),
                    rw.launch_release('d3', 'C', '2026-11-01')]
        watches = rw.release_watch([], releases, window_days=14, today=TODAY)
        assert [w['key'] for w in watches] == ['launch:d2', 'launch:d1']

    @pytest.mark.parametrize(('keywords', 'expected'), [((), True), (('Login',), True), (('login', 'slow'), False)])
    def test_keywords_all_have_to_match(self, keywords, expected):
        assert rw.matches_keywords(fb('x', TODAY, text='The login page'), keywords) is expected

    @pytest.mark.parametrize(('value', 'expected'), [('2026-10-01', True), ('2026-13-01', False),
                                                     ('2026-10-1', False), (None, False)])
    def test_iso_days(self, value, expected):
        assert rw.is_iso_day(value) is expected


class TestReadRecentItems:
    def test_pages_each_day_and_stops_at_the_item_cap(self):
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [{'feedback_id': '1'}], 'LastEvaluatedKey': {'k': 1}},
            {'Items': [{'feedback_id': '2'}]},
            {'Items': [{'feedback_id': '3'}, {'feedback_id': '4'}]},
        ]
        items, partial = rw.read_recent_items(table, 5, now=datetime(2026, 10, 20, tzinfo=UTC),
                                              budget=WalkBudget(), max_items=3)
        assert [i['feedback_id'] for i in items] == ['1', '2', '3']
        assert partial is True
        assert table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {'k': 1}

    def test_a_complete_walk_is_not_partial(self):
        table = MagicMock()
        table.query.return_value = {'Items': []}
        items, partial = rw.read_recent_items(table, 3, now=datetime(2026, 10, 20, tzinfo=UTC), budget=WalkBudget())
        assert (items, partial, table.query.call_count) == ([], False, 3)


def _ctx(items, scope=None, extra=None):
    table = MagicMock()
    by_day: dict[str, list] = {}
    for item in items:
        by_day.setdefault(f"DATE#{item['date']}", []).append(item)

    def query(**kwargs):
        partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        return {'Items': by_day.get(partition, [])}

    table.query.side_effect = query
    return BriefContext(feedback_table=table, aggregates_table=None, scope=scope or CategoryScope(all=True),
                        now=datetime(2026, 10, 20, 9, tzinfo=UTC), extra=extra or {})


class TestCards:
    def test_a_regressed_release_is_an_alert_card(self):
        items = (many('b', 5, _day(-3), score=0.5, version='1.1.0')
                 + many('a', 5, _day(1), score=-0.5, label='negative', version='1.2.0'))
        cards = rw.release_watch_cards(_ctx(items))
        card = next(c for c in cards if c.facts['release'] == '1.2.0')
        assert card.id == card_id('release_watch', TODAY, 'github:1.2.0')
        assert (card.kind, card.layer, card.severity) == ('release_watch', 'org', 'alert')
        assert card.facts['after_sentiment'] == Decimal('-0.5')
        assert card.feedback_ids
        assert card.actions[0].prompt.startswith('Compare customer feedback')

    def test_cards_respect_the_reader_scope(self):
        items = many('a', 5, _day(1), category='billing', version='1.2.0')
        assert rw.release_watch_cards(_ctx(items, scope=CategoryScope(all=False, categories=frozenset({'ui'})))) == []

    def test_launches_come_from_extra_and_old_ones_are_skipped(self):
        items = many('a', 3, _day(1))
        launches = [{'id': 'dec_1', 'label': 'New checkout', 'day': RELEASE_DAY},
                    {'id': 'dec_0', 'label': 'Old', 'day': '2026-08-01'}, {'id': 'bad', 'day': 'soon'}]
        cards = rw.release_watch_cards(_ctx(items, extra={'launches': launches}))
        assert [(c.facts['release'], c.severity) for c in cards] == [('New checkout', 'info')]

    def test_a_release_with_nothing_after_it_gets_no_card(self):
        launches = [{'id': 'quiet', 'label': 'Quiet', 'day': _day(8)}]
        items = [*many('b', 3, _day(-3)), fb('z', _day(6), version='1.3.0')]
        cards = rw.release_watch_cards(_ctx(items, extra={'launches': launches}))
        assert [c.facts['release'] for c in cards] == ['1.3.0']
