"""Mutation hardening for `shared/category_config.py`.

`test_category_access.py` pins that invalid configs are refused and that one
over-the-limit value per bound raises, but a mutation run found two things it
cannot see:

* the WORDING of every refusal. `PUT /settings/categories` returns `str(exc)`
  as the 400 body, so the message is what an admin reads in the Settings
  editor — the client-safe contract the module docstring promises. Every
  message is pinned here as a literal, so a label that drifts (``Category id``
  becoming ``Xxcategoryxx id``) or a bound that moves fails a test.
* the ACCEPTED side of each bound (`>` vs `>=`): exactly 50 subcategories,
  exactly 20 owners, a 128-character id and a 254-character owner field must
  all save, which no earlier test asserted.
"""
import re

import pytest

from shared.category_config import validate_categories


def _owners(count: int) -> list[dict]:
    return [{'sub': f's{i}'} for i in range(count)]


def _subcategories(count: int) -> list[dict]:
    return [{'name': f's{i}'} for i in range(count)]


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('categories', 'message'), [
        ('x', 'categories must be a list'),
        ([{'name': f'c{i}'} for i in range(51)], 'At most 50 categories are allowed'),
        (['not-an-object'], 'Each category must be an object'),
        ([{'name': 1}], 'Category name must be a string'),
        ([{'name': 'x' * 65}], 'Category name must be at most 64 characters'),
        ([{'name': 'a b'}], 'Category name must be 1-64 characters with no spaces or "#"'),
        ([{'name': ''}], 'Category name must be 1-64 characters with no spaces or "#"'),
        ([{}], 'Category name must be 1-64 characters with no spaces or "#"'),
        ([{'name': 'a', 'id': 'i' * 129}], 'Category id must be at most 128 characters'),
        ([{'name': 'a', 'id': 7}], 'Category id must be a string'),
        ([{'name': 'a', 'description': 'd' * 501}],
         'Category description must be at most 500 characters'),
        ([{'name': 'a', 'product': 'p' * 121}], 'Category product must be at most 120 characters'),
        ([{'name': 'a'}, {'name': 'a'}], 'Category names must be unique'),
        ([{'name': 'a', 'owners': 'x'}], 'owners must be a list'),
        ([{'name': 'a', 'owners': _owners(21)}], 'A category can have at most 20 owners'),
        ([{'name': 'a', 'owners': ['x']}], 'Each owner must be an object'),
        ([{'name': 'a', 'owners': [{'sub': 1}]}], 'Owner sub must be a string'),
        ([{'name': 'a', 'owners': [{'sub': 's' * 255}]}], 'Owner sub must be at most 254 characters'),
        ([{'name': 'a', 'owners': [{}]}], 'Each owner needs a sub'),
        ([{'name': 'a', 'owners': [{'sub': ' '}]}], 'Each owner needs a sub'),
        ([{'name': 'a', 'owners': [{'sub': 's', 'username': 1}]}], 'Owner username must be a string'),
        ([{'name': 'a', 'owners': [{'sub': 's', 'email': 1}]}], 'Owner email must be a string'),
        ([{'name': 'a', 'owners': [{'sub': 's'}, {'sub': 's'}]}], 'owners must not repeat'),
        ([{'name': 'a', 'subcategories': 'x'}], 'subcategories must be a list'),
        ([{'name': 'a', 'subcategories': _subcategories(51)}],
         'A category can have at most 50 subcategories'),
        ([{'name': 'a', 'subcategories': ['x']}], 'Each subcategory must be an object'),
        ([{'name': 'a', 'subcategories': [{'name': 1}]}], 'Subcategory name must be a string'),
        ([{'name': 'a', 'subcategories': [{'name': 'a#b'}]}],
         'Subcategory name must be 1-64 characters with no spaces or "#"'),
        ([{'name': 'a', 'subcategories': [{'name': 's', 'id': 7}]}], 'Subcategory id must be a string'),
        ([{'name': 'a', 'subcategories': [{'name': 's', 'description': 7}]}],
         'Subcategory description must be a string'),
        ([{'name': 'a', 'subcategories': [{'name': 's'}, {'name': 's'}]}],
         'Subcategory names must be unique'),
    ])
    def test_refuses_with_the_exact_client_safe_message(self, categories, message):
        with pytest.raises(ValueError, match=f'^{re.escape(message)}$') as exc:
            validate_categories(categories)
        assert str(exc.value) == message


class TestTheBoundItselfIsAllowed:
    def test_fifty_subcategories_save(self):
        result = validate_categories([{'name': 'a', 'subcategories': _subcategories(50)}])
        assert len(result[0]['subcategories']) == 50

    def test_twenty_owners_save(self):
        result = validate_categories([{'name': 'a', 'owners': _owners(20)}])
        assert len(result[0]['owners']) == 20

    def test_a_128_character_id_saves(self):
        assert validate_categories([{'name': 'a', 'id': 'i' * 128}])[0]['id'] == 'i' * 128

    def test_a_254_character_owner_field_saves(self):
        sub = 's' * 254
        result = validate_categories([{'name': 'a', 'owners': [{'sub': sub, 'email': 'e' * 254}]}])
        assert result[0]['owners'] == [{'sub': sub, 'username': '', 'email': 'e' * 254}]

    def test_a_500_character_description_and_120_character_product_save(self):
        result = validate_categories([{'name': 'a', 'description': 'd' * 500, 'product': 'p' * 120}])
        assert result[0]['description'] == 'd' * 500
        assert result[0]['product'] == 'p' * 120
