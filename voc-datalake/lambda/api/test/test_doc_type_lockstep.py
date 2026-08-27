"""Lockstep test: the doc_type set the document route ACCEPTS and the set the
frontend can SEND must not drift apart.

`projects_handler.GENERATED_DOC_TYPES` is what POST /projects/{id}/document
validates against — anything outside it is a 400 raised before `create_job`. The
frontend declares the same set ONCE, as the `DocType` union in
`frontend/src/pages/ProjectDetail/types.ts`: the picker is built from it and both
`generateDocument` client signatures import it, so there is a single declaration to
pin. Nothing tied the two languages together, and the failure is user-visible
rather than loud: a client offering a value the route refuses turns a click into an
HTTP 400 from a document picker, and a client omitting one silently drops a feature
the backend supports.

Same pattern, and the same motivation, as `test_kiro_exportable_types_lockstep.py`
and `lambda/shared/test/test_search_minimum_lockstep.py`.

WHY THIS FILE IS SHORT NOW, and why it must not grow back (issue #381). It carried
~300 lines of TypeScript scanner — `_parameter_list_end`,
`GENERATE_DOCUMENT_ANCHOR`, `DOC_TYPE_ANNOTATION_ANCHOR`, `FINDABLE_SHAPES`,
`WIDENED_SHAPES`, `NARROWED_SHAPES` — for one reason: `client.ts` and
`projectsApi.ts` spelled `'prd' | 'prfaq'` INLINE, so the contract existed in three
places and checking the two inline copies meant locating a method by name inside an
object literal and delimiting its parameter list by bracket balance. Successive
review rounds on PR #377 each found a new way that mis-read legal TypeScript
(nested callback, column-0 latch, nested namespace, `//` and `/* */` comments,
unbalanced brackets, non-literal terms, an unreadable first term) — every one a
defect in the scanner, not in the contract. Both signatures now say
`doc_type: DocType`, which removes the drift axis instead of testing it: the copies
can no longer disagree, and TypeScript, not a regex, enforces it. If a signature
respells the union inline again, the fix is the import, not a parser.

`suggestDocumentBrief` also takes a `doc_type` and is still NOT pinned here: it
calls a different route which the comment above GENERATED_DOC_TYPES documents as
deliberately not sharing this allowlist (there the value picks a prompt label and
never reaches a key, a job type or a routing decision). Binding it here would turn
widening that route — a change the same comment invites — into a failure attributed
to this one. Reading only the `DocType` DECLARATION, rather than every `doc_type`
annotation in the client, keeps that separation with no scoping code at all.

The comparison SKIPS when the frontend tree is absent (a backend-only sparse
checkout should not report a mismatch it never measured), but
`test_the_frontend_declaration_is_findable` carries NO skip marker: it asserts the
source exists and parses, which is the check that must run — without it a rename
would make the parser return an empty set and the equality test would pass while
comparing nothing.

REVERT MAP — which mutation each part catches, so a deletion is a decision:
  * `test_the_frontend_declaration_is_findable` — `DocType` renamed or the file
    moved, leaving the equality test comparing empty sets.
  * `test_the_route_accepts_exactly_what_the_doc_type_union_offers` — the contract
    itself, in both directions.
  * `TestContractDriftIsCaught` — a parser that returns the allowlist however the
    union is edited, and its opposite, one that reports drift for a comment.
  * `TestTheUnionParser` — a legal restyling the parser reads wrongly or silently
    truncates. The findability control cannot cover this half: it reports that the
    parser found nothing in the source as it is TODAY, never that a Prettier-wrapped
    union or a commented-out predecessor would make it find nothing tomorrow. Every
    shape there is one an earlier version of this file read wrongly or not at all.
  * `test_the_guards_refuse_in_a_form_python_dash_o_keeps` — a refusal respelled as
    `assert`, which `-O` strips entirely.
"""
import re
from pathlib import Path

import pytest

# The TypeScript declaration that must agree with GENERATED_DOC_TYPES. Update this
# path if the file moves; a stale path fails the findability test rather than
# silently skipping.
DOC_TYPE_UNION_SOURCE = 'frontend/src/pages/ProjectDetail/types.ts'


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_tree_present() -> bool:
    return (_repo_root() / DOC_TYPE_UNION_SOURCE).is_file()


