"""`shared/pii_redaction.py`: pattern + optional Comprehend redaction of feedback text."""
from unittest.mock import MagicMock, patch

import pytest

from shared import pii_redaction
from shared.pii_redaction import RedactionResult, redact_text


@pytest.fixture(autouse=True)
def _fresh_client():
    pii_redaction._comprehend_client.clear()
    yield
    pii_redaction._comprehend_client.clear()


@pytest.mark.parametrize(('text', 'expected'), [
    ('mail me at jane.doe+x@example.co.uk now', 'mail me at [EMAIL] now'),
    ('Contact: Max.Mustermann@firma.de.', 'Contact: [EMAIL].'),
])
def test_emails_are_replaced(text, expected):
    assert redact_text(text).text == expected


@pytest.mark.parametrize('phone', [
    '+49 30 12345678', '030 12345678', '0171 1234567', '+49 (0)30 1234567',  # DE
    '01 23 45 67 89', '06.12.34.56.78', '+33 1 23 45 67 89',  # FR
    '612 345 678', '+34 912 345 678', '+34912345678',  # ES
    '(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567',  # US
    '+44 20 7946 0958', '020 7946 0958',  # UK
])
def test_phone_formats_are_replaced(phone):
    result = redact_text(f'Call me on {phone} please')
    assert result.text == 'Call me on [PHONE] please'
    assert result.counts == {'PHONE': 1}


@pytest.mark.parametrize('iban', [
    'DE89 3704 0044 0532 0130 00', 'DE89370400440532013000',
    'FR14 2004 1010 0505 0001 3M02 606', 'ES91 2100 0418 4502 0005 1332',
    'GB29 NWBK 6016 1331 9268 19',
])
def test_valid_ibans_are_replaced(iban):
    result = redact_text(f'IBAN {iban} thanks')
    assert result.text == 'IBAN [IBAN] thanks'
    assert result.counts == {'IBAN': 1}


def test_an_iban_with_a_wrong_checksum_is_kept():
    assert redact_text('ref DE00 3704 0044 0532 0130 00').counts.get('IBAN') is None


@pytest.mark.parametrize('card', ['4111 1111 1111 1111', '4111-1111-1111-1111', '5500005555555559', '378282246310005'])
def test_luhn_valid_card_numbers_are_replaced(card):
    result = redact_text(f'my card {card}.')
    assert result.text == 'my card [CARD].'
    assert result.counts == {'CARD': 1}


@pytest.mark.parametrize('address', ['192.168.1.20', '10.0.0.1', '2001:db8::8a2e:370:7334', '::ffff:10.0.0.1'])
def test_ip_addresses_are_replaced(address):
    assert redact_text(f'from {address} today').text == 'from [IP] today'


@pytest.mark.parametrize('text', [
    'on 2024-01-15 at 10:30:00', '15.01.2024', '01/15/2024', '2024-01-15T10:30:00Z',
    'version 1.2.3', 'v2.10.0', 'release 3.03.00', 'build 20240115',
    'order 12345678', 'order #123456789012', 'ORD-2024-000123', 'ticket 4111111111111112',
    'id 1234567890', 'std::vector', 'rated 4.5 out of 5', 'costs 1,299.00 EUR', '300.000 users',
])
def test_dates_versions_and_ids_survive(text):
    result = redact_text(text)
    assert result == RedactionResult(text, {})
    assert result.redacted is False


def test_counts_every_kind_and_redacted_is_true():
    result = redact_text('a@b.io, b@c.io, +49 30 12345678, 4111 1111 1111 1111, 10.0.0.1')
    assert result.counts == {'EMAIL': 2, 'PHONE': 1, 'CARD': 1, 'IP': 1}
    assert result.redacted is True


@pytest.mark.parametrize('text', [None, ''])
def test_empty_input_gives_empty_text(text):
    assert redact_text(text) == RedactionResult('', {})


