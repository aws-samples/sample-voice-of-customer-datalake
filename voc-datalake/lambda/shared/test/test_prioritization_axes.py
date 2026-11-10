"""The prioritization scoring setup: defaults, stored reads, an admin's edit, minted ids, the composite."""
from decimal import Decimal
from typing import Any, ClassVar

import pytest
from moto import mock_aws

from shared import prioritization_axes as axes_mod
from shared.exceptions import ConflictError, ValidationError
from shared.test.moto_tables import create_pk_sk_table


def _axis(axis_id: str, weight: Any = 10, *, direction='higher_better', archived=False, label=None):
    return {'id': axis_id, 'label': label, 'description': None, 'weight': weight, 'direction': direction,
            'low_label': None, 'high_label': None, 'archived': archived}


def _stored(raw: list) -> list[dict]:
    stored = axes_mod.stored_axes(raw)
    assert stored is not None
    return stored


def _defaults_as_input():
    return [{k: v for k, v in axis.items() if k != 'builtin'} for axis in axes_mod.default_axes()]


class TestDefaults:
    def test_the_default_setup_is_todays_four_axes_and_weights(self):
        assert [(a['id'], a['weight'], a['direction']) for a in axes_mod.default_axes()] == [
            ('impact', 40, 'higher_better'), ('time_to_market', 30, 'higher_better'),
            ('strategic_fit', 20, 'higher_better'), ('confidence', 10, 'higher_better')]

    def test_no_stored_item_is_the_default_at_version_zero(self):
        config = axes_mod.config_from_item(None)
        assert (config['config_version'], axes_mod.active_axis_ids(config['axes'])) == (
            0, axes_mod.BUILTIN_AXIS_IDS)

    def test_default_axes_returns_a_copy(self):
        axes_mod.default_axes()[0]['weight'] = 99
        assert axes_mod.DEFAULT_AXES[0]['weight'] == 40

    def test_the_config_item_is_found_in_a_partition_read(self):
        items = [{'sk': 'ROW#r1'}, {'sk': 'CONFIG', 'config_version': Decimal(3), 'axes': [_axis('reach', Decimal(5))]}]
        config = axes_mod.config_from_partition(items)
        assert (config['config_version'], config['axes'][0]['weight']) == (3, 5)


class TestStoredReads:
    def test_unreadable_entries_and_repeats_are_skipped(self):
        stored = _stored([_axis('reach'), 'x', {'id': 'Bad Id'}, _axis('reach', 50), _axis('notes')])
        assert [(a['id'], a['weight']) for a in stored] == [('reach', 10)]

    def test_a_stored_list_with_nothing_active_falls_back_to_the_default(self):
        config = axes_mod.config_from_item({'axes': [_axis('reach', archived=True)], 'config_version': 2})
        assert axes_mod.active_axis_ids(config['axes']) == axes_mod.BUILTIN_AXIS_IDS

    def test_out_of_range_stored_values_are_bounded(self):
        stored = _stored([{'id': 'reach', 'weight': Decimal('NaN'), 'direction': 'sideways'},
                                       {'id': 'effort', 'weight': 900}])
        assert [(a['weight'], a['direction']) for a in stored] == [(0, 'higher_better'), (100, 'higher_better')]

    def test_builtin_is_derived_from_the_id_not_trusted(self):
        stored = _stored([{**_axis('reach'), 'builtin': True}, _axis('impact')])
        assert [a['builtin'] for a in stored] == [False, True]


