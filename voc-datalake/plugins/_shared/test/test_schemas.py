"""Tests for schemas.py - Message validation schemas."""
import pytest
from datetime import datetime, timezone, timedelta


class TestIngestMessageValidation:
    """Tests for IngestMessage schema validation."""

    def test_accepts_valid_message_with_required_fields(self):
        """Validates message with all required fields."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Great product!',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        
        assert result.id == 'msg-123'
        assert result.source_platform == 'trustpilot'
        assert result.text == 'Great product!'

    def test_accepts_valid_message_with_optional_fields(self):
        """Validates message with optional fields."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-456',
            'source_platform': 'yelp',
            'text': 'Good service',
            'created_at': '2025-01-02T10:00:00Z',
            'rating': 4.5,
            'url': 'https://yelp.com/review/456',
            'author': 'John Doe',
            'title': 'Review Title',
        }
        
        result = validate_message(raw)
        
        assert result.rating == 4.5
        assert result.url == 'https://yelp.com/review/456'
        assert result.author == 'John Doe'
        assert result.title == 'Review Title'

    def test_rejects_message_without_id(self):
        """Raises error when id missing."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'source_platform': 'trustpilot',
            'text': 'Some text',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError) as exc_info:
            validate_message(raw)
        
        assert 'id' in str(exc_info.value)

    def test_rejects_message_without_text(self):
        """Raises error when text missing."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError) as exc_info:
            validate_message(raw)
        
        assert 'text' in str(exc_info.value)

    def test_rejects_empty_text(self):
        """Raises error when text is empty string."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': '',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_rejects_message_without_source_platform(self):
        """Raises error when source_platform missing."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'text': 'Some text',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError) as exc_info:
            validate_message(raw)
        
        assert 'source_platform' in str(exc_info.value)


class TestSourcePlatformValidation:
    """Tests for source_platform field validation."""

    def test_accepts_lowercase_alphanumeric_with_underscores(self):
        """Accepts valid source_platform format."""
        from _shared.schemas import validate_message
        
        for platform in ['trustpilot', 'google_reviews', 'appstore_apple', 's3_import']:
            raw = {
                'id': 'msg-123',
                'source_platform': platform,
                'text': 'Test',
                'created_at': '2025-01-01T12:00:00Z',
            }
            result = validate_message(raw)
            assert result.source_platform == platform

    def test_rejects_uppercase_source_platform(self):
        """Rejects source_platform with uppercase letters."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'TrustPilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_rejects_source_platform_starting_with_number(self):
        """Rejects source_platform starting with number."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': '123platform',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_rejects_source_platform_with_special_chars(self):
        """Rejects source_platform with special characters."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trust-pilot',  # hyphen not allowed
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)


class TestRatingValidation:
    """Tests for rating field validation."""

    def test_accepts_rating_between_1_and_5(self):
        """Accepts valid rating values."""
        from _shared.schemas import validate_message
        
        for rating in [1, 2, 3, 4, 5, 1.5, 4.5]:
            raw = {
                'id': 'msg-123',
                'source_platform': 'trustpilot',
                'text': 'Test',
                'created_at': '2025-01-01T12:00:00Z',
                'rating': rating,
            }
            result = validate_message(raw)
            assert result.rating == rating

    def test_rejects_rating_below_1(self):
        """Rejects rating less than 1."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'rating': 0,
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_rejects_rating_above_5(self):
        """Rejects rating greater than 5."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'rating': 6,
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_accepts_none_rating(self):
        """Accepts None/null rating."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'rating': None,
        }
        
        result = validate_message(raw)
        assert result.rating is None


class TestUrlValidation:
    """Tests for URL field validation."""

    def test_accepts_https_url(self):
        """Accepts valid HTTPS URL."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'https://trustpilot.com/review/123',
        }
        
        result = validate_message(raw)
        assert result.url == 'https://trustpilot.com/review/123'

    def test_accepts_http_url(self):
        """Accepts valid HTTP URL."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'http://example.com/review',
        }
        
        result = validate_message(raw)
        assert result.url == 'http://example.com/review'

    def test_rejects_invalid_url_scheme(self):
        """Rejects URL without http/https scheme."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'ftp://example.com/file',
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_accepts_empty_url_as_none(self):
        """Converts empty string URL to None."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'url': '',
        }
        
        result = validate_message(raw)
        assert result.url is None


