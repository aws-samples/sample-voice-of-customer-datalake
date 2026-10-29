"""`shared/ai_mode.py`: one person's way of working with AI, in the aggregates table
(docs/ways-of-working.md). Stored in a moto table, so the key shape and the row a
reader sees are the ones DynamoDB really holds."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from shared import ai_mode
from shared.test.moto_tables import create_pk_sk_table

TABLE_NAME = 'test-aggregates'


@pytest.fixture
def aws() -> Iterator[tuple[Any, Any]]:
    """(dynamodb resource, aggregates table) inside one moto context."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        yield resource, create_pk_sk_table(TABLE_NAME, resource)


@pytest.fixture
def table(aws: tuple[Any, Any]) -> Any:
    return aws[1]


def _stored(table: Any, sub: str) -> dict:
    return table.get_item(Key={'pk': f'USERFLAGS#{sub}', 'sk': 'ai_mode'}).get('Item') or {}


class TestTheDefault:
    def test_the_modes_are_human_driven_ai_assisted_and_ai_driven_in_that_order(self):
        assert ai_mode.MODES == ('human_driven', 'ai_assisted', 'ai_driven')

    def test_the_default_is_ai_driven_with_nothing_unlocked(self):
        assert ai_mode.DEFAULT_MODE == 'ai_driven'
        expected = ai_mode.AiMode('ai_driven', frozenset())
        assert expected == ai_mode.DEFAULT_AI_MODE

    def test_a_person_without_a_row_works_ai_driven(self, table: Any):
        assert ai_mode.get_ai_mode(table, 'sub-nobody') == ai_mode.DEFAULT_AI_MODE

    def test_the_default_reads_as_ai_driven_with_both_unlocks_false(self):
        assert ai_mode.DEFAULT_AI_MODE.to_dict() == {
            'mode': 'ai_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': False}

    def test_the_flags_body_accepts_exactly_the_mode_and_the_two_unlocks(self):
        assert ai_mode.FIELD_NAMES == ('ai_mode', 'ai_writing_prfaq', 'ai_writing_prd')
        assert ai_mode.UNLOCK_FIELDS == {'prfaq': 'ai_writing_prfaq', 'prd': 'ai_writing_prd'}


class TestReadingAStoredRow:
    @pytest.mark.parametrize('item', [
        None,
        {},
        {'mode': 'robot'},
        {'mode': 7},
        {'mode': ['human_driven']},
        {'mode': 'HUMAN_DRIVEN'},
        {'mode': ' human_driven'},
    ])
    def test_an_unreadable_mode_is_ai_driven(self, item: dict | None):
        assert ai_mode.ai_mode_of(item).mode == 'ai_driven'

    @pytest.mark.parametrize('value', ['true', 1, 'yes', None, [True], {'x': True}])
    def test_only_a_real_true_unlocks_a_type(self, value: object):
        mode = ai_mode.ai_mode_of({'mode': 'human_driven', 'ai_writing_prfaq': value, 'ai_writing_prd': value})
        assert mode.unlocked == frozenset()

    def test_each_unlock_maps_to_its_own_document_type(self):
        assert ai_mode.ai_mode_of({'mode': 'human_driven', 'ai_writing_prd': True}).unlocked == {'prd'}
        assert ai_mode.ai_mode_of({'mode': 'human_driven', 'ai_writing_prfaq': True}).unlocked == {'prfaq'}

    def test_unknown_attributes_on_the_row_are_ignored(self):
        mode = ai_mode.ai_mode_of({'mode': 'ai_assisted', 'ai_writing_prototype': True, 'admin': True})
        assert mode == ai_mode.AiMode('ai_assisted', frozenset())

    def test_to_dict_reports_the_mode_and_both_unlocks(self):
        mode = ai_mode.AiMode('human_driven', frozenset({'prd'}))
        assert mode.to_dict() == {'mode': 'human_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': True}

    def test_the_gate_reads_strongly_consistent_at_the_persons_key(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'mode': 'human_driven', 'ai_writing_prfaq': True}}

        mode = ai_mode.get_ai_mode(table, 'sub-ada')

        table.get_item.assert_called_once_with(
            Key={'pk': 'USERFLAGS#sub-ada', 'sk': 'ai_mode'}, ConsistentRead=True)
        assert mode == ai_mode.AiMode('human_driven', frozenset({'prfaq'}))