class TestComposite:
    AXES: ClassVar[list[dict]] = [_axis('value', 60), _axis('effort', 40, direction='lower_better')]

    def test_weights_normalise_over_their_sum(self):
        assert axes_mod.composite({'value': 5, 'effort': 5}, self.AXES) == pytest.approx((60 * 5 + 40 * 1) / 100)

    def test_lower_better_is_inverted(self):
        assert axes_mod.composite({'effort': 1}, self.AXES) == 5

    def test_an_unscored_axis_leaves_both_sums(self):
        assert axes_mod.composite({'value': 4, 'effort': None}, self.AXES) == 4

    def test_zero_is_unscored(self):
        assert axes_mod.composite({'value': 0, 'effort': 0}, self.AXES) is None

    def test_archived_axes_do_not_count(self):
        axes = [_axis('value', 60), _axis('effort', 40, archived=True)]
        assert axes_mod.composite({'value': 2, 'effort': 5}, axes) == 2

    def test_the_default_weights_reproduce_todays_fully_scored_composite(self):
        ballot = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}
        today = 4 * 0.4 + 3 * 0.3 + 5 * 0.2 + 2 * 0.1
        assert axes_mod.composite(ballot, axes_mod.default_axes()) == pytest.approx(today)

    def test_only_zero_weight_axes_scored_has_no_composite(self):
        assert axes_mod.composite({'value': 3}, [_axis('value', 0), _axis('reach', 10)]) is None


class TestMintedIds:
    def test_a_label_becomes_a_slug(self):
        assert axes_mod.mint_axis_id('Ease of build!', []) == 'ease_of_build'

    def test_accents_are_folded(self):
        assert axes_mod.mint_axis_id('Réach', []) == 'reach'

    def test_a_collision_gets_a_suffix(self):
        assert axes_mod.mint_axis_id('Impact', ['impact', 'impact_2']) == 'impact_3'

    @pytest.mark.parametrize('label', ['Notes', 'Composite', 'Score', 'reviewer count'])
    def test_reserved_words_are_never_minted(self, label):
        minted = axes_mod.mint_axis_id(label, [])
        assert minted.endswith('_2')
        assert minted not in axes_mod.RESERVED_AXIS_IDS

    @pytest.mark.parametrize('label', ['影响', '', None, '9', '!!'])
    def test_a_label_with_no_latin_letters_falls_back(self, label):
        assert axes_mod.mint_axis_id(label, []).startswith('metric')

    def test_a_long_label_is_cut_to_the_id_bound_even_with_a_suffix(self):
        long_label = 'a' * 50
        taken = [axes_mod.mint_axis_id(long_label, [])]
        assert len(axes_mod.mint_axis_id(long_label, taken)) <= axes_mod.MAX_ID_LEN

    def test_a_leading_digit_is_prefixed(self):
        assert axes_mod.mint_axis_id('3 month value', []) == 'metric_3_month_value'


