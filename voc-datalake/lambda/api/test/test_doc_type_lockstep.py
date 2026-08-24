"""Lockstep test: the doc_type set the document route ACCEPTS and the set the
frontend can SEND must not drift apart.

`projects_handler.GENERATED_DOC_TYPES` is what POST /projects/{id}/document
validates against — anything outside it is a 400 raised before `create_job`. The
frontend independently declares the same set: the `DocType` union it builds its
picker from, and the `doc_type` field of the two `generateDocument` client
signatures that call this route.

Only THIS route's declarations are pinned. `suggestDocumentBrief` also takes a
`doc_type`, but it calls a different route which the comment above
GENERATED_DOC_TYPES documents as deliberately not sharing this allowlist (there
the value picks a prompt label and never reaches a key, a job type or a routing
decision). Binding it here would turn widening that route — a change the same
comment invites — into a failure attributed to this one.

Nothing tied them together. The failure is user-visible rather than loud: a client
that offers a value the route refuses turns a click into an HTTP 400 from a
document picker, and a client that omits one silently drops a feature the backend
supports. Parsing the other language's source and asserting equality moves that
into CI.

Same pattern, and the same motivation, as `test_kiro_exportable_types_lockstep.py`
and `lambda/shared/test/test_search_minimum_lockstep.py` in this repo.

The comparisons SKIP when the frontend tree is absent (a backend-only sparse
checkout should not report a mismatch it never measured), but
`test_the_frontend_declarations_are_findable` carries NO skip marker: it asserts
the sources exist and parse, which is the check that must run — without it a
rename would make every parser return an empty set and the equality tests would
pass while comparing nothing.
"""
import re
from pathlib import Path

import pytest

# The TypeScript declarations that must agree with GENERATED_DOC_TYPES. Update
# these paths if the files move; a stale path fails the findability test rather
# than silently skipping.
DOC_TYPE_UNION_SOURCE = 'frontend/src/pages/ProjectDetail/types.ts'
API_CLIENT_SOURCES = (
    'frontend/src/api/client.ts',
    'frontend/src/api/projectsApi.ts',
)


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_tree_present() -> bool:
    return (_repo_root() / DOC_TYPE_UNION_SOURCE).is_file()


def _doc_type_union() -> frozenset[str]:
    """The `DocType` union members, or an empty set if the declaration is gone.

    Matches: export type DocType = 'prd' | 'prfaq'
    """
    source = (_repo_root() / DOC_TYPE_UNION_SOURCE).read_text(encoding='utf-8')
    match = re.search(
        r"export\s+type\s+DocType\s*=\s*((?:'[^']+'\s*\|?\s*)+)",
        source,
    )
    return frozenset(re.findall(r"'([^']+)'", match.group(1))) if match else frozenset()


# The client method whose parameters type THIS route's request body, anchored by
# NAME rather than by tracking whichever `name: (` was seen most recently. An
# indentation heuristic was tried first and had to be abandoned: a nested
# function-typed field (`onProgress: (pct: number) => void`) matches `name: (`
# too, and any rule for deciding which match ENDS the enclosing method got the
# answer wrong for some real shape — scoping to the shallowest column seen
# latched onto the first column-0 declaration in the file and skipped
# `generateDocument` forever, silently. Anchoring on the name and delimiting by
# bracket balance asks the question directly and has no such state.
GENERATE_DOCUMENT_ANCHOR = re.compile(r'\bgenerateDocument\s*:\s*(?:async\s*)?\(')
DOC_TYPE_ANNOTATION = re.compile(r"doc_type\??\s*:\s*((?:'[^']+'\s*\|\s*)+'[^']+')")


