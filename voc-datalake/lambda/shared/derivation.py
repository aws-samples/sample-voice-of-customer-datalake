"""
One shape for "what was this document built from", written by every path that
creates a project document.

Before this module the same relation was stored three ways and absent in three
places: the merger wrote `source_documents` (a list), a prototype wrote
`source_prd_id`/`source_prfaq_id` (fixed arity, so it cannot express "built from
two PRDs"), and PRD/PR-FAQ/research/product-report wrote nothing at all. So a
document could not answer how it was made.

Every creating path now ALSO writes a single `derivation` map:

    {
      'sources': [{'document_id': 'prd_1', 'role': 'reference'}, ...],
      'selected_document_count': 5,
      'feedback_count': 12,
      'persona_ids': ['persona_1'],
      'product_context_included': True,
    }

Two properties the callers must preserve:

- `sources` records what was USED, never what was requested. Several paths cap
  the reference documents they feed the model (the document generator keeps the
  first three of the selected ids); `sources` lists the documents that actually
  reached the model and `selected_document_count` states how many were selected,
  so the drop is visible rather than implied. Recording the drop is not fixing
  it — the cap and its ordering are a separate known issue.
- The existing shapes keep being written unchanged. This is additive: nothing is
  removed, renamed, or migrated, and documents written before this module still
  explain themselves through the read-side resolver in the frontend
  (`frontend/src/api/derivation.ts`), which interprets the three legacy shapes.

The role vocabulary is CLOSED and mirrors what the code actually does. It is
kept in lockstep with the frontend's copy by
`lambda/shared/test/test_derivation_roles_lockstep.py`.
"""

# A reference document the caller selected and the generator fed to the model.
ROLE_REFERENCE = 'reference'
# The PRD a prototype was built from.
ROLE_PROTOTYPE_PRD = 'prototype_prd'
# The PR/FAQ a prototype was built from.
ROLE_PROTOTYPE_PRFAQ = 'prototype_prfaq'
# A document fed to a merge.
ROLE_MERGE_INPUT = 'merge_input'

#: The closed vocabulary, in the order a resolver reports it.
DERIVATION_ROLES = (
    ROLE_REFERENCE,
    ROLE_PROTOTYPE_PRD,
    ROLE_PROTOTYPE_PRFAQ,
    ROLE_MERGE_INPUT,
)

#: Attribute name on a ProjectDocument item.
DERIVATION_FIELD = 'derivation'


def _count(value) -> int:
    """A non-negative int, or 0 for anything that is not one.

    Provenance bookkeeping runs inside document generation, so a surprising
    value must degrade to 0 rather than fail the job that produced the document.
    """
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def derivation_source(document_id: str | None, role: str) -> dict | None:
    """One `sources` entry, or None when there is nothing to record.

    A caller may hold an absent document (`(prd or {}).get('document_id')` is a
    real stored None for a prototype built from a PR/FAQ alone), and "no source"
    must not become an entry with an empty id.

    Raises:
        ValueError: for a role outside DERIVATION_ROLES. Roles are literals at
            every call site, so this fires only for a new role that was added
            without being declared here — the same failure the frontend gets as
            a compile error.
    """
    if role not in DERIVATION_ROLES:
        raise ValueError(f'Unknown derivation role: {role!r}')
    if not document_id or not isinstance(document_id, str):
        return None
    return {'document_id': document_id, 'role': role}


def build_derivation(
    *,
    sources=(),
    selected_document_count: int = 0,
    feedback_count: int = 0,
    persona_ids=(),
    product_context_included: bool = False,
) -> dict:
    """Assemble the `derivation` map for a document item.

    Args:
        sources: entries from `derivation_source`; None entries are dropped, so
            callers can pass optional sources without pre-filtering.
        selected_document_count: how many reference documents the request
            selected — may exceed len(sources) when the caller capped them.
        feedback_count: feedback items actually used, not the requested limit.
        persona_ids: persona ids actually used.
        product_context_included: whether the project product-context block was
            injected into the prompt.

    Counts and identifiers only — never copied content.
    """
    return {
        'sources': [s for s in sources if s],
        'selected_document_count': _count(selected_document_count),
        'feedback_count': _count(feedback_count),
        'persona_ids': [p for p in persona_ids if isinstance(p, str) and p],
        'product_context_included': bool(product_context_included),
    }
