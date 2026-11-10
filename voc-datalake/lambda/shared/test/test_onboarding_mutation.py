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
BAD_GUIDE = 'guide must be one of: open, skipped'
BAD_PROMPT = 'subscribe_prompt must be one of: shown, dismissed'
BAD_RUN = 'dismiss_decision_run must be an agent run id'
NO_FIELD = 'Give at least one of: state, start_page, guide, subscribe_prompt, dismiss_decision_run'
NOTHING_DISMISSED = {'subscribe_prompt': 'shown', 'dismissed_decision_runs': []}
RUN_A = 'ar_019a0000000011112222'
RUN_B = 'ar_019a0000000133334444'


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
        ({}, NO_FIELD),
        ({'state': 'gone'}, BAD_STATE),
        ({'state': 3}, BAD_STATE),
        ({'state': None}, BAD_STATE),
        ({'start_page': 'projects'}, BAD_START),
        ({'start_page': ['home']}, BAD_START),
        ({'state': 'active', 'start_page': 'x'}, BAD_START),
        ({'guide': 'closed'}, BAD_GUIDE),
        ({'guide': True}, BAD_GUIDE),
        ({'start_page': 'home', 'guide': None}, BAD_GUIDE),
        ({'subscribe_prompt': 'gone'}, BAD_PROMPT),
        ({'subscribe_prompt': False}, BAD_PROMPT),
        ({'dismiss_decision_run': 'ag_123456789abc'}, BAD_RUN),
        ({'dismiss_decision_run': 'ar_12'}, BAD_RUN),
        ({'dismiss_decision_run': ['ar_019a0000000011112222']}, BAD_RUN),
        ({'dismiss_decision_run': 'ar_019a0000000011112222 '}, BAD_RUN),
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

    @pytest.mark.parametrize('guide', ['open', 'skipped'])
    def test_every_known_guide_is_returned(self, guide):
        assert onboarding.validate_preference({'guide': guide}) == {'guide': guide}

    def test_all_three_fields_in_field_order(self):
        assert list(onboarding.validate_preference({'guide': 'open', 'start_page': 'home', 'state': 'active'})) == [
            'state', 'start_page', 'guide']

    def test_both_fields_together(self):
        assert onboarding.validate_preference({'start_page': 'dashboard', 'state': 'skipped'}) == {
            'state': 'skipped', 'start_page': 'dashboard'}

    @pytest.mark.parametrize('prompt', ['shown', 'dismissed'])
    def test_every_known_subscribe_prompt_is_returned(self, prompt):
        assert onboarding.validate_preference({'subscribe_prompt': prompt}) == {'subscribe_prompt': prompt}

    @pytest.mark.parametrize('run_id', [RUN_A, 'ar_019a00000000abcd'])
    def test_a_run_id_to_dismiss_is_returned(self, run_id):
        assert onboarding.validate_preference({'dismiss_decision_run': run_id}) == {'dismiss_decision_run': run_id}


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

    def test_a_guide_alone_leaves_the_buddy_fields_and_names_no_attribute(self):
        assert onboarding.preference_update({'guide': 'skipped'}, NOW) == {
            'UpdateExpression': 'SET updated_at = :now, guide = :guide',
            'ExpressionAttributeValues': {':now': NOW_ISO, ':guide': 'skipped'},
            'ReturnValues': 'ALL_NEW',
        }

    def test_all_three_changes_in_one_update(self):
        update = onboarding.preference_update({'state': 'active', 'start_page': 'home', 'guide': 'open'}, NOW)
        assert update['UpdateExpression'] == (
            'SET updated_at = :now, #state = :state, start_page = :start_page, guide = :guide REMOVE hidden_until')
        assert update['ExpressionAttributeValues'] == {
            ':now': NOW_ISO, ':state': 'active', ':start_page': 'home', ':guide': 'open'}

    def test_both_changes_in_one_update(self):
        update = onboarding.preference_update({'state': 'skipped', 'start_page': 'home'}, NOW)
        assert update['UpdateExpression'] == (
            'SET updated_at = :now, #state = :state, start_page = :start_page REMOVE hidden_until')
        assert update['ExpressionAttributeValues'] == {':now': NOW_ISO, ':state': 'skipped', ':start_page': 'home'}

    def test_a_subscribe_prompt_alone_names_no_attribute(self):
        assert onboarding.preference_update({'subscribe_prompt': 'dismissed'}, NOW) == {
            'UpdateExpression': 'SET updated_at = :now, subscribe_prompt = :subscribe_prompt',
            'ExpressionAttributeValues': {':now': NOW_ISO, ':subscribe_prompt': 'dismissed'},
            'ReturnValues': 'ALL_NEW',
        }

    def test_dismissed_runs_replace_the_stored_list(self):
        update = onboarding.preference_update({'dismiss_decision_run': RUN_B}, NOW, [RUN_B, RUN_A])
        assert update == {
            'UpdateExpression': 'SET updated_at = :now, dismissed_decision_runs = :dismissed_runs',
            'ExpressionAttributeValues': {':now': NOW_ISO, ':dismissed_runs': [RUN_B, RUN_A]},
            'ReturnValues': 'ALL_NEW',
        }


