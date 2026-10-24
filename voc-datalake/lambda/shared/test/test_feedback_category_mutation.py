"""Mutation hardening for `shared/feedback_category.py`.

The module has no tests of its own: `test_feedback_edit_handler.py` and
`test_data_explorer_category_edit.py` reach it through the two handlers, run
against moto, and pin the end result (status code, the stored item). A mutation
run found what that end-to-end view cannot see:

* the WORDING of every 400/409/500 — the handlers return ``str(exc)`` as the
  body, so each message is what the editor reads. Pinned as literals.
* the exact BOUNDARY of a label: 64 characters save, 65 are refused, and a
  whitespace-only label is refused (``0 < len`` is not ``0 <= len``).
* the PIECES of the conditional write, which moto only checks indirectly: the
  ``SET``/``REMOVE`` clauses, every placeholder name and value, that ``gsi2pk``
  moves to ``CATEGORY#<new>`` and ``gsi2sk`` is never named, and that the
  condition is ``attribute_exists(pk) AND category = <previous>`` (or
  ``attribute_not_exists(category)`` for an item that had none).
* that ``apply_conditional_update`` passes ``kwargs`` through unchanged,
  returns ``Attributes`` (``{}`` when DynamoDB sends none), raises the CALLER's
  error on a failed condition, 409 with the lost-update text by default, and a
  500 whose message never echoes the AWS error.
* the TYPED contract both handlers lean on: ``category_label(..., required=True)``
  is declared to return ``str`` (the overload the type checker picks), and
  ``CategoryChange.condition`` is ``ConditionBase | None``. Both live only in
  annotations, so only introspection sees a decorator or a ``|`` go missing.
"""
import inspect
from datetime import UTC, datetime
from typing import Any, get_overloads, get_type_hints
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder
from botocore.exceptions import ClientError, EndpointConnectionError

from shared import feedback_category as fc
from shared.exceptions import ConflictError, NotFoundError, ServiceError, ValidationError
from shared.project_access import Caller


def _render(condition) -> tuple[str, dict, dict]:
    built = ConditionExpressionBuilder().build_expression(condition, is_key_condition=False)
    return built.condition_expression, built.attribute_name_placeholders, built.attribute_value_placeholders


class TestLabelsAreTrimmedAndBounded:
    @pytest.mark.parametrize('value', [None, ''])
    def test_absent_optional_label_is_none(self, value):
        assert fc.category_label(value, 'subcategory', required=False) is None

    @pytest.mark.parametrize('value', [None, ''])
    def test_absent_required_label_names_the_key(self, value):
        with pytest.raises(ValidationError, match=r'^category is required$'):
            fc.category_label(value, 'category', required=True)

    def test_label_is_stripped(self):
        assert fc.category_label('  billing \n', 'category', required=True) == 'billing'

    def test_a_single_character_is_accepted(self):
        assert fc.category_label('x', 'category', required=True) == 'x'

    def test_required_true_is_declared_to_return_str(self):
        signatures = [inspect.signature(o) for o in get_overloads(fc.category_label)]
        assert [(s.parameters['required'].annotation, s.return_annotation) for s in signatures] == [
            ('Literal[True]', 'str'), ('bool', 'str | None'),
        ]

    def test_max_label_chars_is_64(self):
        assert fc.MAX_LABEL_CHARS == 64

    def test_64_characters_are_accepted_exactly(self):
        assert fc.category_label('x' * 64, 'category', required=True) == 'x' * 64

    @pytest.mark.parametrize('value', ['x' * 65, '   ', 7, ['billing'], {'name': 'billing'}])
    def test_over_long_blank_or_non_string_label_is_refused(self, value):
        with pytest.raises(ValidationError,
                           match=r'^subcategory must be a string of 1-64 characters$'):
            fc.category_label(value, 'subcategory', required=False)


class TestCategoriesConfigFallsBackToDefaults:
    def test_configured_categories_are_returned_as_read(self):
        table = object()
        with patch.object(fc, 'read_categories_config', return_value=[{'name': 'a'}]) as read:
            assert fc.categories_config(table) == [{'name': 'a'}]
        read.assert_called_once_with(table)

    def test_empty_config_yields_one_entry_per_default_category(self):
        with patch.object(fc, 'read_categories_config', return_value=[]):
            assert fc.categories_config(object()) == [
                {'name': 'delivery'}, {'name': 'customer_support'}, {'name': 'product_quality'},
                {'name': 'pricing'}, {'name': 'website'}, {'name': 'app'}, {'name': 'billing'},
                {'name': 'returns'}, {'name': 'communication'}, {'name': 'other'},
            ]


