"""Producer-side tests for `shared.ingest_schemas` - the processing-queue message contract.

The schema's own behaviour (every bound, every refusal message, the created_at
fallback, sanitisation) is pinned exactly in
`lambda/shared/test/test_ingest_schemas_mutation.py`. This file keeps what is
about the PRODUCERS: the shapes each one really sends, and the display-name /
normalisation cases issue #249 was about.
"""

import pytest


class TestIngestMessageValidation:
    """Tests for IngestMessage schema validation."""

    @pytest.mark.parametrize(
        ('manual_fields', 'expected'),
        [
            (
                {
                    'source_origin': 'g2',
                    'source_channel': 'g2',
                    'source_url': 'https://www.g2.com/products/example/reviews',
                    'url': 'https://www.g2.com/products/example/reviews',
                    'ingestion_method': 'manual',
                    'manual_import_job_id': '68d6fcf5-5f19-4983-9e1c-38c17fdb7c90',
                    's3_raw_uri': 's3://raw-data/manual_import/job.json',
                },
                {
                    'ingestion_method': 'manual',
                    'source_origin': 'g2',
                    'source_url': 'https://www.g2.com/products/example/reviews',
                    'manual_import_job_id': '68d6fcf5-5f19-4983-9e1c-38c17fdb7c90',
                },
            ),
            (
                {
                    'source_channel': 'store_reviews',
                    'ingestion_method': 'csv_upload',
                    'csv_row_id': 'source-row-1',
                    's3_raw_uri': 's3://raw-data/csv_upload/job.csv',
                },
                {'ingestion_method': 'csv_upload'},
            ),
            (
                {
                    'source_channel': 'support',
                    'ingestion_method': 'json_upload',
                    'metadata': {'external_ticket': 'ticket-123'},
                    's3_raw_uri': 's3://raw-data/json_upload/job.json',
                },
                {'ingestion_method': 'json_upload'},
            ),
        ],
    )
    def test_accepts_messages_from_each_manual_import_path(self, manual_fields, expected):
        """Keeps the strict schema aligned with all three manual-import producers."""
        from shared.ingest_schemas import validate_message

        raw = {
            'id': 'manual-message-123',
            'source_platform': 'manual_import',
            'text': 'Imported customer feedback',
            'created_at': '2026-01-01T12:00:00Z',
            **manual_fields,
        }

        result = validate_message(raw)

        for field, value in expected.items():
            assert getattr(result, field) == value


class TestSourcePlatformValidation:
    """Tests for source_platform field validation."""

    def test_accepts_the_display_names_real_producers_send(self):
        """source_platform is a display name, not a slug (issue #249).

        The base ingestor sends `source_platform_override` verbatim: the
        app-review plugins send `<app>_iOS` / `<app>_Android`, s3_import sends
        `S3 - <folder>`, the webscraper the scraper's name or the page netloc.
        The old `^[a-z][a-z0-9_]*$` pattern refused every one of them, which was
        invisible only because validation never ran in production.
        """
        from shared.ingest_schemas import validate_message

        for platform in ['MyApp_iOS', 'MyApp_Android', 'S3 - surveys', 'Acme Reviews', 'www.example.com']:
            raw = {
                'id': 'msg-123',
                'source_platform': platform,
                'text': 'Test',
                'created_at': '2025-01-01T12:00:00Z',
            }
            assert validate_message(raw).source_platform == platform

    @pytest.mark.parametrize('platform', [
        'a#b',                 # would spell SOURCE#a#b / METRIC#daily_source#a#b
        'webscraper#',
        '#',
        'a\uff03b',            # fullwidth number sign: NFKC turns it into '#'
        'a\ufe5fb',            # small number sign: likewise
        '\u200b\u200d\ufeff',  # only format characters: blank once stripped
        '\ufdfa' * 15,         # 15 chars in, 270 after NFKC expansion
    ])
    def test_rejects_a_key_separator_or_what_normalises_to_one(self, platform):
        from shared.ingest_schemas import MessageValidationError, validate_message

        raw = {'id': 'msg-123', 'source_platform': platform, 'text': 'Test', 'created_at': '2025-01-01T12:00:00Z'}
        with pytest.raises(MessageValidationError, match='source_platform'):
            validate_message(raw)

    @pytest.mark.parametrize(('platform', 'expected'), [
        ('web\u200bscraper', 'webscraper'),         # zero-width space (Cf)
        ('\u202eMyApp_iOS', 'MyApp_iOS'),           # bidi override (Cf)
        ('\ufeffS3 - surveys', 'S3 - surveys'),     # BOM (Cf)
        ('web\tscraper\n', 'webscraper'),           # tab / newline (Cc)
        ('web\x85scraper', 'webscraper'),           # C1 control (Cc)
        ('\uff2d\uff59\uff21\uff50\uff50_iOS', 'MyApp_iOS'),  # fullwidth letters -> NFKC
        ('Cafe\u0301 Reviews', 'Café Reviews'),     # combining accent composes
    ])
    def test_normalises_source_platform_to_one_spelling(self, platform, expected):
        from shared.ingest_schemas import validate_message

        raw = {'id': 'msg-123', 'source_platform': platform, 'text': 'Test', 'created_at': '2025-01-01T12:00:00Z'}
        assert validate_message(raw).source_platform == expected