class TestCreatedAtValidation:
    """Tests for created_at field validation."""

    def test_accepts_iso_datetime_with_z_suffix(self):
        """Accepts ISO datetime with Z timezone."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        assert result.created_at.year == 2025

    def test_accepts_iso_datetime_with_offset(self):
        """Accepts ISO datetime with timezone offset."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00+05:00',
        }
        
        result = validate_message(raw)
        assert result.created_at is not None

    def test_rejects_future_date_more_than_1_day(self):
        """Rejects created_at more than 1 day in future."""
        from _shared.schemas import validate_message, MessageValidationError
        
        future = datetime.now(timezone.utc) + timedelta(days=5)
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': future.isoformat(),
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_accepts_date_slightly_in_future(self):
        """Accepts created_at within 1 day tolerance."""
        from _shared.schemas import validate_message
        
        # 12 hours in future should be OK
        future = datetime.now(timezone.utc) + timedelta(hours=12)
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': future.isoformat(),
        }
        
        result = validate_message(raw)
        assert result.created_at is not None


class TestTextSanitization:
    """Tests for text field sanitization."""

    def test_removes_control_characters(self):
        """Strips control characters from text."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Hello\x00World\x1fTest',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        assert '\x00' not in result.text
        assert '\x1f' not in result.text
        assert 'HelloWorldTest' == result.text

    def test_preserves_newlines_and_tabs(self):
        """Keeps newlines and tabs in text."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Line 1\nLine 2\tTabbed',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        assert '\n' in result.text
        assert '\t' in result.text

    def test_normalizes_excessive_newlines(self):
        """Reduces multiple consecutive newlines to double."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Para 1\n\n\n\n\nPara 2',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        assert '\n\n\n' not in result.text
        assert 'Para 1\n\nPara 2' == result.text

    def test_strips_leading_trailing_whitespace(self):
        """Removes leading/trailing whitespace from text."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': '   Trimmed text   ',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        result = validate_message(raw)
        assert result.text == 'Trimmed text'


class TestMetadataValidation:
    """Tests for metadata field validation."""

    def test_accepts_flat_metadata_with_primitives(self):
        """Accepts metadata with string, number, boolean values."""
        from _shared.schemas import validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'metadata': {
                'is_verified': True,
                'like_count': 42,
                'location_id': 'loc-123',
            }
        }
        
        result = validate_message(raw)
        assert result.metadata.is_verified is True
        assert result.metadata.like_count == 42

    def test_rejects_nested_objects_in_metadata(self):
        """Rejects metadata with nested objects."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'metadata': {
                'nested': {'key': 'value'}  # Not allowed
            }
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)

    def test_rejects_arrays_in_metadata(self):
        """Rejects metadata with array values."""
        from _shared.schemas import validate_message, MessageValidationError
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Test',
            'created_at': '2025-01-01T12:00:00Z',
            'metadata': {
                'tags': ['tag1', 'tag2']  # Not allowed
            }
        }
        
        with pytest.raises(MessageValidationError):
            validate_message(raw)


class TestSafeValidateMessage:
    """Tests for safe_validate_message() function."""

    def test_returns_message_and_empty_errors_on_success(self):
        """Returns (message, []) for valid input."""
        from _shared.schemas import safe_validate_message
        
        raw = {
            'id': 'msg-123',
            'source_platform': 'trustpilot',
            'text': 'Valid message',
            'created_at': '2025-01-01T12:00:00Z',
        }
        
        message, errors = safe_validate_message(raw)
        
        assert message is not None
        assert message.id == 'msg-123'
        assert errors == []

    def test_returns_none_and_errors_on_failure(self):
        """Returns (None, errors) for invalid input."""
        from _shared.schemas import safe_validate_message
        
        raw = {
            'id': 'msg-123',
            # Missing required fields
        }
        
        message, errors = safe_validate_message(raw)
        
        assert message is None
        assert len(errors) > 0
        assert any('source_platform' in e for e in errors)
