"""What the processor stores for dimensions, tags, producer fields and the PII policy."""
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from processor import handler
from shared.source_profiles import SourceProfilesUnavailable

DIMENSIONS = [
    {'key': 'product', 'label': 'Product', 'infer': True, 'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'module', 'label': 'Module', 'infer': True, 'parent': 'product', 'values': [
        {'name': 'checkout', 'parent_value': 'App'}, {'name': 'search', 'parent_value': 'Web'}]},
    {'key': 'user_type', 'label': 'User type', 'infer': False, 'values': [{'name': 'customer'}, {'name': 'partner'}]},
]
CATEGORIES = [{'name': 'billing', 'product': 'Web'}, {'name': 'other'}]
PROFILE = {'id': 'support_tickets', 'pii': 'redact', 'dimension_defaults': {'user_type': 'partner'},
           'tags': ['support', 'VIP']}

INSIGHTS = {
    'category': 'billing', 'subcategory': None, 'sentiment_label': 'negative', 'sentiment_score': -0.6,
    'urgency': 'high', 'problem_summary': 'Charged twice for [EMAIL]', 'direct_customer_quote': 'I was charged',
    'dimensions': {'product': 'App', 'module': 'search', 'user_type': 'customer'},
}


def _seed(dimensions=None, sources=None):
    handler._failed_settings.clear()
    handler._settings_cache.update({
        'dimensions': (float('inf'), dimensions or []),
        'sources': (float('inf'), sources or []),
    })


@pytest.fixture
def process():
    """`process_feedback` with no AWS calls; the model answers ``INSIGHTS`` (or the given answer)."""
    def run(record, insights=None):
        llm = {'insights': INSIGHTS if insights is None else insights, 'metadata': {}}
        with patch.object(handler, 'check_duplicate', return_value=False), \
             patch.object(handler, 'detect_language', return_value='en'), \
             patch.object(handler, 'translate_text', side_effect=lambda text, *_: text), \
             patch.object(handler, 'get_comprehend_sentiment', return_value={'label': 'neutral', 'score': 0.0}), \
             patch.object(handler, 'invoke_bedrock_llm', return_value=llm), \
             patch.object(handler, 'get_categories_config', return_value=CATEGORIES):
            return handler.process_feedback(record)
    return run


def _record(**extra):
    return {'id': 'r1', 'source_platform': 'support_tickets', 'text': 'I was charged twice',
            'created_at': '2026-10-01T00:00:00Z', **extra}


class TestDimensions:
    def test_message_then_profile_then_category_then_model(self, process):
        _seed(DIMENSIONS, [PROFILE])
        item = process(_record(dimensions={'module': 'checkout', 'product': 'app'}))
        assert item['dimensions'] == {'product': 'App', 'module': 'checkout', 'user_type': 'partner'}
        assert item['dimension_sources'] == {'product': 'source', 'module': 'source', 'user_type': 'profile'}

    def test_the_category_product_beats_the_model(self, process):
        _seed(DIMENSIONS)
        item = process(_record())
        assert item['dimensions'] == {'product': 'Web', 'module': 'search'}
        assert item['dimension_sources'] == {'product': 'category', 'module': 'ai'}

    def test_no_dimensions_configured_stores_none(self, process):
        item = process(_record(dimensions={'product': 'App'}))
        assert 'dimensions' not in item
        assert 'dimension_sources' not in item

    def test_metadata_keyed_by_a_dimension_beats_the_profile(self, process):
        _seed(DIMENSIONS, [PROFILE])
        item = process(_record(metadata={'custom_fields': {'user_type': 'customer'}, 'product': 'App'}))
        assert item['dimensions'] == {'product': 'App', 'user_type': 'customer'}
        assert item['dimension_sources'] == {'product': 'source', 'user_type': 'source'}

    def test_the_model_category_is_resolved_against_the_config(self, process):
        item = process(_record(), insights={**INSIGHTS, 'category': 'invented'})
        assert item['category'] == 'other'
        assert item['gsi2pk'] == 'CATEGORY#other'


class TestTags:
    def test_message_and_profile_tags_are_unioned(self, process):
        _seed(sources=[PROFILE])
        item = process(_record(tags=['vip', 'refund']))
        assert item['tags'] == ['vip', 'refund', 'support']

    def test_no_tags_stores_none(self, process):
        assert 'tags' not in process(_record())


class TestProducerFields:
    def test_author_title_and_metadata_are_stored(self, process):
        item = process(_record(author='Ana', title='Refund', metadata={'plan': 'pro'}))
        assert (item['author'], item['title'], item['metadata']) == ('Ana', 'Refund', {'plan': 'pro'})
        assert 'pii_policy' not in item


class TestPiiPolicy:
    def test_redact_tags_the_item_and_keeps_its_text(self, process):
        item = process(_record(pii_policy_applied='redact', author='[NAME]'))
        assert item['pii_policy'] == 'redact'
        assert item['original_text'] == 'I was charged twice'
        assert item['author'] == '[NAME]'

    def test_summary_only_keeps_derived_fields_only(self, process):
        item = process(_record(pii_policy_applied='summary_only', author='x', title='t', metadata={'a': 'b'}))
        assert item['pii_policy'] == 'summary_only'
        assert item['original_text'] == 'Charged twice for [EMAIL]'
        for field in ('normalized_text', 'direct_customer_quote', 'author', 'title', 'metadata'):
            assert field not in item
        assert item['sentiment_score'] == Decimal('-0.6')

    def test_summary_only_without_a_summary_is_withheld(self, process):
        item = process(_record(pii_policy_applied='summary_only'), insights={'category': 'other'})
        assert item['original_text'] == '[withheld]'

    def test_the_profile_decides_when_the_message_does_not_say(self, process):
        _seed(sources=[{**PROFILE, 'pii': 'summary_only'}])
        assert process(_record())['pii_policy'] == 'summary_only'

    def test_no_applied_policy_and_an_unreadable_profile_raises_for_an_sqs_retry(self):
        handler._settings_cache.clear()
        with patch.object(handler, 'load_source_profiles', side_effect=ValueError('bad')), \
                pytest.raises(SourceProfilesUnavailable):
            handler.pii_policy_for(_record())
        handler._failed_settings.clear()
        handler._settings_cache.clear()

    def test_an_applied_policy_needs_no_profile_read(self):
        handler._settings_cache.clear()
        with patch.object(handler, 'load_source_profiles', side_effect=ValueError('bad')) as loader:
            assert handler.pii_policy_for(_record(pii_policy_applied='redact')) == 'redact'
        loader.assert_not_called()


class TestSettingsCache:
    def test_a_failed_read_is_cached_as_none(self):
        handler._settings_cache.clear()
        loader = MagicMock(side_effect=ClientError({'Error': {'Code': 'Throttling'}}, 'GetItem'))
        assert handler._cached_setting('dimensions', loader) == []
        assert handler._cached_setting('dimensions', loader) == []
        loader.assert_called_once()

    def test_a_corrupt_row_reads_as_none(self):
        handler._settings_cache.clear()
        assert handler._cached_setting('sources', MagicMock(side_effect=ValueError('bad'))) == []

    def test_source_profile_defaults_when_absent(self):
        _seed(sources=[PROFILE])
        assert handler.source_profile('webscraper')['pii'] == 'allow'
        assert handler.source_profile('support_tickets')['tags'] == ['support', 'VIP']
