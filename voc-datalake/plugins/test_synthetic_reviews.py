"""Unit tests for the Synthetic Data Review Generator plugin handler.

Covers the pure parsing/building logic and the Bedrock-backed generation loop
(with `converse` mocked at the import boundary). AWS clients used by BaseIngestor
are mocked so no network calls occur.
"""
import json
from contextlib import contextmanager
from unittest.mock import patch, MagicMock



@contextmanager
def _make_ingestor(secrets: dict):
    """Instantiate SyntheticReviewsIngestor with AWS deps + secrets mocked."""
    with patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo, \
            patch('_shared.base_ingestor.get_s3_client'), \
            patch('_shared.base_ingestor.get_sqs_client'), \
            patch('_shared.base_ingestor.get_secret', return_value=secrets):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        from synthetic_reviews.ingestor.handler import SyntheticReviewsIngestor
        yield SyntheticReviewsIngestor()


def _configured_secrets(**overrides) -> dict:
    base = {
        'company_name': 'Acme Corp',
        'product_name': 'Acme App',
        'product_description': 'A mobile shopping app',
        'target_customer': 'Busy parents',
        'focus_areas': 'delivery, pricing',
        'num_reviews': '3',
        'sentiment_mix': 'balanced',
        'language': 'en',
    }
    base.update(overrides)
    return base


def _reviews_json(count: int) -> str:
    reviews = [
        {
            'text': f'This is synthetic review number {i}.',
            'rating': (i % 5) + 1,
            'title': f'Title {i}',
            'author': f'User {i}',
            'focus_area': 'delivery',
        }
        for i in range(count)
    ]
    return json.dumps(reviews)


class TestParseCount:
    """SyntheticReviewsIngestor._parse_count clamps the requested review count."""

    def _parse(self, raw):
        from synthetic_reviews.ingestor.handler import SyntheticReviewsIngestor
        return SyntheticReviewsIngestor._parse_count(raw)

    def test_returns_default_for_invalid_value(self):
        from synthetic_reviews.ingestor.handler import DEFAULT_REVIEWS
        assert self._parse('not-a-number') == DEFAULT_REVIEWS

    def test_returns_default_for_none(self):
        from synthetic_reviews.ingestor.handler import DEFAULT_REVIEWS
        assert self._parse(None) == DEFAULT_REVIEWS

    def test_clamps_to_max(self):
        from synthetic_reviews.ingestor.handler import MAX_REVIEWS
        assert self._parse('9999') == MAX_REVIEWS

    def test_clamps_to_minimum_of_one(self):
        assert self._parse('0') == 1

    def test_parses_valid_value(self):
        assert self._parse('7') == 7


class TestParseFocusAreas:
    """SyntheticReviewsIngestor._parse_focus_areas splits and caps the list."""

    def _parse(self, raw):
        from synthetic_reviews.ingestor.handler import SyntheticReviewsIngestor
        return SyntheticReviewsIngestor._parse_focus_areas(raw)

    def test_splits_on_commas_and_newlines(self):
        assert self._parse('delivery, pricing\nsupport') == ['delivery', 'pricing', 'support']

    def test_ignores_blank_entries(self):
        assert self._parse('delivery,, ,pricing') == ['delivery', 'pricing']

    def test_returns_empty_list_for_empty_string(self):
        assert self._parse('') == []

    def test_caps_number_of_areas(self):
        from synthetic_reviews.ingestor.handler import MAX_FOCUS_AREAS
        raw = ','.join(f'area{i}' for i in range(MAX_FOCUS_AREAS + 5))
        assert len(self._parse(raw)) == MAX_FOCUS_AREAS


class TestCoerceRating:
    """SyntheticReviewsIngestor._coerce_rating normalizes ratings to 1-5 floats."""

    def _coerce(self, raw):
        from synthetic_reviews.ingestor.handler import SyntheticReviewsIngestor
        return SyntheticReviewsIngestor._coerce_rating(raw)

    def test_returns_none_for_invalid(self):
        assert self._coerce('abc') is None

    def test_returns_none_for_none(self):
        assert self._coerce(None) is None

    def test_clamps_above_five(self):
        assert self._coerce(9) == 5.0

    def test_clamps_below_one(self):
        assert self._coerce(0) == 1.0

    def test_passes_through_valid_rating(self):
        assert self._coerce(4) == 4.0