# A quoted string-literal member, in either quote style: TypeScript accepts both and
# Prettier's `singleQuote` setting decides which a file uses, so reading only one
# makes a formatter setting the difference between a parser that works and one that
# silently returns nothing.
QUOTED_MEMBER = r"""(?:'[^']+'|"[^"]+")"""
# A union TERM is a quoted literal OR a bare identifier. Identifiers are matched
# deliberately, not tolerated: `'prd' | 'prfaq' | ExtraDocType` cannot be compared
# against the allowlist, and reading the literals beside the identifier would
# truncate the union and PASS while the frontend can send whatever it admits — so it
# matches, and `_doc_type_union` refuses it by name. Widening this grammar further
# would be the wrong answer to the shapes it still misses (`(string & {})`,
# `` `${string}-draft` ``, `{ custom: string }`): TypeScript admits unboundedly many
# type expressions, so each addition only moves where the silence starts. The
# POSITIONAL check in `_doc_type_union` is what closes it instead.
UNION_TERM = rf"""(?:{QUOTED_MEMBER}|[A-Za-z_$][\w$]*)"""
MEMBER_LITERAL = re.compile(rf'^{QUOTED_MEMBER}$')
QUOTED_TEXT = re.compile(r"""['"]([^'"]+)['"]""")

# The TERMS, matched only once the anchor has said where the right-hand side starts.
# Split from the anchor deliberately: while they were one pattern, a declaration
# whose FIRST term is unreadable (`= (string & {}) | 'prd'`) matched NOTHING, so the
# parser returned an empty set, the equality test passed, and only the findability
# control fired — asking whether the type had been renamed while the declaration sat
# there, widened.
UNION_TERMS = re.compile(rf'{UNION_TERM}(?:\s*\|\s*{UNION_TERM})*')

# The optional trailing `|` matters: Prettier emits a leading pipe once a union
# exceeds the print width, so adding a third member — the very drift this file
# exists to catch — is a realistic route into a shape a pattern without it cannot
# read at all.
DOC_TYPE_UNION_ANCHOR = re.compile(r'export\s+type\s+DocType\s*=\s*\|?\s*')


def _without_comments(source: str) -> str:
    """`source` with `//` and `/* */` comment BODIES blanked, same length.

    🔑 Kept when the scanner around it went (issue #381), because `_doc_type_union`
    needs it just as much: `re.search` takes the FIRST match, so a commented-out
    older union above the live one is what gets read — reporting the dead
    declaration's members, or agreeing with the route while the live union has
    drifted. A comment BETWEEN members (`| 'prd' // the default`) truncates the
    union at the comment instead. Stubbing this out turns `commented_out_predecessor`
    and `commented` red. Same defect class as counting brackets on
    `line.split('#')[0]`: commentary is not a declaration.

    Blanked rather than deleted, newlines preserved, so indices still refer to the
    same place in the original. Quote state is tracked so a `//` inside a string is
    not mistaken for a comment; a regex literal containing `//` would be, but this
    is a type declaration and the shapes that occur are pinned in
    `TestTheUnionParser`.
    """
    def blanked(text: str) -> str:
        return ''.join('\n' if char == '\n' else ' ' for char in text)

    out: list[str] = []
    quote = None
    index = 0
    while index < len(source):
        char = source[index]
        if quote is not None:
            out.append(char)
            if char == '\\':
                out.append(source[index + 1:index + 2])
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in '\'"`':
            quote = char
            out.append(char)
            index += 1
            continue
        if source.startswith('//', index):
            newline = source.find('\n', index)
            stop = len(source) if newline == -1 else newline
            out.append(blanked(source[index:stop]))
            index = stop
            continue
        if source.startswith('/*', index):
            close = source.find('*/', index + 2)
            stop = len(source) if close == -1 else close + 2
            out.append(blanked(source[index:stop]))
            index = stop
            continue
        out.append(char)
        index += 1
    return ''.join(out)


