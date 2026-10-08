"""Mutation hardening for `shared/github_metrics.py`.

`test_metrics_github.py` pins the shape of ``GET /metrics/github`` over one
six-item fixture, but a mutation run found 33 mutants it cannot see:

* every CAP (``MAX_VERSIONS``, ``MAX_LABELS``, ``TOP_N``, ``NEW_N``) — the
  fixture never has more items than a cap allows, so a cap that grows by one
  or disappears (``most_common(None)`` returns everything) changes nothing.
* the ``version_sort_key`` TUPLE itself — the fixture only compares pairs, so
  the padding width, the "unknown part counts as 0" rule and the release flag
  can all drift while the pairs stay in order.
* SYMMETRIC counts: with one issue and one comment, or one negative and one
  positive item, ``==`` and ``!=`` give the same number.
* ``_number``'s fallback for an unparsable sentiment or 👍 count, the mean's
  divisor and its 3-decimal rounding (the fixture's mean is exactly 0.0).
* "new since last version" with EXACTLY two releases (the ``< 2`` boundary),
  the ``earlier`` slice (an error shared by the middle and the latest release
  is not new), the ``other`` fallback category and the ``components`` list,
  which no earlier test read.
* that an empty string or a non-string is NOT a version / error signature /
  component, and the label rows' sort order.
"""
from collections.abc import Iterable
from decimal import Decimal

import pytest

from shared.github_metrics import github_breakdown, version_sort_key


def item(feedback_id: str, version: str | None = None, *, category: str | None = 'bug',
         sentiment: float | None = -0.5, label: str = 'negative', labels: Iterable[str] = ('bug',),
         error: str | None = None, component: str | None = None, kind: str = 'issue',
         attributes: dict[str, object] | None = None) -> dict[str, object]:
    """One github_issues item; ``attributes`` overrides/adds ``issue_attributes`` keys."""
    attrs = {'kind': kind, 'repo': 'acme/Kiro', 'labels': list(labels), 'state': 'open'}
    if version is not None:
        attrs['software_version'] = version
    if error is not None:
        attrs['error_signature'] = error
    if component is not None:
        attrs['component'] = component
    attrs.update(attributes or {})
    return {
        'feedback_id': feedback_id, 'source_platform': 'github_issues', 'category': category,
        'sentiment_score': None if sentiment is None else Decimal(str(sentiment)),
        'sentiment_label': label, 'issue_attributes': attrs,
    }


class TestVersionSortKeyTuple:
    @pytest.mark.parametrize(('version', 'key'), [
        ('1.2.3', (1, 2, 3, 1, '')),
        ('1.2', (1, 2, 0, 1, '')),                 # padded to three numeric parts with 0
        ('7', (7, 0, 0, 1, '')),
        ('1.2.3.4', (1, 2, 3, 1, '')),             # a fourth numeric part is dropped
        ('1.x.3', (1, 0, 3, 1, '')),               # a non-numeric part counts as 0
        ('1.0.0-rc.1', (1, 0, 0, 0, 'rc.1')),      # pre-release flag 0 sorts before release flag 1
        ('1.0.0-beta.2', (1, 0, 0, 0, 'beta.2')),
    ])
    def test_the_key_is_three_numbers_a_release_flag_and_the_pre_release_tag(self, version, key):
        assert version_sort_key(version) == key

    def test_an_unknown_part_sorts_with_zero_not_above_it(self):
        assert version_sort_key('1.x.0') == version_sort_key('1.0.0')
        assert version_sort_key('1.x.0') < version_sort_key('1.1.0')


class TestOnlyNonEmptyStringsAreVersionsOrFields:
    @pytest.mark.parametrize('version', ['', 5, None])
    def test_an_empty_or_non_string_version_is_unversioned(self, version):
        body = github_breakdown([item('a', attributes={'software_version': version})])
        assert body['versions'] == []
        assert body['latest_version'] is None
        assert body['unversioned']['count'] == 1

    @pytest.mark.parametrize('error', ['', 7])
    def test_an_empty_or_non_string_error_signature_is_not_ranked(self, error):
        body = github_breakdown([item('a', '1.0.0', attributes={'error_signature': error})])
        assert body['versions'][0]['top_errors'] == []

    def test_a_non_string_repo_is_not_listed(self):
        body = github_breakdown([item('a', '1.0.0', attributes={'repo': 3})])
        assert body['repos'] == []


