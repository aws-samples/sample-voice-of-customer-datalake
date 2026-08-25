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

THE CHEAPER END STATE, recorded so choosing it stays deliberate. Those two sibling
lockstep tests are 84 and 182 lines and read a single declaration with one regex;
this one is far longer because it hand-parses TypeScript, and successive reviews
have each found a new way that scanner mis-reads legal syntax — nested callback,
column-0 latch, nested namespace, `//` comments, `/* */` comments, unbalanced
brackets, then non-literal union members in both parsers. That is not bad luck; it
is what parsing another language's syntax costs.

The scanner exists only because `client.ts` and `projectsApi.ts` each spell
`'prd' | 'prfaq'` INLINE instead of referencing the `DocType` union the picker
already uses, so this contract has three copies in the frontend. If both signatures
referenced `DocType`, there would be one declaration to pin, `_doc_type_union` alone
would read it, and `_parameter_list_end`, `GENERATE_DOCUMENT_ANCHOR`,
`DOC_TYPE_ANNOTATION_ANCHOR`, `FINDABLE_SHAPES`, `WIDENED_SHAPES`,
`NARROWED_SHAPES` and most of `TestTheParser` would all be unnecessary —
collapsing a drift axis instead of testing it. (`_without_comments` STAYS:
`_doc_type_union` calls it too, and without it the `commented` shape truncates at
the comment and `commented_out_predecessor` reads the dead union — the silent
failure this file singles out as the worst.) That change is in
`frontend/`, which the PR introducing this file deliberately kept out of scope, so
it is recorded here rather than done: the next round of parser bugs should be a
choice between extending the scanner and deleting it, not a default.

The comparisons SKIP when the frontend tree is absent (a backend-only sparse
checkout should not report a mismatch it never measured), but
`test_the_frontend_declarations_are_findable` carries NO skip marker: it asserts
the sources exist and parse, which is the check that must run — without it a
rename would make every parser return an empty set and the equality tests would
pass while comparing nothing.

Both parsers are pure functions of the text (`_doc_type_union`,
`_doc_type_annotations`) and both have their own class of synthetic shapes
(`TestTheUnionParser`, `TestTheParser`). That is deliberate and it is the half the
findability control cannot cover: the control can report that a parser found
nothing in the sources as they are TODAY, never that a plausible restyling — a
Prettier-wrapped union, a double-quoted member, a commented-out predecessor — would
make it find nothing tomorrow. Every shape pinned there is one an earlier version
of this file read wrongly or not at all.
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


# A quoted string-literal union member, in either quote style. TypeScript accepts
# both and Prettier's `singleQuote` setting decides which a file uses, so reading
# only one of them makes a formatter setting the difference between a parser that
# works and one that silently returns nothing.
QUOTED_MEMBER = r"""(?:'[^']+'|"[^"]+")"""
# A union TERM is a quoted literal OR a bare identifier. Identifiers are matched
# deliberately, not tolerated: a union that refers to another type
# (`'prd' | 'prfaq' | ExtraDocType`) cannot be compared against the route's
# allowlist, and matching only the literals beside it would truncate the union and
# PASS while the frontend can send whatever the identifier admits. Captured here
# so `_union_members` can refuse it by name instead.
#
# Widening this grammar further would be the wrong answer to the shapes it still
# does not match — `(string & {})`, `` `${string}-draft` ``, `{ custom: string }`.
# TypeScript admits unboundedly many type expressions, so no term pattern is
# exhaustive, and each addition only moves where the silence starts. That is why
# `_union_members` also checks POSITIONALLY for a term the pattern could not
# read at all; see its docstring.
UNION_TERM = rf"""(?:{QUOTED_MEMBER}|[A-Za-z_$][\w$]*)"""
MEMBER_LITERAL = re.compile(rf'^{QUOTED_MEMBER}$')
QUOTED_TEXT = re.compile(r"""['"]([^'"]+)['"]""")