class TestSafeValidateMessage:
    """Tests for safe_validate_message() function."""

    def test_returns_message_and_empty_errors_on_success(self):
        """Returns (message, []) for valid input."""
        from shared.ingest_schemas import safe_validate_message

        raw = {
            'id': 'msg-123',
            'source_platform': 'webscraper',
            'text': 'Valid message',
            'created_at': '2025-01-01T12:00:00Z',
        }

        message, errors = safe_validate_message(raw)

        assert message is not None
        assert message.id == 'msg-123'
        assert errors == []


# ============================================
# Producer shapes (issues #412, #249)
# ============================================
#
# One case per producer of processing-queue messages, built the way that
# producer builds it: plugin messages go through the real `normalized_item_fields`
# (what BaseIngestor/BaseWebhook.normalize_item spread), with the plugin item
# copied from that plugin's builder; API producers are copied field-for-field
# from the dict literal in the handler named. If a producer gains a field, its
# case here should gain it too — `extra='forbid'` refuses anything undeclared,
# and since #249 a refusal dead-letters the message.

_NOW = '2026-01-05T10:00:00+00:00'


def _ingestor_message(item: dict, *, source_platform: str, brand: str = 'Acme') -> dict:
    """BaseIngestor.normalize_item, minus the S3 call: the archive succeeded."""
    from _shared.normalized_item import normalized_item_fields

    return {
        **normalized_item_fields(
            item,
            source_platform=item.get('source_platform_override') or source_platform,
            default_channel='unknown',
            brand_name=brand,
        ),
        's3_raw_uri': 's3://voc-raw/raw/x/2026/01/05/id.json',
        'raw_data': None,
    }


def _webscraper_item() -> dict:
    # webscraper/ingestor/handler.py::_scraped_item (CSS path: date is page text)
    return {
        'id': 'scraper_abc_123', 'channel': 'web_scrape', 'url': 'https://shop.example.com/r/1',
        'text': 'Great\n\nLoved it', 'title': 'Great', 'rating': 4, 'created_at': '3 days ago',
        'brand_handles_matched': ['Acme'], 'author': 'Jo', 'scraper_id': 'abc',
        'scraper_name': 'Acme Shop Reviews', 'domain': 'shop.example.com',
        'extraction_method': 'css', 'source_platform_override': 'Acme Shop Reviews',
    }


def _app_review_item(platform: str) -> dict:
    # app_reviews_{ios,android}/ingestor/handler.py::_format_review
    return {
        'id': f'{platform}-42', 'channel': f'app_review_{platform.lower()}', 'text': 'Crashes on start',
        'title': '', 'rating': 1, 'created_at': _NOW,
        'url': 'https://apps.apple.com/app/id123', 'author': 'Anonymous',
        'brand_handles_matched': ['Acme'], 'source_platform_override': f'MyApp_{platform}',
        'app_name': 'MyApp', 'app_identifier': '123', 'country': 'us',
    }


def _s3_import_item() -> dict:
    # s3_import/ingestor/handler.py::_normalize_row for a CSV with no date/url column
    return {
        'id': 's3-0123456789abcdef', 'channel': 'import', 'url': '', 'text': 'Imported row',
        'rating': 3.0, 'created_at': '', 'author': '', 'source_platform_override': 'S3 - surveys',
    }


def _synthetic_message() -> dict:
    # synthetic_reviews/ingestor/handler.py::_build_item + its normalize_item override
    item = {
        'id': 'synthetic-abc', 'text': 'Synthetic review', 'rating': 4.0, 'created_at': _NOW,
        'channel': 'review', 'author': 'Sam', 'title': 'Nice', 'language': 'en',
        'metadata': {'is_synthetic': True, 'generator': 'synthetic_reviews',
                     'generator_model': 'claude-sonnet-4-5', 'focus_area': 'general'},
    }
    message = _ingestor_message(item, source_platform='synthetic_reviews')
    for key in ('author', 'title', 'language', 'metadata'):
        message[key] = item[key]
    return message


def _github_webhook_message() -> dict:
    # BaseWebhook.normalize_item: default_channel='webhook', is_webhook, raw_data=item
    from _shared.normalized_item import normalized_item_fields

    item = {'id': 'o/r#7', 'text': 'Bug', 'created_at': None, 'url': 'https://github.com/o/r/issues/7',
            'channel': 'issue', 'title': 'Bug', 'author': 'octo',
            'issue_attributes': {'kind': 'issue', 'repo': 'o/r', 'number': 7, 'labels': ['bug']}}
    return {
        **normalized_item_fields(item, source_platform='github_issues', default_channel='webhook', brand_name=''),
        'is_webhook': True,
        'raw_data': item,
    }