class TestStatsCountExactlyWhatTheyName:
    def test_negative_counts_only_negative_labels(self):
        items = [item('a', sentiment=-0.5), item('b', sentiment=-0.75),
                 item('c', sentiment=0.5, label='positive')]
        stats = github_breakdown(items)['unversioned']
        assert stats['count'] == 3
        assert stats['negative'] == 2

    def test_issues_and_comments_are_counted_by_kind_and_an_unknown_kind_by_neither(self):
        items = [item('a', '1.0.0'), item('b', '1.0.0'), item('c', '1.0.0'),
                 item('d', '1.0.0', kind='comment'), item('e', '1.0.0', kind='review')]
        row = github_breakdown(items)['versions'][0]
        assert row['count'] == 5
        assert row['issues'] == 3
        assert row['comments'] == 1

    def test_avg_sentiment_is_the_mean_rounded_to_three_decimals(self):
        items = [item('a', sentiment=-0.1), item('b', sentiment=-0.2), item('c', sentiment=-0.2)]
        assert github_breakdown(items)['unversioned']['avg_sentiment'] == -0.167

    def test_avg_sentiment_divides_by_the_number_of_scored_items(self):
        items = [item('a', sentiment=-0.5), item('b', sentiment=-0.25), item('c', sentiment=None)]
        assert github_breakdown(items)['unversioned']['avg_sentiment'] == -0.375

    def test_an_unparsable_sentiment_score_counts_as_zero(self):
        items = [item('a', sentiment=-0.5), {**item('b'), 'sentiment_score': 'n/a'}]
        assert github_breakdown(items)['unversioned']['avg_sentiment'] == -0.25

    @pytest.mark.parametrize(('plus_one', 'weight'), [
        (2, 3), (Decimal('4'), 5), ('3', 4),
        ('many', 1),   # unparsable 👍 count adds nothing
        (None, 1),
    ])
    def test_weight_is_one_report_plus_its_thumbs_up(self, plus_one, weight):
        body = github_breakdown([item('a', attributes={'plus_one': plus_one})])
        assert body['unversioned']['weight'] == weight

    def test_weight_without_a_plus_one_field_is_one(self):
        assert github_breakdown([item('a')])['unversioned']['weight'] == 1

    def test_a_negative_item_without_a_category_is_an_other_complaint(self):
        body = github_breakdown([item('a', '1.0.0', category=None)])
        assert body['versions'][0]['top_complaints'] == [{'name': 'other', 'count': 1}]


class TestCaps:
    def test_only_the_latest_fifteen_releases_are_reported(self):
        items = [item(f'i{n}', f'1.{n}.0') for n in range(16)]
        body = github_breakdown(items)
        assert len(body['versions']) == 15
        assert body['versions'][0]['version'] == '1.1.0'
        assert body['latest_version'] == '1.15.0'
        assert body['previous_version'] == '1.14.0'

    def test_fifteen_releases_are_all_reported(self):
        items = [item(f'i{n}', f'1.{n}.0') for n in range(15)]
        assert len(github_breakdown(items)['versions']) == 15

    def test_only_the_twenty_most_used_labels_are_reported(self):
        rows = github_breakdown([item('a', labels=[f'l{n:02d}' for n in range(21)])])['labels']
        assert len(rows) == 20
        assert rows[-1]['label'] == 'l19'

    def test_top_complaints_and_errors_keep_three(self):
        items = [item(f'i{n}', '1.0.0', category=f'c{n}', error=f'e{n}') for n in range(4)]
        row = github_breakdown(items)['versions'][0]
        assert len(row['top_complaints']) == 3
        assert len(row['top_errors']) == 3

    def test_new_in_latest_keeps_ten(self):
        items = [item('old', '1.0.0'), *(item(f'i{n}', '2.0.0', error=f'e{n:02d}') for n in range(11))]
        new = github_breakdown(items)['new_in_latest']['errors']
        assert len(new) == 10
        assert new[0] == {'name': 'e00', 'count': 1}


class TestLabelRowsAreSortedByCountThenName:
    def test_order(self):
        items = [item('a', labels=('zeta', 'bug')), item('b', labels=('bug', 'alpha')), item('c', labels=('alpha',))]
        rows = github_breakdown(items)['labels']
        assert [(row['label'], row['count']) for row in rows] == [('alpha', 2), ('bug', 2), ('zeta', 1)]


class TestNewSinceLastVersion:
    def test_exactly_two_releases_compare_the_latest_with_the_earlier_one(self):
        items = [item('a', '1.0.0', error='old: x', component='chat'),
                 item('b', '1.1.0', error='new: y', component='auth', category='delivery')]
        body = github_breakdown(items)
        assert body['latest_version'] == '1.1.0'
        assert body['previous_version'] == '1.0.0'
        assert body['new_in_latest'] == {
            'errors': [{'name': 'new: y', 'count': 1}],
            'categories': [{'name': 'delivery', 'count': 1}],
            'components': [{'name': 'auth', 'count': 1}],
        }

    def test_everything_already_seen_in_any_earlier_release_is_not_new(self):
        items = [item('a', '1.0.0', error='first: a', component='chat', category='bug'),
                 item('b', '1.1.0', error='middle: b', component='auth', category='delivery'),
                 item('c', '1.2.0', error='middle: b', component='auth', category='delivery'),
                 item('d', '1.2.0', error='first: a', component='chat', category='bug')]
        assert github_breakdown(items)['new_in_latest'] == {'errors': [], 'categories': [], 'components': []}

    def test_a_latest_item_without_a_category_is_a_new_other_category(self):
        items = [item('a', '1.0.0', category='bug'), item('b', '1.1.0', category=None)]
        assert github_breakdown(items)['new_in_latest']['categories'] == [{'name': 'other', 'count': 1}]

    def test_new_counts_are_the_number_of_latest_items_carrying_the_value(self):
        items = [item('a', '1.0.0'), item('b', '1.1.0', error='e', component='c'),
                 item('c', '1.1.0', error='e', component='c')]
        new = github_breakdown(items)['new_in_latest']
        assert new['errors'] == [{'name': 'e', 'count': 2}]
        assert new['components'] == [{'name': 'c', 'count': 2}]