def test_a_pattern_failure_withholds_the_text():
    with patch.object(pii_redaction, '_redact_patterns', side_effect=RuntimeError('boom')):
        assert redact_text('secret a@b.io') == RedactionResult('[withheld]', {'WITHHELD': 1})


def _client(entities):
    client = MagicMock()
    client.detect_pii_entities.return_value = {'Entities': entities}
    return client


def test_comprehend_is_off_without_the_flag(monkeypatch):
    monkeypatch.delenv('PII_COMPREHEND', raising=False)
    with patch.object(pii_redaction.boto3, 'client') as factory:
        assert redact_text('Jane Doe wrote', 'en').text == 'Jane Doe wrote'
    factory.assert_not_called()


@pytest.mark.parametrize('language', [None, 'de', 'fr', 'pt-BR'])
def test_comprehend_skips_unsupported_or_unknown_languages(monkeypatch, language):
    monkeypatch.setenv('PII_COMPREHEND', '1')
    with patch.object(pii_redaction.boto3, 'client') as factory:
        assert redact_text('Jane Doe wrote', language).text == 'Jane Doe wrote'
    factory.assert_not_called()


def test_comprehend_names_and_addresses_replace_after_patterns(monkeypatch):
    monkeypatch.setenv('PII_COMPREHEND', '1')
    text = 'Jane Doe at 1 Main St, a@b.io'
    # Offsets refer to the pattern-redacted text: 'Jane Doe at 1 Main St, [EMAIL]'.
    client = _client([
        {'Type': 'NAME', 'BeginOffset': 0, 'EndOffset': 8, 'Score': 0.99},
        {'Type': 'ADDRESS', 'BeginOffset': 12, 'EndOffset': 21, 'Score': 0.9},
        {'Type': 'NAME', 'BeginOffset': 2, 'EndOffset': 6, 'Score': 0.99},  # overlaps, dropped
        {'Type': 'AGE', 'BeginOffset': 0, 'EndOffset': 4, 'Score': 0.99},  # not redacted here
        {'Type': 'NAME', 'BeginOffset': 23, 'EndOffset': 30, 'Score': 0.2},  # low score
    ])
    with patch.object(pii_redaction.boto3, 'client', return_value=client):
        result = redact_text(text, 'en-US')
    assert result.text == '[NAME] at [ADDRESS], [EMAIL]'
    assert result.counts == {'EMAIL': 1, 'NAME': 1, 'ADDRESS': 1}
    client.detect_pii_entities.assert_called_once_with(Text='Jane Doe at 1 Main St, [EMAIL]', LanguageCode='en')


def test_comprehend_failure_keeps_the_pattern_result_and_counts_a_metric(monkeypatch):
    monkeypatch.setenv('PII_COMPREHEND', '1')
    client = MagicMock()
    client.detect_pii_entities.side_effect = RuntimeError('throttled')
    with patch.object(pii_redaction.boto3, 'client', return_value=client), \
            patch.object(pii_redaction.metrics, 'add_metric') as add_metric:
        result = redact_text('Juan Pérez, juan@example.es', 'es')
    assert result == RedactionResult('Juan Pérez, [EMAIL]', {'EMAIL': 1})
    add_metric.assert_called_once_with(name='PiiComprehendFailures', unit='Count', value=1)


def test_comprehend_is_skipped_for_text_over_its_byte_limit(monkeypatch):
    monkeypatch.setenv('PII_COMPREHEND', '1')
    with patch.object(pii_redaction.boto3, 'client') as factory:
        assert redact_text('é' * 60_000, 'es').text == 'é' * 60_000
    factory.assert_not_called()


def test_comprehend_client_is_built_once(monkeypatch):
    monkeypatch.setenv('PII_COMPREHEND', '1')
    with patch.object(pii_redaction.boto3, 'client', return_value=_client([])) as factory:
        redact_text('one', 'en')
        redact_text('two', 'en')
    factory.assert_called_once_with('comprehend')
