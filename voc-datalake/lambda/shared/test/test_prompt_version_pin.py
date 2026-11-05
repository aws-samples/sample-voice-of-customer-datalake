"""PROMPT_VERSION is pinned to the enrichment prompts (TENETS.md D2: an item says which prompt made it).

A change to any prompt the enrichment or a reprocess sends (the templates, the system prompt, the
category and dimension instructions) changes the digest below. Bump ``PROMPT_VERSION`` in
``shared/categorization.py`` and record the new pair in ``PINNED``: the old pair stays, so a
digest can never be re-used by a later version.
"""
import hashlib

from shared import categorization

#: version -> sha256 of the prompts at that version. Append only.
PINNED = {
    '2.0.0': '2744a4263b9c4ebd3a1be1bbc869bc127e91196844aa8ae0f24669cce2ed1c6c',
}

_CATEGORIES = [
    {'name': 'delivery', 'description': 'Shipping and arrival', 'subcategories': [{'name': 'late'}]},
    {'name': 'other'},
]
_DIMENSIONS = [
    {'key': 'product', 'label': 'Product', 'description': 'Which product', 'infer': True,
     'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'module', 'label': 'Module', 'infer': True, 'parent': 'product',
     'values': [{'name': 'checkout', 'parent_value': 'App'}, {'name': 'login'}]},
    {'key': 'region', 'label': 'Region', 'infer': False, 'values': [{'name': 'EU'}]},
]


def prompts_digest() -> str:
    parts = [
        categorization.SYSTEM_PROMPT,
        categorization.USER_PROMPT_TEMPLATE,
        categorization.CLASSIFY_PROMPT_TEMPLATE,
        categorization.CLASSIFY_DIMENSIONS_PROMPT_TEMPLATE,
        categorization.build_categories_instruction([]),
        categorization.build_categories_instruction(_CATEGORIES),
        categorization.build_dimensions_instruction(_DIMENSIONS),
    ]
    # An empty instruction would pin nothing: the fixture must exercise every builder.
    assert all(parts), 'a prompt part rendered empty; fix the fixture'
    return hashlib.sha256('\x00'.join(parts).encode('utf-8')).hexdigest()


def test_prompt_change_bumps_the_version():
    digest = prompts_digest()
    version = categorization.PROMPT_VERSION
    assert version in PINNED, f'PROMPT_VERSION {version} is not pinned; add it with digest {digest}'
    assert PINNED[version] == digest, (
        f'The enrichment prompts changed under PROMPT_VERSION {version}: bump it and pin {digest}')


def test_a_digest_belongs_to_one_version():
    assert len(set(PINNED.values())) == len(PINNED)
