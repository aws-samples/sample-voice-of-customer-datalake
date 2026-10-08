"""`shared/source_policy.py`: the per-source PII policy applied before archive and queue."""
from unittest.mock import patch

import pytest

from shared import source_policy
from shared.ingest_schemas import IngestMessage
from shared.source_policy import (
    ARCHIVE_FILE,
    ARCHIVE_ITEM,
    ARCHIVE_NONE,
    apply_source_policy,
    archive_mode,
    policy_message,
    raw_archive_allowed,
)
from shared.source_profiles import profile_for


def _profile(**overrides):
    return {**profile_for([], 'support_tickets'), **overrides}


def _message(**overrides):
    return {
        'id': 'm1', 'source_platform': 'support_tickets', 'created_at': '2026-01-15T10:00:00+00:00',
        'text': 'Jane here, write to jane@example.com or call +49 30 12345678',
        'title': 'Refund to DE89 3704 0044 0532 0130 00', 'author': 'Jane Doe',
        'metadata': {'email': 'jane@example.com', 'author_image': 'https://x/jane.png', 'plan': 'pro',
                     'seats': 5, 'custom_fields': {'phone': '+33 1 23 45 67 89', 'score': 9}},
        'raw_data': {'whole': 'payload'}, 's3_raw_uri': 's3://b/raw/x.json',
        **overrides,
    }


def test_allow_passes_the_message_through_and_marks_it():
    message = _message()
    out = apply_source_policy(message, _profile())
    assert out == {**message, 'pii_policy_applied': 'allow'}
    assert 'pii_policy_applied' not in message


@pytest.mark.parametrize('pii', ['redact', 'summary_only'])
def test_non_allow_redacts_text_title_metadata_and_drops_author(pii):
    out = apply_source_policy(_message(), _profile(pii=pii))
    assert out is not None
    assert out['text'] == 'Jane here, write to [EMAIL] or call [PHONE]'
    assert out['title'] == 'Refund to [IBAN]'
    assert out['metadata'] == {'email': '[EMAIL]', 'plan': 'pro', 'seats': 5,
                               'custom_fields': {'phone': '[PHONE]', 'score': 9}}
    assert out['pii_policy_applied'] == pii


def test_redact_reaches_urls_nested_metadata_and_lists():
    out = apply_source_policy(_message(
        url='https://shop.example/track?email=jane@example.com&id=7',
        source_url='https://help.example/t/1?phone=+49 30 12345678',
        metadata={'custom_fields': {'contact': {'mail': 'jane@example.com'}, 'cc': ['a@b.io', 'plain', 3]},
                  'author_name': 'Jane'}), _profile(pii='redact'))
    assert out is not None
    assert out['url'] == 'https://shop.example/track?email=[EMAIL]&id=7'
    assert '12345678' not in out['source_url']
    assert out['metadata'] == {'custom_fields': {'contact': {'mail': '[EMAIL]'}, 'cc': ['[EMAIL]', 'plain', 3]}}


def test_allow_keeps_urls_and_metadata_but_lower_cases_erasable_emails():
    out = apply_source_policy(_message(metadata={'email': ' Jane@Example.COM', 'submitter_email': 'A@B.io',
                                                 'note': 'Keep Case'}), _profile())
    assert out is not None
    assert out['metadata'] == {'email': 'jane@example.com', 'submitter_email': 'a@b.io', 'note': 'Keep Case'}


@pytest.mark.parametrize('field', ['author', 'raw_data', 's3_raw_uri'])
def test_non_allow_drops_author_and_raw_payload(field):
    out = apply_source_policy(_message(), _profile(pii='redact'))
    assert out is not None
    assert field not in out


def test_redacted_message_is_still_a_valid_queue_message():
    out = apply_source_policy(_message(), _profile(pii='redact'))
    assert out is not None
    assert IngestMessage.model_validate(out).pii_policy_applied == 'redact'


def test_redaction_rebounds_values_a_placeholder_lengthened():
    text = 'a@b.io ' * 7_143  # 50,001 chars, each address grows by one
    out = apply_source_policy(_message(text=text[:50_000], title=('x@y.io ' * 72)[:500]), _profile(pii='redact'))
    assert out is not None
    assert len(out['text']) == 50_000
    assert len(out['title']) == 500


def test_unknown_pii_value_is_treated_as_allow():
    out = apply_source_policy(_message(), _profile(pii='bogus'))
    assert out is not None
    assert out['pii_policy_applied'] == 'allow'


@pytest.mark.parametrize('text', ['', '   ', None])
def test_a_redact_message_without_text_is_not_sent(text):
    assert apply_source_policy(_message(text=text), _profile(pii='redact')) is None


def test_an_allow_message_without_text_still_passes():
    assert apply_source_policy({'id': 'x'}, _profile()) == {'id': 'x', 'pii_policy_applied': 'allow'}


def test_language_is_passed_to_the_redactor():
    with patch.object(source_policy, 'redact_text', wraps=source_policy.redact_text) as redact:
        apply_source_policy(_message(language='es', metadata=None, title=None), _profile(pii='redact'))
    redact.assert_called_once_with(_message()['text'], 'es')


@pytest.mark.parametrize(('profile', 'mode', 'allowed'), [
    (_profile(), ARCHIVE_FILE, True),
    (_profile(retention_days=365), ARCHIVE_ITEM, True),
    (_profile(pii='redact'), ARCHIVE_NONE, False),
    (_profile(pii='summary_only', retention_days=30), ARCHIVE_NONE, False),
])
def test_archive_mode(profile, mode, allowed):
    assert (archive_mode(profile), raw_archive_allowed(profile)) == (mode, allowed)


def test_policy_message_uses_the_cached_profile_of_the_source():
    with patch.object(source_policy, 'cached_source_profile_strict', return_value=_profile(pii='redact')) as cached:
        out, profile = policy_message(_message())
    cached.assert_called_once_with('support_tickets')
    assert (out or {}).get('pii_policy_applied') == 'redact'
    assert profile['pii'] == 'redact'


def test_policy_message_reports_a_skipped_message():
    with patch.object(source_policy, 'cached_source_profile_strict', return_value=_profile(pii='redact')):
        out, _profile_used = policy_message(_message(text=''))
    assert out is None
