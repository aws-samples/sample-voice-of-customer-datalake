"""Guard tests for the MCP credential vocabulary, mirrored in Python and TypeScript.

`shared/mcp_tokens.py` owns both axes of what a credential may do:
`VALID_SCOPES` (which domains it may read) and `VALID_READ_REACHES` (how far),
plus `DEFAULT_READ_REACH`, the reach assumed when a stored row does not state one.
`projects_handler`'s mint route refuses anything outside either vocabulary, and
`mcp_handler` enforces both on every read. `frontend/src/api/mcpTokenSchema.ts`
declares its own `MCP_SCOPES`, `READ_REACHES` and `DEFAULT_READ_REACH`, which
decide what the mint form offers and what `normalizeApiTokens` will parse back.

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

Comments are stripped before parsing
------------------------------------
The readers pull every single-quoted token out of the declaration span they match,
which meant a `//`-commented entry inside a mirrored array was read as a live
member — see `_strip_comments`. That produced a failure in the safe DIRECTION (a
false positive rather than a missed drift) but with an actively wrong DIAGNOSIS:
the message named a value the form does not offer and prescribed adding it to both
languages. For a file whose entire value is that a reader trusts its verdict about
a language they may not be working in, a misleading message is close to as costly
as a missed one.

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
3. The supported consumers — local full-backend testing and the manually-
   dispatched MCP workflow — both use a full checkout.

Failing loudly on a partial checkout is also the better behaviour: a mirror test
that quietly measures nothing is the exact failure mode this file exists to
prevent, applied to itself. So the file states the requirement instead of
pretending to degrade gracefully.
"""
import re
import sys
from pathlib import Path

from shared.mcp_tokens import (
    DEFAULT_READ_REACH,
    REACH_NONE,
    VALID_READ_REACHES,
    VALID_SCOPES,
)


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


_SCHEMA_SOURCE = _repo_root() / 'frontend' / 'src' / 'api' / 'mcpTokenSchema.ts'


def _strip_comments(source: str) -> str:
    """TypeScript source with `//` and `/* */` comments blanked out.

    Necessary because both readers below pull every single-quoted token out of the
    span they match, and neither has any notion of a comment. A commented-out entry
    INSIDE a mirrored array was therefore read as a live member:

        export const MCP_SCOPES = [
          // 'personas:read' lands with the persona tool
          'feedback:read', 'metrics:read', 'projects:read',
        ] as const

    made the scope mirror fail with "the form offers ['personas:read'] which the
    mint route refuses" — a value the form does not offer, prescribing a fix that
    would be wrong. The failure direction was safe (a false positive, not a missed
    drift) but the diagnosis was not, and this file's whole value is that a reader
    trusts its verdict about a language they may not be working in.

    Comments are replaced by spaces rather than deleted so that offsets, and hence
    the `[^\\]]*` array span, are unchanged: a comment containing a `]` must not
    make the span end early or, worse, extend to a later bracket.

    String literals are walked rather than regex-replaced, so a legitimate `'//'`
    or `'/*'` inside a quoted value is preserved — the URL-in-a-constant case that
    a naive `//.*$` substitution would truncate.

    This does not parse JavaScript/TypeScript regular-expression literals. An
    unescaped comment opener inside one would be blanked; the current schema has
    no such literal, and that under-read fails the positive or mirror checks rather
    than silently passing.
    """
    out: list[str] = []
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        # Inside a string or template literal, nothing starts a comment. Consumed
        # verbatim, honouring backslash escapes so an escaped quote does not end it.
        if char in '\'"`':
            quote = char
            out.append(char)
            index += 1
            while index < length:
                if source[index] == '\\' and index + 1 < length:
                    out.append(source[index:index + 2])
                    index += 2
                    continue
                out.append(source[index])
                index += 1
                if source[index - 1] == quote:
                    break
            continue
        if source.startswith('//', index):
            while index < length and source[index] != '\n':
                out.append(' ')
                index += 1
            continue
        if source.startswith('/*', index):
            end = source.find('*/', index + 2)
            end = length if end == -1 else end + 2
            # Newlines kept so line-oriented reading of the result still lines up.
            out.append(''.join('\n' if c == '\n' else ' ' for c in source[index:end]))
            index = end
            continue
        out.append(char)
        index += 1
    return ''.join(out)


def _schema_source() -> str | None:
    """The schema module's text with comments blanked, or None if it is absent."""
    if not _SCHEMA_SOURCE.exists():
        return None
    return _strip_comments(_SCHEMA_SOURCE.read_text())


