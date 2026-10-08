"""Mutation hardening for `shared/onboarding.py`.

`api/test/test_settings_onboarding.py` drives the routes against moto and pins
the states, the caller scoping and the snooze boundary, but a mutation run found
what it cannot see:

* the WORDING of every refusal. `PUT /settings/my-onboarding` returns
  `str(exc)` as the 400 body; the route test only asserts that some error came
  back, so a reordered or relabelled message passed.
* the exact snooze length (one day to the second, not "somewhere under a day"),
  and that a naive or offset `hidden_until` is read in UTC / kept as written.
* the exact single-item reads `signals` makes (`Limit=1`, a `pk` projection),
  the exact `UpdateItem` a change becomes, and that `get_onboarding` /
  `put_onboarding` use the clock they are given.
"""
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Key

from shared import onboarding
from shared.exceptions import ValidationError

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
NOW_ISO = '2026-10-06T12:00:00+00:00'
TOMORROW_ISO = '2026-10-07T12:00:00+00:00'
WATERMARK_KEY = {'pk': 'METRIC#meta', 'sk': 'earliest_date'}
NO_SIGNALS = {'feedback_present': False, 'feedback_form_configured': False}
BAD_STATE = 'state must be one of: active, hidden, dismissed, skipped'
BAD_START = 'start_page must be one of: home, dashboard'


def _table(item: dict | None = None, watermark: dict | None = None, forms: list | None = None,
           written: dict | None = None) -> MagicMock:
    """A table whose preference row, watermark, FEEDBACK_FORM page and ALL_NEW answer are given."""
    table = MagicMock()

    def get_item(**kwargs: dict) -> dict:
        found = watermark if kwargs['Key'] == WATERMARK_KEY else item
        return {} if found is None else {'Item': found}

    table.get_item.side_effect = get_item
    table.query.return_value = {'Items': forms or []}
    table.update_item.return_value = {} if written is None else {'Attributes': written}
    return table


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('body', 'message'), [
        ({'state': 'active', 'zeta': 1, 'alpha': 2}, 'Unknown field(s): alpha, zeta'),
        ({'sub': 'x'}, 'Unknown field(s): sub'),
        ({}, 'Give state, start_page or both'),
        ({'state': 'gone'}, BAD_STATE),
        ({'state': 3}, BAD_STATE),
        ({'state': None}, BAD_STATE),
        ({'start_page': 'projects'}, BAD_START),
        ({'start_page': ['home']}, BAD_START),
        ({'state': 'active', 'start_page': 'x'}, BAD_START),
    ])
    def test_message(self, body, message):
        with pytest.raises(ValidationError) as exc:
            onboarding.validate_preference(body)
        assert str(exc.value) == message

    @pytest.mark.parametrize('state', ['active', 'hidden', 'dismissed', 'skipped'])
    def test_every_known_state_is_returned(self, state):
        assert onboarding.validate_preference({'state': state}) == {'state': state}

    @pytest.mark.parametrize('page', ['home', 'dashboard'])
    def test_every_known_start_page_is_returned(self, page):
        assert onboarding.validate_preference({'start_page': page}) == {'start_page': page}

    def test_both_fields_together(self):
        assert onboarding.validate_preference({'start_page': 'dashboard', 'state': 'skipped'}) == {
            'state': 'skipped', 'start_page': 'dashboard'}


class TestPreferenceUpdate:
    def test_a_snooze_sets_an_end_exactly_one_day_out(self):
        assert onboarding.preference_update({'state': 'hidden'}, NOW) == {
            'UpdateExpression': 'SET updated_at = :now, #state = :state, hidden_until = :until',
            'ExpressionAttributeNames': {'#state': 'state'},
            'ExpressionAttributeValues': {':now': NOW_ISO, ':state': 'hidden', ':until': TOMORROW_ISO},
            'ReturnValues': 'ALL_NEW',
        }

    @pytest.mark.parametrize('state', ['active', 'dismissed', 'skipped'])
    def test_any_other_state_removes_the_end(self, state):
        assert onboarding.preference_update({'state': state}, NOW) == {
            'UpdateExpression': 'SET updated_at = :now, #state = :state REMOVE hidden_until',
            'ExpressionAttributeNames': {'#state': 'state'},
            'ExpressionAttributeValues': {':now': NOW_ISO, ':state': state},
            'ReturnValues': 'ALL_NEW',
        }

    def test_a_start_page_alone_leaves_the_buddy_fields_and_names_no_attribute(self):
        assert onboarding.preference_update({'start_page': 'dashboard'}, NOW) == {
            'UpdateExpression': 'SET updated_at = :now, start_page = :start_page',
            'ExpressionAttributeValues': {':now': NOW_ISO, ':start_page': 'dashboard'},
            'ReturnValues': 'ALL_NEW',
        }

    def test_both_changes_in_one_update(self):
        update = onboarding.preference_update({'state': 'skipped', 'start_page': 'home'}, NOW)
        assert update['UpdateExpression'] == (
            'SET updated_at = :now, #state = :state, start_page = :start_page REMOVE hidden_until')
        assert update['ExpressionAttributeValues'] == {':now': NOW_ISO, ':state': 'skipped', ':start_page': 'home'}