class TestParseReviews:
    """SyntheticReviewsIngestor._parse_reviews extracts the JSON array safely."""

    def _parse(self, text):
        from synthetic_reviews.ingestor.handler import SyntheticReviewsIngestor
        return SyntheticReviewsIngestor._parse_reviews(text)

    def test_parses_array_with_surrounding_text(self):
        result = self._parse('Here are the reviews: [{"text": "Great"}] done')
        assert result == [{'text': 'Great'}]

    def test_returns_empty_for_malformed_json(self):
        assert self._parse('[{"text": "Great",}]') == []

    def test_returns_empty_when_no_array_present(self):
        assert self._parse('no json here') == []

    def test_drops_entries_without_text(self):
        result = self._parse('[{"text": "ok"}, {"rating": 5}, {"text": ""}]')
        assert result == [{'text': 'ok'}]


class TestBuildItem:
    """SyntheticReviewsIngestor._build_item produces normalized-ready items tagged synthetic."""

    def test_builds_item_with_synthetic_metadata(self):
        with _make_ingestor(_configured_secrets()) as ingestor:
            item = ingestor._build_item({
                'text': 'Loved the fast delivery',
                'rating': 5,
                'title': 'Great',
                'author': 'Sam P.',
                'focus_area': 'delivery',
            })
        assert item is not None
        assert item['id'].startswith('synthetic-')
        assert item['text'] == 'Loved the fast delivery'
        assert item['rating'] == 5.0
        assert item['channel'] == 'review'
        assert item['metadata']['is_synthetic'] is True
        assert item['metadata']['focus_area'] == 'delivery'

    def test_returns_none_for_empty_text(self):
        with _make_ingestor(_configured_secrets()) as ingestor:
            assert ingestor._build_item({'text': '   '}) is None

    def test_defaults_focus_area_when_missing(self):
        with _make_ingestor(_configured_secrets()) as ingestor:
            item = ingestor._build_item({'text': 'ok'})
        assert item['metadata']['focus_area'] == 'general'


class TestNormalizeItem:
    """normalize_item override carries synthetic tagging fields through to the queue."""

    def test_forwards_metadata_author_title_language(self):
        with _make_ingestor(_configured_secrets()) as ingestor:
            ingestor.store_raw_to_s3 = MagicMock(return_value='s3://bucket/key.json')
            normalized = ingestor.normalize_item({
                'id': 'synthetic-1',
                'text': 'ok',
                'channel': 'review',
                'author': 'Sam P.',
                'title': 'Great',
                'language': 'en',
                'metadata': {'is_synthetic': True},
            })
        assert normalized['author'] == 'Sam P.'
        assert normalized['title'] == 'Great'
        assert normalized['language'] == 'en'
        assert normalized['metadata'] == {'is_synthetic': True}


class TestFetchNewItems:
    """fetch_new_items generates reviews via Bedrock and yields synthetic items."""

    def test_yields_generated_reviews(self):
        with _make_ingestor(_configured_secrets(num_reviews='3')) as ingestor:
            with patch(
                'synthetic_reviews.ingestor.handler.converse',
                return_value=_reviews_json(3),
            ) as mock_converse:
                items = list(ingestor.fetch_new_items())
        assert len(items) == 3
        assert mock_converse.called
        assert all(i['metadata']['is_synthetic'] is True for i in items)
        assert all(i['id'].startswith('synthetic-') for i in items)

    def test_yields_nothing_when_not_configured(self):
        with _make_ingestor(_configured_secrets(company_name='', product_name='')) as ingestor:
            with patch('synthetic_reviews.ingestor.handler.converse') as mock_converse:
                items = list(ingestor.fetch_new_items())
        assert items == []
        assert not mock_converse.called

    def test_stops_early_when_generation_fails(self):
        with _make_ingestor(_configured_secrets(num_reviews='20')) as ingestor:
            with patch(
                'synthetic_reviews.ingestor.handler.converse',
                side_effect=RuntimeError('bedrock down'),
            ):
                items = list(ingestor.fetch_new_items())
        assert items == []


class TestLambdaHandler:
    """lambda_handler wires execution_id and runs the ingestor."""

    def test_sets_execution_id_from_event(self):
        import types
        ctx = types.SimpleNamespace(
            function_name='voc-ingestor-synthetic_reviews',
            function_version='$LATEST',
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-ingestor-synthetic_reviews',
            memory_limit_in_mb=512,
            aws_request_id='req-1',
        )
        with _make_ingestor(_configured_secrets()) as ingestor:
            from synthetic_reviews.ingestor import handler as handler_mod
            with patch.object(handler_mod, 'SyntheticReviewsIngestor', return_value=ingestor):
                ingestor.run = MagicMock(return_value={'status': 'success'})
                result = handler_mod.lambda_handler({'execution_id': 'run-123'}, ctx)
        assert ingestor.execution_id == 'run-123'
        assert result == {'status': 'success'}