def _parse_string_array(name: str) -> tuple[str, ...] | None:
    """The named `as const` / typed string array from the schema module, in order.

    Returns None when the declaration is not found, so a rename shows up as the
    positive control failing rather than as an empty comparison passing.
    """
    source = _schema_source()
    if source is None:
        return None
    match = re.search(
        rf'export\s+const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*\[([^\]]*)\]',
        source,
    )
    if match is None:
        return None
    return tuple(re.findall(r"'([^']*)'", match.group(1)))


def _parse_string_constant(name: str) -> str | None:
    """The named single-quoted string constant from the schema module.

    `export const DEFAULT_READ_REACH: ReadReach = 'workspace'` — a scalar rather
    than an array, so it needs its own reader. Returns None on a miss for the same
    reason as `_parse_string_array`: a rename must surface as the positive control
    failing, not as a comparison against nothing.
    """
    source = _schema_source()
    if source is None:
        return None
    match = re.search(
        rf"export\s+const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*'([^']*)'",
        source,
    )
    return None if match is None else match.group(1)


def _use_schema_source(tmp_path: Path, monkeypatch, source: str) -> None:
    schema_source = tmp_path / 'mcpTokenSchema.ts'
    schema_source.write_text(source)
    monkeypatch.setattr(sys.modules[__name__], '_SCHEMA_SOURCE', schema_source)


# Every declaration this module compares against, mapped to the reader that can
# parse it. Named in one place so the positive control below covers all of them —
# a rename of any one must fail loudly rather than leave its own comparison
# measuring nothing.
_MIRRORED_DECLARATIONS = {
    'READ_REACHES': _parse_string_array,
    'OFFERED_READ_REACHES': _parse_string_array,
    'MCP_SCOPES': _parse_string_array,
    'DEFAULT_READ_REACH': _parse_string_constant,
}


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
        unparsed = [name for name, read in _MIRRORED_DECLARATIONS.items() if read(name) is None]
        assert not unparsed, (
            f'parsed no {unparsed} from mcpTokenSchema.ts. Either a declaration was '
            'renamed, or it is no longer the flat array or quoted-string literal the '
            'matching reader can read — in both cases the comparisons below would '
            'silently measure nothing.'
        )


