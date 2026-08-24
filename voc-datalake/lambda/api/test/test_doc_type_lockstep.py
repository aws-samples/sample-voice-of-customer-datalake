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


def _api_client_doc_type_sets() -> dict[str, frozenset[str]]:
    """The `doc_type: 'a' | 'b'` annotations of the `generateDocument` signatures.

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

    Keyed by "file:line" so a mismatch report names the declaration that drifted
    rather than only the file.
    """
    # The client method whose body types THIS route's request. The annotation sits
    # on the same line in one file and a line or two below in the other, so track
    # the enclosing property rather than matching `doc_type` anywhere.
    method_start = re.compile(r'\b(\w+)\s*:\s*(?:async\s*)?\(')
    annotation = re.compile(r"doc_type\??\s*:\s*((?:'[^']+'\s*\|\s*)+'[^']+')")

    found: dict[str, frozenset[str]] = {}
    for relative in API_CLIENT_SOURCES:
        path = _repo_root() / relative
        if not path.is_file():
            continue
        enclosing = None
        enclosing_column = -1
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            # COLUMN-SCOPED, because a function-typed field NESTED in the request
            # body — `onProgress: (pct: number) => void`, an abort-signal factory,
            # any callback — also matches `name: (`. Taking every match would
            # reassign `enclosing` to that field and silently skip the real
            # annotation below it, returning an empty set with nothing saying so.
            # A nested field is indented deeper than the method that contains it,
            # so only a match at the same or lower column can END the method:
            # `generateDocument` in projectsApi.ts sits at column 2 with its body
            # fields at 4, and in client.ts the whole signature is one line where
            # the method is the leftmost match.
            for start in method_start.finditer(line):
                if enclosing is None or start.start() <= enclosing_column:
                    enclosing, enclosing_column = start.group(1), start.start()
            if enclosing != 'generateDocument':
                continue
            for raw in annotation.findall(line):
                found[f'{relative}:{line_number}'] = frozenset(re.findall(r"'([^']+)'", raw))
    return found


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
