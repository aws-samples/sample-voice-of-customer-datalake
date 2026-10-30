"""The CSV content digest under a source's PII policy (issue #411 security review).

Under ``redact`` / ``summary_only`` the digest covers only what the source policy stores,
so it can never confirm a guess of withheld PII; under ``allow`` it is unchanged.
"""
import pytest

from shared.csv_content_digest import csv_row_digest
from shared.csv_datasets import csv_content_hash

ALLOW = {'id': 'manual_import', 'pii': 'allow'}


def _fields(**extra) -> dict:
    return {'text': 'the app crashes', 'rating': 2.0, 'created_at': '2026-01-15', 'author': 'Ann',
            'title': 'Crash', 'url': None, 'channel': 'csv_upload', 'metadata': {}, **extra}


def test_an_allow_source_keeps_the_original_recipe():
    assert csv_row_digest(_fields(), ALLOW) == csv_content_hash(_fields())
    assert csv_row_digest(_fields(), {}) == csv_content_hash(_fields())


@pytest.mark.parametrize('pii', ['redact', 'summary_only'])
def test_a_guess_of_withheld_pii_cannot_be_confirmed_against_the_digest(pii):
    """Two rows that differ only in redacted PII share a digest: it reveals nothing about it."""
    profile = {'pii': pii}
    real = csv_row_digest(_fields(text='mail me at ann@example.com', author='Ann'), profile)
    guess = csv_row_digest(_fields(text='mail me at bob@example.com', author='Bob'), profile)
    assert real == guess
    assert real != csv_content_hash(_fields(text='mail me at ann@example.com', author='Ann'))


@pytest.mark.parametrize('pii', ['redact', 'summary_only'])
def test_a_change_to_what_is_stored_still_changes_the_digest(pii):
    profile = {'pii': pii}
    base = csv_row_digest(_fields(), profile)
    assert csv_row_digest(_fields(text='the app freezes'), profile) != base
    assert csv_row_digest(_fields(rating=5.0), profile) != base
    assert csv_row_digest(_fields(title='Freeze'), profile) != base


def test_the_policed_digest_never_equals_the_allow_digest_of_the_same_values():
    """A distinct version tag: a row moved between policies reads as changed, never as a false match."""
    no_pii = _fields(author=None)
    assert csv_row_digest(no_pii, {'pii': 'redact'}) != csv_row_digest(no_pii, ALLOW)
