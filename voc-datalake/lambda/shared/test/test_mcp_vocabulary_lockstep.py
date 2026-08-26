"""Guard tests for the MCP credential vocabulary, mirrored in Python and TypeScript.

`shared/mcp_tokens.py` owns both axes of what a credential may do:
`VALID_SCOPES` (which domains it may read) and `VALID_READ_REACHES` (how far).
`projects_handler`'s mint route refuses anything outside either, and
`mcp_handler` enforces both on every read. `frontend/src/api/mcpTokenSchema.ts`
declares its own `MCP_SCOPES` and `READ_REACHES`, which decide what the mint
form offers and what `normalizeApiTokens` will parse back.

Nothing tied the two languages together, and the drift is asymmetric in a way
that hides. `mcpTokenSchema.test.ts` pins the TypeScript side, and both Python
vocabularies are pinned only against *themselves* — `set(ALL_READ_SCOPES) ==
VALID_SCOPES` and the exact-members reach assertion in `test_mcp_tokens.py` are
internally consistent by construction. So a change made on the PYTHON side
leaves every test in both languages green while the backend starts refusing a
value the form still offers. The user-visible result is an HTTP 400 from the
mint dialog for a value the dialog itself presented.

Both directions were verified silent before this module existed: renaming
`SCOPE_METRICS_READ` from `'metrics:read'` to `'metric:read'`, and adding a
Python-only `'personas:read'`, each left the whole MCP gate at `904 passed`,
exit 0, audit exit 0.

`test_mcp_tokens.py::TestVocabulary` pins each Python collection's exact
members; this file pins the two languages to EACH OTHER. Both are needed: the
former fails when a vocabulary changes at all, the latter fails when it changes
on only one side.

Same pattern as `test_search_minimum_lockstep.py` (TS ↔ Python search bound) and
`test_indexes.py` (CDK ↔ Python GSI names): parse the other language's source and
assert equality, so a change on either side fails CI instead of the live UI.

A full checkout is required, deliberately
-----------------------------------------
There is no `skipif` for a missing `frontend/` tree. An earlier version carried
one, reasoning that a backend-only sparse checkout should not report a mismatch
it never measured — but that tolerance could not take effect, for three reasons:

1. The positive control asserts the source exists and carries no marker, so the
   module failed on precisely the checkout the `skipif` existed to accommodate
   (`2 failed, 5 skipped`). The marker changed which test reported the problem,
   not whether one did.
2. `scripts/mcp_gate.py` floors this module on tests that RAN, so any skip drops
   it below its floor and fails the audit regardless.
3. The CI gate — the only consumer — always has a full checkout.

Failing loudly on a partial checkout is also the better behaviour: a mirror test
that quietly measures nothing is the exact failure mode this file exists to
prevent, applied to itself. So the file states the requirement instead of
pretending to degrade gracefully.
"""
import re
from pathlib import Path

from shared.mcp_tokens import REACH_NONE, VALID_READ_REACHES, VALID_SCOPES


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


# Every declaration this module compares against. Named in one place so the
# positive control below covers all of them — a rename of any one must fail
# loudly rather than leave its own comparison measuring nothing.
_MIRRORED_DECLARATIONS = ('READ_REACHES', 'OFFERED_READ_REACHES', 'MCP_SCOPES')


class TestTheFrontendSourceIsReadable:
    """The positive control for every comparison below.

    Without it, a rename to `MCP_READ_REACHES` would make the parser return None
    and each comparison would be measuring nothing — a green result meaning "did
    not check", which is the failure mode this file exists to prevent, applied to
    itself.
    """

    def test_the_schema_module_is_where_this_test_expects(self):
        assert _SCHEMA_SOURCE.exists(), (
            f'schema source moved: {_SCHEMA_SOURCE}. This module deliberately has no '
            'skipif for an absent frontend tree — see the file docstring — so point it '
            'at the new location rather than tolerating the miss.'
        )

    def test_every_mirrored_declaration_parses(self):
        unparsed = [name for name in _MIRRORED_DECLARATIONS if _parse_string_array(name) is None]
        assert not unparsed, (
            f'parsed no {unparsed} from mcpTokenSchema.ts. Either a declaration was '
            'renamed, or it is no longer a flat array literal this regex can read — in '
            'both cases the comparisons below would silently measure nothing.'
        )


class TestReadReachMirror:
    """How far a credential may read, agreed between the two languages."""

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

    def test_every_offered_reach_is_one_the_backend_accepts(self):
        """The offered set is deliberately NARROWER than the accepted set.

        `none` is accepted but not offered — it produces an inert credential
        while no write tool exists, per `mcpTokenSchema.ts`'s own comment. So
        this is a subset assertion, not equality: the form may withhold a reach,
        but it must never offer one the mint route will refuse.
        """
        offered = _parse_string_array('OFFERED_READ_REACHES')
        # Guarded for the same reason as the scope comparison: a rename is the
        # positive control's finding, not this test's.
        assert offered is not None, (
            'parsed no OFFERED_READ_REACHES from mcpTokenSchema.ts — see the positive '
            'control above'
        )
        assert set(offered) <= set(VALID_READ_REACHES), (
            f'the form offers {sorted(set(offered) - set(VALID_READ_REACHES))}, which the '
            'mint route refuses — the user would get a 400 for a value the dialog presented'
        )
        # Pins the reason the two sets differ, so re-offering `none` has to be a
        # deliberate edit here rather than a silent widening of the dialog.
        assert REACH_NONE not in offered, (
            'the form now offers `none`, which mints a credential that reads nothing — '
            'intended only once a write tool exists to make such a token useful'
        )


class TestScopeMirror:
    """WHICH domains a credential may read, agreed between the two languages.

    The reach axis above was mirrored first; this axis is the same coupling and
    was left unwatched. `mcpTokenSchema.ts`'s own comment claims `MCP_SCOPES`
    "Mirrors VALID_SCOPES in shared/mcp_tokens.py", and until this class that
    claim was enforced by nothing — no test under `lambda/` or `plugins/` read
    `MCP_SCOPES` at all.
    """

    def test_both_languages_agree_on_the_scope_vocabulary(self):
        """Set equality, because a scope is a mint-time boundary on both sides.

        Set rather than ordered: the frontend renders scope checkboxes from its
        own list and the backend stores a `frozenset`, so unlike the reach axis
        there is no user-visible ordering to pin. Membership is the contract.

        Both directions matter and both were silent:

        - a scope the frontend offers and the backend does not accept is a 400
          for a value the form presented (verified: renaming `'metrics:read'` to
          `'metric:read'` left the entire gate green);
        - a scope the backend accepts and the frontend never offers is mintable
          but unreachable through the UI, and if no tool consults it, it is the
          retired `read-write` phantom permission that `VALID_SCOPES`' own
          comment says it exists to prevent.
        """
        declared = _parse_string_array('MCP_SCOPES')
        # Guarded rather than allowed to raise: the positive control above is what
        # reports a rename, and this test failing on a TypeError next to it would
        # add noise pointing at the wrong line.
        assert declared is not None, (
            'parsed no MCP_SCOPES from mcpTokenSchema.ts — see the positive control above'
        )
        frontend_scopes = set(declared)
        assert frontend_scopes == set(VALID_SCOPES), (
            f'the form offers {sorted(frontend_scopes - set(VALID_SCOPES))} which the mint '
            f'route refuses, and the backend accepts '
            f'{sorted(set(VALID_SCOPES) - frontend_scopes)} which the form never offers. '
            'Add or remove a scope in mcpTokenSchema.ts and shared/mcp_tokens.py in the '
            'same change, along with the tool that requires it.'
        )
