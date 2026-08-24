"""Lockstep test: the doc_type set the document route ACCEPTS and the set the
frontend can SEND must not drift apart.

`projects_handler.GENERATED_DOC_TYPES` is what POST /projects/{id}/document
validates against — anything outside it is a 400 raised before `create_job`. The
frontend independently declares the same set three times: the `DocType` union it
builds its picker from, and the `doc_type` field of the two API client signatures
that call this route.

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
    """Every inline `doc_type: 'a' | 'b'` annotation in the API client sources.

    Keyed by "file:line" so a mismatch report names the declaration that drifted
    rather than only the file. The route's own callers and the sibling
    suggest-brief signature are both matched — they should all agree, and the
    suggest-brief route accepting a wider set than this one would be the drift
    worth knowing about.
    """
    found: dict[str, frozenset[str]] = {}
    for relative in API_CLIENT_SOURCES:
        path = _repo_root() / relative
        if not path.is_file():
            continue
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            for raw in re.findall(r"doc_type\??\s*:\s*((?:'[^']+'\s*\|\s*)+'[^']+')", line):
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
        assert _api_client_doc_type_sets(), (
            f'parsed no inline doc_type unions from {API_CLIENT_SOURCES} — '
            f'were the request-body signatures extracted into named types? '
            f'If so, point this parser at them.'
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
    def test_every_api_client_signature_agrees_with_the_route(self):
        """The client signatures are what actually types the request body, so a
        widened signature is the change that would let a refused value be sent."""
        from projects_handler import GENERATED_DOC_TYPES

        expected = frozenset(GENERATED_DOC_TYPES)
        drifted = {
            where: sorted(declared)
            for where, declared in _api_client_doc_type_sets().items()
            if declared != expected
        }
        assert not drifted, (
            f'API client doc_type signatures disagree with the route, which '
            f'accepts {sorted(expected)}: {drifted}'
        )