class TestTheReadersIgnoreComments:
    """A commented-out entry is not a member, and a comment cannot hide one.

    The readers pull every single-quoted token out of the span they match, so
    without comment-stripping a `//`-commented line inside a mirrored array was
    parsed as live. Verified before the fix: adding
    `// 'personas:read' lands with the persona tool` inside `MCP_SCOPES` made the
    scope mirror fail with "the form offers ['personas:read'] which the mint route
    refuses" — asserting something untrue about the form and prescribing the wrong
    remedy.

    These cases run against synthetic source rather than the real file, so they
    keep testing the reader after the real file's formatting changes.
    """

    def test_a_commented_out_entry_is_not_read_as_a_member(self, tmp_path, monkeypatch):
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "export const MCP_SCOPES = [\n"
            "  // 'line:ignored' is retired\n"
            "  'line:first',\n"
            "  'line:second',\n"
            '] as const\n',
        )
        assert _parse_string_array('MCP_SCOPES') == ('line:first', 'line:second')

    def test_a_block_comment_inside_a_declaration_is_not_read(
        self, tmp_path, monkeypatch
    ):
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "export const MCP_SCOPES = [\n"
            "  /* 'block:ignored', 'block:also-ignored' */\n"
            "  'block:live',\n"
            '] as const\n',
        )
        assert _parse_string_array('MCP_SCOPES') == ('block:live',)

    def test_a_trailing_comment_does_not_change_a_scalar(self, tmp_path, monkeypatch):
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "export const DEFAULT_READ_REACH: ReadReach = 'scalar-live' "
            "// not 'scalar-ignored'\n",
        )
        assert _parse_string_constant('DEFAULT_READ_REACH') == 'scalar-live'

    def test_a_bracket_inside_a_comment_does_not_truncate_the_span(
        self, tmp_path, monkeypatch
    ):
        """Why comments are blanked rather than deleted.

        The array span is matched with `[^\\]]*`, so a `]` inside a comment would
        end it early and the members after the comment would be lost — a silent
        under-read, which is the dangerous direction.
        """
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "export const MCP_SCOPES = [\n"
            '  // see BracketReach[] for the other axis\n'
            "  'bracket:first',\n"
            "  'bracket:second',\n"
            '] as const\n',
        )
        assert _parse_string_array('MCP_SCOPES') == ('bracket:first', 'bracket:second')

    def test_a_quoted_slash_slash_is_not_treated_as_a_comment(
        self, tmp_path, monkeypatch
    ):
        """`'//'` inside a string is data, not the start of a comment.

        A naive `//.*$` substitution would truncate the rest of the line, dropping
        real members declared after such a value.
        """
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "export const THINGS = ['https://example.test', 'url:after'] as const\n",
        )
        assert _parse_string_array('THINGS') == ('https://example.test', 'url:after')

    def test_the_real_source_still_yields_non_empty_declarations(self):
        """Comment-stripping must not break the file it exists to read.

        The schema module is heavily commented — including a docblock that names
        `'workspace'`, `'project-set'` and `'none'` in prose ABOVE the constant
        declaring them, and a `/** ... */` block immediately before `MCP_SCOPES`.
        A reader that stripped too little would pick those prose mentions up; one
        that stripped too much, or mishandled the offsets, would return an empty
        tuple here and every comparison below would pass while measuring nothing.

        Deliberately asserts only shape, not values: the comparisons in the classes
        below are what pin the values, and duplicating them here would mean two
        places to edit for one legitimate vocabulary change.
        """
        empty = [
            name
            for name, read in _MIRRORED_DECLARATIONS.items()
            if not read(name)
        ]
        assert not empty, (
            f'parsed nothing for {empty} from the real mcpTokenSchema.ts. If the '
            'declarations are present, comment-stripping consumed too much — the '
            'comparisons below would then be measuring nothing.'
        )

    def test_prose_mentions_above_a_declaration_are_not_read_as_members(
        self, tmp_path, monkeypatch
    ):
        """The specific over-read the real file invites.

        `READ_REACHES` is preceded by a docblock listing each reach in prose
        (`` - `workspace` — the default...``). Those are backtick-quoted rather
        than single-quoted so they never matched, but the `MCP_SCOPES` docblock
        does contain single-quoted names (`` `read` / `read-write` `` and
        `'personas:read'`-shaped notes are the natural thing to add there). The
        array span starts at the `[`, so a docblock above it is outside the span
        anyway — this pins that, since a future reader made more permissive to
        tolerate a formatting change could easily lose it.
        """
        _use_schema_source(
            tmp_path,
            monkeypatch,
            "/**\n"
            " * Mirrors VALID_SCOPES. The retired 'prose:ignored' scope is gone.\n"
            " */\n"
            "export const MCP_SCOPES = ['prose:live'] as const\n",
        )
        assert _parse_string_array('MCP_SCOPES') == ('prose:live',)


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

    def test_both_languages_agree_on_the_default_reach(self):
        """The reach assumed when a stored row does not state one.

        Not a list axis, and its consequence is narrower than the two above — a
        divergence here produces no 400, because the frontend constant is a
        `z.enum(...).catch(...)` fallback for a row whose `read_reach` is absent or
        unparseable. But that is precisely the case where the two must agree, and
        `mcpTokenSchema.ts`'s own docstring says why: "Defaults mirror the backend's
        own reading of a partial row (shared/mcp_tokens.py): an absent read_reach is
        'workspace', because that is what enforcement assumes. Choosing a
        safer-looking default here would be the wrong call — it would show a
        credential as narrower than it really is."

        So a drift means the UI describes a credential's reach differently from how
        the backend enforces it — the harm that file exists to prevent — and both
        sides were pinned only against themselves (`mcpTokenSchema.test.ts` asserts
        `toBe('workspace')`, `test_mcp_tokens.py` asserts `== REACH_WORKSPACE`),
        which is the same internally-consistent-by-construction shape as the axes
        above.
        """
        declared = _parse_string_constant('DEFAULT_READ_REACH')
        # Guarded rather than allowed to compare against None: a rename is the
        # positive control's finding, not this test's.
        assert declared is not None, (
            'parsed no DEFAULT_READ_REACH from mcpTokenSchema.ts — see the positive '
            'control above'
        )
        assert declared == DEFAULT_READ_REACH, (
            f'the frontend assumes a partial row means {declared!r} while the backend '
            f'enforces {DEFAULT_READ_REACH!r}. A token row with no read_reach would be '
            'displayed with one reach and enforced with another — and if the frontend '
            'value is the narrower of the two, the UI shows a credential as more '
            'restricted than it actually is.'
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
