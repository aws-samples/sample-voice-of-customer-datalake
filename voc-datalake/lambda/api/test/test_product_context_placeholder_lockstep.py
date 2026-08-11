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
import ast
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


def _leading_literal(node: ast.expr) -> str | None:
    """The string literal a concatenation expression starts with, if any.

    Every section in the producer is `"### header…" + something`, so the header is
    the left-most leaf of a `+` chain. Returns None for an expression that does
    not begin with a literal — which the test below treats as a finding rather
    than a pass, because such a section's emptiness could not be reasoned about.
    """
    while isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        node = node.left
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _section_headers() -> list[str | None]:
    """The leading literal of every `sections.append(...)` in the producer."""
    source = _read(PRODUCER_SOURCE)
    functions = [
        node for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.FunctionDef) and node.name == 'build_product_context_block'
    ]
    assert len(functions) == 1, f'Expected one build_product_context_block; found {len(functions)}.'
    return [
        _leading_literal(node.args[0])
        for node in ast.walk(functions[0])
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == 'append'
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == 'sections'
        and node.args
    ]


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


class TestNoBlockCanBeBlankWithoutBeingThePlaceholder:
    """Why `_product_context` needs no `bool(block and block.strip())` guard.

    The flag is `block != NO_PRODUCT_CONTEXT`, which would be wrong if the
    producer could return a non-placeholder block that is nonetheless empty or
    whitespace — a document would then record product context it never had. It
    cannot, and the reason is structural rather than incidental: the producer has
    exactly two returns, and the non-placeholder one joins `sections`, every
    member of which begins with a visible `###` heading and is appended only when
    its own content list is non-empty.

    That is an argument, so it is worth exactly nothing unless something enforces
    it. These two tests are the enforcement: a future section that could be blank,
    or a third return, fails here and asks for the guard to be reconsidered. Until
    then the guard is unreachable, and an unreachable guard is dead code that
    reads as protection.
    """

    def test_the_producer_has_exactly_two_returns(self):
        source = _read(PRODUCER_SOURCE)
        functions = [
            node for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.FunctionDef) and node.name == 'build_product_context_block'
        ]
        returns = [node for node in ast.walk(functions[0]) if isinstance(node, ast.Return)]
        assert len(returns) == 2, (
            f'build_product_context_block now has {len(returns)} returns, not 2. '
            f'The generator decides product_context_included by comparing the '
            f"result against one placeholder literal — check that every new exit "
            f'either is that placeholder or carries real content.'
        )

    def test_every_section_starts_with_a_visible_heading(self):
        headers = _section_headers()
        assert headers, 'No sections.append(...) found — did the producer change shape?'
        for header in headers:
            assert header is not None and header.strip().startswith('###'), (
                f'A section is appended without a leading "###" heading literal '
                f'({header!r}). A section that can be blank makes a non-placeholder '
                f'block blank too, and _product_context would then record '
                f'product_context_included: True for a document with no product '
                f'context. Either keep the heading, or add the '
                f'`bool(block and block.strip())` guard in '
                f'{CONSUMER_SOURCE}::_product_context.'
            )
