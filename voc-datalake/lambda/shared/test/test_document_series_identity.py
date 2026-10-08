"""A document version series is (base title without type/version suffix, type).

Production QA: the project wizard titles a PRD and a PR/FAQ generated together
'X — PRD' / 'X — PR/FAQ', while a single PRD (wizard or the assistant's
generate_document tool) asks for plain 'X'. The allocator keyed the series on
the raw base title, so 'X' started a THIRD series ('X (v1)') next to
'X — PRD (v1)' instead of continuing as PRD v2.
"""

import hashlib

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared.document_versions import (
    normalize_document_versions,
    normalized_base_title,
    persist_versioned_document,
    version_partition_key,
)
from shared.test.moto_tables import create_projects_table_with_meta

# MIRRORED by SERIES_KEY_CASES in
# frontend/src/pages/ProjectDetail/generatedDocTitle.test.tsx — change both together.
SERIES_KEY_CASES = [
    ('X', 'prd', 'x'),
    ('X — PRD', 'prd', 'x'),
    ('X — PRD (v1)', 'prd', 'x'),
    ('X (v3)', 'prd', 'x'),
    ('x - prd', 'prd', 'x'),
    ('  X   —   PRD  ', 'prd', 'x'),
    ('X — PR/FAQ', 'prfaq', 'x'),
    ('X — PR/FAQ (v2)', 'prfaq', 'x'),
    ('X \u2013 PRFAQ', 'prfaq', 'x'),  # en dash
    ('X — PR/FAQ', 'prd', 'x — pr/faq'),
    ('X — PRD', 'prfaq', 'x — prd'),
    ('X — PRD', 'prototype', 'x — prd'),
    ('X — PRDs', 'prd', 'x — prds'),
    ('Checkout PRD', 'prd', 'checkout prd'),
    ('PRD', 'prd', 'prd'),
    ('PR/FAQ', 'prfaq', 'pr/faq'),
]


@pytest.mark.parametrize(('title', 'document_type', 'expected'), SERIES_KEY_CASES)
def test_series_key_strips_version_and_own_type_label(title, document_type, expected):
    assert normalized_base_title(title, document_type) == expected


@pytest.fixture
def projects_table():
    with mock_aws():
        yield create_projects_table_with_meta('test-projects')


def _fields(minute: int) -> dict:
    created_at = f'2026-10-06T10:{minute:02d}:00+00:00'
    return {
        'gsi1pk': 'PROJECT#p1#DOCUMENTS', 'gsi1sk': created_at,
        'content': '# doc', 'created_at': created_at,
    }


def _generate(table, document_type: str, title: str, job: str, minute: int) -> dict:
    return persist_versioned_document(table, 'p1', document_type, title, job, _fields(minute))


def _wizard_dual(table, title: str, minute: int) -> tuple[dict, dict]:
    """What the wizard requests for PRD + PR/FAQ generated together."""
    prd = _generate(table, 'prd', f'{title} — PRD', f'job-dual-prd-{minute}', minute)
    prfaq = _generate(table, 'prfaq', f'{title} — PR/FAQ', f'job-dual-prfaq-{minute}', minute)
    return prd, prfaq


def _versions(table, document_type: str) -> list[tuple[int, str]]:
    """(version, title) of the project's stored documents of *document_type*."""
    items = table.query(
        KeyConditionExpression=Key('pk').eq('PROJECT#p1')
        & Key('sk').begins_with(f'{document_type.upper()}#'),
    )['Items']
    return sorted((int(item['version']), item['title']) for item in items)


def test_dual_generation_then_single_prd_continues_the_prd_series(projects_table):
    prd_v1, prfaq_v1 = _wizard_dual(projects_table, 'Checkout', 0)

    prd_v2 = _generate(projects_table, 'prd', 'Checkout', 'job-single-prd', 5)

    assert (prd_v1['version'], prd_v1['title']) == (1, 'Checkout — PRD (v1)')
    assert (prd_v2['version'], prd_v2['title']) == (2, 'Checkout — PRD (v2)')
    assert prd_v2['base_title'] == prd_v1['base_title']
    assert _versions(projects_table, 'prfaq') == [(1, 'Checkout — PR/FAQ (v1)')]
    assert prfaq_v1['version'] == 1


def test_single_prd_then_dual_generation_continues_prd_and_starts_prfaq(projects_table):
    prd_v1 = _generate(projects_table, 'prd', 'Checkout', 'job-single-prd', 0)

    prd_v2, prfaq_v1 = _wizard_dual(projects_table, 'Checkout', 5)

    assert (prd_v1['version'], prd_v1['title']) == (1, 'Checkout (v1)')
    assert (prd_v2['version'], prd_v2['title']) == (2, 'Checkout (v2)')
    assert (prfaq_v1['version'], prfaq_v1['title']) == (1, 'Checkout — PR/FAQ (v1)')
    assert _versions(projects_table, 'prd') == [(1, 'Checkout (v1)'), (2, 'Checkout (v2)')]


def test_a_stored_legacy_type_suffixed_prd_is_the_plain_titles_series(projects_table):
    # A pre-versioning row: only its title carries the type label and the version.
    projects_table.put_item(Item={
        'pk': 'PROJECT#p1', 'sk': 'PRD#legacy', 'document_id': 'legacy',
        'document_type': 'prd', 'title': 'Checkout — PRD (v1)', 'created_at': '2026-01-01',
    })

    item = _generate(projects_table, 'prd', 'Checkout', 'job-new', 0)

    assert (item['version'], item['title']) == (2, 'Checkout — PRD (v2)')


def test_plain_and_type_suffixed_prds_read_as_one_series():
    documents = [
        {'sk': 'PRD#a', 'document_id': 'a', 'document_type': 'prd',
         'title': 'Checkout (v1)', 'created_at': '2026-01-01'},
        {'sk': 'PRD#b', 'document_id': 'b', 'document_type': 'prd',
         'title': 'Checkout — PRD (v1)', 'created_at': '2026-02-01'},
        {'sk': 'PRFAQ#c', 'document_id': 'c', 'document_type': 'prfaq',
         'title': 'Checkout — PR/FAQ (v1)', 'created_at': '2026-02-01'},
    ]

    read = normalize_document_versions(documents)

    assert [(doc['version'], doc['title']) for doc in read] == [
        (1, 'Checkout (v1)'), (2, 'Checkout (v2)'), (1, 'Checkout — PR/FAQ (v1)'),
    ]


def test_previously_split_series_continue_past_both_halves(projects_table):
    # Data written before the fix: two PRD series, each with its own v1 and counter.
    for sk, base, minute in (('PRD#plain', 'Checkout', 0), ('PRD#typed', 'Checkout — PRD', 1)):
        projects_table.put_item(Item={
            'pk': 'PROJECT#p1', 'sk': sk, 'document_id': sk[4:], 'document_type': 'prd',
            'base_title': base, 'version': 1, 'title': f'{base} (v1)',
            'created_at': _fields(minute)['created_at'],
        })
    # The plain series' counter (sk format of document_versions._counter_key).
    projects_table.put_item(Item={
        'pk': version_partition_key('p1'),
        'sk': f"PRD#{hashlib.sha256(b'checkout').hexdigest()}",
        'document_type': 'prd', 'base_title': 'Checkout',
        'normalized_base_title': 'checkout', 'last_version': 1,
    })

    item = _generate(projects_table, 'prd', 'Checkout', 'job-after-fix', 5)

    assert (item['version'], item['title']) == (3, 'Checkout (v3)')
