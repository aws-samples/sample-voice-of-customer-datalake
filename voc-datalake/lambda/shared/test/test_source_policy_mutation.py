"""Mutation hardening for `shared/source_policy.py`.

`test_source_policy.py` pins the redaction itself, but a mutation run found what it
could not see:

* the archive-mode VALUES. Callers compare against the constants, so a renamed
  constant passed every test; `archive_mode` documents ``none``/``item``/``file``.
* three of the five author metadata keys (`author_url`, `username`,
  `submitter_name`) were never sent, so dropping one from the set went unnoticed.
* the `PiiPolicyApplied` metric (name and value) and the skip warning (wording and
  its `source_platform` key) — operators alarm and search on both.
* a message with no `source_platform` looks up the profile of `''`.

It also showed the `[withheld]` fallback for an empty redacted text was dead: the
text is checked non-blank first and a placeholder is never empty. It was deleted.
"""
from unittest.mock import MagicMock, patch

import pytest

from shared import source_policy
from shared.source_policy import apply_source_policy, archive_mode, policy_message
from shared.source_profiles import profile_for


def _profile(**overrides: object) -> dict:
    return {**profile_for([], 'support_tickets'), **overrides}


class TestArchiveModeValues:
    @pytest.mark.parametrize(('profile', 'mode'), [
        (_profile(), 'file'),
        (_profile(retention_days=7), 'item'),
        (_profile(pii='redact'), 'none'),
    ])
    def test_the_documented_strings(self, profile: dict, mode: str) -> None:
        assert archive_mode(profile) == mode


class TestEveryAuthorMetadataKeyIsDropped:
    @pytest.mark.parametrize('key', ['author_image', 'author_name', 'author_url', 'username', 'submitter_name'])
    def test_key(self, key: str) -> None:
        out = apply_source_policy({'text': 'hello', 'metadata': {key: 'Jane', 'plan': 'pro'}}, _profile(pii='redact'))
        assert out == {'text': 'hello', 'metadata': {'plan': 'pro'}, 'pii_policy_applied': 'redact'}


class TestObservability:
    def test_a_redacted_message_counts_one_metric(self) -> None:
        metrics = MagicMock()
        with patch.object(source_policy, 'metrics', metrics):
            apply_source_policy({'text': 'hello'}, _profile(pii='summary_only'))
        metrics.add_metric.assert_called_once_with(name='PiiPolicyApplied', unit='Count', value=1)

    def test_an_allowed_message_counts_no_metric(self) -> None:
        metrics = MagicMock()
        with patch.object(source_policy, 'metrics', metrics):
            apply_source_policy({'text': 'hello'}, _profile())
        assert metrics.add_metric.call_args_list == []

    def test_a_skipped_message_is_logged_with_its_source(self) -> None:
        logger = MagicMock()
        with patch.object(source_policy, 'cached_source_profile_strict', return_value=_profile(pii='redact')), \
                patch.object(source_policy, 'logger', logger):
            assert policy_message({'source_platform': 'support_tickets', 'text': ' '}) == (None, _profile(pii='redact'))
        logger.warning.assert_called_once_with(
            'Message without text skipped by the source policy', extra={'source_platform': 'support_tickets'})

    def test_a_sent_message_logs_nothing(self) -> None:
        logger = MagicMock()
        with patch.object(source_policy, 'cached_source_profile_strict', return_value=_profile()), \
                patch.object(source_policy, 'logger', logger):
            out, _ = policy_message({'source_platform': 'support_tickets', 'text': 'hi'})
        assert out == {'source_platform': 'support_tickets', 'text': 'hi', 'pii_policy_applied': 'allow'}
        assert logger.warning.call_args_list == []


def test_a_message_without_a_source_looks_up_the_empty_id() -> None:
    cached = MagicMock(return_value=_profile())
    with patch.object(source_policy, 'cached_source_profile_strict', cached):
        policy_message({'text': 'hi'})
    cached.assert_called_once_with('')