class TestPreferenceView:
    @pytest.mark.parametrize(('state', 'visible'), [('active', True), ('dismissed', False), ('skipped', False)])
    def test_stored_state_and_updated_at(self, state, visible):
        view = onboarding.preference_view({'state': state, 'updated_at': 'then'}, NOW)
        assert view == {'state': state, 'hidden_until': None, 'updated_at': 'then', 'visible': visible,
                        'start_page': 'home'}

    @pytest.mark.parametrize(('stored', 'start_page'), [
        ('dashboard', 'dashboard'), ('home', 'home'), ('projects', 'home'), (None, 'home'), (1, 'home'),
    ])
    def test_start_page_is_a_known_page_or_home(self, stored, start_page):
        assert onboarding.preference_view({'start_page': stored}, NOW)['start_page'] == start_page

    @pytest.mark.parametrize('item', [['state', 'dismissed'], 'dismissed', {'state': 'dismissed', 'updated_at': 5}])
    def test_non_dict_row_and_non_string_updated_at(self, item):
        view = onboarding.preference_view(item, NOW)
        assert view['updated_at'] is None
        assert view['state'] == ('dismissed' if isinstance(item, dict) else 'active')

    @pytest.mark.parametrize(('offset', 'visible'), [
        (timedelta(seconds=-1), False), (timedelta(0), True), (timedelta(seconds=1), True),
    ])
    def test_snooze_boundary(self, offset, visible):
        view = onboarding.preference_view({'state': 'hidden', 'hidden_until': TOMORROW_ISO}, NOW + timedelta(days=1) + offset)
        assert (view['hidden_until'], view['visible']) == (TOMORROW_ISO, visible)

    def test_naive_end_is_read_as_utc(self):
        view = onboarding.preference_view({'state': 'hidden', 'hidden_until': '2026-10-07T12:00:00'}, NOW)
        assert (view['hidden_until'], view['visible']) == (TOMORROW_ISO, False)

    def test_offset_end_is_kept(self):
        plus_two = datetime(2026, 10, 6, 13, 0, tzinfo=timezone(timedelta(hours=2)))
        view = onboarding.preference_view({'state': 'hidden', 'hidden_until': plus_two.isoformat()}, NOW)
        assert (view['hidden_until'], view['visible']) == ('2026-10-06T13:00:00+02:00', True)

    @pytest.mark.parametrize('end', [None, 1700000000, 'not-a-date'])
    def test_unreadable_end_shows_again(self, end):
        view = onboarding.preference_view({'state': 'hidden', 'hidden_until': end}, NOW)
        assert (view['hidden_until'], view['visible']) == (None, True)


class TestSignals:
    def test_exact_reads(self):
        table = _table()
        assert onboarding.signals(table) == NO_SIGNALS
        table.get_item.assert_called_once_with(Key=WATERMARK_KEY)
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('FEEDBACK_FORM'), Limit=1, ProjectionExpression='pk')

    def test_both_present(self):
        table = _table(watermark={'date': '2025-01-15'}, forms=[{'pk': 'FEEDBACK_FORM'}])
        assert onboarding.signals(table) == {'feedback_present': True, 'feedback_form_configured': True}


class TestReadAndWrite:
    def test_get_reads_the_callers_row_on_the_given_clock(self):
        table = _table(item={'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': 'then',
                             'start_page': 'dashboard'})
        assert onboarding.get_onboarding(table, 'u1', NOW) == {
            'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': 'then', 'visible': False,
            'start_page': 'dashboard', 'signals': NO_SIGNALS,
        }
        assert table.get_item.call_args_list[0].kwargs == {'Key': {'pk': 'USERCTX#u1', 'sk': 'onboarding'}}

    @pytest.mark.parametrize(('offset', 'visible'), [(timedelta(hours=-1), True), (timedelta(hours=1), False)])
    def test_get_defaults_to_the_server_clock(self, offset, visible):
        end = (datetime.now(UTC) + offset).isoformat()
        table = _table(item={'state': 'hidden', 'hidden_until': end})
        assert onboarding.get_onboarding(table, 'u1')['visible'] is visible

    def test_put_updates_the_callers_row_and_returns_the_written_view(self):
        written = {'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': NOW_ISO, 'start_page': 'dashboard'}
        table = _table(written=written)
        view = onboarding.put_onboarding(table, 'u1', {'state': 'hidden'}, NOW)
        table.update_item.assert_called_once_with(Key={'pk': 'USERCTX#u1', 'sk': 'onboarding'},
                                                  **onboarding.preference_update({'state': 'hidden'}, NOW))
        assert view == {
            'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': NOW_ISO,
            'visible': False, 'start_page': 'dashboard', 'signals': NO_SIGNALS,
        }
        table.get_item.assert_called_once_with(Key=WATERMARK_KEY)
        table.put_item.assert_not_called()

    def test_put_without_attributes_reads_as_the_default(self):
        view = onboarding.put_onboarding(_table(), 'u1', {'start_page': 'home'}, NOW)
        assert (view['state'], view['start_page']) == ('active', 'home')

    def test_put_defaults_to_the_server_clock(self):
        table = _table()
        before = datetime.now(UTC)
        onboarding.put_onboarding(table, 'u1', {'state': 'hidden'})
        after = datetime.now(UTC)
        until = datetime.fromisoformat(table.update_item.call_args.kwargs['ExpressionAttributeValues'][':until'])
        assert before + timedelta(days=1) <= until <= after + timedelta(days=1)
