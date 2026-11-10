"""email_intake/compose.py: an inbox mail's channel and ``feedback_type`` (docs/email-intake.md).

Every type an alias or a subject tag forces must be a value of the built-in ``feedback_type``
dimension (shared/feedback_types.py); anything else would be dropped by the processor and
the mail would lose its type.
"""
import pytest

from email_intake.compose import SUBJECT_TAG_TYPES, channel_and_type
from shared.email_intake_settings import ALIASES
from shared.feedback_types import feedback_type_dimension

BUILTIN_TYPES = {value['name'] for value in feedback_type_dimension()['values']}


def test_every_subject_tag_forces_a_built_in_type():
    assert set(SUBJECT_TAG_TYPES.values()) <= BUILTIN_TYPES


def test_every_alias_forces_a_built_in_type_or_none():
    assert {forced for forced in ALIASES.values() if forced is not None} <= BUILTIN_TYPES


@pytest.mark.parametrize(('aliases', 'tags', 'expected'), [
    (['bugs'], [], ('bugs', 'bug')),
    (['ideas'], [], ('ideas', 'feature_request')),
    (['feedback'], [], ('feedback', None)),
    (['reviews'], [], ('reviews', None)),
    (['feedback'], ['praise'], ('feedback', 'praise')),
    (['bugs'], ['idea'], ('bugs', 'feature_request')),
    # `[review]` used to force a `review` type the built-in list does not have; it is no tag now.
    (['bugs'], ['review'], ('bugs', 'bug')),
    (['feedback'], ['review'], ('feedback', None)),
    ([], [], ('feedback', None)),
])
def test_a_tag_beats_the_alias_and_an_unknown_tag_leaves_the_alias(aliases, tags, expected):
    assert channel_and_type(aliases, tags) == expected