def _parameter_list_end(source: str, open_paren: int) -> int | None:
    """The index just past the `)` closing the parameter list at `open_paren`.

    None when the brackets never balance, which means the extent of the method
    could not be determined. Returning the rest of the file instead would be
    worse than returning nothing: in `projectsApi.ts` the next `doc_type` below
    `generateDocument` belongs to `suggestDocumentBrief`, which this file
    deliberately does not pin, so an over-long extent would quietly reintroduce
    the coupling. Nothing found fails the findability control loudly instead.

    Quoted strings and `//` comments are skipped so a bracket inside either
    cannot unbalance the count — the same defect class as the comment-stripping
    in `test_the_routing_predicate_reads_the_allowlist_constant`.
    """
    depth = 0
    quote = None
    index = open_paren
    while index < len(source):
        char = source[index]
        if quote is not None:
            if char == '\\':
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in '\'"`':
            quote = char
        elif source.startswith('//', index):
            newline = source.find('\n', index)
            index = len(source) if newline == -1 else newline
            continue
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def _doc_type_annotations(source: str) -> dict[int, frozenset[str]]:
    """The `doc_type: 'a' | 'b'` annotations inside `generateDocument`'s signature.

    Keyed by 1-based line number. A pure function of the text so the parser
    itself is testable — `TestTheParser` below feeds it the awkward shapes that
    broke earlier attempts, because a lockstep test whose parser silently returns
    nothing is a green result meaning "did not check".

    Scoped to that ONE client method on purpose. Matching every `doc_type`
    annotation in these files also picks up `suggestDocumentBrief`, which calls a
    DIFFERENT route (POST .../documents/suggest-brief) that the comment above
    GENERATED_DOC_TYPES documents as deliberately NOT sharing this allowlist —
    there the value only picks a prompt label and never reaches a key, a job type
    or a routing decision. Asserting it against this constant would make widening
    suggest-brief, the change that comment invites, fail a test named after the
    document route, and narrowing the test back would look like weakening a
    security check. If suggest-brief is ever worth pinning it wants its own
    constant and its own rationale.
    """
    found: dict[int, frozenset[str]] = {}
    for anchor in GENERATE_DOCUMENT_ANCHOR.finditer(source):
        open_paren = anchor.end() - 1
        end = _parameter_list_end(source, open_paren)
        if end is None:
            continue
        signature = source[open_paren:end]
        first_line = source.count('\n', 0, open_paren) + 1
        for match in DOC_TYPE_ANNOTATION.finditer(signature):
            line_number = first_line + signature.count('\n', 0, match.start())
            found[line_number] = frozenset(re.findall(r"'([^']+)'", match.group(1)))
    return found


def _api_client_doc_type_sets() -> dict[str, frozenset[str]]:
    """`_doc_type_annotations` over each client source.

    Keyed by "file:line" so a mismatch report names the declaration that drifted
    rather than only the file.
    """
    found: dict[str, frozenset[str]] = {}
    for relative in API_CLIENT_SOURCES:
        path = _repo_root() / relative
        if not path.is_file():
            continue
        source = path.read_text(encoding='utf-8')
        for line_number, declared in _doc_type_annotations(source).items():
            found[f'{relative}:{line_number}'] = declared
    return found


