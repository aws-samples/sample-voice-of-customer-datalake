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


PRODUCER_FUNCTION = 'build_product_context_block'

#: The list whose members become the returned block. Named once: every helper
#: below reasons about mutations of this name.
SECTIONS = 'sections'


def _producer_function() -> ast.FunctionDef:
    """The producer's AST node, with the two conditions its readers depend on.

    Both are asserted here rather than at the call sites: a rename must produce
    the message that names the rename, not an `IndexError`; and `ast.walk`
    descends into nested definitions, so a nested function's statements would be
    collected as the producer's own (the same leak the research handler's test
    guards against, demonstrated there by mutation).
    """
    functions = [
        node for node in ast.walk(ast.parse(_read(PRODUCER_SOURCE)))
        if isinstance(node, ast.FunctionDef) and node.name == PRODUCER_FUNCTION
    ]
    assert len(functions) == 1, (
        f'Expected exactly one {PRODUCER_FUNCTION} in {PRODUCER_SOURCE}; found '
        f'{len(functions)}. If it was renamed or duplicated, update '
        f'PRODUCER_FUNCTION in this test file.'
    )
    nested = [
        node.name for node in ast.walk(functions[0])
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node is not functions[0]
    ]
    assert nested == [], (
        f'{PRODUCER_FUNCTION} now defines nested function(s) {nested}, whose '
        f'statements ast.walk cannot tell from the producer\'s own. Scope the '
        f'helpers below to the function body before trusting them again.'
    )
    return functions[0]


def _section_mutations() -> list[tuple[int, str, ast.expr | None]]:
    """Every statement that changes `sections`, as (line, kind, value).

    `kind` is `'append'`, `'init'` for `sections … = []`, or the shape of whatever
    else was found: a method name as written (`'extend'`, `'insert'`, …), `'+='`,
    `'setitem'`, or `'rebind'` for an assignment of anything but an empty list.
    Every kind in that list is one this function can actually emit — a label it
    could not produce would be a promise the reader cannot rely on.

    The heading check can only reason about `append`, so collecting every kind
    rather than only the appends is what stops it passing vacuously over a form it
    never looks at. Read uses like `'\\n\\n'.join(sections)` are not mutations and
    are deliberately not collected.
    """
    found: list[tuple[int, str, ast.expr | None]] = []
    for node in ast.walk(_producer_function()):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == SECTIONS
        ):
            found.append((node.lineno, node.func.attr, node.args[0] if node.args else None))
        elif isinstance(node, (ast.AnnAssign, ast.Assign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id == SECTIONS:
                    if isinstance(node, ast.AugAssign):
                        kind = '+='
                    elif isinstance(node.value, ast.List) and not node.value.elts:
                        kind = 'init'
                    else:
                        kind = 'rebind'
                    found.append((node.lineno, kind, node.value))
                elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) \
                        and target.value.id == SECTIONS:
                    found.append((node.lineno, 'setitem', node.value))
    return found


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
    it. These tests are the enforcement: a third return, a section that could be
    blank, or a way of adding a section that the heading check cannot read, each
    fail here and ask for the guard to be reconsidered. Until then the guard is
    unreachable, and an unreachable guard is dead code that reads as protection.

    The last of the three exists because the check's own failure direction is the
    dangerous one. A heading check that inspects only `sections.append(...)`
    passes vacuously the moment a section arrives by `extend`, `+=` or a
    comprehension — it would stop watching without saying so, which is exactly
    the fail-open shape it was written to rule out. So the enumeration of HOW
    sections may be added is asserted first, and the headings second.
    """

    def test_the_producer_has_exactly_two_returns(self):
        returns = [node for node in ast.walk(_producer_function()) if isinstance(node, ast.Return)]
        assert len(returns) == 2, (
            f'{PRODUCER_FUNCTION} now has {len(returns)} returns, not 2. The '
            f'generator decides product_context_included by comparing the result '
            f'against one placeholder literal — check that every new exit either '
            f'is that placeholder or carries real content.'
        )

    def test_sections_is_only_ever_built_by_append(self):
        """Fail CLOSED on an unrecognised mutation, rather than ignoring it.

        Asserted as a closed set, not as "no extend": a form nobody has thought
        of yet is a finding here instead of a silent gap in the test below.
        """
        unreadable = [(line, kind) for line, kind, _ in _section_mutations() if kind not in ('append', 'init')]
        assert unreadable == [], (
            f'{SECTIONS} is mutated by something other than append at '
            f'{unreadable} in {PRODUCER_SOURCE}. The heading check below can only '
            f'read appends, so it would pass while watching nothing. Either build '
            f'sections with append, or extend that check to cover this form — and '
            f'until then treat the missing `bool(block and block.strip())` guard '
            f'in {CONSUMER_SOURCE}::_product_context as no longer justified.'
        )

    def test_sections_starts_empty_exactly_once(self):
        """The `if not sections:` fallback means what it says only if the list
        begins empty and is never rebound to something non-empty."""
        inits = [line for line, kind, _ in _section_mutations() if kind == 'init']
        assert len(inits) == 1, (
            f'Expected exactly one `{SECTIONS} … = []` in {PRODUCER_FUNCTION}; '
            f'found {len(inits)} at lines {inits}.'
        )

    def test_every_section_starts_with_a_visible_heading(self):
        appends = [(line, value) for line, kind, value in _section_mutations() if kind == 'append']
        assert appends, f'No {SECTIONS}.append(...) found — did the producer change shape?'
        for line, value in appends:
            header = _leading_literal(value) if value is not None else None
            assert header is not None and header.strip().startswith('###'), (
                f'The section appended at {PRODUCER_SOURCE}:{line} has no leading '
                f'"###" heading literal ({header!r}). A section that can be blank '
                f'makes a non-placeholder block blank too, and _product_context '
                f'would then record product_context_included: True for a document '
                f'with no product context. Either keep the heading, or add the '
                f'`bool(block and block.strip())` guard in '
                f'{CONSUMER_SOURCE}::_product_context.'
            )