def _doc_type_union(source: str) -> frozenset[str]:
    """The `DocType` members, an empty set if the declaration is gone, or a LOUD
    failure if the union cannot be compared against the route's allowlist.

    Reads `export type DocType = 'prd' | 'prfaq'` and its wrapped, leading-pipe,
    double-quoted and commented restylings; `UNION_SHAPES` is the list.

    A union can be unreadable in three positions and all three must be loud, because
    the quiet version of any of them is the same thing: a PASS reporting agreement
    with the route while the frontend admits values it refuses.

      * AT THE ANCHOR — nothing matches, because the first term is unreadable. An
        empty set is what a RENAMED type returns, so this used to report "no drift"
        and send the maintainer looking for a rename that had not happened.
      * A MATCHED NON-LITERAL — an identifier. It matches deliberately (see
        UNION_TERM) so the refusal can name it, rather than tightening the pattern
        until it stops matching and yields an empty set again.
      * AN UNREAD TERM — no pattern matched it, so the terms before it look like the
        whole union. Caught POSITIONALLY: a `|` after the match means something was
        left unread, whatever its shape. This is the only one of the three that does
        not depend on anyone having enumerated TypeScript's type expressions.

    Between them, a value comes back only when every `|`-separated term was read AND
    was a literal.

    `raise AssertionError` rather than `assert`: `python -O` strips `assert`, and a
    guard whose whole purpose is to not be the quiet option must not have a mode
    where it silently is. `pytest.raises(AssertionError)` is unaffected.
    """
    code = _without_comments(source)
    anchor = DOC_TYPE_UNION_ANCHOR.search(code)
    if anchor is None:
        return frozenset()
    terms_match = UNION_TERMS.match(code, anchor.end())
    if terms_match is None:
        raise AssertionError(
            f'the DocType union begins with a term this parser cannot read: '
            f'{code[anchor.end():anchor.end() + 60]!r}. Returning nothing here '
            f'would report no drift and blame a rename.'
        )
    matched = terms_match.group(0)
    terms = [term.strip() for term in matched.split('|') if term.strip()]
    non_literal = [term for term in terms if not MEMBER_LITERAL.match(term)]
    if non_literal:
        raise AssertionError(
            f'the DocType union has members that are not string literals: '
            f'{non_literal}. Those cannot be compared against the route\'s '
            f'allowlist, and reading only the literals beside them would PASS '
            f'while the frontend can send whatever they admit.'
        )
    unread = code[terms_match.end():].lstrip()
    if unread.startswith('|'):
        raise AssertionError(
            f'the DocType union continues past the terms this parser could read, '
            f'with {unread[:60]!r}. Reading only the members before it would report '
            f'agreement with the route while the frontend admits more. This says '
            f'only that the term could not be READ — a parenthesised or '
            f'backtick-quoted literal lands here too, and is still drift the '
            f'comparison cannot make.'
        )
    return frozenset(QUOTED_TEXT.findall(matched))


def _declared_doc_type_union() -> frozenset[str]:
    """`_doc_type_union` over the checked-in declaration."""
    return _doc_type_union(
        (_repo_root() / DOC_TYPE_UNION_SOURCE).read_text(encoding='utf-8')
    )


# Each value declares `prd` and `prfaq`, however it is styled. The reason a shape is
# here sits with the shape.
UNION_SHAPES = {
    # The declaration in types.ts today.
    'single_line': "export type DocType = 'prd' | 'prfaq'\n",
    # What Prettier produces once the union exceeds the print width — so adding a
    # third member, the drift this file exists to catch, is a realistic route into
    # this shape. An earlier pattern required a quoted literal straight after `=`.
    'leading_pipe': "export type DocType =\n  | 'prd'\n  | 'prfaq'\n",
    'wrapped_without_leading_pipe': "export type DocType =\n  'prd'\n  | 'prfaq'\n",
    # Quote style is a formatter setting, not a fact about the contract.
    'double_quoted': 'export type DocType = "prd" | "prfaq"\n',
    # A comment between the members, which must not end the union — in both
    # spellings, since `_without_comments` handles them by separate branches.
    'commented': "export type DocType =\n  | 'prd' // the default\n  | 'prfaq'\n",
    'block_commented':
        "export type DocType =\n  | 'prd' /* the default */\n  | 'prfaq'\n",
    # A commented-out predecessor above the live declaration: without comment
    # stripping the DEAD union is the first match, so it is what gets read.
    'commented_out_predecessor':
        "// export type DocType = 'prd' | 'prfaq' | 'legacy'\n"
        "export type DocType = 'prd' | 'prfaq'\n",
    # The shape types.ts has today: a leading comment explaining why this is the
    # only copy. It must not be read as the union.
    'documented': (
        '// 🔑 The ONE frontend declaration. Do not respell it inline; import it.\n'
        "export type DocType = 'prd' | 'prfaq'\n"
    ),
}


