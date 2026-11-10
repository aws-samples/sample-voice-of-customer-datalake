"""Mutation hardening for `shared/pii_redaction.py`.

`test_pii_redaction.py` pins the placeholder for every kind of personal data in
its common shapes, but a mutation run found what it cannot see:

* both sides of every numeric bound: 8 and 15 phone digits (7 and 16 kept), 9
  digits after a trunk ``0`` or a ``(`` (8 kept), 4 IPv6 hex digits (3 kept),
  a 15- and a 34-character IBAN (a 14- and a 35-character one with a valid
  checksum kept) and the 100,000-byte Comprehend limit;
* the Comprehend entity filter one condition at a time: a missing score, a
  score of exactly 0.5, an empty or end-of-text span, adjacent and partly
  overlapping spans, an entity that is skipped BEFORE a valid one (a ``break``
  would drop the rest) and text before the first entity;
* the log line a withheld text leaves, and that the result is frozen (the
  Comprehend-failure log line is pinned in `test_pii_redaction.py`).
"""
import dataclasses
from unittest.mock import MagicMock, patch

import pytest

from shared import pii_redaction
from shared.pii_redaction import RedactionResult, redact_text

# Valid mod-97 checksums, built for the bounds (real IBANs are 15-34 characters).
IBAN_15 = 'NO9386011117947'
IBAN_34 = 'DE8212345678901234567890123456789A'
CHECKSUM_OK_14 = 'DE791234567890'
CHECKSUM_OK_35 = 'DE7112345678901234567890123456789AB'


@pytest.fixture(autouse=True)
def _fresh_client():
    pii_redaction._comprehend_client.clear()
    yield
    pii_redaction._comprehend_client.clear()


def _entity(kind: str, begin: object, end: object, score: object = 0.9) -> dict:
    return {'Type': kind, 'BeginOffset': begin, 'EndOffset': end, 'Score': score}


def _with_comprehend(monkeypatch: pytest.MonkeyPatch, text: str, entities: list[dict]) -> tuple[RedactionResult, MagicMock]:
    monkeypatch.setenv('PII_COMPREHEND', '1')
    client = MagicMock()
    client.detect_pii_entities.return_value = {'Entities': entities}
    with patch.object(pii_redaction.boto3, 'client', return_value=client):
        return redact_text(text, 'en'), client


class TestPhoneDigitBounds:
    @pytest.mark.parametrize('phone', [
        '+49 301 234',  # 8 digits, the minimum
        '+491234567890123',  # 15 digits, the maximum
        '(555) 123-456',  # 9 digits after "("
        '030 123 456',  # 9 digits after a trunk 0
    ])
    def test_the_bound_itself_is_a_phone(self, phone):
        assert redact_text(f'Call {phone} now') == RedactionResult('Call [PHONE] now', {'PHONE': 1})

    @pytest.mark.parametrize('text', [
        '+4930123',  # 7 digits
        '+4912345678901234',  # 16 digits
        '(55) 123-456',  # 8 digits after "("
        '0301 2345',  # 8 digits after a trunk 0
        '030123456',  # trunk 0, 9 digits, no separator: an id
        '0301234567',
    ])
    def test_one_past_the_bound_is_kept(self, text):
        assert redact_text(f'Call {text} now') == RedactionResult(f'Call {text} now', {})


class TestIbanLengthBounds:
    @pytest.mark.parametrize('iban', [IBAN_15, IBAN_34])
    def test_the_shortest_and_longest_iban_are_replaced(self, iban):
        assert redact_text(f'IBAN {iban} ok') == RedactionResult('IBAN [IBAN] ok', {'IBAN': 1})

    @pytest.mark.parametrize('candidate', [CHECKSUM_OK_14, CHECKSUM_OK_35])
    def test_a_valid_checksum_outside_the_lengths_is_kept(self, candidate):
        assert redact_text(f'IBAN {candidate} ok') == RedactionResult(f'IBAN {candidate} ok', {})


class TestIpv6HexDigitBound:
    def test_four_hex_digits_are_an_address(self):
        assert redact_text('from 1:2::3:4 x') == RedactionResult('from [IP] x', {'IP': 1})

    def test_three_hex_digits_are_kept(self):
        assert redact_text('from 1::2:3 x') == RedactionResult('from 1::2:3 x', {})


class TestComprehendByteLimit:
    def test_exactly_the_limit_is_sent(self, monkeypatch):
        text = 'a' * 100_000
        result, client = _with_comprehend(monkeypatch, text, [])
        assert result == RedactionResult(text, {})
        client.detect_pii_entities.assert_called_once_with(Text=text, LanguageCode='en')

    def test_one_byte_over_is_not_sent(self, monkeypatch):
        text = 'a' * 100_001
        result, client = _with_comprehend(monkeypatch, text, [])
        assert result == RedactionResult(text, {})
        client.detect_pii_entities.assert_not_called()


class TestEntityFilter:
    TEXT = 'Hi Jane and Bob'  # Jane = 3..7, Bob = 12..15 (the end of the text)

    @pytest.mark.parametrize('skipped', [
        _entity('AGE', 0, 2),  # not a redacted type, offsets valid
        _entity('NAME', None, 2),  # begin not an int
        _entity('NAME', 0, '2'),  # end not an int
        {'Type': 'NAME', 'BeginOffset': 0, 'EndOffset': 2},  # no score
        _entity('NAME', 0, 2, 0.49),
        _entity('NAME', 2, 2),  # empty span
        _entity('NAME', 13, 16),  # past the end
    ])
    def test_a_skipped_entity_before_a_valid_one_does_not_stop_the_scan(self, monkeypatch, skipped):
        result, _ = _with_comprehend(monkeypatch, self.TEXT, [skipped, _entity('NAME', 3, 7)])
        assert result == RedactionResult('Hi [NAME] and Bob', {'NAME': 1})

    def test_a_score_of_exactly_half_and_a_span_ending_the_text_are_kept(self, monkeypatch):
        result, _ = _with_comprehend(monkeypatch, self.TEXT, [_entity('NAME', 12, 15, 0.5)])
        assert result == RedactionResult('Hi Jane and [NAME]', {'NAME': 1})

    def test_adjacent_spans_are_both_replaced(self, monkeypatch):
        result, _ = _with_comprehend(monkeypatch, 'JaneDoe', [_entity('NAME', 0, 4), _entity('NAME', 4, 7)])
        assert result == RedactionResult('[NAME][NAME]', {'NAME': 2})

    def test_a_span_starting_inside_an_earlier_one_is_dropped(self, monkeypatch):
        result, _ = _with_comprehend(monkeypatch, self.TEXT, [_entity('NAME', 3, 7), _entity('ADDRESS', 5, 11)])
        assert result == RedactionResult('Hi [NAME] and Bob', {'NAME': 1})


class TestLogLines:
    def test_a_pattern_failure_logs_that_the_text_is_withheld(self):
        with patch.object(pii_redaction, '_redact_patterns', side_effect=RuntimeError('boom')), \
                patch.object(pii_redaction.logger, 'exception') as log:
            redact_text('secret')
        log.assert_called_once_with('Pattern PII redaction failed; withholding the text')


def test_the_result_is_frozen():
    result = redact_text('nothing here')
    field_name = 'text'
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(result, field_name, 'changed')