# Each value is a client source the parser must find the annotation in. Named
# rather than inlined so the reason a shape is here sits with the shape.
FINDABLE_SHAPES = {
    # The shape in projectsApi.ts today: the annotation a line below the
    # method, inside a multi-line request-body type.
    'multi_line': """generateDocument: (projectId: string, data: {
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    # The shape in client.ts today: the whole signature on one line.
    'single_line':
        "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,\n",
    # A function-typed field NESTED in the request body. It matches `name: (`
    # as much as the method does, so a parser tracking "the most recent
    # `name: (`" reassigns to it and skips the annotation below.
    'nested_callback': """generateDocument: (projectId: string, data: {
  onProgress: (pct: number) => void
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    # A column-0 function-typed declaration ABOVE the object literal. The
    # column heuristic this parser replaced latched its threshold to 0 here and
    # could never accept the indented `generateDocument` again, for the rest of
    # the file — silently, which is why this case is pinned.
    'column_zero_preamble': """label: (x: string) => void
export const api = {
  generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,
}
""",
    # The method nested one level deeper than a sibling above it, which the
    # same latch also refused.
    'nested_namespace': """export const api = {
  helper: (x: string) => x,
  projects: {
generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,
  },
}
""",
    # Brackets inside a string and inside a `//` comment, neither of which may
    # unbalance the search for the end of the parameter list.
    'bracket_in_string': """generateDocument: (p: string, d: {
  label: ')('
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    'bracket_in_comment': """generateDocument: (p: string, d: {
  // see runResearch( for the twin
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    # `async` between the name and the parameter list.
    'async':
        "generateDocument: async (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,\n",
}


class TestTheParser:
    """The parser itself, on synthetic sources.

    A lockstep test is only worth its positive control, and the control can only
    report that the parser found nothing — never that a plausible restyling of the
    client would make it find nothing. These cases are that second half: each is a
    shape an earlier version of this parser silently returned `{}` for, which
    would have left the equality tests below comparing empty sets.
    """

    @pytest.mark.parametrize('shape', FINDABLE_SHAPES.values(), ids=FINDABLE_SHAPES)
    def test_the_annotation_is_found_however_the_signature_is_shaped(self, shape):
        assert list(_doc_type_annotations(shape).values()) == [
            frozenset({'prd', 'prfaq'})
        ], f'parsed nothing from:\n{shape}'

    def test_the_line_number_points_at_the_annotation(self):
        """The keys are what a failure report names, so they must be right —
        pointing a maintainer at the method's line instead of the annotation's
        would send them to the wrong declaration in a file with several."""
        source = (
            'export const api = {\n'
            '  generateDocument: (p: string, d: {\n'
            "    doc_type: 'prd' | 'prfaq'\n"
            '  }) => q,\n'
            '}\n'
        )
        assert list(_doc_type_annotations(source)) == [3]

    def test_a_sibling_methods_doc_type_is_not_collected(self):
        """`suggestDocumentBrief` calls a different route which the handler comment
        documents as deliberately not sharing this allowlist. Widening it must not
        fail a test named after the document route — see this module's docstring.
        """
        source = (
            "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,\n"
            "suggestDocumentBrief: (p: string, b: "
            "{ doc_type?: 'prd' | 'prfaq' | 'brief_only' }) => q,\n"
        )
        assert list(_doc_type_annotations(source).values()) == [
            frozenset({'prd', 'prfaq'})
        ]

    def test_an_unbalanced_signature_yields_nothing_rather_than_overreaching(self):
        """Failing to find the end of the parameter list must find NOTHING.

        Falling back to "the rest of the file" would sweep in the next method's
        `doc_type` — which in projectsApi.ts is `suggestDocumentBrief`'s, the one
        annotation this file must not pin. An empty result is caught loudly by the
        findability control instead.
        """
        source = "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq'\n"
        assert _doc_type_annotations(source) == {}

    def test_a_renamed_method_yields_nothing(self):
        """The negative control for the anchor: if this returned annotations for
        any method name, scoping to `generateDocument` would be doing nothing and
        the suggest-brief exclusion above would be accidental."""
        source = "createDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,\n"
        assert _doc_type_annotations(source) == {}


class TestDocTypeLockstep:
    """The route refuses what the client cannot send, so the two must agree."""

    def test_the_frontend_declarations_are_findable(self):
        """The positive control.

        Renaming `DocType`, or restyling the client signatures, would make the
        parsers above return nothing and leave the equality tests passing while
        comparing empty sets — a green result meaning "did not check", which is
        the failure mode this file exists to prevent, applied to itself.
        """
        union_path = _repo_root() / DOC_TYPE_UNION_SOURCE
        assert union_path.is_file(), f'DocType source moved: {DOC_TYPE_UNION_SOURCE}'
        assert _doc_type_union(), (
            f'parsed no DocType union members from {DOC_TYPE_UNION_SOURCE} — '
            f'was the type renamed, or reformatted across lines?'
        )
        client_sets = _api_client_doc_type_sets()
        # PER FILE, not a total. `found` is keyed "file:line", so a bare
        # `len(client_sets) == 2` is satisfied by two annotations parsed from one
        # source while the other is entirely unparsed — which is precisely the mode
        # this control exists to exclude, so counting the total lets through the
        # only thing it is for.
        parsed_sources = sorted({where.split(':')[0] for where in client_sets})
        assert parsed_sources == sorted(API_CLIENT_SOURCES), (
            f'expected a generateDocument doc_type annotation in EACH of '
            f'{sorted(API_CLIENT_SOURCES)}, parsed only {parsed_sources} '
            f'(declarations found: {sorted(client_sets)}) — was the method renamed, '
            f'or the request-body signature extracted into a named type? '
            f'If so, point this parser at it.'
        )

    @pytest.mark.skipif(
        not _frontend_tree_present(), reason='frontend tree absent from this checkout'
    )
    def test_the_route_accepts_exactly_what_the_doc_type_union_offers(self):
        """Equality, not containment.

        A frontend value the route refuses is a 400 from a picker; a route value
        the frontend never offers is a backend capability no user can reach. Both
        are drift, so neither direction is allowed.
        """
        from projects_handler import GENERATED_DOC_TYPES

        assert _doc_type_union() == frozenset(GENERATED_DOC_TYPES), (
            f'DocType in {DOC_TYPE_UNION_SOURCE} declares {sorted(_doc_type_union())} '
            f'while the route accepts {sorted(GENERATED_DOC_TYPES)}.\n'
            f'  Offered but refused (a user-visible 400): '
            f'{sorted(_doc_type_union() - frozenset(GENERATED_DOC_TYPES))}\n'
            f'  Accepted but never offered (unreachable): '
            f'{sorted(frozenset(GENERATED_DOC_TYPES) - _doc_type_union())}'
        )

    @pytest.mark.skipif(
        not _frontend_tree_present(), reason='frontend tree absent from this checkout'
    )
    def test_every_generate_document_signature_agrees_with_the_route(self):
        """The `generateDocument` signatures are what actually types this route's
        request body, so a widened signature is the change that would let a
        refused value be sent. Sibling routes' `doc_type` fields are out of scope
        — see this module's docstring for why suggest-brief is excluded."""
        from projects_handler import GENERATED_DOC_TYPES

        expected = frozenset(GENERATED_DOC_TYPES)
        drifted = {
            where: sorted(declared)
            for where, declared in _api_client_doc_type_sets().items()
            if declared != expected
        }
        assert not drifted, (
            f'generateDocument doc_type signatures disagree with the route, '
            f'which accepts {sorted(expected)}: {drifted}'
        )