# Legal TypeScript that UNION_TERM does not match. In FIRST position nothing matches
# at all; in LAST position the pattern stops before it and the union looks complete.
# Both returned a value that compared equal to the allowlist, so both positions are
# parametrised over the same three members.
UNMATCHABLE_MEMBERS = ('(string & {})', '`${string}-draft`', '{ custom: string }')


class TestTheUnionParser:
    """`_doc_type_union` on synthetic declarations."""

    @pytest.mark.parametrize('shape', UNION_SHAPES.values(), ids=UNION_SHAPES)
    def test_the_members_are_found_however_the_union_is_styled(self, shape):
        assert _doc_type_union(shape) == frozenset({'prd', 'prfaq'}), (
            f'parsed {sorted(_doc_type_union(shape))} from:\n{shape}'
        )

    def test_a_three_member_union_is_read_whole(self):
        """The drift this file exists to catch is a member being ADDED, so the added
        one must be read — truncating to the first two reports agreement with the
        route while the picker offers a third value."""
        source = "export type DocType =\n  | 'prd'\n  | 'prfaq'\n  | 'onepager'\n"
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

    def test_a_renamed_type_yields_nothing(self):
        """The negative control: the findability check is only meaningful if an empty
        set really means the declaration was not found."""
        assert _doc_type_union("export type DocKind = 'prd' | 'prfaq'\n") == frozenset()

    def test_a_non_literal_member_fails_rather_than_truncating(self):
        """Reading only the literals beside an identifier returned {'prd','prfaq'}
        and PASSED, while the frontend could send whatever the identifier admits — a
        silent pass, which is the direction that matters here."""
        with pytest.raises(AssertionError, match='not string literals'):
            _doc_type_union("export type DocType = 'prd' | 'prfaq' | ExtraDocType\n")

    @pytest.mark.parametrize('member', UNMATCHABLE_MEMBERS)
    def test_an_unreadable_member_in_FIRST_position_refuses_at_the_anchor(self, member):
        """The position the positional guard cannot see: `= (string & {}) | 'prd'`
        matched nothing, and an empty set is what a renamed type returns — so the
        equality test read "no drift" and the control asked about a rename while the
        declaration sat there, widened."""
        with pytest.raises(AssertionError, match='begins with a term'):
            _doc_type_union(f"export type DocType = {member} | 'prd' | 'prfaq'\n")

    @pytest.mark.parametrize('member', UNMATCHABLE_MEMBERS)
    def test_a_member_the_grammar_cannot_read_fails_rather_than_ending_the_match(
        self, member
    ):
        """The half no term pattern can supply. Adding alternations would be endless
        — TypeScript admits arbitrarily many type expressions — so the positional
        check closes it for shapes nobody enumerated, which is why these are
        parametrised rather than each pinned as its own grammar."""
        with pytest.raises(AssertionError, match='continues past the terms'):
            _doc_type_union(f"export type DocType = 'prd' | 'prfaq' | {member}\n")

    # The refusals `_doc_type_union` must carry: no readable term at the anchor, a
    # matched non-literal, an unread term after the match.
    EXPECTED_REFUSALS = 3

    def test_the_guards_refuse_in_a_form_python_dash_o_keeps(self):
        """`assert` is stripped under `python -O`, and these guards exist to be the
        loud option — so none may have a mode where it is not.

        Read from the source rather than run under a second interpreter, because an
        `assert` compiles to nothing under `-O`: no runtime observation
        distinguishes "the guard passed" from "the guard was removed", which is the
        whole problem. Walked as an AST rather than matched as text, which two
        earlier versions got wrong in opposite directions — searching for `raise
        AssertionError` passed on a body with no raise at all, because this
        docstring names the phrase, and stripping the docstring line-by-line deleted
        code lines that equalled a short docstring line. A docstring is an `Expr`,
        never an `Assert`.

        The COUNT is the complement: the `assert` scan alone is also satisfied by
        there being no guard at all. LIMIT: `raise` is counted SYNTACTICALLY, so this
        cannot tell a reachable refusal from one behind an `if False:` —
        reachability is what the behavioural cases above cover.
        """
        import ast
        import inspect
        import textwrap

        # `getsource` starts at the def, so ast line numbers are offsets within it.
        # Rebase onto the file so a failure names a line you can open.
        first_line = _doc_type_union.__code__.co_firstlineno - 1
        tree = ast.parse(textwrap.dedent(inspect.getsource(_doc_type_union)))
        asserts = [
            f'line {first_line + node.lineno}'
            for node in ast.walk(tree) if isinstance(node, ast.Assert)
        ]
        raises = [node for node in ast.walk(tree) if isinstance(node, ast.Raise)]

        assert not asserts, (
            f'these parser guards refuse via `assert`, which `python -O` removes '
            f'entirely: {asserts}. Use `raise AssertionError(...)`.'
        )
        assert len(raises) >= self.EXPECTED_REFUSALS, (
            f'_doc_type_union should carry {self.EXPECTED_REFUSALS} refusals '
            f'(anchor, non-literal term, unread term); found {len(raises)}'
        )