class TestValidatedUpdate:
    def _update(self, axes, current=None):
        return axes_mod.validated_axes_update(axes, current if current is not None else axes_mod.default_axes())

    def test_the_default_round_trips(self):
        assert self._update(_defaults_as_input()) == axes_mod.default_axes()

    def test_a_new_metric_gets_a_minted_id(self):
        new = self._update([*_defaults_as_input(), {'label': ' Reach ', 'weight': 30}])[-1]
        assert (new['id'], new['label'], new['builtin'], new['direction']) == ('reach', 'Reach', False, 'higher_better')

    def test_two_new_metrics_with_one_name_get_distinct_ids(self):
        result = self._update([*_defaults_as_input(), {'label': 'Effort', 'weight': 1}, {'label': 'Effort', 'weight': 1}])
        assert [a['id'] for a in result[-2:]] == ['effort', 'effort_2']

    @pytest.mark.parametrize(('axes', 'message'), [
        ('nope', 'axes must be a list'),
        ([{'label': f'm{i}', 'weight': 1} for i in range(21)], 'at most 20'),
        ([*_defaults_as_input(), 'x'], 'must be an object'),
        ([*_defaults_as_input(), {'id': 'ghost', 'label': 'G', 'weight': 1}], 'does not exist'),
        ([*_defaults_as_input(), {'label': '  ', 'weight': 1}], 'needs a name'),
        ([*_defaults_as_input(), {'label': 'x' * 41, 'weight': 1}], 'label must be at most 40'),
        ([*_defaults_as_input(), {'label': 'x', 'description': 'd' * 161, 'weight': 1}], 'description must be'),
        ([*_defaults_as_input(), {'label': 'x', 'low_label': 'l' * 25, 'weight': 1}], 'low_label must be'),
        ([*_defaults_as_input(), {'label': 'x'}], 'weight must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': 101}], 'weight must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': 2.5}], 'weight must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': True}], 'weight must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': float('inf')}], 'weight must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': 1, 'direction': 'up'}], 'direction must be'),
        ([*_defaults_as_input(), {'label': 'x', 'weight': 1, 'archived': 'no'}], 'archived must be'),
        ([*_defaults_as_input(), {'label': 7, 'weight': 1}], 'label must be text'),
        (_defaults_as_input()[:3], 'archive it instead'),
        ([*_defaults_as_input(), _defaults_as_input()[0]], 'only once'),
        ([{**a, 'archived': True} for a in _defaults_as_input()], 'at least one metric'),
        ([{**a, 'weight': 0} for a in _defaults_as_input()], 'weight above 0'),
        ([*_defaults_as_input(), *({'label': f'm{i}', 'weight': 1} for i in range(5))], 'at most 8'),
    ])
    def test_each_rule_is_a_400_with_a_message(self, axes, message):
        with pytest.raises(ValidationError, match=message):
            self._update(axes)

    def test_archived_metrics_do_not_count_toward_the_active_cap(self):
        extra = [{'label': f'm{i}', 'weight': 1, 'archived': True} for i in range(10)]
        assert len(self._update([*_defaults_as_input(), *extra])) == 14

    def test_a_builtin_may_be_renamed_and_its_name_cleared(self):
        renamed = [{**_defaults_as_input()[0], 'label': 'Customer value'}, *_defaults_as_input()[1:]]
        assert self._update(renamed)[0]['label'] == 'Customer value'

    def test_an_existing_custom_metric_keeps_its_id(self):
        current = [*axes_mod.default_axes(), {**_axis('reach', label='Reach'), 'builtin': False}]
        result = self._update([*_defaults_as_input(), {**_axis('reach', label='People reached')}], current)
        assert (result[-1]['id'], result[-1]['label']) == ('reach', 'People reached')

    @pytest.mark.parametrize('raw', [None, -1, '1', True, 1.0])
    def test_base_version_must_be_a_non_negative_int(self, raw):
        with pytest.raises(ValidationError, match='base_version'):
            axes_mod.validated_base_version(raw)


class TestRefusedBallotKeys:
    AXES: ClassVar[list[dict]] = [_axis('impact'), _axis('reach', archived=True)]

    def test_archived_and_unknown_ids_with_a_value_are_refused(self):
        entry = {'impact': 3, 'reach': 2, 'ghost': 1, 'notes': 'x', 'row_id': 'r', 'Weird-Key': 1, 'nulled': None}
        assert axes_mod.refused_ballot_keys(entry, self.AXES, ('notes',)) == ['ghost', 'reach']

    def test_allowed_fields_pass(self):
        assert axes_mod.refused_ballot_keys({'ballot_x': 'y'}, self.AXES, ('ballot_x',)) == []


class TestPublicAxes:
    def test_only_active_axes_and_no_weights(self):
        public = axes_mod.public_axes([_axis('impact'), _axis('reach', archived=True)])
        assert public == [{'id': 'impact', 'label': None, 'description': None, 'low_label': None,
                           'high_label': None, 'direction': 'higher_better', 'builtin': None}]


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('aggregates')


class TestWriteConfig:
    def test_the_first_write_is_version_one(self, table):
        written = axes_mod.write_config(table, axes_mod.default_axes(), 0, now='T', updated_by='ana')
        assert (written['config_version'], axes_mod.read_config(table)['updated_by']) == (1, 'ana')

    def test_a_stale_base_version_is_a_409(self, table):
        axes_mod.write_config(table, axes_mod.default_axes(), 0, now='T', updated_by='ana')
        with pytest.raises(ConflictError):
            axes_mod.write_config(table, axes_mod.default_axes(), 0, now='T', updated_by='bo')

    def test_the_current_base_version_wins(self, table):
        axes_mod.write_config(table, axes_mod.default_axes(), 0, now='T', updated_by='ana')
        assert axes_mod.write_config(table, axes_mod.default_axes(), 1, now='T', updated_by='bo')['config_version'] == 2
