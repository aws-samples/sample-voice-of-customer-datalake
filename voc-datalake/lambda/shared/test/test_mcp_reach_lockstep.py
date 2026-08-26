"""Guard test for the MCP read-reach vocabulary, mirrored in Python and TypeScript.

`shared/mcp_tokens.py` owns `VALID_READ_REACHES`: `projects_handler`'s mint route
refuses anything outside it, and `mcp_handler` enforces it on every read.
`frontend/src/api/mcpTokenSchema.ts` has its own `READ_REACHES`, which decides
what the mint form offers and what `normalizeApiTokens` will parse back.

Nothing tied the two together, and the drift is asymmetric in a way that hides:
the TypeScript side is already pinned exactly by `mcpTokenSchema.test.ts`
(`expect(OFFERED_READ_REACHES).toEqual([...])`, `expect(READ_REACHES).toContain('none')`),
so a change made on the PYTHON side leaves every frontend test green while the
backend starts refusing a reach the form still offers. The user-visible result is
an HTTP 400 from the mint dialog for a value the dialog itself presented — the
same failure shape as the search-minimum drift this file is modelled on.

`test_mcp_tokens.py::TestVocabulary` pins the Python tuple's exact members; this
file pins the two languages to EACH OTHER. Both are needed: the former fails when
the vocabulary changes at all, the latter fails when it changes on only one side.

Same pattern as `test_search_minimum_lockstep.py` (TS ↔ Python search bound) and
`test_indexes.py` (CDK ↔ Python GSI names): parse the other language's source and
assert equality, so a change on either side fails CI instead of the live UI.
"""
import re
from pathlib import Path

import pytest

from shared.mcp_tokens import REACH_NONE, VALID_READ_REACHES


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


_SCHEMA_SOURCE = _repo_root() / 'frontend' / 'src' / 'api' / 'mcpTokenSchema.ts'


def _parse_string_array(name: str) -> tuple[str, ...] | None:
    """The named `as const` / typed string array from the schema module, in order.

    Returns None when the declaration is not found, so a rename shows up as the
    positive control failing rather than as an empty comparison passing.
    """
    if not _SCHEMA_SOURCE.exists():
        return None
    match = re.search(
        rf'export\s+const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*\[([^\]]*)\]',
        _SCHEMA_SOURCE.read_text(),
    )
    if match is None:
        return None
    return tuple(re.findall(r"'([^']*)'", match.group(1)))


class TestReadReachMirror:
    """The comparisons SKIP when the frontend tree is gone; the control does not.

    A checkout without `frontend/` (a backend-only sparse checkout, say) should
    not report a mirror mismatch it never measured — that is a
    `FileNotFoundError` masquerading as a finding, so the equality tests carry a
    `skipif`.

    `test_the_frontend_vocabulary_is_findable` carries NO skip marker on purpose:
    it asserts the file exists and both declarations parse, which is exactly the
    check that has to run. Skipping it would leave the equality tests able to
    pass while comparing against nothing.
    """

    def test_the_frontend_vocabulary_is_findable(self):
        """The positive control.

        Without it, a rename to `MCP_READ_REACHES` would make the parser return
        None and the equality tests below would be comparing against nothing — a
        green result meaning "did not check", which is the failure mode this
        file exists to prevent, applied to itself.
        """
        assert _SCHEMA_SOURCE.exists(), f'schema source moved: {_SCHEMA_SOURCE}'
        assert _parse_string_array('READ_REACHES') is not None, (
            'parsed no READ_REACHES from mcpTokenSchema.ts — parser drift?'
        )
        assert _parse_string_array('OFFERED_READ_REACHES') is not None, (
            'parsed no OFFERED_READ_REACHES from mcpTokenSchema.ts — parser drift?'
        )

    @pytest.mark.skipif(
        not _SCHEMA_SOURCE.exists(), reason='frontend tree absent from this checkout'
    )
    def test_both_languages_agree_on_the_reach_vocabulary(self):
        """Equality including ORDER.

        The backend interpolates `VALID_READ_REACHES` into the mint route's
        error message, and the frontend renders its list in declaration order,
        so the two orders are both user-visible and worth pinning together.
        """
        assert _parse_string_array('READ_REACHES') == VALID_READ_REACHES, (
            f'frontend READ_REACHES is {_parse_string_array("READ_REACHES")!r} while the '
            f'backend accepts {VALID_READ_REACHES!r} — mint would refuse a reach the form '
            'offers, or the form would omit one the backend accepts'
        )

    @pytest.mark.skipif(
        not _SCHEMA_SOURCE.exists(), reason='frontend tree absent from this checkout'
    )
    def test_every_offered_reach_is_one_the_backend_accepts(self):
        """The offered set is deliberately NARROWER than the accepted set.

        `none` is accepted but not offered — it produces an inert credential
        while no write tool exists, per `mcpTokenSchema.ts`'s own comment. So
        this is a subset assertion, not equality: the form may withhold a reach,
        but it must never offer one the mint route will refuse.
        """
        offered = _parse_string_array('OFFERED_READ_REACHES')
        assert set(offered) <= set(VALID_READ_REACHES), (
            f'the form offers {sorted(set(offered) - set(VALID_READ_REACHES))}, which the '
            'mint route refuses — the user would get a 400 for a value the dialog presented'
        )
        # Pins the reason the two sets differ, so re-offering `none` has to be a
        # deliberate edit here rather than a silent widening of the dialog.
        assert REACH_NONE not in offered, (
            "the form now offers `none`, which mints a credential that reads nothing — "
            'intended only once a write tool exists to make such a token useful'
        )