# The `DocType` union. The optional leading `|` matters: it is what Prettier
# produces once a union exceeds the print width, so adding a third member — the
# very drift this file exists to catch — is a realistic route into a shape the
# previous pattern could not read at all.
# The TERMS of a union, matched only once an anchor below has said where the
# right-hand side starts. Split from the anchors deliberately: while the terms and
# the declaration were one pattern, a declaration whose FIRST term is unreadable
# (`= (string & {}) | 'prd' | 'prfaq'`) matched NOTHING, so the parser returned an
# empty set, the equality test passed, and only the findability control fired —
# asking whether the type had been renamed while the declaration sat there,
# widened. Anchoring first turns that into a refusal at the declaration.
UNION_TERMS = re.compile(rf'{UNION_TERM}(?:\s*\|\s*{UNION_TERM})*')

DOC_TYPE_UNION_ANCHOR = re.compile(r'export\s+type\s+DocType\s*=\s*\|?\s*')

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
# The union is OPTIONAL, so a NARROWED signature (`doc_type: 'prd'`, dropping
# PR-FAQ from the client while the route still accepts it) is read and reported as
# drift against the route. Requiring a `|` made that edit unparseable instead, and
# the two failures send a maintainer to different places: "the client and the route
# disagree" is the finding, "was the method renamed?" is a wrong turn.
#
# Built from UNION_TERM, not from QUOTED_MEMBER, for the reason recorded there and
# because THIS is the parser that reads the declaration typing the request body.
# With quoted literals only, a signature widened to
# `doc_type: 'prd' | 'prfaq' | LegacyDocType` matched just the first two terms and
# was reported as agreeing with the route — the same silent pass the union parser
# was hardened against, on the more load-bearing of the two declarations. The union
# is the picker's type; the signature is the wire contract.
#
# `\|?\s*` matches the union anchor's, and closes a gap this parser had from the
# start: Prettier emits a LEADING PIPE once a union outgrows the print width, so
# `doc_type:\n  | 'prd'\n  | 'prfaq'` read as nothing at all — widened or not. That
# is also the likeliest route into a first-position widening, since a maintainer
# reformatting to that shape and then adding a member lands in it.
DOC_TYPE_ANNOTATION_ANCHOR = re.compile(r'doc_type\??\s*:\s*\|?\s*')