class TestMergedDismissedRuns:
    def test_adds_to_nothing_stored(self):
        assert onboarding.merged_dismissed_runs(None, RUN_A) == [RUN_A]

    def test_dedupes_and_sorts_newest_first(self):
        assert onboarding.merged_dismissed_runs({'dismissed_decision_runs': [RUN_A, RUN_B]}, RUN_A) == [RUN_B, RUN_A]

    def test_drops_drifted_entries(self):
        stored = {'dismissed_decision_runs': ['nope', 3, RUN_A]}
        assert onboarding.merged_dismissed_runs(stored, RUN_B) == [RUN_B, RUN_A]

    def test_keeps_only_the_newest_fifty(self):
        stored = {'dismissed_decision_runs': [f'ar_{n:012x}aaaa' for n in range(1, 61)]}
        merged = onboarding.merged_dismissed_runs(stored, f'ar_{0:012x}aaaa')
        assert len(merged) == onboarding.MAX_DISMISSED_RUNS == 50
        assert merged[0] == f'ar_{60:012x}aaaa'
        assert merged[-1] == f'ar_{11:012x}aaaa'


class TestPreferenceView:
    @pytest.mark.parametrize(('state', 'visible'), [('active', True), ('dismissed', False), ('skipped', False)])
    def test_stored_state_and_updated_at(self, state, visible):
        view = onboarding.preference_view({'state': state, 'updated_at': 'then'}, NOW)
        assert view == {'state': state, 'hidden_until': None, 'updated_at': 'then', 'visible': visible,
                        'start_page': 'home', 'guide': 'open', **NOTHING_DISMISSED}

    @pytest.mark.parametrize(('stored', 'prompt'), [
        ('dismissed', 'dismissed'), ('shown', 'shown'), ('hidden', 'shown'), (None, 'shown'), (True, 'shown'),
    ])
    def test_subscribe_prompt_is_a_known_choice_or_shown(self, stored, prompt):
        assert onboarding.preference_view({'subscribe_prompt': stored}, NOW)['subscribe_prompt'] == prompt

    @pytest.mark.parametrize(('stored', 'runs'), [
        (None, []), ('ar_000000000001aaaa', []), ([], []),
        (['ar_000000000001aaaa', 'ag_123456789abc', 7, 'ar_00000000000Zaaaa'], ['ar_000000000001aaaa']),
        (['ar_000000000001aaaa', 'ar_000000000002aaaa'], ['ar_000000000002aaaa', 'ar_000000000001aaaa']),
    ])
    def test_dismissed_runs_keep_only_run_ids_newest_first(self, stored, runs):
        assert onboarding.preference_view({'dismissed_decision_runs': stored}, NOW)['dismissed_decision_runs'] == runs

    @pytest.mark.parametrize(('stored', 'guide'), [
        ('skipped', 'skipped'), ('open', 'open'), ('closed', 'open'), (None, 'open'), (1, 'open'),
    ])
    def test_guide_is_a_known_choice_or_open(self, stored, guide):
        assert onboarding.preference_view({'guide': stored}, NOW)['guide'] == guide

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
            'start_page': 'dashboard', 'guide': 'open', **NOTHING_DISMISSED, 'signals': NO_SIGNALS,
        }
        assert table.get_item.call_args_list[0].kwargs == {'Key': {'pk': 'USERCTX#u1', 'sk': 'onboarding'}}

    @pytest.mark.parametrize(('offset', 'visible'), [(timedelta(hours=-1), True), (timedelta(hours=1), False)])
    def test_get_defaults_to_the_server_clock(self, offset, visible):
        end = (datetime.now(UTC) + offset).isoformat()
        table = _table(item={'state': 'hidden', 'hidden_until': end})
        assert onboarding.get_onboarding(table, 'u1')['visible'] is visible

    def test_put_updates_the_callers_row_and_returns_the_written_view(self):
        written = {'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': NOW_ISO, 'start_page': 'dashboard',
                   'guide': 'skipped'}
        table = _table(written=written)
        view = onboarding.put_onboarding(table, 'u1', {'state': 'hidden'}, NOW)
        table.update_item.assert_called_once_with(Key={'pk': 'USERCTX#u1', 'sk': 'onboarding'},
                                                  **onboarding.preference_update({'state': 'hidden'}, NOW))
        assert view == {
            'state': 'hidden', 'hidden_until': TOMORROW_ISO, 'updated_at': NOW_ISO,
            'visible': False, 'start_page': 'dashboard', 'guide': 'skipped', **NOTHING_DISMISSED, 'signals': NO_SIGNALS,
        }
        table.get_item.assert_called_once_with(Key=WATERMARK_KEY)
        table.put_item.assert_not_called()

    def test_put_dismissing_a_run_merges_it_into_the_stored_list(self):
        table = _table(item={'dismissed_decision_runs': [RUN_A]},
                       written={'dismissed_decision_runs': [RUN_B, RUN_A]})
        view = onboarding.put_onboarding(table, 'u1', {'dismiss_decision_run': RUN_B}, NOW)
        assert table.get_item.call_args_list[0].kwargs == {'Key': {'pk': 'USERCTX#u1', 'sk': 'onboarding'}}
        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':dismissed_runs'] == [RUN_B, RUN_A]
        assert view['dismissed_decision_runs'] == [RUN_B, RUN_A]

    def test_put_without_a_dismissal_does_not_read_the_row(self):
        table = _table()
        onboarding.put_onboarding(table, 'u1', {'subscribe_prompt': 'dismissed'}, NOW)
        table.get_item.assert_called_once_with(Key=WATERMARK_KEY)
        assert ':dismissed_runs' not in table.update_item.call_args.kwargs['ExpressionAttributeValues']

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
