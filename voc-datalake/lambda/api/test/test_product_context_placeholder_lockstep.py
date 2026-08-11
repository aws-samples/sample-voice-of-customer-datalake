"""Lockstep test: the "no product context" placeholder is one string in two files.

`build_product_context_block` (lambda/api/product_context.py) returns a literal
placeholder when a project has nothing to say about its product, and the document
generator decides `derivation.product_context_included` by comparing the block it
got back against its own copy of that literal
(lambda/jobs/document_generator/handler.py::_product_context).

The comparison is therefore a string equality across a module boundary, and it
fails OPEN: whitespace or wording drift in the producer's copy makes every
context-less project record `product_context_included: True`, claiming an input
the document never had. Nothing else would notice — the prompts keep working,
because the placeholder is only ever read by a human.

Both literals are read as SOURCE TEXT rather than imported, so this test cannot
be satisfied by whatever either module happens to resolve at import time, and it
needs neither module's AWS-shaped import graph.

Pattern follows test_kiro_exportable_types_lockstep.py (same directory).
"""
import re
from pathlib import Path

PRODUCER_SOURCE = 'lambda/api/product_context.py'
CONSUMER_SOURCE = 'lambda/jobs/document_generator/handler.py'


def _read(relative: str) -> str:
    # lambda/api/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? '
        f'If so, update the path constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _producer_placeholder() -> str:
    """The string build_product_context_block returns when it has no sections.

    Anchored to that branch specifically: the placeholder's meaning is "nothing
    was assembled", so a second unrelated `return "…"` elsewhere in the module
    must not be mistaken for it.
    """
    source = _read(PRODUCER_SOURCE)
    matches = re.findall(r'if not sections:\s*\n\s*return\s+"([^"]*)"', source)
    assert len(matches) == 1, (
        f'Expected exactly one `if not sections: return "…"` fallback in '
        f'{PRODUCER_SOURCE}; found {len(matches)}. If the fallback moved or was '
        f'restructured, update this helper — and check that whatever replaced it '
        f'still agrees with the consumer.'
    )
    return matches[0]


def _consumer_placeholder() -> str:
    """The NO_PRODUCT_CONTEXT constant the generator compares against."""
    source = _read(CONSUMER_SOURCE)
    matches = re.findall(r'^NO_PRODUCT_CONTEXT\s*=\s*"([^"]*)"', source, re.MULTILINE)
    assert len(matches) == 1, (
        f'Expected exactly one module-level NO_PRODUCT_CONTEXT assignment in '
        f'{CONSUMER_SOURCE}; found {len(matches)}.'
    )
    return matches[0]


class TestProductContextPlaceholderLockstep:
    def test_producer_and_consumer_use_the_same_placeholder(self):
        assert _producer_placeholder() == _consumer_placeholder(), (
            'The "no product context" placeholder is compared by value across '
            f'{PRODUCER_SOURCE} and {CONSUMER_SOURCE}. They have drifted, so '
            'every project with no product context now records '
            'product_context_included: True. Change both, or give them a shared '
            'constant.'
        )

    def test_the_placeholder_is_pinned_literally(self):
        """Named as a literal so this file cannot derive its expectation from
        either side of the comparison it is checking."""
        assert _producer_placeholder() == '(No product context provided.)'