def _manual_confirm_message() -> dict:
    # manual_import_handler.py::_confirmed_review_message
    return {
        'id': 'manual-job-1-0', 'source_platform': 'manual_import', 'source_origin': 'g2',
        'source_channel': 'g2', 'source_url': 'https://www.g2.com/products/x/reviews',
        'url': 'https://www.g2.com/products/x/reviews', 'ingestion_method': 'manual',
        'manual_import_job_id': 'job-1', 'text': 'Parsed review', 'rating': 5, 'author': None,
        'title': None, 'created_at': '2026-01-05', 's3_raw_uri': 's3://voc-raw/raw/manual/job-1.json',
    }


def _csv_upload_message() -> dict:
    # manual_import_handler.py::csv_upload `messages` comprehension
    return {
        'id': 'a' * 32, 'csv_row_id': None, 'source_platform': 'manual_import',
        'source_channel': 'csv_upload', 'ingestion_method': 'csv_upload', 'text': 'Row text',
        'rating': None, 'author': '', 'title': '', 'url': '', 'created_at': _NOW,
        's3_raw_uri': None,
    }


def _json_upload_message() -> dict:
    # manual_import_handler.py::_json_upload_message (flat metadata passed through)
    return {
        'id': 'ticket-1', 'source_platform': 'manual_import', 'source_channel': 'support',
        'ingestion_method': 'json_upload', 'text': 'Item text', 'rating': 2, 'author': 'u-1',
        'title': None, 'url': None, 'created_at': _NOW, 's3_raw_uri': None,
        'metadata': {'external_ticket': 'T-1'},
    }


def _feedback_form_message() -> dict:
    # feedback_form_handler.py::submit_form_feedback `normalized_record`, a form
    # with a 64-char id (FORM_ID_MAX_LENGTH), email + name collected, custom
    # fields answered, a numeric (1..10) rating and no preset category.
    form_id = 'f' * 64
    return {
        'id': '7b0c6c1e-0000-4000-8000-000000000000', 'source_platform': 'feedback_form',
        'source_channel': f'form_{form_id}', 'text': 'Love it', 'rating': 9,
        'created_at': _NOW, 'ingested_at': _NOW, 'brand_name': 'Acme',
        'url': 'https://www.example.com/pricing?' + 'q' * 2100,
        'preset_category': '', 'preset_subcategory': '',
        'metadata': {
            'form_id': form_id, 'form_name': 'NPS', 'form_version': '2.0',
            'submitter_email': 'a@example.com', 'submitter_name': 'A',
            'custom_fields': {'plan': 'pro', 'seats': 12, 'would_recommend': True, 'notes': None},
        },
    }


_PRODUCER_MESSAGES = {
    'webscraper': lambda: _ingestor_message(_webscraper_item(), source_platform='webscraper'),
    'app_reviews_ios': lambda: _ingestor_message(_app_review_item('iOS'), source_platform='app_reviews_ios'),
    'app_reviews_android': lambda: _ingestor_message(_app_review_item('Android'), source_platform='app_reviews_android'),
    's3_import': lambda: _ingestor_message(_s3_import_item(), source_platform='s3_import'),
    'synthetic_reviews': _synthetic_message,
    'github_issues_webhook': _github_webhook_message,
    'manual_import_confirm': _manual_confirm_message,
    'manual_import_csv_upload': _csv_upload_message,
    'manual_import_json_upload': _json_upload_message,
    'feedback_form_submit': _feedback_form_message,
}


class TestProducerShapes:
    """Every live producer's message validates, so enabling validation is not an outage."""

    @pytest.mark.parametrize('producer', sorted(_PRODUCER_MESSAGES))
    def test_the_producer_message_validates(self, producer):
        from shared.ingest_schemas import safe_validate_message

        message, errors = safe_validate_message(_PRODUCER_MESSAGES[producer]())

        assert errors == []
        assert message is not None

    def test_the_processor_still_sees_the_fields_it_reads(self):
        """Validation replaces the record the processor enriches, so a field the
        processor reads must survive the round trip (model_dump)."""
        from shared.ingest_schemas import validate_message

        form = validate_message(_feedback_form_message()).model_dump(mode='json', exclude_none=True)
        manual = validate_message(_manual_confirm_message()).model_dump(mode='json', exclude_none=True)

        assert form['preset_category'] == ''
        assert form['metadata']['custom_fields']['seats'] == 12
        assert manual['ingestion_method'] == 'manual'
        assert manual['manual_import_job_id'] == 'job-1'