def _without_comments(source: str) -> str:
    """`source` with `//` and `/* */` comment BODIES blanked, same length.

    Comments are removed before anything else looks at the text, because both
    parsers below were reading declarations out of them. A commented-out older
    signature above the live one was collected as a second declaration and failed
    the equality test while the client was correct; worse, a renamed method with a
    commented-out reference left behind was collected as though it were live, so
    the findability control passed while nothing live was pinned — the "green
    result meaning did not check" this file exists to prevent, arriving through the
    parser instead of the code under test. Same defect class as counting brackets
    on `line.split('#')[0]` in `test_the_routing_predicate_reads_the_allowlist_constant`:
    commentary is not a declaration.

    Blanked rather than deleted, and newlines inside comments preserved, so every
    index and every line number in the result still refers to the same place in the
    original file — the annotation line numbers are what a failure report names.

    Quote state is tracked so a `//` inside a string is not mistaken for a comment.
    A regex literal containing `//` or `/*` would be, but an empty regex is not
    legal TypeScript and these are API-client type signatures; the shapes that do
    occur are pinned in `TestTheParser`.
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


def _union_members(code: str, anchor: re.Match, what: str) -> frozenset[str]:
    """The quoted members of the union at `anchor`, or a LOUD failure.

    Shared by both parsers because both had the same hole, and a guard written twice
    is how the earlier rounds' defects happened. A union can be unreadable in three
    positions and all three must be loud, because the quiet version of any of them
    is the same thing: a PASS reporting agreement with the route while the frontend
    admits values it refuses.

    FIRST — nothing matches at the anchor. `= (string & {}) | 'prd' | 'prfaq'`.
    Before the anchors were split out this returned an empty set, which the equality
    test reads as "no drift" and the findability control reports as a possible
    rename. The worst of the three, because the message sent the maintainer looking
    for something that had not happened.

    MIDDLE or LAST — a term is not a string literal. Two sub-cases, and the split
    matters because only one of them can be spelled as a pattern:

      * it MATCHED and is an identifier (`ExtraDocType`, `string`, `DocType`).
        UNION_TERM matches identifiers deliberately so they arrive here to be named,
        rather than tightening the pattern until they stop matching — which yields
        an empty set and, again, a rename message.
      * it did not match, so the terms before it look like the whole union.
        `(string & {})` — "any string, but keep autocomplete", precisely what one
        reaches for to widen a picker — plus template-literal and inline object
        types. No grammar is exhaustive over TypeScript's type expressions, so this
        one is caught POSITIONALLY: a `|` after the match means a term was left
        unread, whatever its shape.

    Between the anchor check and the positional check, a value comes back only when
    every `|`-separated term in the declaration was read AND was a literal. That is
    the property worth having; it does not depend on anyone having enumerated the
    shapes TypeScript admits.

    `raise AssertionError` rather than `assert`: `python -O` strips `assert`, and a
    guard whose entire purpose is to not be the quiet option must not have a mode
    where it silently is. `pytest.raises(AssertionError)` is unaffected.
    """
    terms_match = UNION_TERMS.match(code, anchor.end())
    if terms_match is None:
        raise AssertionError(
            f'{what} begins with a term this parser cannot read: '
            f'{code[anchor.end():anchor.end() + 60]!r}. Returning nothing here '
            f'would report no drift and blame a rename.'
        )
    matched = terms_match.group(0)
    terms = [term.strip() for term in matched.split('|') if term.strip()]
    non_literal = [term for term in terms if not MEMBER_LITERAL.match(term)]
    if non_literal:
        raise AssertionError(
            f'{what} has members that are not string literals: {non_literal}. '
            f'This parser cannot compare those against the route\'s allowlist, and '
            f'silently reading only the literals beside them would PASS while the '
            f'frontend can send whatever they admit. If the declaration now '
            f'references the shared DocType union, this parser wants retiring '
            f'rather than teaching to resolve it — see '
            f'test_the_frontend_declarations_are_findable.'
        )
    unread = code[terms_match.end():].lstrip()
    if unread.startswith('|'):
        raise AssertionError(
            f'{what} continues past the terms this parser could read, with '
            f'{unread[:60]!r}. Reading only the members before it would report '
            f'agreement with the route while the frontend admits more. This says '
            f'only that the term could not be READ — a parenthesised or '
            f'backtick-quoted literal would land here too, and is still drift the '
            f'comparison cannot make.'
        )
    return frozenset(QUOTED_TEXT.findall(matched))


def _doc_type_union(source: str) -> frozenset[str]:
    """The `DocType` union members, or an empty set if the declaration is gone.

    A pure function of the text, for the same reason `_doc_type_annotations` is:
    the findability control can report that this parser found nothing, never that
    a plausible restyling of the declaration would make it find nothing.
    `TestTheUnionParser` is that second half.

    Reads, among others:
        export type DocType = 'prd' | 'prfaq'
        export type DocType =
          | 'prd'
          | 'prfaq'

    Raises rather than truncating when a member is not a string literal — see
    UNION_TERM.
    """
    code = _without_comments(source)
    anchor = DOC_TYPE_UNION_ANCHOR.search(code)
    if anchor is None:
        return frozenset()
    return _union_members(code, anchor, 'the DocType union')


def _declared_doc_type_union() -> frozenset[str]:
    """`_doc_type_union` over the checked-in declaration."""
    return _doc_type_union(
        (_repo_root() / DOC_TYPE_UNION_SOURCE).read_text(encoding='utf-8')
    )


def _parameter_list_end(source: str, open_paren: int) -> int | None:
    """The index just past the `)` closing the parameter list at `open_paren`.

    None when the brackets never balance, which means the extent of the method
    could not be determined. Returning the rest of the file instead would be
    worse than returning nothing: in `projectsApi.ts` the next `doc_type` below
    `generateDocument` belongs to `suggestDocumentBrief`, which this file
    deliberately does not pin, so an over-long extent would quietly reintroduce
    the coupling. Nothing found fails the findability control loudly instead.

    Quoted strings are skipped so a bracket inside one cannot unbalance the count.
    Comments need no handling here because `_doc_type_annotations` blanks them
    before calling this — which is also what stops a bracket or an apostrophe
    inside a `/* */` comment from unbalancing the count or opening a quote state
    that swallows the rest of the parameter list.
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

    Both the anchor and the annotations are matched against the COMMENT-FREE text,
    so a commented-out signature is neither collected as a declaration nor allowed
    to stand in for the live one. See `_without_comments`.

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
    code = _without_comments(source)
    found: dict[int, frozenset[str]] = {}
    for anchor in GENERATE_DOCUMENT_ANCHOR.finditer(code):
        open_paren = anchor.end() - 1
        end = _parameter_list_end(code, open_paren)
        if end is None:
            continue
        signature = code[open_paren:end]
        first_line = code.count('\n', 0, open_paren) + 1
        for match in DOC_TYPE_ANNOTATION_ANCHOR.finditer(signature):
            line_number = first_line + signature.count('\n', 0, match.start())
            # The line number is in the message because a refusal has to point at
            # the declaration, not just report that one exists somewhere.
            found[line_number] = _union_members(
                signature,
                match,
                f'the generateDocument doc_type annotation on line {line_number}',
            )
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
    # A BLOCK comment carrying a bracket, which unbalanced the end-of-signature
    # search and lost the annotation entirely.
    'bracket_in_block_comment': """generateDocument: (p: string, d: {
  /* see runResearch( for the twin */
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    # A block comment carrying an apostrophe, which opened a quote state that
    # swallowed the rest of the parameter list.
    'apostrophe_in_block_comment': """generateDocument: (p: string, d: {
  /* don't widen this */
  doc_type: 'prd' | 'prfaq'
}) => q,
""",
    # A commented-out OLDER signature above the live one — what a maintainer
    # plausibly leaves behind when narrowing it. Only the live annotation may be
    # collected: reading the comment too reported drift (`legacy`) against a
    # client that was entirely correct.
    'commented_out_predecessor':
        """  // was: generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' | 'legacy' }) => q,
  generateDocument: (projectId: string, data: {
    doc_type: 'prd' | 'prfaq'
  }) => q,
