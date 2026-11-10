"""shared.scope_names — which text names a category a restricted reader may not see."""
import pytest

from shared.category_access import UNRESTRICTED, CategoryScope
from shared.memory_categories import category_ids
from shared.scope_names import HIDE_ALL, HiddenNames, hidden_names, named_category_ids, scoped_company_context

CONFIG = [
    {'name': 'technical_support', 'description': 'Technical Support',
     'subcategories': [{'name': 'response_time', 'description': 'Response time'}]},
    {'name': 'hardware_quality', 'description': 'Hardware Quality',
     'subcategories': [{'name': 'hardware_failures', 'description': 'Hardware failures'}]},
    {'name': 'software_firmware', 'description': 'Software & Firmware'},
    {'name': 'pricing', 'description': 'A long explanation of everything about prices that is not a label at all'},
    {'name': 'other', 'description': 'Other'},
]
TS_ONLY = CategoryScope(all=False, categories=frozenset({'technical_support'}))


def _names(scope: CategoryScope, config: object) -> HiddenNames:
    names = hidden_names(scope, config)
    assert names is not None
    return names


@pytest.fixture
def hidden():
    return _names(TS_ONLY, CONFIG)


def test_unrestricted_and_source_only_scopes_hide_no_name():
    assert hidden_names(UNRESTRICTED, CONFIG) is None
    assert hidden_names(None, CONFIG) is None
    assert hidden_names(CategoryScope(all=True, source_deny=frozenset({'web'})), CONFIG) is None


@pytest.mark.parametrize('text', [
    'The workspace has eight categories, such as Hardware Quality.',
    'hardware_quality is up', 'Software/Firmware issues', 'software and firmware', 'SOFTWARE & FIRMWARE',
    'more hardware failures than before', 'Pricing complaints grew',
])
def test_hidden_names_match_ids_labels_and_subcategories(hidden, text):
    assert hidden.named_in(text)


@pytest.mark.parametrize('text', [
    'Technical Support answers slowly', 'Response time is 9 days', 'other customers agree',
    'hardwarequality', 'softwares', None, 42,
])
def test_visible_fallback_and_partial_words_do_not_match(hidden, text):
    assert not hidden.named_in(text)


def test_a_name_shared_with_a_visible_category_is_not_hidden():
    config = [*CONFIG, {'name': 'support_desk', 'description': 'Hardware Quality'}]
    scope = CategoryScope(all=False, categories=frozenset({'support_desk'}))
    assert not _names(scope, config).named_in('Hardware Quality')


def test_malformed_config_entries_are_ignored():
    names = _names(TS_ONLY, ['x', {'name': 3}, {'name': 'hardware_quality'}, None])
    assert (names.named_in('hardware quality'), names.named_in('anything else')) == (True, False)
    assert _names(TS_ONLY, 'not a list').pattern is None


def test_company_context_drops_naming_objectives_and_paragraphs(hidden):
    company = {
        'vision': 'Be the most trusted brand.\n\nHalve Hardware Quality returns.',
        'objectives': [{'title': 'Faster support replies'},
                       {'title': 'Fix firmware', 'description': 'Cut software_firmware complaints'}, 'junk'],
        'updated_at': 'x',
    }
    scoped = scoped_company_context(company, hidden)
    assert scoped['vision'] == 'Be the most trusted brand.'
    assert scoped['objectives'] == [{'title': 'Faster support replies'}, 'junk']
    assert (scoped['updated_at'], company['vision'].endswith('returns.')) == ('x', True)


def test_company_context_unchanged_without_hidden_names():
    company = {'vision': 'Hardware Quality first.', 'objectives': [{'title': 'Hardware Quality'}]}
    assert scoped_company_context(company, None) == company
    assert scoped_company_context(company, hidden_names(TS_ONLY, [])) == company


def test_hide_all_hides_every_non_empty_text():
    assert [HIDE_ALL.named_in(text) for text in ('anything', '  ', None)] == [True, False, False]
    assert scoped_company_context({'vision': 'x', 'objectives': [{'title': 'y'}]}, HIDE_ALL) == {
        'vision': '', 'objectives': []}


def test_named_category_ids_tags_what_a_statement_names():
    assert named_category_ids('Hardware failures and Software & Firmware bugs, other things', CONFIG) == [
        'hardware_quality', 'software_firmware']
    assert named_category_ids('nothing here', CONFIG) == []
    assert [named_category_ids(text, CONFIG) for text in (None, '  ')] == [[], []]


def test_category_ids_unions_the_answer_with_the_named_categories():
    assert category_ids(['Technical Support'], CONFIG, 'Hardware Quality slipped') == [
        'technical_support', 'hardware_quality']
    assert category_ids('junk', CONFIG, 'pricing went up') == ['pricing']