# Edits to the exported union that MUST break the equality test below. One per
# direction, because the two are user-visible in different ways: an added member is
# a 400 from a picker, a removed one a backend capability nobody can reach.
DRIFTED_UNIONS = {
    'member_added': "export type DocType = 'prd' | 'prfaq' | 'onepager'\n",
    'member_removed': "export type DocType = 'prd'\n",
    'member_replaced': "export type DocType = 'prd' | 'onepager'\n",
}


class TestContractDriftIsCaught:
    """The complement of the equality test: that it is equality doing the work.

    Without these it could be green because the parser returns the allowlist however
    the union is edited — the "green result meaning did not check" this file exists
    to prevent, applied to itself. Both directions are here so neither can be
    satisfied by a parser that always agrees or always refuses.
    """

    @pytest.mark.parametrize('source', DRIFTED_UNIONS.values(), ids=DRIFTED_UNIONS)
    def test_a_changed_member_no_longer_matches_the_route(self, source):
        from projects_handler import GENERATED_DOC_TYPES

        assert _doc_type_union(source) != frozenset(GENERATED_DOC_TYPES), (
            f'this edit to DocType compares EQUAL to the route\'s allowlist, so '
            f'the lockstep test below cannot see it:\n{source}'
        )

    @pytest.mark.parametrize('shape', ['commented', 'commented_out_predecessor'])
    def test_a_legal_comment_leaves_the_result_matching_the_route(self, shape):
        """Restricted to the two comment shapes on purpose: the rest of
        `UNION_SHAPES` is reformatting, already pinned above against the same two
        members. A comment is the case where the parser reads the WRONG declaration
        rather than none, so `_without_comments` is the only thing standing between
        it and a report of drift the frontend does not have."""
        from projects_handler import GENERATED_DOC_TYPES

        assert _doc_type_union(UNION_SHAPES[shape]) == frozenset(GENERATED_DOC_TYPES)


class TestDocTypeLockstep:
    """The route refuses what the client cannot send, so the two must agree."""

    def test_the_frontend_declaration_is_findable(self):
        """The positive control. Renaming `DocType` would make the parser return
        nothing and leave the equality test passing while comparing empty sets — the
        failure mode this file exists to prevent, applied to itself."""
        union_path = _repo_root() / DOC_TYPE_UNION_SOURCE
        assert union_path.is_file(), f'DocType source moved: {DOC_TYPE_UNION_SOURCE}'
        assert _declared_doc_type_union(), (
            f'parsed no DocType union members from {DOC_TYPE_UNION_SOURCE} — '
            f'was the type renamed? (Legal restylings of the union are covered by '
            f'TestTheUnionParser, so a reformatting should not land here.)'
        )

    @pytest.mark.skipif(
        not _frontend_tree_present(), reason='frontend tree absent from this checkout'
    )
    def test_the_route_accepts_exactly_what_the_doc_type_union_offers(self):
        """Equality, not containment.

        A frontend value the route refuses is a 400 from a picker; a route value the
        frontend never offers is a backend capability no user can reach. Both are
        drift, so neither direction is allowed.

        This is the whole contract now that both `generateDocument` signatures import
        `DocType` instead of respelling it: TypeScript rejects a request body outside
        the union, and this test pins the union to the allowlist.
        """
        from projects_handler import GENERATED_DOC_TYPES

        declared = _declared_doc_type_union()
        assert declared == frozenset(GENERATED_DOC_TYPES), (
            f'DocType in {DOC_TYPE_UNION_SOURCE} declares {sorted(declared)} '
            f'while the route accepts {sorted(GENERATED_DOC_TYPES)}.\n'
            f'  Offered but refused (a user-visible 400): '
            f'{sorted(declared - frozenset(GENERATED_DOC_TYPES))}\n'
            f'  Accepted but never offered (unreachable): '
            f'{sorted(frozenset(GENERATED_DOC_TYPES) - declared)}'
        )
