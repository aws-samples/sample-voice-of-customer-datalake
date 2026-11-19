"""What a feedback form's test response row is, for the modules that read or delete one.

A test link's tagged response (docs/feedback-forms.md "Test mode") never becomes a feedback item. It is one row of
voc-aggregates in a partition of its own, shared by every form's test responses: ``pk FEEDBACK_FORM_TEST``,
``sk {form_id}#{created_at}#{response_id}`` (a form id never holds ``#``), ``is_test: true``. It stays until an admin
or the form's creator deletes it (lambda/api/feedback_form_handler.py) or a legal obligation does
(lambda/jobs/retention/form_tests.py).

Why a partition of its own, not the forms partition (``FEEDBACK_FORM``, shared/onboarding.py ``FEEDBACK_FORM_PK``)
the form's definition, revisions and funnel rows live in: voc-retention may delete test responses, and IAM can pin a
delete to a partition (``dynamodb:LeadingKeys``) but not to a sort-key prefix. In the forms partition its grant would
also cover every form definition, revision and funnel row; here it covers test responses alone
(lib/stacks/retention-worker.ts, TENETS.md tenet 6).

What a tester typed can still be a person's data: a ``contact_info`` answer (``{name?, email?, phone?, company?}``,
under that question's id in ``answers``). From 7.04.00 the row also keeps the contact's email (stripped and
lower-cased) and name at its top level, as ``submitter_email`` / ``submitter_name``, the names a real response keeps
them under in ``metadata``. A row written by voc-multiplayer 7.55.00 has them only inside ``answers``, so
``person_values`` reads both places.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

__all__ = ['CONTACT_EMAIL', 'CONTACT_NAME', 'TEST_RESPONSES_PK', 'form_sk_prefix', 'person_values', 'response_id_of',
           'test_response_key']

#: The partition of every form's test responses (and nothing else).
TEST_RESPONSES_PK: Final = 'FEEDBACK_FORM_TEST'
#: The contact fields a person can be found by, as a ``contact_info`` answer names them.
CONTACT_EMAIL: Final = 'email'
CONTACT_NAME: Final = 'name'
#: Where the row keeps each one at its top level (from 7.04.00).
_TOP_LEVEL: Final = {CONTACT_EMAIL: 'submitter_email', CONTACT_NAME: 'submitter_name'}


def form_sk_prefix(form_id: str) -> str:
    """The sort-key prefix of one form's test responses (``{form_id}#``: a form id never holds ``#``, so it never
    names another form's rows)."""
    return f'{form_id}#'


def test_response_key(form_id: str, created_at: str, response_id: str) -> dict[str, str]:
    """One test response's key: oldest first within its form, and unique by its response id."""
    return {'pk': TEST_RESPONSES_PK, 'sk': f'{form_sk_prefix(form_id)}{created_at}#{response_id}'}


def person_values(row: Mapping[str, Any], field: str) -> list[str]:
    """Every value of the contact ``field`` (``email`` or ``name``) the row holds: its top-level copy, then each
    answer that is a contact answer naming it. The contact question's id differs per form, so every answer that is a
    mapping is read (a choice answer, ``{code}`` / ``{codes}``, names neither field)."""
    values: list[str] = []
    top = row.get(_TOP_LEVEL[field])
    if isinstance(top, str) and top:
        values.append(top)
    answers = row.get('answers')
    if isinstance(answers, Mapping):
        for answer in answers.values():
            value = answer.get(field) if isinstance(answer, Mapping) else None
            if isinstance(value, str) and value:
                values.append(value)
    return values


def response_id_of(row: Mapping[str, Any]) -> str:
    """The row's ``response_id``, else the last part of its sort key (``…#{response_id}``)."""
    response_id = row.get('response_id')
    if isinstance(response_id, str) and response_id:
        return response_id
    return str(row.get('sk') or '').rsplit('#', 1)[-1]
