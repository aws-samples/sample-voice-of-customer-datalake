"""Which document types are SCORABLE is decided in two places that must agree.

A prioritization row is a project's set of scorable documents. The backend
composes that set (`_default_row_composition` in `projects_handler.py`, off the
`SCORABLE_SK_PREFIXES` sort-key prefixes) and the page decides what a row's
expansion shows and what the type badge says (`SCORABLE_TYPE_META` in
`frontend/src/pages/Prioritization/prioritizationUtils.ts`, described in its own
docstring as "the single source of truth for which document types are scorable").

Drift either way is silent and neither direction raises:

  * A type scorable on the BACKEND only is put on rows nobody can see inside them.
    The row is scored — the ballot is real — while the page shows fewer documents
    than the ballot was cast about.
  * A type scorable on the FRONTEND only leaves a project whose ONLY document is of
    that type with no row at all: the create route refuses it ("no PRD or PR/FAQ to
    score"), while the page believes there is something to score and shows an empty
    invitation instead.

Adding a scorable type is therefore a two-file change, and this is what says so.
The mapping between the two spellings is mechanical: a document of type `prd` is
stored under the sort-key prefix `PRD#` (see `projects.py`), so the comparison is
`{prefix.rstrip('#').lower()}` against the frontend's keys.

Every value is read as SOURCE TEXT on the frontend side, per the convention in
`test_anon_ballot_key_lockstep.py`: reading text needs no bundler, and the
assertion must not be satisfiable by whatever a module happens to resolve at
import time.
"""
import re
from pathlib import Path

import pytest

FRONTEND_SOURCE = 'frontend/src/pages/Prioritization/prioritizationUtils.ts'


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_scorable_types() -> set[str]:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test — the same reading `test_prioritization_weights_lockstep.py`
        # takes.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    source = path.read_text(encoding='utf-8')

    marker = 'export const SCORABLE_TYPE_META'
    start = source.find(marker)
    assert start != -1, (
        f'{marker} not found in {FRONTEND_SOURCE}. If the declaration moved, '
        f'update this test — what it pins (one list of scorable types, not two) '
        f'still holds.'
    )
    # Scope to the object LITERAL, so a type named in a comment or in another
    # declaration cannot satisfy the comparison. The literal begins after the
    # annotation's own `= {` — the declared type is itself a `Record<…, {…}>`
    # spanning several lines, so scanning from the marker to the first `\n}` would
    # stop inside the annotation and find no entries at all.
    literal = source.find('= {', start)
    assert literal != -1, f'{marker} is not an object literal assignment'
    end = source.find('\n}', literal)
    assert end != -1, f'{marker} body not delimited as expected'
    body = source[literal:end]

    # `prd: { badgeColor: …` — the KEYS of the map are the scorable types.
    types = set(re.findall(r'^\s{2}(\w+):\s*\{', body, re.MULTILINE))
    assert types, f'no scorable document types found in {marker}'
    return types


def _backend_scorable_types() -> set[str]:
    import projects_handler

    return {prefix.rstrip('#').lower() for prefix in projects_handler.SCORABLE_SK_PREFIXES}


class TestScorableTypesLockstep:
    def test_both_sides_score_exactly_the_same_document_types(self):
        frontend = _frontend_scorable_types()
        backend = _backend_scorable_types()

        assert backend == frontend, (
            f'SCORABLE_SK_PREFIXES resolves to {sorted(backend)} but '
            f'SCORABLE_TYPE_META names {sorted(frontend)}. A type scorable on the '
            f'backend only is put on rows whose expansion never shows it; a type '
            f'scorable on the frontend only leaves a project holding just that type '
            f'with no row, while the page believes it has something to score.'
        )

    def test_the_prototype_prefix_is_not_among_them(self):
        # A prototype is CONTEXT on a row, carried in its own field, not a document
        # the row is scored on — and the frontend agrees by keeping `prototype` out
        # of SCORABLE_TYPE_META. Folding it in would make a project with a
        # prototype and no PRD get a row with nothing to read.
        import projects_handler

        assert projects_handler.PROTOTYPE_SK_PREFIX not in projects_handler.SCORABLE_SK_PREFIXES, (
            'PROTOTYPE_SK_PREFIX is listed as scorable. A prototype rides on a row '
            'as context (its own `prototype_id` field); scoring it would give a '
            'project with a prototype and no PRD a row with nothing to score.'
        )
