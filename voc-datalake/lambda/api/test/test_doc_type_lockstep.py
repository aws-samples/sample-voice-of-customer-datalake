"""Lockstep test: the doc_type set the document route ACCEPTS and the set the
frontend can SEND must not drift apart.

`projects_handler.GENERATED_DOC_TYPES` is what POST /projects/{id}/document
validates against — anything outside it is a 400 raised before `create_job`. The
frontend declares the same set ONCE, as the `DocType` union in
`frontend/src/api/types.ts`, and reaches this route through ONE named request body,
`GenerateDocumentBody`, whose `doc_type` field is that union. Nothing tied the two
languages together, and the failure is user-visible rather than loud: a client
offering a value the route refuses turns a click into an HTTP 400 from a document
picker, and a client omitting one silently drops a feature the backend supports.

Same pattern, and the same motivation, as `test_kiro_exportable_types_lockstep.py`
and `lambda/shared/test/test_search_minimum_lockstep.py`.

WHY THIS FILE IS SHORT NOW, and why it must not grow back (issue #381). It carried
~300 lines of TypeScript scanner — `_parameter_list_end`,
`GENERATE_DOCUMENT_ANCHOR`, `DOC_TYPE_ANNOTATION_ANCHOR`, `FINDABLE_SHAPES`,
`WIDENED_SHAPES`, `NARROWED_SHAPES` — for one reason: `client.ts` and
`projectsApi.ts` spelled `'prd' | 'prfaq'` INLINE inside their `generateDocument`
signatures, so the contract existed in three places and checking the two inline
copies meant locating a method by name inside an object literal and delimiting its
parameter list by bracket balance. Every review round on that scanner found another
shape of legal TypeScript it mis-read; none found a defect in the contract. Both
signatures now take `GenerateDocumentBody`, which removes the drift axis rather
than testing it.

WHAT ENFORCES WHICH HALF, measured rather than assumed — the compiler does NOT do
all of it, and an earlier version of this docstring claimed it did:
  * `DocType` -> the route's allowlist: THIS file, by parsing the declaration.
    Nothing in TypeScript knows what Python accepts.
  * `GenerateDocumentBody.doc_type` -> `DocType`: the compiler, but ONLY because
    `DocTypeFieldIsExactlyTheUnion` in that file compares the two. Spelling the
    union in the field is not self-enforcing and this file cannot see the field: it
    parses the `export type DocType =` declaration and nothing else, so respelling
    the field `'prd' | 'prfaq' | 'onepager'` was measured to exit `tsc` 0 and pass
    every test here. The signature pin below cannot help either — it compares
    against this interface, so a widened one satisfies it by construction.
    ⚠️ What that pin checks is SET EQUALITY, not reference: the field must admit
    exactly `DocType`'s members, and a same-member respelling (`'prd' | 'prfaq'`,
    no reference at all) PASSES it. Measured — earlier versions of this file claimed
    the opposite in five places, the last of them surviving a round that was
    supposed to have corrected all of them, so treat "reference" phrasing about
    either pin as a bug wherever it turns up. Equality is the sufficient property:
    the coincidence is harmless today and becomes a TS2344 the moment `DocType` is
    widened, so the drift is still caught where it would be introduced.
  * The two `generateDocument` signatures -> `GenerateDocumentBody`: the compiler
    for `client.ts`, which forwards its `data` into `projectsApi.generateDocument`
    and so gets a TS2345 if it widens. `projectsApi.generateDocument` is the
    TERMINAL consumer — its `data` is only spread into `JSON.stringify`, so its
    annotation is compared against nothing and by itself type-checks however wide it
    is. `GenerateDocumentTakesTheSharedBody` in that file is what closes it, by
    comparing the parameter to the interface. NAMING the type is not sufficient on
    its own — an `Omit<GenerateDocumentBody, 'doc_type'> & { doc_type: ...
    | 'onepager' }` annotation uses the name and still widens, and was measured to
    exit `tsc` 0 with every test here green. `noUnusedLocals` does NOT cover that
    either, since the name is used.
    So a widening has to edit `DocType` itself — the declaration this file parses —
    and `GENERATED_DOC_TYPES` with it. Editing `GenerateDocumentBody.doc_type` is
    not a way around that: the pin above makes it a compiler error.

WHY EACH GUARD IS THE KIND IT IS. The rule this file has converged on over several
rounds, each of which found the same hole one level further in: a link TypeScript can
check gets a COMPILER check, and text assertions are reserved for the ones it cannot.
Both pins are type-level comparisons rather than `'... in source'` assertions for
exactly that reason — a text check on a field or a parameter would have to enumerate
the spellings that widen it (enumerated members, an intersection, `Omit`, a widened
alias), and enumerating legal TypeScript is what the deleted scanner did and why it
was deleted.

A COMPARISON RATHER THAN A CLAUSE, for the same reason. The parameter link was first
closed with `satisfies GenerateDocumentBody` inside the method body — equivalent for
the compiler, but a clause has a LOCATION, so from Python it needed a text guard
saying where it sat, and every bound tried was evadable: a whole-file check passed
with the clause moved to an unrelated helper, and narrowing to the slice before the
next named method passed with the clause in a NEW method inserted into that slice.
Both measured, `tsc` exit 0 and every test here green while the axis was reopened.
`GenerateDocumentTakesTheSharedBody` compares the method's own parameter type, which
has nowhere to migrate to, so the guard, its two method-name markers and their
ordering assumption all went.

The text assertions that remain pin the PRESENCE of things whose absence is silent
(the two type-level pins, and that each is still spelled as a comparison rather than
stubbed to a constant) and the ONE link no compiler can see: `DocType` against a
Python tuple.

A `.test-d.ts`-style type test was considered for that job and REJECTED, so it does
not get proposed again: `typecheck:tests` is not in the root `check` chain
(`typecheck:all` is `typecheck && typecheck:cdk && typecheck:stream`), so a type
assertion living under a test tsconfig would be checked by no gate. The pin lives in
`api/types.ts` — production source that `npm run typecheck` already compiles — which
is why it needs no new wiring. If `typecheck:tests` is ever added to that chain, a
type test becomes a reasonable home for it; until then it would be a control nothing
runs.

A LITERAL UNION IS THE REQUIRED SHAPE for `DocType`. A derivation
(`typeof GENERATED_DOC_TYPES[number]`, as `KIRO_EXPORTABLE_DOC_TYPES` uses one
directory away) is refused by `_doc_type_union`, deliberately and permanently:
resolving an alias means evaluating TypeScript, which is what the deleted scanner
tried and is the whole reason it was deleted. If the frontend wants a runtime array
of doc types, declare the array FROM the union (`const DOC_TYPES: DocType[] = [...]`)
rather than the union from the array, so the pinned declaration stays a literal
union. The same answer applies to `test_kiro_exportable_types_lockstep.py`, which
therefore cannot share this parser.

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
  * `test_both_client_signatures_use_the_shared_request_body` — a signature
    respelling the body inline again, which is a compiler error in `client.ts` and
    NOTHING in `projectsApi.ts` (see above). Text, not a parse: it asks whether the
    shared name appears, so it needs no model of TypeScript and cannot mis-read a
    restyling. A rename of `GenerateDocumentBody` fails it too, which is correct —
    the constant here is what the two files must agree on.
  * `test_the_type_level_pins_are_present` — either type-level pin deleted, STUBBED
    to a bare constant, or left with only one of its two controls. All are silent
    otherwise: deleting a pin compiles cleanly, and stubbing both a pin and its
    control to `= true` / `= false` was measured to exit `tsc` 0 and pass every test
    here while the guarded field was widened. So the assertion SPELLING is required,
    and it names the pin's USE of the verdict helper (`MustBeTrue<BothWays<`) — an
    earlier version required only `MustBeTrue<`, which the helper's OWN declaration
    contains, so exporting the helpers and stubbing the pins passed every gate.
    Covers both links: the field-vs-union pin, and the parameter-vs-body pin that
    replaced the `satisfies` clause and the location guard it needed — see WHY EACH
    GUARD IS THE KIND IT IS for why a comparison was the answer and a tighter text
    slice was not.
  * The `...WouldSeeNarrowing` controls — `BothWays` collapsed to a one-way
    `extends`, which admits a NARROWED field or parameter: the "capability nobody
    can reach" half of this contract's drift. The widened-side controls cannot see
    that collapse (a superset fails the one-way test too), and it was measured to
    leave `tsc` at exit 0 with every test here green.
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
DOC_TYPE_UNION_SOURCE = 'frontend/src/api/types.ts'

# The named request body both `generateDocument` signatures must take, and the two
# files that must take it. `client.ts` only wraps `projectsApi.ts`, so a body type
# in one and an inline object literal in the other is the shape this pins against —
# see the docstring: the compiler catches that in one file and not the other.
REQUEST_BODY_TYPE = 'GenerateDocumentBody'

# The TERMINAL client — the one whose `data` is only spread into `JSON.stringify`, so
# its annotation is checked against nothing and naming the body type is not enough on
# its own (an `Omit<..> & { doc_type: .. | 'x' }` respelling names it and still
# widens).
TERMINAL_CLIENT = 'frontend/src/api/projectsApi.ts'

# The two type-level pins that carry every link TypeScript can check, each with the
# file it is declared in and its non-vacuity control. A pin's own absence is SILENT —
# delete either block and the frontend still compiles — which is the only reason this
# file mentions them at all: `test_the_type_level_pins_are_present` keeps them there.
#
# 🔑 A pin is spelled `<Name> = <Verdict><Comparison<...>>`, and the SPELLINGS BELOW
# INCLUDE THE COMPARISON, not just the verdict helper. Both halves of that were
# measured, one review round apart:
#
#   * Requiring only the NAMES was vacuous. Stub a pin and its control to bare
#     constants (`export type DocTypeFieldIsExactlyTheUnion = true`), delete the helper
#     types so no unused-local fires, and `tsc` exits 0 with every test here green
#     while the field they guard is widened past the route's allowlist.
#   * Requiring `MustBeTrue<` was ALSO vacuous, for a subtler reason: that substring
#     occurs in the helper's OWN declaration (`type MustBeTrue<Verdict ...>`), so it is
#     satisfied by the helper merely existing. The stub only has to keep the helpers
#     and `export` them — measured, `tsc` exit 0 and every test here green with the
#     field widened. So the spelling must name the pin's USE of the helper, which
#     `MustBeTrue<BothWays<` does and a declaration cannot accidentally contain.
#
# This is why the pins in both files are written on ONE line: the substring spans the
# helper and the comparison, so a wrapped declaration puts a newline between them.
#
# Keyed by relative path, since the pins live in two files. Each value is
# (pin, controls, assertion-spellings) — the controls and spellings are tuples because
# each pin needs TWO controls (widened and narrowed; see below).
TYPE_LEVEL_PINS = {
    # `GenerateDocumentBody.doc_type` admits exactly the members of `DocType`. Nothing
    # else in either language sees this field: this file parses only the
    # `export type DocType =` declaration, and the signature pin below compares
    # against the interface, so a widened interface satisfies it by construction.
    DOC_TYPE_UNION_SOURCE: (
        'DocTypeFieldIsExactlyTheUnion',
        ('DocTypeFieldPinWouldSeeDrift', 'DocTypeFieldPinWouldSeeNarrowing'),
        ('MustBeTrue<BothWays<', 'MustBeFalse<BothWays<'),
    ),
    # `generateDocument`'s parameter admits exactly `GenerateDocumentBody`. This is the
    # one that replaced a `satisfies` clause in the method body plus the text guard
    # that pinned WHERE the clause sat — see the docstring's WHY EACH GUARD IS THE KIND
    # IT IS: a clause has a location and could be migrated out of whatever slice was
    # searched, and both slices tried were measured to be evadable. A comparison
    # against the method's own type has nowhere to migrate to.
    TERMINAL_CLIENT: (
        'GenerateDocumentTakesTheSharedBody',
        (
            'GenerateDocumentSignaturePinWouldSeeDrift',
            'GenerateDocumentSignaturePinWouldSeeNarrowing',
        ),
        ('SignatureMustMatch<BothWays<', 'SignatureMustDiffer<BothWays<'),
    ),
}

# Both clients, the terminal one included rather than respelled — a second copy of
# that path here is the same duplication this whole issue was about.
GENERATE_DOCUMENT_CLIENTS = (
    TERMINAL_CLIENT,
    'frontend/src/api/client.ts',
)


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
    # A DOCUMENTING comment — one whose subject IS this declaration — that quotes the
    # declaration to say what not to do with it. Distinct from the case above, which
    # is dead code: this one is prose a maintainer is invited to write, and the
    # comment `types.ts` carries today already quotes the members
    # (``respelling `'prd' | 'prfaq'` inline``). It becomes the first `re.search`
    # match the moment someone quotes the whole `export type` line in it, which is a
    # natural edit in a comment about that line. An earlier version of this fixture
    # quoted NEITHER, so it parsed the same whether `_without_comments` ran or not
    # and pinned nothing.
    'documented': (
        '// 🔑 The ONE declaration. Not '
        "`export type DocType = 'prd' | 'legacy'` — import this one.\n"
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
        # EXACTLY, now that one function carries all three: `>=` also passed on a
        # guard duplicated rather than moved, and there is no reason for a fourth
        # raise in a parser with three unreadable positions.
        assert len(raises) == self.EXPECTED_REFUSALS, (
            f'_doc_type_union should carry exactly {self.EXPECTED_REFUSALS} refusals '
            f'(anchor, non-literal term, unread term); found {len(raises)}'
        )


def _rendered_union(members: tuple[str, ...], comment: str = '') -> str:
    """`export type DocType = ...` over `members`.

    With a `comment`, one member per line and the comment after the FIRST — the
    position where it truncates the union if it is not stripped.

    Rendered from the members rather than written out because the controls below
    compare against the LIVE allowlist: fixtures pinned to today's two values would
    turn a legitimate widening of the contract into three extra failures in the one
    file whose job is to point at the single real one.
    """
    quoted = [f"'{member}'" for member in members]
    if not comment:
        return f"export type DocType = {' | '.join(quoted)}\n"
    terms = [f'  | {term}' for term in quoted]
    terms[0] = f'{terms[0]} {comment}'
    return 'export type DocType =\n' + '\n'.join(terms) + '\n'


def _member_the_route_refuses(accepted: frozenset[str]) -> str:
    """A doc_type value outside `accepted`, for the widening mutations.

    Derived rather than hardcoded for the same reason: if `onepager` is ever added
    to the allowlist, a mutation using it would compare EQUAL and the control would
    pass while measuring nothing.
    """
    candidate = 'onepager'
    while candidate in accepted:
        candidate = f'{candidate}_unaccepted'
    return candidate


# The three ways the exported union can drift from the allowlist. Named, and turned
# into sources inside the test, because deriving them needs the handler imported —
# which the tests here do in their bodies, not at collection time.
DRIFT_KINDS = ('member_added', 'member_removed', 'member_replaced')


class TestContractDriftIsCaught:
    """The complement of the equality test: that it is equality doing the work.

    Without these it could be green because the parser returns the allowlist however
    the union is edited — the "green result meaning did not check" this file exists
    to prevent, applied to itself. Both directions are here so neither can be
    satisfied by a parser that always agrees or always refuses.
    """

    @pytest.mark.parametrize('kind', DRIFT_KINDS)
    def test_a_changed_member_no_longer_matches_the_route(self, kind):
        """Each direction is user-visible in a different way: an added member is a
        400 from a picker, a removed one a backend capability nobody can reach."""
        from projects_handler import GENERATED_DOC_TYPES

        accepted = tuple(GENERATED_DOC_TYPES)
        extra = _member_the_route_refuses(frozenset(accepted))
        if kind == 'member_removed' and len(accepted) < 2:
            # REMOVAL only. Dropping the last member leaves `export type DocType =`
            # with no union at all, which the parser REFUSES rather than returning a
            # set to compare — a different test than this one. Skipped rather than
            # silently reinterpreted.
            #
            # `member_replaced` is deliberately NOT skipped here: on a one-member
            # allowlist `(*accepted[:-1], extra)` is `(extra,)`, a valid
            # single-member union the parser reads cleanly and which compares
            # unequal, so the control still works. Widening the skip to cover it
            # would drop a working control the moment the contract narrowed to one
            # value — a green result meaning "did not check", which is the failure
            # this class exists to prevent.
            pytest.skip('the route accepts one value; removal leaves no union to parse')
        mutations = {
            'member_added': (*accepted, extra),
            'member_removed': accepted[:-1],
            'member_replaced': (*accepted[:-1], extra),
        }
        source = _rendered_union(mutations[kind])

        assert _doc_type_union(source) != frozenset(GENERATED_DOC_TYPES), (
            f'this edit to DocType compares EQUAL to the route\'s allowlist, so '
            f'the lockstep test below cannot see it:\n{source}'
        )

    @pytest.mark.parametrize(
        'shape', ['between_members', 'commented_out_predecessor', 'documented']
    )
    def test_a_legal_comment_leaves_the_result_matching_the_route(self, shape):
        """Restricted to the comment shapes on purpose: the rest of `UNION_SHAPES` is
        reformatting, already pinned above against its own members. A comment is the
        case where the parser reads the WRONG declaration rather than none, so
        `_without_comments` is the only thing standing between it and a report of
        drift the frontend does not have.

        All three quote or carry a full declaration, so each goes red if
        `_without_comments` is stubbed to a pass-through — which is how to check that
        they measure what they claim.
        """
        from projects_handler import GENERATED_DOC_TYPES

        accepted = tuple(GENERATED_DOC_TYPES)
        live = _rendered_union(accepted)
        dead = _rendered_union((*accepted, _member_the_route_refuses(frozenset(accepted))))
        shapes = {
            'between_members': _rendered_union(accepted, '// the default'),
            'commented_out_predecessor': f'// {dead}{live}',
            'documented': f'// The ONE declaration. Not `{dead.strip()}`.\n{live}',
        }

        assert _doc_type_union(shapes[shape]) == frozenset(GENERATED_DOC_TYPES)


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

        This half of the contract is only checkable HERE: TypeScript has no idea what
        Python accepts. The compiler's half is that `GenerateDocumentBody.doc_type`
        admits EXACTLY this union's members, in both directions — set equality, NOT
        reference: a same-member respelling of the field passes, and is harmless for
        the reason given on `BothWays`. That is enforced by
        `DocTypeFieldIsExactlyTheUnion` in `frontend/src/api/types.ts` and kept present
        by `test_the_type_level_pins_are_present`. Not by
        `test_both_client_signatures_use_the_shared_request_body`, which an earlier
        version of this docstring credited: that one asserts the two client FILES name
        the shared body type, and says nothing about the interface field.
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

    @pytest.mark.skipif(
        not _frontend_tree_present(), reason='frontend tree absent from this checkout'
    )
    def test_both_client_signatures_use_the_shared_request_body(self):
        """Neither `generateDocument` may respell the body inline again.

        The axis the deleted scanner covered, at ~1/60th of its size, and it is
        genuinely uncovered otherwise: widening `projectsApi.generateDocument`'s
        annotation type-checks cleanly (measured — `tsc -p tsconfig.app.json
        --noEmit` exits 0), because that `data` is only spread into `JSON.stringify`
        and so is compared against nothing. `client.ts` is compiler-protected by
        forwarding into it; this test is what covers the other one.

        Deliberately TEXT and not a parse. It asks whether each file mentions the
        shared type at all — no method location, no parameter-list extent, no model
        of TypeScript, so none of the ways the scanner mis-read legal code apply.

        LIMIT, stated precisely because an earlier version of this docstring
        overstated it: this test cannot tell WHERE the name is used, so a signature
        that names `GenerateDocumentBody` and widens `doc_type` anyway passes HERE.
        That residue is not closed by `noUnusedLocals` — an earlier claim that it was
        is false, and was measured to be: an
        `Omit<GenerateDocumentBody, 'doc_type'> & { doc_type: ... | 'onepager' }`
        annotation USES the imported name, so no unused-local fires and `tsc` exits
        0. What closes it is `GenerateDocumentTakesTheSharedBody`, a type-level
        comparison of that method's parameter against the interface, which makes any
        widening of it a TS2344 — whatever the spelling.
        `test_the_type_level_pins_are_present` is what keeps it there, since deleting
        it is silent otherwise.
        """
        for relative in GENERATE_DOCUMENT_CLIENTS:
            path = _repo_root() / relative
            assert path.is_file(), f'{relative} moved — update GENERATE_DOCUMENT_CLIENTS'
            source = _without_comments(path.read_text(encoding='utf-8'))
            assert 'generateDocument' in source, (
                f'{relative} no longer mentions generateDocument. If the method '
                f'moved, point GENERATE_DOCUMENT_CLIENTS at its new home; if this '
                f'client dropped it, drop the entry.'
            )
            assert REQUEST_BODY_TYPE in source, (
                f'{relative} does not name {REQUEST_BODY_TYPE}, so its '
                f'generateDocument body is spelled inline. In projectsApi.ts nothing '
                f'checks such an annotation — the request goes out with whatever it '
                f'admits and the route 400s it. Take {REQUEST_BODY_TYPE} (declared '
                f'in {DOC_TYPE_UNION_SOURCE}) instead, and widen the contract there '
                f'if that is what is wanted.'
            )

    @pytest.mark.skipif(
        not _frontend_tree_present(), reason='frontend tree absent from this checkout'
    )
    @pytest.mark.parametrize('relative', TYPE_LEVEL_PINS, ids=lambda p: Path(p).name)
    def test_the_type_level_pins_are_present(self, relative):
        """Every link TypeScript CAN check has a compiler check, and each one's
        absence is silent — so this keeps them present.

        The two links, and what each was measured to permit without its pin:

          * `GenerateDocumentBody.doc_type` vs `DocType` — respelling the field
            `'prd' | 'prfaq' | 'onepager'` exited `tsc` 0, passed every test here and
            linted clean, while a caller could then send a value the route 400s. This
            file parses only the `export type DocType =` declaration, so the interface
            field is invisible to it, and the signature pin below compares against the
            interface, so a widened one satisfies it by construction.
          * `generateDocument`'s parameter vs `GenerateDocumentBody` — that method is
            the TERMINAL consumer, its `data` only spread into `JSON.stringify`, so
            the annotation is compared against nothing. An
            `Omit<GenerateDocumentBody, 'doc_type'> & { doc_type: ... | 'onepager' }`
            respelling USES the shared name, so neither `noUnusedLocals` nor the name
            assertion above sees it.

        Text, not a parse — but text with two lessons in it, one per review round.
        Asserting the pin NAMES alone was measured to be vacuous: stub both a pin and
        its control to bare constants (`= true` / `= false`), delete the helper types
        so no unused-local fires, and `tsc` exits 0 with every test here green while
        the guarded field is widened. Requiring `MustBeTrue<` did not fix it, because
        that substring is in the HELPER'S OWN DECLARATION — so the stub just keeps the
        helpers and exports them, and every gate is green again. The spelling required
        is therefore the pin's USE of the helper (`MustBeTrue<BothWays<`). That the
        comparisons BITE is the compiler's job; this test says only that a real
        comparison is spelled.

        TWO controls per pin, both required. `MustBeTrue<BothWays<...>>` is satisfied
        by a `BothWays` that degenerates to `true`, and by one collapsed to its
        ONE-WAY form — and those need different controls, because a widened-side
        control cannot see the second: a superset fails `[Left] extends [Right]` under
        either form, so both forms look identical to it. Measured — collapsing
        `BothWays` to `[Left] extends [Right]` left `tsc` at exit 0 with every test
        here green. The narrowed-side controls (`...WouldSeeNarrowing`) are what
        refuse that, using `never` as the left side.
        """
        pin, controls, assertions = TYPE_LEVEL_PINS[relative]
        path = _repo_root() / relative
        assert path.is_file(), f'{relative} moved — update TYPE_LEVEL_PINS'
        source = _without_comments(path.read_text(encoding='utf-8'))
        assert pin in source, (
            f'{relative} no longer declares `{pin}`. That is the only check on its '
            f'half of this contract — nothing else in either language covers it (see '
            f'this test\'s docstring), so without it the doc_type it guards can be '
            f'widened past the route\'s allowlist with tsc, eslint and this whole '
            f'file green. Restore it, or widen DocType and GENERATED_DOC_TYPES '
            f'together, which is the supported way to change the contract.'
        )
        for control in controls:
            assert control in source, (
                f'{relative} declares `{pin}` but not its control `{control}`. The '
                f'pin is satisfied both by a comparison that degenerates to `true` '
                f'and by one collapsed to a one-way `extends`, each of which passes '
                f'while measuring less than it claims; the controls are what refuse '
                f'those, the same way TestContractDriftIsCaught does for the parser '
                f'here. A widened-side control cannot detect the one-way collapse, '
                f'so the narrowed-side one is not redundant.'
            )
        for assertion in assertions:
            assert assertion in source, (
                f'{relative} does not spell `{assertion}`, so a pin or a control is '
                f'no longer applied to a comparison. A bare `= true` satisfies a '
                f'name check while comparing nothing, and naming the helper alone is '
                f'satisfied by the helper\'s own declaration — both were measured to '
                f'pass every gate with the guarded field widened. Note these pins are '
                f'written on ONE line deliberately: wrapping the declaration puts a '
                f'newline inside this substring.'
            )