class TestSettingTheMode:
    def test_setting_a_mode_stores_it_with_who_and_when(self, table: Any):
        result = ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'human_driven'},
                                     actor_sub='admin-sub')

        assert result == ai_mode.AiMode('human_driven', frozenset())
        stored = _stored(table, 'sub-ada')
        assert {k: stored[k] for k in ('mode', 'ai_writing_prfaq', 'ai_writing_prd', 'updated_by')} == {
            'mode': 'human_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': False,
            'updated_by': 'admin-sub'}
        updated_at = stored['updated_at']
        assert isinstance(updated_at, str)
        assert datetime.fromisoformat(updated_at).tzinfo is not None

    def test_the_stored_mode_is_what_the_next_read_sees(self, table: Any):
        ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'ai_assisted'}, actor_sub='admin-sub')

        assert ai_mode.get_ai_mode(table, 'sub-ada').mode == 'ai_assisted'
        assert ai_mode.get_ai_mode(table, 'sub-bob') == ai_mode.DEFAULT_AI_MODE

    def test_unlocking_a_type_alone_keeps_the_mode(self, table: Any):
        ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'human_driven'}, actor_sub='a')

        result = ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_writing_prd': True}, actor_sub='a')

        assert result == ai_mode.AiMode('human_driven', frozenset({'prd'}))
        assert ai_mode.get_ai_mode(table, 'sub-ada') == result

    def test_an_unlock_on_a_person_without_a_row_keeps_the_ai_driven_default(self, table: Any):
        result = ai_mode.set_ai_mode(table, sub='sub-new', changes={'ai_writing_prfaq': True}, actor_sub='a')

        assert result == ai_mode.AiMode('ai_driven', frozenset({'prfaq'}))

    def test_the_unlocks_are_kept_when_the_mode_moves_up_and_back_down(self, table: Any):
        ai_mode.set_ai_mode(table, sub='sub-ada',
                            changes={'ai_mode': 'human_driven', 'ai_writing_prfaq': True}, actor_sub='a')

        up = ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'ai_assisted'}, actor_sub='a')
        down = ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'human_driven'}, actor_sub='a')

        assert up == ai_mode.AiMode('ai_assisted', frozenset({'prfaq'}))
        assert down == ai_mode.AiMode('human_driven', frozenset({'prfaq'}))
        assert _stored(table, 'sub-ada')['ai_writing_prfaq'] is True

    def test_an_unlock_can_be_taken_back(self, table: Any):
        ai_mode.set_ai_mode(table, sub='sub-ada',
                            changes={'ai_mode': 'human_driven', 'ai_writing_prfaq': True, 'ai_writing_prd': True},
                            actor_sub='a')

        result = ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_writing_prfaq': False}, actor_sub='a')

        assert result.unlocked == {'prd'}

    def test_the_mode_row_never_touches_the_flags_row_beside_it(self, table: Any):
        flags_row = {'pk': 'USERFLAGS#sub-ada', 'sk': 'config', 'memory_reviewer': True}
        table.put_item(Item=flags_row)

        ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'human_driven'}, actor_sub='a')

        assert table.get_item(Key={'pk': 'USERFLAGS#sub-ada', 'sk': 'config'})['Item'] == flags_row


class TestModesForManyUsers:
    def test_each_user_gets_their_own_mode_and_an_unset_user_the_default(self, aws: tuple[Any, Any]):
        resource, table = aws
        ai_mode.set_ai_mode(table, sub='sub-ada', changes={'ai_mode': 'human_driven', 'ai_writing_prd': True},
                            actor_sub='a')
        ai_mode.set_ai_mode(table, sub='sub-bob', changes={'ai_mode': 'ai_assisted'}, actor_sub='a')

        modes = ai_mode.ai_modes_for_subs(resource, TABLE_NAME, ['sub-ada', 'sub-bob', 'sub-cy'])

        assert modes == {
            'sub-ada': ai_mode.AiMode('human_driven', frozenset({'prd'})),
            'sub-bob': ai_mode.AiMode('ai_assisted', frozenset()),
            'sub-cy': ai_mode.DEFAULT_AI_MODE,
        }

    def test_duplicate_and_blank_subs_are_asked_for_once_or_not_at_all(self, aws: tuple[Any, Any]):
        resource, _ = aws

        modes = ai_mode.ai_modes_for_subs(resource, TABLE_NAME, ['sub-ada', '', 'sub-ada'])

        assert list(modes) == ['sub-ada']

    def test_no_users_reads_nothing(self):
        dynamodb = MagicMock()

        assert ai_mode.ai_modes_for_subs(dynamodb, TABLE_NAME, []) == {}
        dynamodb.batch_get_item.assert_not_called()

    def test_a_junk_row_in_the_list_reads_as_the_default(self, aws: tuple[Any, Any]):
        resource, table = aws
        table.put_item(Item={'pk': 'USERFLAGS#sub-ada', 'sk': 'ai_mode', 'mode': 'robot', 'ai_writing_prd': 'yes'})

        modes = ai_mode.ai_modes_for_subs(resource, TABLE_NAME, ['sub-ada'])

        assert modes == {'sub-ada': ai_mode.DEFAULT_AI_MODE}
