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
    '2.0.0': '6a10d104f0931ad23371a2f452957f9977e508bddd147cfe06a05833941e911e',
}

_CATEGORIES = [
    {'name': 'delivery', 'description': 'Shipping and arrival', 'subcategories': [{'name': 'late'}]},
    {'name': 'other'},
]
_DIMENSIONS = [
    {'key': 'channel_kind', 'label': 'Channel kind', 'description': 'Where the customer wrote from', 'infer': True,
     'values': [{'name': 'Mobile'}, {'name': 'Desktop'}]},
    {'key': 'flow', 'label': 'Flow', 'infer': True, 'parent': 'channel_kind',
     'values': [{'name': 'booking', 'parent_value': 'Mobile'}, {'name': 'check-in'}]},
    {'key': 'market', 'label': 'Market', 'infer': False, 'values': [{'name': 'EU'}]},
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
