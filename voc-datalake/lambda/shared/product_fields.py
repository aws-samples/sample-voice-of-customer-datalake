"""The product context's fields: the one place Python spells them (docs/project-workspace.md → Product tab).

``api/product_context.py`` (its routes, the PRD / PR-FAQ block) imports them from here, and so may any shared module
that reads or writes the product context (7.104.00: an extract's prompt and its validation, a proposal's accept).
Shared code cannot import ``product_context`` itself: the API bundle imports it as ``product_context`` and the job
bundles as ``api.product_context``.

The TypeScript side is ``lambda/stream/src/assistant/tools/client/allowlists.ts`` (``PRODUCT_CONTEXT_STRING_FIELDS``
and ``LIFECYCLE_STATES``), which the assistant's card, the plan contract and the Product tab's form read;
``shared/test/test_product_fields.py`` pins the two against each other.

IMPORTS NOTHING but the standard library, so any bundle can read the field list.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Final

__all__ = [
    'ALL_FIELDS', 'CURRENT_STATE', 'FIELD_LABELS', 'LIFECYCLE_STATES', 'MAX_QUESTION_CHARS', 'STRING_FIELDS',
    'clean_patch_value',
]

#: Free-text fields, each with its character cap. There are no list fields: a list
#: reads as a file-list control in the UI, and a textarea is clearer for descriptive prose; a record written under the
#: old list schema is joined into a string on read (shared/product_proposals.py ``context_state``, the one reader).
#: ``product_summary`` ("What the product does", 7.104.00) is the paragraph an extract proposes from the sources; a
#: person edits it like any other field, and it is written only when someone accepts it.
STRING_FIELDS: Final = MappingProxyType({
    'product_name': 200,
    'one_liner': 200,
    'product_summary': 3000,
    'target_users': 1000,
    'problem_solved': 2000,
    'key_features': 2000,
    'differentiators': 2000,
    'known_limitations': 2000,
    'non_goals': 2000,
    'success_metrics': 2000,
    'free_form_notes': 4000,
})

#: The single-choice field and its values, in lifecycle order.
CURRENT_STATE: Final = 'current_state'
LIFECYCLE_STATES: Final = ('idea', 'mvp', 'beta', 'ga', 'mature')

#: Every field of the product context: the 11 text fields and ``current_state``.
ALL_FIELDS: Final = frozenset(STRING_FIELDS) | {CURRENT_STATE}

#: Each field and the label the PRD / PR-FAQ block gives it (api/product_context.py ``build_product_context_block``),
#: in the block's order. A field left empty is left out of the block, so a project without a summary reads as before.
FIELD_LABELS: Final = (
    ('product_name', 'Product'),
    ('one_liner', 'One-liner'),
    ('product_summary', 'What it does'),
    (CURRENT_STATE, 'Current state'),
    ('target_users', 'Target users'),
    ('problem_solved', 'Problem solved'),
    ('key_features', 'Key features'),
    ('differentiators', 'Differentiators'),
    ('known_limitations', 'Known limitations'),
    ('non_goals', 'Non-goals'),
    ('success_metrics', 'Success metrics'),
    ('free_form_notes', 'Notes'),
)

#: The one cap of a question about a field (7.104.00): an extract's question (shared/product_extract.py), a typed
#: answer's question (POST …/product-docs/answers, shared/product_source_routes.py) and a voice interview's
#: (shared/voice_subjects.py). 200 characters: one sentence, as the extract asks for; the Product tab's default
#: questions are at most 105 characters in every locale.
MAX_QUESTION_CHARS: Final = 200


def clean_patch_value(key: str, value: object) -> str | None:
    """One field of a product-context patch (``key`` is in ALL_FIELDS): the value cut to its cap, or None for a value
    the field refuses.

    No field can legitimately be set to None (an explicit null clears a text field to ''), so None is unambiguous as
    "drop this key". ``current_state`` takes only one of LIFECYCLE_STATES.
    """
    if key == CURRENT_STATE:
        # isinstance first: the model can answer a list or an object here, and an unhashable value tested against the
        # states raises TypeError (a 500).
        return value if isinstance(value, str) and value in LIFECYCLE_STATES else None
    if value is None:
        return ''
    return value[: STRING_FIELDS[key]] if isinstance(value, str) else None
