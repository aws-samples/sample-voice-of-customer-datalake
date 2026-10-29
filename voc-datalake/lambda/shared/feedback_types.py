"""The built-in ``feedback_type`` dimension: what kind of feedback a review is.

Every deployment has it with no setup (``shared.dimension_config`` adds it to the
stored dimensions on every read). The enrichment model fills it in the SAME call
that categorises a review (``shared.categorization``), so it costs no extra model
call; stored reviews get it from the reprocess job (``mode: 'dimensions'``). A
manual edit (``PUT /feedback/{id}/dimensions``) or a value the producer sent (a
CSV column, an email alias) wins over the model, like for any dimension.

One primary type per review. The value names are a contract with the Problems
page's Type filter and the SPA's ``common.json`` ``feedbackTypes.<value>`` labels (the
Problems page's default "Problems only" set lives in the SPA).

Imports nothing: ``shared.dimension_config`` (and through it the processing-queue
schema) depends on it.
"""

from __future__ import annotations

from typing import Any, Final

__all__ = [
    'BUILTIN_DIMENSION_KEYS',
    'FEEDBACK_TYPE_KEY',
    'feedback_type_dimension',
]

FEEDBACK_TYPE_KEY: Final = 'feedback_type'

#: (value name, English label, what it covers). The order is the order shown everywhere.
_TYPES: Final = (
    ('bug', 'Bug', 'Something is broken or wrong: an error, a crash, wrong data'),
    ('service_failure', 'Service failure',
     'The service did not deliver: an outage, a failed delivery or payment, cannot log in'),
    ('feature_request', 'Feature request', 'Asks for something new or for a change'),
    ('usability', 'Usability', 'Works, but is confusing or hard to use'),
    ('performance', 'Performance', 'Works, but is slow (a crash is a bug)'),
    ('pricing_billing', 'Pricing and billing', 'Prices, fees, charges, refunds, invoices'),
    ('support_experience', 'Support experience', 'How customer support or staff handled the customer'),
    ('praise', 'Praise', 'Positive feedback with no problem to fix'),
    ('question', 'Question', 'Asks how something works'),
    ('other', 'Other', 'None of the above'),
)

#: Dimension keys defined in code; an admin cannot redefine or remove them.
BUILTIN_DIMENSION_KEYS: Final = frozenset({FEEDBACK_TYPE_KEY})

# The prompt sees the dimension description (at most 300 characters, see
# shared.categorization.MAX_PROMPT_DESCRIPTION_CHARS), not the value descriptions,
# so the description carries the rules the model needs to pick ONE type.
_DESCRIPTION: Final = (
    'The ONE primary type of the feedback. bug = broken or wrong, crash; service_failure = outage, '
    'failed delivery or payment, cannot log in; usability = confusing, not broken; performance = slow; '
    'praise = positive, nothing to fix; question = asks how; other = none fits'
)


def feedback_type_dimension() -> dict[str, Any]:
    """A fresh copy of the built-in ``feedback_type`` dimension, in the validated config shape.

    ``builtin: true`` tells the SPA to show it read-only; ``validate_dimensions``
    drops the flag (and any stored entry with this key), so it is never persisted.
    """
    return {
        'key': FEEDBACK_TYPE_KEY,
        'label': 'Feedback type',
        'description': _DESCRIPTION,
        'infer': True,
        'builtin': True,
        'values': [{'name': name, 'label': label, 'description': about} for name, label, about in _TYPES],
    }