""",
    # Double-quoted members. Which quote style a file uses is a Prettier setting,
    # not a fact about the contract.
    'double_quoted':
        'generateDocument: (p: string, d: { doc_type: "prd" | "prfaq" }) => q,\n',
}

# Shapes where the annotation is present but does NOT declare both members, so
# `_doc_type_annotations` must report what it read rather than nothing. A narrowed
# signature is real drift in the "accepted but never offered" direction, and it has
# to surface from the comparison test that names that — not as an unparseable file
# from the findability control, which would send a maintainer looking for a rename
# that never happened.
NARROWED_SHAPES = {
    'single_value':
        "generateDocument: (p: string, d: { doc_type: 'prd' }) => q,\n",
    'optional_single_value':
        "generateDocument: (p: string, d: { doc_type?: 'prd' }) => q,\n",
}

# Shapes where the signature admits MORE than the two literals, by a term this
# parser cannot compare against the allowlist. Separate from NARROWED_SHAPES
# because the required behaviour is the opposite: narrowing must be READ and
# reported as drift, widening past a literal must REFUSE — reading the literals
# beside such a term reports agreement with the route while the client can send
# whatever it admits.
#
# Each maps to the message fragment its refusal must carry, so the test pins WHICH
# of the three guards fired rather than only that something did. That matters here:
# with a single either-message assertion, dropping the identifier alternation from
# UNION_TERM left every one of these green — the positional guard refused them all
# on its own — and the grammar change the fix rests on was unpinned.
WIDENED_SHAPES = {
    # Caught BY NAME: an identifier matches UNION_TERM, so it reaches the
    # not-a-literal check and the failure can say what it is.
    # What a maintainer writes to add values without touching this signature —
    # and so the realistic route to a client offering a value the route 400s.
    'named_type': (
        "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' | LegacyDocType }) => q,\n",
        'not string literals',
    ),
    'bare_string': (
        "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' | string }) => q,\n",
        'not string literals',
    ),
    # The shape the grammar change ALONE catches: one non-literal term, no pipe, so
    # the positional guard has nothing to see. With quoted literals only this
    # parsed to {} and reported no drift. It is also `doc_type: DocType`, the end
    # state the module docstring recommends — which must fail loudly here rather
    # than quietly, so whoever makes that frontend change is told to retire this
    # parser instead of finding a green suite that checks nothing.
    'single_named_type': (
        'generateDocument: (p: string, d: { doc_type: DocType }) => q,\n',
        'not string literals',
    ),
    # Caught POSITIONALLY: no term pattern matches these, so the guard sees only
    # that a `|` follows what it could read.
    # "Any string, but keep autocomplete on the known members" — the idiom for
    # exactly this widening.
    'string_and_empty_object': (
        "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' | (string & {}) }) => q,\n",
        'continues past',
    ),
    'template_literal': (
        'generateDocument: (p: string, d: { doc_type: \'prd\' | \'prfaq\' | `${string}-draft` }) => q,\n',
        'continues past',
    ),
    'inline_object': (
        "generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' | { custom: string } }) => q,\n",
        'continues past',
    ),
    # Caught at the ANCHOR: the unreadable term comes FIRST, so nothing matches at
    # all. This is the position the earlier fix missed entirely — it returned {},
    # the comparison test passed, and only the findability control fired, blaming a
    # rename that had not happened.
    'unreadable_term_first': (
        "generateDocument: (p: string, d: { doc_type: (string & {}) | 'prd' | 'prfaq' }) => q,\n",
        'begins with a term',
    ),
    # The same, in Prettier's leading-pipe form — the likeliest route here, since
    # reformatting to it and then adding a member lands in this class.
    'unreadable_term_first_leading_pipe': (
        (
            "generateDocument: (projectId: string, data: {\n"
            "  doc_type:\n"
            "    | (string & {})\n"
            "    | 'prd'\n"
            "}) => q,\n"
        ),
        'begins with a term',
    ),
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

    def test_a_renamed_method_yields_nothing_despite_a_commented_out_reference(self):
        """The worst of the comment cases, because it is SILENT.

        A rename that leaves the old call commented out used to satisfy the
        findability control — one annotation parsed per source — while the live
        signature was pinned by nothing. That is the "green result meaning did not
        check" this file exists to prevent, arriving through the parser rather than
        through the code under test, so the comment must not stand in for the
        declaration it is a copy of.
        """
        source = (
            "  // generateDocument: (p: string, d: { doc_type: 'prd' | 'prfaq' }) => q,\n"
            '  createDocument: (projectId: string, data: {\n'
            "    doc_type: 'prd' | 'prfaq'\n"
            '  }) => q,\n'
        )
        assert _doc_type_annotations(source) == {}

    @pytest.mark.parametrize(
        ('shape', 'expected'), WIDENED_SHAPES.values(), ids=WIDENED_SHAPES
    )
    def test_a_widened_signature_refuses_rather_than_truncating(self, shape, expected):
        """The signature is what types the request body, so this is the direction
        that matters: every one of these returned `{'prd','prfaq'}` or `{}` and
        reported agreement with the route while the client admitted more.

        Asserting the refusal rather than the parsed value on purpose — a test
        expecting `{'prd','prfaq','LegacyDocType'}` would pass on a parser that
        merely widened its grammar, and the point is that the two declarations can
        no longer be compared by equality at all.

        The expected MESSAGE is asserted per shape, not just "some refusal": the
        three guards are independent, and a shared either-message assertion let a
        revert of one of them stay green.
        """
        with pytest.raises(AssertionError, match=expected):
            _doc_type_annotations(shape)

    @pytest.mark.parametrize('shape', NARROWED_SHAPES.values(), ids=NARROWED_SHAPES)
    def test_a_narrowed_signature_is_read_rather_than_missed(self, shape):
        """Drift must be reported as drift, not as an unparseable file.

        Dropping PR-FAQ from the client while the route still accepts it is exactly
        the "accepted but never offered (unreachable)" direction the comparison test
        names. Requiring a `|` in the annotation made that edit invisible to this
        parser, so it surfaced from the findability control as "was the method
        renamed?" — a wrong turn for a maintainer who had just narrowed a union.
        """
        assert list(_doc_type_annotations(shape).values()) == [frozenset({'prd'})]


# Each value declares `prd` and `prfaq`, however it is styled.
UNION_SHAPES = {
    # The declaration in types.ts today.
    'single_line': "export type DocType = 'prd' | 'prfaq'\n",
    # What Prettier produces once the union exceeds the print width — so adding a
    # third member, the drift this file exists to catch, is a realistic route into
    # this shape. The previous pattern required a quoted literal immediately after
    # `=` and read nothing here.
    'leading_pipe': "export type DocType =\n  | 'prd'\n  | 'prfaq'\n",
    'wrapped_without_leading_pipe': "export type DocType =\n  'prd'\n  | 'prfaq'\n",
    # Quote style is a formatter setting, not a fact about the contract.
    'double_quoted': 'export type DocType = "prd" | "prfaq"\n',
    # A comment between the members, which must not end the union.
    'commented': "export type DocType =\n  | 'prd' // the default\n  | 'prfaq'\n",
    # A commented-out predecessor above the live declaration. `re.search` takes the
    # first match, so without comment stripping the DEAD union is what gets read.
    'commented_out_predecessor':
        "// export type DocType = 'prd' | 'prfaq' | 'legacy'\n"
        "export type DocType = 'prd' | 'prfaq'\n",
}


class TestTheUnionParser:
    """`_doc_type_union` on synthetic declarations.

    The same reasoning as `TestTheParser`, applied to the other parser in this
    file: the findability control can only report that this one found nothing, and
    a maintainer who reads its message ("was the type renamed, or reformatted
    across lines?") is sent looking for a rename when the real answer may be that
    their union is legal TypeScript this parser could not read.
    """

    @pytest.mark.parametrize('shape', UNION_SHAPES.values(), ids=UNION_SHAPES)
    def test_the_members_are_found_however_the_union_is_styled(self, shape):
        assert _doc_type_union(shape) == frozenset({'prd', 'prfaq'}), (
            f'parsed {sorted(_doc_type_union(shape))} from:\n{shape}'
        )

    def test_a_three_member_union_is_read_whole(self):
        """The drift this file exists to catch is a member being ADDED, so the
        parser must read the added one — truncating to the first two would report
        agreement with the route while the picker offers a third value."""
        source = "export type DocType =\n  | 'prd'\n  | 'prfaq'\n  | 'onepager'\n"
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

    def test_a_renamed_type_yields_nothing(self):
        """The negative control: the findability check below is only meaningful if
        an empty set really means the declaration was not found."""
        assert _doc_type_union("export type DocKind = 'prd' | 'prfaq'\n") == frozenset()

    def test_a_non_literal_member_fails_rather_than_truncating(self):
        """A union referring to another type cannot be compared with the route's
        allowlist. Reading only the literals beside it returned {'prd','prfaq'} and
        PASSED, while the frontend could send whatever the identifier admits — a
        silent pass, which is the direction that matters here.
        """
        with pytest.raises(AssertionError, match='not string literals'):
            _doc_type_union("export type DocType = 'prd' | 'prfaq' | ExtraDocType\n")

    @pytest.mark.parametrize('member', [
        '(string & {})',
        '`${string}-draft`',
        '{ custom: string }',
    ])
    def test_an_unreadable_member_in_FIRST_position_refuses_at_the_anchor(self, member):
        """The position the positional guard cannot see.

        `= (string & {}) | 'prd' | 'prfaq'` matched nothing at all, because the
        pattern required a readable term immediately after `=`. An empty set is what
        a renamed type returns, so the equality test read "no drift" and the
        findability control asked whether `DocType` had been renamed — while the
        declaration sat there, widened. Splitting the anchor from the terms is what
        turns this into a refusal; these three pin the direction the earlier fix
        missed.
        """
        with pytest.raises(AssertionError, match='begins with a term'):
            _doc_type_union(f"export type DocType = {member} | 'prd' | 'prfaq'\n")

    @pytest.mark.parametrize('member', [
        # Each is legal TypeScript that UNION_TERM does not match, so the pattern
        # stopped at it and `{'prd','prfaq'}` was returned as though complete.
        '(string & {})',
        '`${string}-draft`',
        '{ custom: string }',
    ])
    def test_a_member_the_grammar_cannot_read_fails_rather_than_ending_the_match(
        self, member
    ):
        """The second half of the guard, and the one no term pattern can supply.

        `UNION_TERM` covers quoted literals and identifiers, so a member that is
        neither did not MATCH — and because the union pattern stops at the first
        unmatched term, it was dropped before the not-a-literal check could see it.
        These three all returned {'prd','prfaq'} and passed the equality test.

        Fixing this by adding alternations would have been endless: TypeScript
        admits arbitrarily many type expressions. The positional check in
        `_union_members` closes it for shapes nobody enumerated, which is why
        these three are parametrised rather than each pinned as its own grammar.
        """
        with pytest.raises(AssertionError, match='continues past the terms'):
            _doc_type_union(f"export type DocType = 'prd' | 'prfaq' | {member}\n")

    def test_the_guard_survives_python_dash_o(self):
        """`assert` is stripped under `python -O`, and this guard's whole purpose is
        to be the loud option — so it must not have a mode in which it is not.

        Read from the source rather than run under a second interpreter, because an
        `assert` compiles to nothing under `-O`: there is no runtime observation that
        distinguishes "the guard passed" from "the guard was removed", which is the
        whole problem. The property is therefore syntactic — no `assert` statement in
        the body — and the source is the only place it is visible.

        The DOCSTRING is stripped before looking. Without that, this test passed on a
        body containing no raise at all, because the docstring above discusses
        `raise AssertionError` by name — a test satisfied by prose about itself.
        `assert\\b` rather than `assert `, since `assert(x), msg` is stripped by `-O`
        just as thoroughly and reads as a function call.
        """
        import inspect

        body = inspect.getsource(_union_members)
        docstring = inspect.getdoc(_union_members) or ''
        for line in docstring.splitlines():
            body = body.replace(line, '')

        assert 'raise AssertionError' in body, (
            'the refusals must be raises; found none outside the docstring'
        )
        stripped = [
            line for line in body.splitlines() if re.match(r'\s*assert\b', line)
        ]
        assert not stripped, (
            f'these refusals in _union_members are `assert`, which `python -O` '
            f'removes: {stripped}'
        )


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
        assert _declared_doc_type_union(), (
            f'parsed no DocType union members from {DOC_TYPE_UNION_SOURCE} — '
            f'was the type renamed? (Restylings of the union itself are covered by '
            f'TestTheUnionParser, so a legal reformatting should not land here.)'
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
            f'If a named type: pointing this parser at it is ONE option, and '
            f'retiring most of this parser is the other — see the module docstring '
            f'on collapsing the duplicated declarations.'
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