CONFIG = [
    {'name': 'delivery'},
    {'name': 'billing', 'subcategories': [{'name': 'refund'}, 'not-a-dict', {'name': 'invoice'}]},
    {'name': 'app', 'subcategories': 'broken'},
    {'name': 'web', 'subcategories': []},
]


class TestTargetMustBeConfigured:
    @pytest.mark.parametrize('category', ['unknown', 'Billing', ''])
    def test_unconfigured_category_is_refused(self, category):
        with pytest.raises(ValidationError, match=r'^category is not a configured category$'):
            fc.validate_target(CONFIG, category, None)

    def test_an_entry_without_a_name_never_matches(self):
        with pytest.raises(ValidationError, match=r'^category is not a configured category$'):
            fc.validate_target([{'subcategories': []}], 'None', None)

    @pytest.mark.parametrize(('category', 'subcategory'), [
        ('delivery', None), ('billing', None), ('billing', 'refund'), ('billing', 'invoice'),
        ('app', 'anything'), ('web', 'anything'), ('delivery', 'anything'),
    ])
    def test_accepted_targets(self, category, subcategory):
        assert fc.validate_target(CONFIG, category, subcategory) is None

    @pytest.mark.parametrize('subcategory', ['nope', 'Refund', 'not-a-dict'])
    def test_subcategory_outside_the_configured_set_is_refused(self, subcategory):
        with pytest.raises(ValidationError, match=r'^subcategory does not belong to this category$'):
            fc.validate_target(CONFIG, 'billing', subcategory)


class TestOverrideRecordKeepsTheEditorsSub:
    def test_record_fields(self):
        caller = Caller(subject='sub-1', username='ada', is_admin=True)
        item = {'category': 'delivery', 'subcategory': 'late', 'pk': 'x'}
        before = datetime.now(UTC)
        record = fc.override_record(item, caller)
        after = datetime.now(UTC)
        assert set(record) == {'previous_category', 'previous_subcategory', 'by_sub', 'by_username', 'at'}
        assert record['previous_category'] == 'delivery'
        assert record['previous_subcategory'] == 'late'
        assert record['by_sub'] == 'sub-1'
        assert record['by_username'] == 'ada'
        at = datetime.fromisoformat(record['at'])
        assert at.tzinfo is not None
        assert before <= at <= after

    def test_missing_previous_values_are_none(self):
        record = fc.override_record({}, Caller(subject='s', username='u'))
        assert record['previous_category'] is None
        assert record['previous_subcategory'] is None


class TestItemExists:
    def test_is_attribute_exists_on_pk(self):
        expression, names, values = _render(fc.item_exists())
        assert expression == 'attribute_exists(#n0)'
        assert names == {'#n0': 'pk'}
        assert values == {}


class TestCategoryChangeDefaults:
    def test_empty_change(self):
        change = fc.CategoryChange()
        assert change.sets == []
        assert change.removes == []
        assert change.names == {}
        assert change.values == {}
        assert change.condition is None

    def test_declared_field_types(self):
        assert get_type_hints(fc.CategoryChange) == {
            'sets': list[str], 'removes': list[str], 'names': dict[str, str],
            'values': dict[str, Any], 'condition': fc.ConditionBase | None,
        }


ITEM = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'category': 'delivery', 'subcategory': 'late',
        'gsi2pk': 'CATEGORY#delivery', 'gsi2sk': '-0.5#2026'}
OVERRIDE = {'previous_category': 'delivery', 'by_sub': 's'}


class TestCategoryChangeBuildsTheWholeMove:
    def test_category_source_manual(self):
        assert fc.CATEGORY_SOURCE_MANUAL == 'manual'

    def test_without_subcategory_sets_four_and_removes_subcategory(self):
        change = fc.category_change(ITEM, 'billing', None, OVERRIDE)
        assert change.sets == ['#cat_c = :cat_c', '#cat_g = :cat_g', '#cat_src = :cat_src', '#cat_o = :cat_o']
        assert change.removes == ['#cat_s']
        assert change.names == {'#cat_c': 'category', '#cat_s': 'subcategory', '#cat_g': 'gsi2pk',
                                '#cat_src': 'category_source', '#cat_o': 'category_override'}
        assert change.values == {':cat_c': 'billing', ':cat_g': 'CATEGORY#billing',
                                 ':cat_src': 'manual', ':cat_o': OVERRIDE}
        assert change.values[':cat_o'] is OVERRIDE

    def test_with_subcategory_sets_five_and_removes_nothing(self):
        change = fc.category_change(ITEM, 'billing', 'refund', OVERRIDE)
        assert change.sets == ['#cat_c = :cat_c', '#cat_g = :cat_g', '#cat_src = :cat_src',
                               '#cat_o = :cat_o', '#cat_s = :cat_s']
        assert change.removes == []
        assert change.values == {':cat_c': 'billing', ':cat_g': 'CATEGORY#billing',
                                 ':cat_src': 'manual', ':cat_o': OVERRIDE, ':cat_s': 'refund'}

    def test_condition_requires_existence_and_the_category_that_was_read(self):
        change = fc.category_change(ITEM, 'billing', None, OVERRIDE)
        expression, names, values = _render(change.condition)
        assert expression == '(attribute_exists(#n0) AND #n1 = :v0)'
        assert names == {'#n0': 'pk', '#n1': 'category'}
        assert values == {':v0': 'delivery'}

    def test_condition_for_an_uncategorised_item_requires_no_category(self):
        change = fc.category_change({'pk': 'p', 'sk': 's'}, 'billing', None, OVERRIDE)
        expression, names, values = _render(change.condition)
        assert expression == '(attribute_exists(#n0) AND attribute_not_exists(#n1))'
        assert names == {'#n0': 'pk', '#n1': 'category'}
        assert values == {}

    def test_an_empty_string_category_is_a_value_not_absence(self):
        change = fc.category_change({'category': ''}, 'billing', None, OVERRIDE)
        expression, _, values = _render(change.condition)
        assert expression == '(attribute_exists(#n0) AND #n1 = :v0)'
        assert values == {':v0': ''}


