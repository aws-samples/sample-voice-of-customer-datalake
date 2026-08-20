"""Guard test for the search-query minimum, mirrored in Python and TypeScript.

`shared/api.py` owns `SEARCH_QUERY_MIN_LENGTH`: the route enforces it and the MCP
tool declares it as `inputSchema.minLength`. The frontend has its own
`SEARCH_MIN_CHARS`, which decides whether to issue a search at all.

Nothing tied the two together, so the frontend could gate at a different number
than the route refuses at — and the failure is user-visible rather than loud: the
client lets a term through and the user gets an HTTP 400 from a search box. That
is how the two halves of this bound drifted in the first place.

Same pattern as `test_indexes.py` (CDK ↔ Python GSI names) and the model-allowlist
TS ↔ Python mirror: parse the other language's source and assert equality, so a
change on either side fails CI instead of the live UI.
"""
import re
from pathlib import Path

import pytest

from shared.api import SEARCH_QUERY_MIN_LENGTH


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


_GATE_SOURCE = _repo_root() / 'frontend' / 'src' / 'pages' / 'Categories' / 'useFeedbackListData.ts'


def _frontend_minimum() -> int | None:
    """`SEARCH_MIN_CHARS` as declared in the hook, or None if not found."""
    match = re.search(
        r'export\s+const\s+SEARCH_MIN_CHARS\s*=\s*(\d+)',
        _GATE_SOURCE.read_text(),
    )
    return int(match.group(1)) if match else None


class TestSearchMinimumMirror:
    """The comparison SKIPS when the frontend tree is gone; the control does not.

    A checkout without `frontend/` (a backend-only sparse checkout, say) should
    not report a mirror mismatch it never measured — that is a
    `FileNotFoundError` masquerading as a finding, so the equality test carries a
    `skipif`.

    `test_the_frontend_constant_is_findable` carries NO skip marker on purpose: it
    asserts the file exists and the constant parses, which is exactly the check
    that has to run. Skipping it would leave the equality test able to pass while
    comparing against nothing.
    """

    def test_the_frontend_constant_is_findable(self):
        """The positive control.

        Without it, a rename to `SEARCH_MIN_CHARACTERS` would make the parser
        return None and the equality test below would be comparing against
        nothing — a green result meaning "did not check", which is the failure
        mode this file exists to prevent, applied to itself.
        """
        assert _GATE_SOURCE.exists(), f'gate source moved: {_GATE_SOURCE}'
        assert _frontend_minimum() is not None, (
            'parsed no SEARCH_MIN_CHARS from useFeedbackListData.ts — parser drift?'
        )

    @pytest.mark.skipif(not _GATE_SOURCE.exists(), reason='frontend tree absent from this checkout')
    def test_both_languages_agree_on_the_minimum(self):
        """Equality, so raising the bound on one side fails here rather than
        turning an ordinary keystroke into a 400."""
        assert _frontend_minimum() == SEARCH_QUERY_MIN_LENGTH, (
            f'frontend gates at {_frontend_minimum()} while the route enforces '
            f'{SEARCH_QUERY_MIN_LENGTH}'
        )

    # The client's TRIM is deliberately not asserted here.
    #
    # Grepping another language's source for an expression pins CHARACTERS rather
    # than behaviour: a reformat or an extracted local breaks such a test with no
    # change in what the code does. This file keeps only what genuinely requires
    # cross-language parsing — the shared CONSTANT — and the trim is pinned where
    # it can be observed, in `client.test.ts` § "searchFeedback trims the query at
    # the boundary", which asserts the trimmed term in the REQUEST URL.