class TestUpdateExpression:
    @pytest.mark.parametrize(('sets', 'removes', 'expected'), [
        (['a = :a', 'b = :b'], ['c'], 'SET a = :a, b = :b REMOVE c'),
        (['a = :a'], [], 'SET a = :a'),
        ([], ['c', 'd'], 'REMOVE c, d'),
        ([], [], ''),
    ])
    def test_clauses(self, sets, removes, expected):
        assert fc.update_expression(sets, removes) == expected


def _client_error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'aws detail'}}, 'UpdateItem')


class TestApplyConditionalUpdate:
    def test_lost_update_message(self):
        assert fc.LOST_UPDATE_MESSAGE == 'This review was changed by someone else. Reload and retry.'

    def test_passes_kwargs_through_and_returns_attributes(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'category': 'billing'}}
        kwargs = {'Key': {'pk': 'p', 'sk': 's'}, 'ReturnValues': 'ALL_NEW'}
        assert fc.apply_conditional_update(table, kwargs) == {'category': 'billing'}
        table.update_item.assert_called_once_with(Key={'pk': 'p', 'sk': 's'}, ReturnValues='ALL_NEW')

    def test_no_attributes_is_an_empty_dict(self):
        table = MagicMock()
        table.update_item.return_value = {}
        assert fc.apply_conditional_update(table, {}) == {}

    def test_failed_condition_is_409_with_the_lost_update_text(self):
        table = MagicMock()
        table.update_item.side_effect = _client_error('ConditionalCheckFailedException')
        with pytest.raises(ConflictError) as info:
            fc.apply_conditional_update(table, {})
        assert str(info.value) == 'This review was changed by someone else. Reload and retry.'
        assert info.value.status_code == 409
        assert isinstance(info.value.__cause__, ClientError)

    def test_failed_condition_raises_the_callers_error_instead(self):
        table = MagicMock()
        table.update_item.side_effect = _client_error('ConditionalCheckFailedException')
        missing = NotFoundError('Feedback not found')
        with pytest.raises(NotFoundError) as info:
            fc.apply_conditional_update(table, {}, on_condition_failed=missing)
        assert info.value is missing

    def test_other_client_errors_are_500_without_the_aws_detail(self):
        table = MagicMock()
        table.update_item.side_effect = _client_error('ProvisionedThroughputExceededException')
        with patch.object(fc.logger, 'exception') as log, pytest.raises(ServiceError) as info:
            fc.apply_conditional_update(table, {}, on_condition_failed=NotFoundError('nf'))
        assert str(info.value) == 'Could not update the feedback. Please retry.'
        assert info.value.status_code == 500
        assert isinstance(info.value.__cause__, ClientError)
        log.assert_called_once_with('Feedback update failed')

    def test_a_botocore_error_is_500_and_never_a_conflict(self):
        table = MagicMock()
        table.update_item.side_effect = EndpointConnectionError(endpoint_url='http://x')
        with patch.object(fc.logger, 'exception') as log, \
                pytest.raises(ServiceError, match=r'^Could not update the feedback\. Please retry\.$'):
            fc.apply_conditional_update(table, {})
        log.assert_called_once_with('Feedback update failed')

    def test_an_unrelated_exception_propagates_untouched(self):
        table = MagicMock()
        table.update_item.side_effect = KeyError('boom')
        with pytest.raises(KeyError):
            fc.apply_conditional_update(table, {})
