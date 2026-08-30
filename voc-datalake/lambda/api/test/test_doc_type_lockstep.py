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

THE SCANNER IS GONE AND MUST NOT COME BACK (issue #381). This file used to carry
~300 lines of TypeScript scanner — `_parameter_list_end`, `GENERATE_DOCUMENT_ANCHOR`,
`DOC_TYPE_ANNOTATION_ANCHOR`, `FINDABLE_SHAPES`, `WIDENED_SHAPES`, `NARROWED_SHAPES`
— for one reason: `client.ts` and `projectsApi.ts` spelled `'prd' | 'prfaq'` INLINE
inside their `generateDocument` signatures, so the contract existed in three places
and checking the two inline copies meant locating a method by name inside an object
literal and delimiting its parameter list by bracket balance. Every review round on
that scanner found another shape of legal TypeScript it mis-read; none found a defect
in the contract. Both signatures now take `GenerateDocumentBody`, which removes that
drift axis rather than testing it. Nothing here should ever again try to decide what
an arbitrary TypeScript type expression MEANS.

WHAT THIS FILE COSTS, stated plainly because a previous version of this heading read
"WHY THIS FILE IS SHORT NOW" long after it had stopped being true. Two fixed points,
both in OTHER commits and so both stable:

    944 lines   on `development`, the scanner version
    455 lines   after the scanner was deleted

This file is now WELL OVER 1.5x the scanner it replaced, and about TWO THIRDS of it is
prose — this docstring, the test docstrings and the comments — against a body of code
that is `_without_comments`, `_doc_type_union` and the pin matcher with their shape
fixtures, plus the text assertions keeping two type-level pins and their four controls
present. So the claim that the file was short was false for two review rounds, and it
is not becoming true.

NO EXACT "NOW" FIGURE IS GIVEN HERE, and that is the fix rather than an omission. Three
successive rounds shipped one wrong, each time for the same unavoidable reason: the
count lives INSIDE the thing it counts, so any later edit — including an edit to this
very block — falsifies it, and the last edit of a round is never the one that wrote the
number. A self-referential exact count cannot be kept true by being more careful; the
third recurrence landed in the same commit that added the instruction not to let it go
wrong. The approximations above survive a hundred lines in either direction, which is
the precision this argument actually needs. If a precise figure is wanted, MEASURE it
rather than reading it here — parse the file with `ast`, take the module docstring's
span, sum the docstring spans of every class and function, count lines whose stripped
form starts with `#`, and derive code as total minus prose minus blank.

Whether that is proportionate is a fair question and was asked in review. The honest
answer: the PINS are cheap and they are what bite — every widening mutation tried is
refused by the compiler, not by this file. The length is the SCAFFOLDING proving the
pins are not vacuous, and it grew because six successive rounds each found a guard
whose documented mechanism differed from its actual one.

The scaffolding is not redundant, and that was measured rather than assumed. Each
control was DELETED in turn and the degeneration it exists for reapplied; in both
cases nothing else noticed:

  * remove `...WouldSeeDrift` (widened side), then collapse `BothWays` to the reverse
    one-way `[Right] extends [Left]` -> `tsc` reports NOTHING in that file.
  * remove `...WouldSeeNarrowing` (narrowed side), then collapse it to the forward
    one-way `[Left] extends [Right]` -> `tsc` reports NOTHING in that file.

With both present, those two collapses are 2 errors each — one per pin, since each
control now compares its OWN pin's operand — and a `BothWays` degenerated to constant
`true` is 5. So neither control covers the other's axis and there is no third one to
add.

THE RULE THAT REPLACES ADDING MORE: when a guard turns out to be evadable, move the
check to the compiler or pin the whole construct. Do NOT add a longer text fragment —
that was tried four times and defeated four times, because a fragment of the thing
being pinned is always a substring something else can supply.

Its corollary, which took a fifth defeat to see: also ask WHERE the string is allowed
to come from. Pinning the whole declaration still passed on a copy inside a template
literal, so the pins match against `_declarations(...)` — comment AND string bodies
blanked — rather than against comment-stripped text. "Commentary is not a declaration"
was only half the rule; a string is not one either.

And its second corollary, from a SIXTH defeat: blanking is not comparing. Matching both
sides through `_declarations` made the quoted operands INSIDE a pin equal by LENGTH —
`'not-a-doc-type'` and `'AAAAAAAAAAAAAA'` blank to the same fourteen spaces — so a
control's member could be swapped for an arbitrary same-length string with `tsc` at exit
0 and every test here green. `_declaration_offset` therefore locates a candidate in the
blanked view and then requires the RAW text to match there: structure decides WHERE,
exact text decides WHAT. The compiler backstops one shape of this (a pin repointed at a
field that does not exist is a TS2339) but not the operand swap, since one arbitrary
non-member is as good as another to `BothWays` and the control goes on working.

And its THIRD corollary, from a seventh defeat: asking where a string may come from is
only answered if the answer knows where a string ENDS. `${...}` inside a template
literal is code again, so a scan that ran to the next backtick had the inner template's
opening backtick close the OUTER one — and a decoy in a nested template was in the
blanked view as if it were real source. That one bug reopened every text guard here at
once: the field pin could be DELETED with a copy in such a decoy and the field widened
(`tsc` exit 0, eslint clean, all tests green, and NO compiler backstop for that pin);
the union parser read the decoy's members instead of the live union's; the ratio was
satisfied by a decoy alone. Fixed in `_without_comments` with a frame stack, which is
the one mechanism all four guards share, rather than in any of them.

An EIGHTH defeat then made the same point about a different construct, which is why that
corollary is phrased about where a string ENDS rather than about `${`: the scan had no
notion of a REGEX literal, so a backtick inside one opened a phantom template frame that
the decoy's own opening backtick then closed — and everything after it was code again,
exactly as before. A second regex after the decoy resynchronises the scan, so only the
decoy is affected and the evasion is clean rather than noisy (a bare desync runs to EOF
and incidentally swallows whatever follows). Measured on the tree that shipped it: the
field pin DELETED, a copy left in such a decoy, and the field widened — `tsc` exit 0,
eslint clean, every test here green, and no lint rule in the way this time since nothing
is nested. `_regex_allowed_here` now decides whether a `/` opens a regex or divides, and
its branch sits AFTER the two comment branches: placed before them it consumes `//` as an
empty regex, which is measured to break the commented-out predecessor and commented-out
pin cases. It errs toward reading LESS, because misreading a division blanks real code —
a false FAILURE, bounded to the one line a regex body may occupy — while misreading a
regex is this vacuity, a false PASS with no bound. The two mistakes are not symmetric,
and `TestThePinMatcher` pins both directions.

A NINTH defeat came from the same place one delimiter deeper, and it is why the lesson is
better stated as a question about DELIMITERS than about any one construct: reading a regex
is not enough if the scan is wrong about where the regex ENDS. A `/` inside a CHARACTER
CLASS does not close one — `/[/`]/` is legal, and `node` confirms it compiles and matches
a backtick — so a body scanned to the first `/` stopped at the class's own slash, leaving
the backtick after it live to open a phantom template frame exactly as an unread regex
had. Measured on the tree that shipped it, with the same resynchronising trailing regex:
the field pin DELETED outright, a copy in such a decoy, the field widened to
`DocType | 'onepager'` — `tsc` exit 0, eslint clean, every test here green, and again
nothing for a lint rule to object to, since a character class needs no suppression. All
four guards went with it, as in the seventh and eighth. The scan now tracks class state,
and that fix has a wrong side of its own — treating every `[` as opening a class would
swallow an indexed division — so both directions are pinned separately, because they are
different mistakes.

A TENTH defeat came from the third way a scan can be wrong about a regex: not whether it
reads one, nor where one ends, but WHERE ONE MAY BEGIN. `_REGEX_MAY_FOLLOW` excludes `)`,
which is right for an expression — `(a + b) / 2` divides — and wrong for the `)` that
closes an `if`/`for`/`while`/`switch` HEAD, after which a statement follows and a statement
cannot begin with a division. So `for (const _c of []) /`/…` was read as a division, its
backtick stayed live, and a decoy's own backtick closed the phantom frame it opened, with
the same resynchronising trailing statement as the eighth and ninth. Measured on the tree
that shipped it: the field pin DELETED outright, a copy in such a decoy, the field widened
to `DocType | 'onepager'` — `tsc` exit 0, eslint clean, every test here green, and nothing
for a lint rule to object to (assigning `.lastIndex` rather than calling `.test(...)`
raises no `sonarjs/no-ignored-return` and no TS2774). All four guards went with it again.
`_closes_control_head` walks back to the matching `(` and reads the word before it, which
is the only thing distinguishing the two `)`s. That fix has TWO wrong sides rather than
one, and both are pinned, because a single over-broad rule produces only one of them:
admitting a regex after every `)` blanks a grouped division, and accepting any word before
the matching `(` blanks a CALL's.

An ELEVENTH defeat then showed that fix had read the wrong word: the head KEYWORD is not
always the word before the `(`, because one MODIFIER may sit between them. `for await (…)`
ends in `await`, so `_closes_control_head` said False and `for await (const _c of []) /`/…`
reopened all four guards exactly as the tenth had — measured on the tree that shipped it,
with the field pin DELETED outright, a copy in such a decoy and the field widened: `tsc`
exit 0, eslint clean, every test here green. `for await` is the ONLY modified head form in
the language, so the surface here is one grammatical form rather than a construct; `catch`
stays out because `catch (e) /`/` is TS1005 under `tsc` and a SyntaxError in `node`.

⚠️ The one-word fix — adding `await` to `_REGEX_MAY_FOLLOW_HEAD` — is WRONG, and neither
existing wrong-side control catches it (measured: both green under it). `await` also leads
an EXPRESSION, so `await (w + h) / 2` is a legal division that a bare set membership blanks.
`_REGEX_MAY_FOLLOW_HEAD_MODIFIER` maps each modifier to the heads admitting it, so the word
before the modifier must be one of those, and `test_an_awaited_group_is_not_a_control_head`
pins the direction the simpler fix would have broken.

Rounds seven through eleven are ONE bug in ONE function surfacing in five constructs, each
fixed in the shared helper rather than in any guard. That is the part worth keeping: the
remaining surface is bounded by the ways JavaScript delimits a string — whether one is
read, where it ends, and where it may begin — not by the unbounded space of type
expressions this file rightly refuses to model. The eleventh is the narrowest of the five,
being one grammatical form rather than a construct, which is what convergence looks like.

THE GUARDS' OWN FIXES ARE PINNED TOO, which took its own finding. The two repairs made
in the fifth round shipped with no test, and reverting either left all 30 tests here
green — a green result meaning "did not check", applied to the machinery this file uses
to refuse exactly that. `TestThePinMatcher` covers `_declaration_offset` and
`_carries_expect_error` directly, so each repair is red when reverted. That the pin
matcher then needed a SIXTH repair, in a step whose first version was untested, is the
argument for having it.

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
    either, since the name is used. Nor does any EXISTENCE check over the file: the
    name APPEARING is satisfied by the pin block at its foot, the annotation
    `data: GenerateDocumentBody` by any unrelated line spelling it, and the whole
    signature by a decoy that copies it — all three measured, `tsc` exit 0 and every
    test here green with the real parameter respelled as an inline literal. Which is
    why the text guard asserts a RATIO: every declaration of the method takes the
    shared body.
    So a widening has to edit `DocType` itself — the declaration this file parses —
    and `GENERATED_DOC_TYPES` with it. Editing `GenerateDocumentBody.doc_type` is
    not a way around that: the pin above makes it a compiler error.

⚠️ THOSE TWO EDITS ARE NOT THE WHOLE SUPPORTED CHANGE, and every round of this file
claimed they were. TWO MORE are required — in the generator and in the picker — and
neither this file nor the compiler asks for either.

THE THIRD EDIT: the generator. `lambda/jobs/document_generator/handler.py` dispatches on
`doc_type` as a BINARY with PR-FAQ as the unconditional `else`, in three places —
anchored on the symbols rather than line numbers, since a citation into a file this
test does not read is exactly what goes stale (it has three times on this branch):

    `_generate_prd` vs `_generate_prfaq`                — the generation branch
    `get_prd_generation_steps` vs `get_prfaq_...`       — the step-builder selection
    `_assemble_and_save`'s `if doc_type == 'prd'`       — assembly, result indexing

— and it never imports `GENERATED_DOC_TYPES` (zero references). So a third member
added the blessed way passes `_validated_doc_type`, is routed into the Step Functions
chain by `is_chain = doc_type in GENERATED_DOC_TYPES` (true BY CONSTRUCTION for the
new member), and is then generated as a PR-FAQ, persisted with `sk = '{DOC_TYPE}#...'`
and `document_type = doc_type`. The user gets a document of the WRONG KIND under the
right label, after a Bedrock spend, with no error anywhere.

Measured: `DocType` and `GENERATED_DOC_TYPES` widened together leaves `tsc` at exit 0
and every test here green — the correct false-positive result for THESE guards, and
exactly why the incompleteness was invisible for seven rounds. That is worse than the
drift this file does catch: a refused value is a visible 400, this is a wrong-content
success. Adding a member therefore also needs a step builder, a generation branch and
an assembly branch there.

THE FOURTH EDIT: the picker. `frontend/src/pages/ProjectDetail/Wizards.tsx` names its
members as LITERALS, so a widening leaves the new type accepted by this route but never
OFFERED by the UI — dead capability rather than wrong content. Also symbol-anchored:

    `hasPrfaq` / `hasPrd`                       — the two selection flags
    the two `toggleDocType('...')` buttons      — in `renderFinalStep`
    `bothSelected`, `singleTitle`,              — copy and layout, all written as
      `singleSubmitLabel`                         a PRD-or-PR-FAQ binary
    `onSuggestBrief`'s `doc_type` ternary       — the same binary against a DIFFERENT
      (`...includes('prd') ? 'prd' : 'prfaq'`)    route: a third member selected alone
                                                  asks `suggest-brief` for a PR-FAQ
                                                  brief, so the AI-drafted title and
                                                  description come back framed as one.
                                                  The only place the picker's set meets
                                                  `suggestDocumentBrief`'s, which is
                                                  deliberately unbound (see above)

Measured the same way: the two blessed edits alone leave `tsc -p tsconfig.app.json
--noEmit` at exit 0 and every test here green, with the picker still rendering exactly
two buttons — `tsc` is fine with a NARROWER argument to `includes`/`filter`, so nothing
in that file has to change for it to compile. `Wizards.tsx` documents this direction
from its own side, beside the literals; the two statements should stay consistent.

THE FIFTH EDIT: the wire type the generator writes. `ProjectDocument.document_type` in
`frontend/src/api/types.ts` restates the doc types as LITERALS and is a SUPERSET of
`DocType` — it also carries `research`, `custom`, `product_report` and `prototype`, which
this route never accepts. The generator persists that field straight from `doc_type`, so
a widened `DocType` produces rows the wire type does not admit: latent rather than
absent, since `tsc` is clean until something assigns a `DocType` into the field, and a
probe that makes the two meet is a TS2322 (measured).

Referencing `DocType` there would remove the edit, and was tried — it is NOT available.
`test_kiro_exportable_types_lockstep.py` parses that union as string literals to derive
the full document-type set, and a referenced type makes it read zero members; it fails
loudly, but it fails. That parser answers a different contract (Kiro export inclusion),
so the ceiling is named at the field instead, beside the literals.

Deliberately NOT guarded here, any of the three. Those are different contracts — the
generator's dispatch, the picker's offering, and the wire type's superset, each against
the route's allowlist — and each wants its own test next to the code it constrains rather
than three further responsibilities bolted onto this file. What is fixed is the RECIPE:
the ceilings are stated, so a widener reads them instead of discovering one from a
mislabelled document, one from a button that never appears, and one from a type error in
whatever code first makes the two unions meet. Same reasoning as `suggestDocumentBrief`
above: name the boundary, do not grow the guard across it.

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
(the two type-level pins, spelled out in full so neither a stub nor a self-comparing
alias satisfies them, plus each control's `@ts-expect-error`) and the ONE link no
compiler can see: `DocType` against a Python tuple.

A DECLARATION RATHER THAN A FRAGMENT is the rule those pins converged on. Requiring
part of a declaration was defeated three rounds running — by the helper's own
declaration containing the fragment, and by the fragment saying nothing about the
operands — so what is pinned is the exact text of each declaration, operands included.
That is not an enumeration of legal TypeScript, which is the thing this file refuses:
there is one string per declaration, and any edit to it is either the same declaration
or a different one. The cost is that these declarations must stay on ONE line.

MATCHED AGAINST CODE, NOT AGAINST TEXT THAT MERELY LOOKS LIKE IT. Every pin above is
compared against `_declarations(...)`, which blanks comment bodies AND string bodies.
Blanking only comments — which is all this file did for seven rounds — left every one
of these guards satisfiable by a decoy inside a template literal: it survives
stripping, survives `noUnusedLocals` once exported, and can contain newlines, so it
also redirects any index computed with `find`. Measured on the shipped tree: deleting
`DocTypeFieldIsExactlyTheUnion` outright, putting a copy of it in an exported template
literal and widening the field it guards left `tsc` at exit 0 with every test here
green. The same decoy defeated the `@ts-expect-error` lookup, and would have defeated
the narrower "the preceding line must BE the directive" spelling that was the obvious
fix for that. This is the FOURTH shape of "some other construct supplies the string",
after the three fragment defeats above, and it is the general form of them: the earlier
three were about pinning too little of the declaration, this one about not caring where
the declaration was. `_doc_type_union` had the same hole — a quoted union above the
live one was read INSTEAD of it — and anchors in the same view now, while still reading
its members from the comments-only view because those members ARE string literals.

WHAT IS SELF-CHECKING, and therefore needs no text pin at all: the verdict helpers'
`extends true`. Each control applies the same helper as its pin and expects to be
rejected, via `@ts-expect-error`, so dropping the constraint — one edit that would
otherwise disable a pin and every control at once — makes those directives unused and
`tsc` reports TS2578. Preferring that to a fifth spelling is the same rule as above:
a link TypeScript can check gets a compiler check.

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
  * `test_a_union_inside_a_string_is_not_read_as_the_declaration` — the union parser
    anchoring on a quoted copy of the declaration instead of the live one. Measured: a
    `` const historical = `export type DocType = 'prd' | 'legacy'` `` above the live
    union returned the DECOY's members, so the equality test compared the wrong set.
    Same silent failure as the commented-out predecessor, one quote character away.
  * `test_a_union_inside_a_nested_template_is_not_read_as_the_declaration` — the same,
    one interpolation deeper, which is the SEVENTH vacuity: `${` re-enters code, so a
    scan running to the next backtick let the inner template's backtick close the outer
    one and the decoy became code again. Red when `_without_comments`'s frame stack is
    reverted to a single quote character, as are the three nested-template cases in
    `TestThePinMatcher` — one bug, four guards, so all four are pinned.
  * `TestThePinMatcher` — the pin MATCHER itself degenerating, which is what every
    round's finding about these guards has actually been. Each case is one revert of a
    repair that shipped untested and was therefore silently revertible:
      - matching against comment-stripped text rather than `_declarations(...)`, so a
        copy in an exported template literal supplies a pin that was DELETED;
      - locating the `@ts-expect-error` with an independent `raw.find`, which such a
        decoy redirects onto its own line, so the live control needs no directive;
      - accepting a preceding line that merely MENTIONS the directive, which the prose
        in these files does;
      - dropping the exact-text step, which compares a pin's quoted operands by LENGTH
        and lets `'not-a-doc-type'` become any other fourteen characters;
      - stopping at the FIRST candidate offset, which a decoy above the live
        declaration occupies — a false FAILURE rather than a false pass, and the reason
        the search continues;
      - scanning a template body to the next backtick, so a decoy in a NESTED template
        (`` `${`...`}` ``) was code again and could supply a pin that was DELETED, feed
        the union parser its own members, and satisfy both sides of the ratio alone.
        Three cases cover it here plus one in `TestTheUnionParser`, because the bug was
        in `_without_comments` and therefore in every guard that reads it.
      - having no notion of a REGEX literal, so a backtick inside one desynchronised the
        scan the same way — the EIGHTH vacuity, same root cause one construct over, and
        again in every guard at once. Two cases here plus one in `TestTheUnionParser` are
        red when the regex branch is reverted. Its two failure directions are pinned
        separately, since the fix has a wrong side of its own: reading a DIVISION as a
        regex blanks real code (`test_a_division_is_not_read_as_a_regex`), and deciding
        from the last character alone misses `return /`/` and desynchronises exactly as
        before (`test_a_keyword_led_regex_is_still_read_as_one`).
      - scanning a regex body to the first `/`, which a CHARACTER CLASS may contain
        (`/[/`]/` is legal) — so the body ended early and the backtick after it
        desynchronised the scan just as an unread regex did. The NINTH vacuity, the
        eighth's root cause one delimiter deeper, and again in every guard at once. Two
        cases here plus one in `TestTheUnionParser` are red when the class tracking is
        reverted, and its wrong side is pinned separately too: treating every `[` as
        opening a class swallows an indexed division
        (`test_an_indexed_division_is_not_read_as_a_character_class`).
      - reading a `/` after a control-flow head's `)` as a DIVISION, which it cannot be —
        a statement cannot begin with one. The TENTH vacuity, the same root cause a fourth
        time, and again in every guard at once: `for (const _c of []) /`/…` left its
        backtick live to open a phantom template frame. Three cases here plus one in
        `TestTheUnionParser` are red when `_closes_control_head` is no longer consulted.
        This fix has TWO wrong sides, pinned separately because a single over-broad rule
        would produce only one of them: admitting a regex after every `)` blanks a grouped
        division (`test_an_expression_division_is_not_read_as_a_regex`), and accepting any
        word before the matching `(` blanks a CALL's
        (`test_a_call_expression_is_not_a_control_head`).
      - reading only the word before that `(` as the head KEYWORD, which misses the one
        modified form the language has: `for await (…)` ends in `await`. The ELEVENTH
        vacuity, the same root cause a fifth time and again in every guard at once, so the
        four cases for the tenth are PARAMETRISED over both openers rather than duplicated
        — the `for_await` id of each is red when the modifier retry is reverted. Its wrong
        side is the reason the fix is a mapping and not one more set member: `await` leads
        an expression too, so `await (w + h) / 2` divides
        (`test_an_awaited_group_is_not_a_control_head`), and that control is the ONLY thing
        red under the one-word fix — measured, with both older wrong-side controls green.
        ⚠️ The mapping has TWO halves and its `in admitted_by` membership test was itself
        unpinned for a round: weakened to `keyword is not None`, all 65 tests passed while
        `return await (w + h) / 2` was blanked. The `const a = …` fixture cannot see that —
        its token before `await` is `=`, so no word precedes the modifier — so the same
        control now carries a KEYWORD-led fixture, which is what makes the membership half
        red. The mapping's other half needs no control: falling back to the head set for an
        unrecognised word differs only for `for each (` / `if foo (`, and `node` rejects
        every such shape as a SyntaxError, so that mutation is a noop rather than a vacuity.
    Each was measured against the live tree, `tsc` at exit 0 in every case. Positive
    assertions sit beside the negative ones so none can pass by rejecting everything.
  * `test_the_route_accepts_exactly_what_the_doc_type_union_offers` — the contract
    itself, in both directions.
  * `test_both_client_signatures_use_the_shared_request_body` — a signature
    respelling the body inline again, which is a compiler error in `client.ts` and
    NOTHING in `projectsApi.ts` (see above). Text, not a parse: it requires EVERY
    declaration of the method to take the shared body, so it needs no model of
    TypeScript and cannot mis-read a restyling. ⚠️ THREE weaker spellings were each
    measured to permit that respelling while claiming to forbid it — the bare NAME
    (satisfied by the pin block at the foot of `projectsApi.ts`), the ANNOTATION
    searched whole-file (satisfied by any unrelated `data: GenerateDocumentBody` line),
    and the whole signature merely PRESENT or present once (satisfied by a decoy that
    copies it). Each was `tsc` exit 0 with every test here green. Hence the RATIO,
    which a decoy adds to both sides of. A rename of `GenerateDocumentBody` or of the
    method fails it too, which is correct — the constants here are what the two files
    must agree on. ⚠️ A FOURTH spelling of this guard was also vacuous, and for the
    VIEW rather than the pattern: counted over comment-stripped text, a decoy inside an
    exported template literal added to both sides, and respelling the real colon
    (`generateDocument:(`) removed the real declaration from the count entirely —
    `tsc` exit 0, eslint clean, every test here green. Counted over `_declarations(...)`
    now, so this guard and the pins read the same code-only view; the `declared >= 1`
    floor is what refuses the respelled colon.
  * `test_the_type_level_pins_are_present` — either type-level pin deleted, STUBBED
    to a bare constant, fed through an alias that compares a type to itself, left with
    only one of its two controls, or stripped of a control's `@ts-expect-error`. All
    are silent otherwise, and each was measured to exit `tsc` 0 and pass every test
    here while the guarded field or parameter was widened. So what is required is each
    WHOLE DECLARATION, operands included — three successive fragments (the names,
    `MustBeTrue<`, then `MustBeTrue<BothWays<`) each turned out to be satisfiable
    without the pin doing anything: the second is in the helper's own declaration, and
    the third says nothing about what is being compared. Covers both links: the
    field-vs-union pin, and the parameter-vs-body pin that replaced the `satisfies`
    clause and the location guard it needed — see WHY EACH GUARD IS THE KIND IT IS for
    why a comparison was the answer and a tighter text slice was not.
  * Each control's `@ts-expect-error` — `extends true` dropped from a verdict helper,
    ONE edit that disables a pin and all its controls at once and was measured to
    leave `tsc` at exit 0 with every test here green. Because a control asserts its
    verdict by applying the SAME helper and expecting rejection, losing that
    constraint turns every directive into a TS2578, so the constraint is
    self-checking rather than a further thing this file has to spell. `@ts-ignore`
    cannot be swapped in — `@typescript-eslint/ban-ts-comment` refuses it.
    ⚠️ The directive is required to BE the line above the control, and is located by
    an index into the comment-and-string-blanked view. Two weaker spellings were
    measured to pass while both pins were fully disabled: a preceding line that merely
    MENTIONS the directive (several comments in these files do), and an index taken
    from the RAW source, which a decoy copy of a control in a comment or template
    literal redirects onto its own line.
  * The `...WouldSeeNarrowing` controls — `BothWays` collapsed to a one-way
    `extends`, which admits a NARROWED field or parameter: the "capability nobody
    can reach" half of this contract's drift. The widened-side controls cannot see
    that collapse (a superset fails the one-way test too), and it was measured to
    leave `tsc` at exit 0 with every test here green. Each reads the SAME operand as
    the pin it controls: the signature one used `never`, which discriminates the two
    forms but mentions nothing about the method, so it was a second detector of a
    collapse in the shared `BothWays` — measured, deleting it left that collapse
    reported only by `types.ts` — rather than a control on its own pin. Both right
    sides are DERIVED (`Partial<...>`, the field itself) so neither names a member
    that would go stale when the contract is legitimately widened.
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

# 🔑 EVERY DECLARATION of `generateDocument` must be the whole pinned signature —
# asserted as "the number of declaration openers equals the number of full
# signatures", not as "the full signature appears somewhere". Both files spell the
# signature identically, so one pair of constants covers them.
#
# Three successively weaker versions of this guard were each measured to permit the
# very edit it names — a structurally identical inline object literal in place of the
# shared type, which is precisely what issue #381 removed. None is hypothetical:
#
#   * `REQUEST_BODY_TYPE in source` — the bare NAME. Satisfied by the type-level pin
#     block at the foot of `projectsApi.ts`, which names `GenerateDocumentBody` three
#     times whatever the signature says. `tsc` exit 0, every test here green.
#   * `f'data: {REQUEST_BODY_TYPE}'` — the ANNOTATION, but searched over the whole
#     file, so ANY occurrence satisfies it. One unrelated line
#     (`const _probe = (data: GenerateDocumentBody) => data`) plus the inline literal
#     was again `tsc` exit 0 and all 29 tests green.
#   * The whole signature, required merely to be PRESENT — or present exactly once.
#     Still satisfied by a decoy, because a decoy may be a full COPY: a
#     `const _decoy = { generateDocument: (projectId: string, data:
#     GenerateDocumentBody) => ... }` above the real method makes the signature
#     present (and, for the once-only form, makes the real one inline while the count
#     still reaches its target). Measured: `tsc` exit 0, 29 passed.
#
# All three failed the same way, and it is the failure this file keeps rediscovering:
# an EXISTENCE check over a whole file asks whether some construct supplies the
# string, never whether the construct that matters does. A count of one is the same
# check with one more way to satisfy it.
#
# So the property asserted is a RATIO, which no added text can satisfy: every place
# the method is declared is a place the shared type is used. A decoy declaration adds
# an opener and, unless it too takes `GenerateDocumentBody`, no signature — so it
# fails. A decoy that DOES take the shared type adds one to both sides and is
# harmless, which is correct: it is not a respelling of the contract. And the real
# signature going inline removes a signature while leaving its opener, which fails.
#
# Not an enumeration of legal TypeScript — the thing this file refuses. There is one
# string per side, and `generateDocument` is either declared here or it is not.
#
# ⚠️ A SIXTH vacuity, and it is the fourth one whose root cause was the VIEW rather
# than the pattern: the ratio was counted over `_without_comments`, which blanks
# comment bodies but leaves STRING bodies intact — so a copy of this signature inside
# an exported template literal counted toward BOTH sides. Combined with respelling the
# real method's colon `generateDocument:(` (legal TypeScript, lints clean, and NOT this
# whitespace-exact opener), the real declaration went inline while the decoy supplied
# one opener and one signature: measured `tsc` exit 0, eslint clean, every test here
# green. The count is now taken over `_declarations(...)`, the same view the pins use,
# so every text guard in this file reads code and only code. The `declared >= 1` floor
# is what catches the colon half, and says so, because a method that is not SEEN is a
# different failure from one seen and unpinned.
#
# The cost, as for the pins below: this signature must stay on ONE line in both files.
GENERATE_DOCUMENT_SIGNATURE = (
    f'generateDocument: (projectId: string, data: {REQUEST_BODY_TYPE}) =>'
)

# What a DECLARATION of the method looks like, independent of its parameter type. The
# left side of the ratio above. `client.ts` also CALLS
# `m.projectsApi.generateDocument(...)`, which this deliberately does not match: a
# call site takes whatever the declaration admits and is not a place the contract can
# be respelled.
GENERATE_DOCUMENT_DECLARATION = 'generateDocument: ('

# The TERMINAL client — the one whose `data` is only spread into `JSON.stringify`, so
# its annotation is checked against nothing and naming the body type is not enough on
# its own (an `Omit<..> & { doc_type: .. | 'x' }` respelling names it and still
# widens).
TERMINAL_CLIENT = 'frontend/src/api/projectsApi.ts'

# The two type-level pins that carry every link TypeScript can check, each with the
# file it is declared in. A pin's own absence is SILENT — delete either block and the
# frontend still compiles — which is the only reason this file mentions them at all:
# `test_the_type_level_pins_are_present` keeps them there.
#
# 🔑 WHOLE DECLARATIONS, not fragments. Three rounds each found the fragment being
# required was satisfiable without the pin doing anything, so the rule this converged
# on is: pin the entire right-hand side, because any fragment of it is a substring some
# other construct can contain.
#
#   * Requiring only the NAMES was vacuous. Stub a pin and its control to bare
#     constants (`export type DocTypeFieldIsExactlyTheUnion = true`), delete the helper
#     types so no unused-local fires, and `tsc` exits 0 with every test here green
#     while the field they guard is widened past the route's allowlist.
#   * Requiring `MustBeTrue<` was ALSO vacuous, for a subtler reason: that substring
#     occurs in the helper's OWN declaration (`type MustBeTrue<Verdict ...>`), so it is
#     satisfied by the helper merely existing. The stub only has to keep the helpers
#     and `export` them — measured, `tsc` exit 0 and every test here green.
#   * Requiring `MustBeTrue<BothWays<` was vacuous a THIRD way, and this is why the
#     rule is now the whole declaration rather than a longer fragment: the fragment
#     says nothing about what the comparison's OPERANDS are. Repointing the
#     intermediate alias the left side was read through (`Parameters<...>[1]` ->
#     `GenerateDocumentBody`) made the pin compare the interface to itself — still
#     spelled `SignatureMustMatch<BothWays<`, still with both controls present and
#     green because they read the same alias, `tsc` exit 0, every test here green, and
#     a caller able to send a value the route 400s. The alias is now inlined and the
#     operands are part of what is pinned.
#
# This is why every pinned declaration in both files is written on ONE line: what is
# required is the exact text, so a wrapped declaration puts newlines inside it.
#
# The `@ts-expect-error` above each CONTROL is load-bearing, and pinned separately
# below. A control asserts its comparison must NOT hold by applying the SAME verdict
# helper as the pin and expecting the error — so if `extends true` is dropped from that
# helper (which would silently disable the pin and every control at once) the expected
# errors stop arriving and each directive becomes a TS2578 "unused
# '@ts-expect-error'". That is what makes the helper's constraint self-checking rather
# than a fourth thing this file has to spell. `@ts-ignore` cannot be swapped in: it is
# a lint error under `@typescript-eslint/ban-ts-comment`.
#
# A FOURTH vacuity, and the general form of the three above: WHERE the string comes
# from was never checked. Matching against the comment-stripped source stopped a
# commented-out copy, but not one inside a template literal — which survives stripping,
# survives `noUnusedLocals` once exported, and can carry newlines. Measured: delete
# `DocTypeFieldIsExactlyTheUnion`, put a copy in an exported template literal and widen
# the field it guards — `tsc` exit 0, every test here green. So these are matched
# against `_declarations(...)`, which blanks string bodies as well; the expected text
# goes through it too, so a quoted member inside a pinned declaration still matches.
#
# Keyed by relative path, since the pins live in two files. Each value is
# (pin-declaration, control-declarations) — the controls are a tuple because each pin
# needs TWO of them (widened and narrowed; see below). Every entry is the EXACT text of
# a declaration.
TYPE_LEVEL_PINS = {
    # `GenerateDocumentBody.doc_type` admits exactly the members of `DocType`. Nothing
    # else in either language sees this field: this file parses only the
    # `export type DocType =` declaration, and the signature pin below compares
    # against the interface, so a widened interface satisfies it by construction.
    DOC_TYPE_UNION_SOURCE: (
        (
            "export type DocTypeFieldIsExactlyTheUnion = "
            "MustBeTrue<BothWays<GenerateDocumentBody['doc_type'], DocType>>"
        ),
        (
            (
                "export type DocTypeFieldPinWouldSeeDrift = MustBeTrue<BothWays<"
                "GenerateDocumentBody['doc_type'] | 'not-a-doc-type', DocType>>"
            ),
            (
                'export type DocTypeFieldPinWouldSeeNarrowing = MustBeTrue<BothWays<'
                "GenerateDocumentBody['doc_type'], DocType | 'not-a-doc-type'>>"
            ),
        ),
    ),
    # `generateDocument`'s parameter admits exactly `GenerateDocumentBody`. This is the
    # one that replaced a `satisfies` clause in the method body plus the text guard
    # that pinned WHERE the clause sat — see the docstring's WHY EACH GUARD IS THE KIND
    # IT IS: a clause has a location and could be migrated out of whatever slice was
    # searched, and both slices tried were measured to be evadable. A comparison
    # against the method's own type has nowhere to migrate to.
    TERMINAL_CLIENT: (
        (
            'export type GenerateDocumentTakesTheSharedBody = '
            'SignatureMustMatch<BothWays<Parameters<typeof '
            'projectsApi.generateDocument>[1], GenerateDocumentBody>>'
        ),
        (
            (
                'export type GenerateDocumentSignaturePinWouldSeeDrift = '
                'SignatureMustMatch<BothWays<Parameters<typeof '
                'projectsApi.generateDocument>[1], GenerateDocumentBody & '
                '{ not_in_the_body: true }>>'
            ),
            (
                'export type GenerateDocumentSignaturePinWouldSeeNarrowing = '
                'SignatureMustMatch<BothWays<Parameters<typeof '
                'projectsApi.generateDocument>[1], Partial<GenerateDocumentBody>>>'
            ),
        ),
    ),
}

# The directive each control must carry, on the line immediately above it. Checked
# against the RAW source, since `_without_comments` blanks exactly this.
EXPECT_ERROR_DIRECTIVE = '@ts-expect-error'

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

# A `/` opens a REGEX rather than dividing when the last significant thing before it
# cannot end an expression. Deliberately CONSERVATIVE: mistaking a division for a regex
# would blank real code, while mistaking a regex for a division is what the eighth
# vacuity was — so the two errors are not symmetric, and this errs toward reading less.
#
# ⚠️ `)` is NOT here, and must not be: `(a + b) / 2` is a division, and taking every `)`
# to admit a regex would blank the rest of that line. The one `)` that cannot be
# followed by a division is the one closing an `if`/`for`/`while`/`switch` HEAD, which
# `_closes_control_head` decides separately — leaving it out of both readings was the
# TENTH vacuity.
_REGEX_MAY_FOLLOW = '=(,:[!&|?{};+-*%~^<>'
# The keywords a regex may directly follow, where the preceding CHARACTER is a word
# character and so says nothing on its own (`return /`/.test(x)`).
_REGEX_MAY_FOLLOW_KEYWORD = frozenset({
    'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'delete',
    'void', 'instanceof', 'new',
})
# The heads whose closing `)` ends a STATEMENT position, so a `/` after it can only open
# a regex. `catch` is absent deliberately: `catch (e) /`/` is not reachable code — `tsc`
# reports TS1005 and `node` a SyntaxError — and the conservative direction costs nothing.
_REGEX_MAY_FOLLOW_HEAD = frozenset({'if', 'for', 'while', 'switch'})
# 🔑 The modifiers a head may carry between the keyword and its `(`, mapped to the heads
# that admit them. `for await (…)` is the only such form in the language, and reading only
# the word immediately before the `(` — which is `await`, not `for` — was the ELEVENTH
# vacuity: `_closes_control_head` said False, the regex after that `)` was read as a
# division, and every guard here reopened.
#
# ⚠️ Mapped rather than folded into `_REGEX_MAY_FOLLOW_HEAD`, which is the one-word fix and
# is WRONG: `await` also leads an expression, so `await (w + h) / 2` is a legal DIVISION
# (`node` confirms it evaluates) that a bare set membership blanks. Requiring the word
# BEFORE the modifier to be a head that admits it keeps the expression form dividing, so
# this closes the vacuity without opening a false FAILURE beside it.
_REGEX_MAY_FOLLOW_HEAD_MODIFIER = {'await': frozenset({'for'})}
_TRAILING_WORD = re.compile(r'[A-Za-z_$][\w$]*$')

# 🔑 The TENTH vacuity's decoy opener, shared by every guard's fixture for it because the
# defect was one — a regex in STATEMENT position, whose backtick opened a phantom template
# frame that a decoy's own backtick then closed. Two of these bracket the decoy: the second
# resynchronises the scan, which is what made the evasion clean rather than one that ran to
# EOF and noisily swallowed whatever followed. Assigning `.lastIndex` rather than calling
# `.test(...)` keeps it lint-clean, so nothing stood in the way of this one either.
CONTROL_HEAD_DESYNC = 'for (const _c of []) /`/.lastIndex = Number(_c)\n'
# 🔑 The ELEVENTH vacuity's opener: the same statement one MODIFIER wider. Every guard's
# fixture for the tenth is parametrised over BOTH rather than duplicated, because the two
# are one defect — the head keyword is not the word before the `(` — and four more test
# bodies would have been four more places for the next round's fix to go untested.
CONTROL_HEAD_DESYNCS = {
    'for': CONTROL_HEAD_DESYNC,
    'for_await': 'for await (const _c of []) /`/.lastIndex = Number(_c)\n',
}


def _closes_control_head(text: str) -> bool:
    """Whether `text` ends with the `)` that closed an `if`/`for`/`while`/`switch` head.

    🔑 The TENTH vacuity, and the same root cause as the seventh through ninth: a `/`
    after such a `)` can only open a regex, since a control-flow head is followed by a
    STATEMENT and a statement cannot begin with a division. `_REGEX_MAY_FOLLOW` excludes
    `)` — correctly, for an expression `)` — so `for (const _c of []) /`/…` was read as
    a division, its backtick stayed live, and the phantom template frame it opened was
    closed by a decoy's own backtick. Everything after that was code again.

    Walks back to the matching `(` and reads the word before it, which is the only way to
    tell the two `)`s apart: `(w + h) / 2` and `for (x of y) /re/` differ solely in what
    precedes the group. Errs toward returning False for the reason `_REGEX_MAY_FOLLOW`
    gives — an unmatched `(` or an unknown word leaves the `/` read as a division, which
    is a false FAILURE bounded to one line.

    🔑 The word before the `(` is not always the HEAD KEYWORD, and assuming it was for one
    round was the ELEVENTH vacuity: `for await (…)` ends in `await`, so this returned False
    and the eleventh reopened all four guards exactly as the tenth had. One MODIFIER may sit
    between the keyword and its `(`, so an unrecognised word is retried as one — see
    `_REGEX_MAY_FOLLOW_HEAD_MODIFIER` for why that indirection is not the simpler set
    addition, which would blank a legal `await (w + h) / 2`.
    """
    depth = 0
    for index in range(len(text) - 1, -1, -1):
        char = text[index]
        if char == ')':
            depth += 1
        elif char == '(':
            depth -= 1
            if depth == 0:
                head = _TRAILING_WORD.search(text[:index].rstrip())
                if head is None:
                    return False
                if head.group(0) in _REGEX_MAY_FOLLOW_HEAD:
                    return True
                # Not a head, so try it as a modifier: the head is then the word before it,
                # and must be one this modifier is legal on.
                admitted_by = _REGEX_MAY_FOLLOW_HEAD_MODIFIER.get(head.group(0))
                if admitted_by is None:
                    return False
                keyword = _TRAILING_WORD.search(text[:head.start()].rstrip())
                return keyword is not None and keyword.group(0) in admitted_by
    return False


def _regex_allowed_here(emitted: list[str]) -> bool:
    """Whether a `/` at this point starts a REGEX rather than being a division operator.

    Decided from what has already been emitted, since that is the only context a
    single-pass scan has. See `_REGEX_MAY_FOLLOW` for why the conservative direction is
    the safe one, and `_closes_control_head` for the one `)` that admits a regex.
    """
    text = ''.join(emitted).rstrip()
    if not text:
        return True
    if text[-1] in _REGEX_MAY_FOLLOW:
        return True
    if text[-1] == ')':
        return _closes_control_head(text)
    trailing = _TRAILING_WORD.search(text)
    return trailing is not None and trailing.group(0) in _REGEX_MAY_FOLLOW_KEYWORD


def _without_comments(source: str, blank_strings: bool = False) -> str:
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
    not mistaken for a comment, and regex literals are read too, character classes
    included — see the 🔑 notes below on the eighth and ninth vacuities, which are what
    each of those used to cost.

    🔑 `blank_strings` additionally blanks STRING and TEMPLATE bodies, and exists
    because "commentary is not a declaration" has a second half this file missed for
    seven review rounds: a STRING is not a declaration either. Comments were the only
    thing blanked, so every text guard here could be satisfied by a decoy inside a
    template literal — which survives stripping, survives `noUnusedLocals` once
    exported, and can carry newlines, so it also redirects an index computed with
    `find`. Measured on the shipped tree: deleting `DocTypeFieldIsExactlyTheUnion`
    outright, putting a copy in an exported template literal and widening the field it
    guards left `tsc` at exit 0 with every test here green. The same decoy defeated
    the `@ts-expect-error` check, and would have defeated the narrower "the preceding
    line must BE the directive" spelling that was the obvious fix for it.

    Off by default because `_doc_type_union` reads the union's members, which ARE
    string literals — blanking them there would blank the contract itself. On for
    LOCATING the declaration pins, where both the source and the expected text go
    through it (see `_declaration_offset`), so a decoy that merely contains the same
    characters is not a place a pin can match. What the pin says is then read from the
    raw text at that offset: blanking cannot tell two same-length literals apart, so it
    answers where a declaration is and never what it declares.

    🔑 A template body is NOT opaque to its closing backtick, and scanning as if it
    were was the seventh measured vacuity — a bug in this one function that reopened
    every text guard in the file. `${...}` is CODE again, so the first backtick inside
    an interpolation CLOSED the outer template under a single-quote-character scan and
    everything after it was code once more. A decoy in a NESTED template was therefore
    in the blanked view exactly as if it were real source. Measured on the tree that
    shipped it, with `sonarjs/no-nested-template-literals` suppressed on one line
    (legal, and lint-clean): `DocTypeFieldIsExactlyTheUnion` deleted outright, a copy
    left in a nested template, and the field it guards widened left `tsc` at exit 0,
    eslint clean, and every test here green — and that pin has NO compiler backstop,
    since nothing else in either language compares the field to the union. The same
    decoy also fed `_doc_type_union` the decoy's members instead of the live union's,
    and supplied both sides of `_generate_document_ratio` on its own.

    So the state is a STACK of frames rather than one quote character: inside a
    template, `${` pushes an interpolation frame; inside that frame braces track depth
    and the depth-0 `}` pops back into the template, with code rules (comments, new
    strings) applying in between. `TestThePinMatcher` and `TestTheUnionParser` pin all
    four consequences, since the previous round's finding was that repairs to these
    helpers ship silently revertible.

    🔑 A REGEX literal is not code either, and having no notion of one was the EIGHTH
    measured vacuity — the same root cause as the seventh, one construct over, and the
    reason the module docstring's corollary is about where a string ENDS rather than about
    `${`. A backtick inside a regex (`/`/`) opened a phantom template frame, which the
    decoy's own opening backtick then CLOSED, so the decoy body was emitted as code; a
    second regex after it resynchronises the scan, making the evasion clean rather than
    running to EOF and swallowing whatever follows. Measured on the tree that shipped it:
    the field pin deleted, a copy in such a decoy, the field widened — `tsc` exit 0,
    eslint clean, every test here green, and this time no lint rule in the way.

    `_regex_allowed_here` decides regex-versus-division from what has been emitted, and it
    is deliberately CONSERVATIVE: misreading a division blanks real code, which is a false
    FAILURE bounded to one line, while misreading a regex is the vacuity above, a false
    PASS with no bound. Both directions are pinned, because the fix has a wrong side too.

    🔑 And a regex body does not necessarily END at the next `/` — a CHARACTER CLASS may
    hold one, `/[/`]/` being legal — which was the NINTH vacuity and the eighth's root
    cause one delimiter deeper. The body stopped at the class's own slash, so the backtick
    after it stayed live and opened a phantom template frame exactly as an unread regex
    had; measured the same way, with the field pin deleted and every gate green. So the
    scan tracks class state, and its wrong side is pinned too: taking every `[` to open a
    class would swallow an indexed division (`x[i] / 2 + y[j] / 3`), the same false-FAILURE
    direction as misreading a division.

    🔑 And a regex does not only END where the scan must be right — it also BEGINS there,
    which was the TENTH vacuity. A `/` after the `)` closing an `if`/`for`/`while`/`switch`
    head can only open a regex, since what follows such a head is a statement; but `)` is
    absent from `_REGEX_MAY_FOLLOW` (correctly, for a grouped `(a + b) / 2`), so
    `for (const _c of []) /`/…` was read as a division and its backtick desynchronised the
    scan exactly as an unread regex had. Measured the same way, with the field pin deleted
    and every gate green including eslint. `_closes_control_head` decides it, and both of
    its wrong sides are pinned — see there.

    🔑 And WHERE it begins is decided from a word, which must be the right one: reading the
    word before that `)`'s matching `(` misses `for await (…)`, whose is `await`. The
    ELEVENTH vacuity, measured the same way — field pin deleted, every gate green — and the
    reason `_closes_control_head` retries an unrecognised word as a MODIFIER rather than
    taking `await` as a head, which would blank a legal `await (w + h) / 2`. Rounds seven to
    eleven were one bug in this function surfacing in five constructs, which is why each fix
    belongs here and not in a guard.
    """
    def blanked(text: str) -> str:
        return ''.join('\n' if char == '\n' else ' ' for char in text)

    out: list[str] = []
    # A STACK, not a single quote character, because `${...}` inside a template
    # literal is CODE again — see the 🔑 note above on the seventh vacuity. Frames are
    # `('str', quote_char)` for a string or template body and `('interp', depth)` for
    # an interpolation, whose brace depth says which `}` closes it.
    frames: list[tuple[str, object]] = []
    index = 0
    while index < len(source):
        char = source[index]
        if frames and frames[-1][0] == 'str':
            quote = frames[-1][1]
            if char == '\\':
                # Blank the escape as a unit, so a trailing `\` cannot swallow the
                # closing quote and blank the rest of the file.
                out.append(blanked(source[index:index + 2]) if blank_strings
                           else source[index:index + 2])
                index += 2
                continue
            if quote == '`' and source.startswith('${', index):
                frames.append(('interp', 0))
                out.append(blanked('${') if blank_strings else '${')
                index += 2
                continue
            if char == quote:
                out.append(char)
                frames.pop()
                index += 1
                continue
            out.append(blanked(char) if blank_strings else char)
            index += 1
            continue
        if char in '\'"`':
            frames.append(('str', char))
            out.append(char)
            index += 1
            continue
        if frames and frames[-1][0] == 'interp' and char in '{}':
            depth = frames[-1][1]
            assert isinstance(depth, int)
            if char == '}' and depth == 0:
                # Back into the enclosing template body.
                frames.pop()
            else:
                frames[-1] = ('interp', depth + (1 if char == '{' else -1))
            out.append(blanked(char) if blank_strings else char)
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
        # ⚠️ AFTER the two comment branches, never before: a `/` that opens `//` or `/*`
        # would otherwise be consumed as an empty regex, and reading a comment as code is
        # the defect `_without_comments` exists for. Measured — placed first, the
        # commented-out predecessor and commented-out pin cases all fail.
        if char == '/' and _regex_allowed_here(out):
            stop = index + 1
            # A `/` inside a CHARACTER CLASS does not close the regex — `/[/`]/` is
            # legal — and scanning to the first `/` regardless was the ninth vacuity.
            # See the 🔑 note above; the class's own slash ended the body early, so the
            # backtick after it opened a phantom template frame.
            in_class = False
            while stop < len(source) and source[stop] != '\n':
                if source[stop] == '\\':
                    stop += 2
                    continue
                if source[stop] == '[':
                    in_class = True
                elif source[stop] == ']':
                    in_class = False
                elif source[stop] == '/' and not in_class:
                    break
                stop += 1
            if stop < len(source) and source[stop] == '/':
                out.append(char)
                body = source[index + 1:stop]
                out.append(blanked(body) if blank_strings else body)
                out.append('/')
                index = stop + 1
                continue
        out.append(char)
        index += 1
    return ''.join(out)


def _declarations(raw: str) -> str:
    """`raw` reduced to the text that can actually DECLARE something: comment bodies
    and string bodies both blanked, length preserved.

    This is where a pin is LOCATED: `_declaration_offset` matches here, with the
    expected text put through this too so the two are compared on equal terms, which is
    what stops a copy inside a comment or a template literal from being a place a pin
    can match.

    ⚠️ Locating is all it does. Blanking makes two quoted operands of equal length
    indistinguishable, so it cannot decide WHAT was declared — `_declaration_offset`
    re-checks the raw text at each candidate for that, and the 🔑 note there carries
    the measurement. Reading a pin's operands from this view alone was a vacuity.

    Length preserved, so an index found here is valid against `raw`. That is relied on
    for the `@ts-expect-error` lookup, which has to read a line this function blanks.
    """
    return _without_comments(raw, blank_strings=True)


def _declaration_offset(expected: str, raw: str) -> int | None:
    """Where `raw` DECLARES `expected`, or None — structurally located, exactly matched.

    Two steps, and both are needed:

      1. WHERE. The candidate offsets come from `_declarations(raw)` matched against
         `_declarations(expected)`, so a copy of the declaration inside a comment or a
         template literal is not a place this can match. Blanking is done on BOTH
         sides because the expected text contains quoted members
         (`'not-a-doc-type'`), which blanking one side only would never match.
      2. WHAT. At each candidate offset the RAW text must equal `expected`. Blanking
         preserves length, so the offset is valid in `raw`.

    🔑 Step 2 exists because step 1 alone compares quoted operands by LENGTH, not
    content — blanking maps `'not-a-doc-type'` and `'AAAAAAAAAAAAAA'` to the same
    fourteen spaces. Measured on the shipped tree: swapping the widened control's
    member for an arbitrary same-length string left `tsc` at exit 0 with every test
    here green, and swapping `['doc_type']` for `['bogusKey']` in the pin was caught
    only by the compiler (TS2339), not here. The second is backstopped; the first is
    not, since one arbitrary non-member is as good as another to the compiler and the
    control keeps working — so nothing but this comparison notices the literals
    drifting. A guard that reads a pin's operands by length is the same vacuity class
    as the four this file already records, one level in.

    Several candidates are tried rather than just the first, so a commented-out or
    quoted copy ABOVE the live declaration cannot mask it: that copy blanks to the
    same shape and would otherwise be the only offset examined, fail step 2, and
    report the live pin missing.

    Returns the OFFSET rather than a bool because the `@ts-expect-error` lookup needs
    the same location, and computing it twice by different means is how the two
    drifted apart before: that lookup used its own `find` and a decoy redirected it.
    """
    needle = _declarations(expected)
    haystack = _declarations(raw)
    located = haystack.find(needle)
    while located != -1:
        if raw[located:located + len(expected)] == expected:
            return located
        located = haystack.find(needle, located + 1)
    return None


def _pinned(expected: str, raw: str) -> bool:
    """Whether `raw` declares `expected`. See `_declaration_offset`."""
    return _declaration_offset(expected, raw) is not None


def _generate_document_ratio(raw: str) -> tuple[int, int]:
    """How many times `raw` DECLARES `generateDocument`, and how many of those take the
    shared request body — the two sides of the ratio
    `test_both_client_signatures_use_the_shared_request_body` asserts.

    🔑 Counted over `_declarations(...)`, not over comment-stripped text, and that was
    a measured vacuity of its own: `_without_comments` leaves STRING bodies intact, so a
    copy of the signature inside an exported template literal counted toward BOTH sides.
    Paired with respelling the real method's colon (`generateDocument:(` — legal
    TypeScript, lint-clean, and not the exact opener counted) the real declaration
    vanished from the count while the decoy supplied one of each side, so the ratio held
    with `tsc` at exit 0, eslint clean, and every test here green. Same root cause as
    the pins' fourth vacuity, which is why both read one view now.

    A function rather than two inline `str.count` calls so the property is reachable from
    a test without a fixture file on disk — the fix above was silently revertible until
    this existed, which is the failure mode this file's own controls exist to refuse.
    """
    source = _declarations(raw)
    return (
        source.count(GENERATE_DOCUMENT_DECLARATION),
        source.count(GENERATE_DOCUMENT_SIGNATURE),
    )


def _directive_above(declaration: str, raw: str) -> str | None:
    """The line directly above where `raw` declares `declaration`, or None if it does
    not declare it at all.

    Located via `_declaration_offset`, so it is the LIVE declaration's line and not
    that of a copy in a comment or a template literal — an independent `raw.find` here
    was measured to land on such a decoy, which let both real `@ts-expect-error`
    directives be deleted with every gate green.

    Returned rather than asserted on so the caller's rule ("must BE the directive, not
    merely mention it") is checkable from a test without a fixture file. Both halves of
    this lookup were silently revertible before that was possible.
    """
    located = _declaration_offset(declaration, raw)
    if located is None:
        return None
    return raw[:located].rstrip().rsplit('\n', 1)[-1]


def _carries_expect_error(declaration: str, raw: str) -> bool:
    """Whether `raw` declares `declaration` with an `@ts-expect-error` directly above.

    🔑 The line must BE the directive, not merely contain it: several comments in these
    two files DISCUSS `@ts-expect-error` in prose, and a substring test over the
    preceding line was measured to be satisfied by one of them — so both real
    directives could be deleted and `extends true` dropped from a verdict helper,
    disabling both pins and all four controls, with `tsc` at exit 0 and every test here
    green.
    """
    preceding = _directive_above(declaration, raw)
    if preceding is None:
        return False
    return preceding.lstrip().startswith(f'// {EXPECT_ERROR_DIRECTIVE}')


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

    🔑 The ANCHOR is located in `_declarations(source)` — comment AND string bodies
    blanked — while the MEMBERS are read from `code`, which blanks comments only. Both
    are needed and neither alone will do: the members are string literals, so reading
    them from the strings-blanked view would return a set of empty strings, but
    anchoring there means a declaration quoted inside a template literal is not the
    first `re.search` match. Measured: without this, a decoy
    `` const historical = `export type DocType = 'prd' | 'legacy'` `` above the live
    declaration was read INSTEAD of it, returning the decoy's members — the same
    silent failure as the commented-out predecessor, one quote character away. The two
    views are the same length, so an index from one is valid in the other.
    """
    code = _without_comments(source)
    anchor = DOC_TYPE_UNION_ANCHOR.search(_declarations(source))
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

    def test_a_union_inside_a_string_is_not_read_as_the_declaration(self):
        """The parser reads the LIVE union, not a copy of one in a template literal.

        `_doc_type_union` deliberately does NOT blank string bodies — the members it
        reads are string literals — so this pins that the anchor still has to match
        real code. A decoy above the live declaration would otherwise be the first
        `re.search` match, which is the same silent failure as the commented-out
        predecessor `_without_comments` exists for.
        """
        source = (
            "const historical = `export type DocType = 'prd' | 'legacy'`\n"
            "export type DocType = 'prd' | 'prfaq'\n"
        )
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq'})

    def test_a_union_inside_a_nested_template_is_not_read_as_the_declaration(self):
        """The same, one interpolation deeper — the seventh vacuity.

        `${` re-enters code, so under a scan that ran to the next backtick the inner
        template's opening backtick closed the outer one and the decoy became code. The
        union read was then the DECOY's, so a live union that had DRIFTED compared equal
        to the route and reported no drift. The live union here carries the extra member
        deliberately: this must read `onepager`, not agree with a stale copy.
        """
        source = (
            "const historical = `kept: ${`export type DocType = 'prd' | 'legacy'`}`\n"
            "export type DocType = 'prd' | 'prfaq' | 'onepager'\n"
        )
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

    def test_a_union_inside_a_regex_desynced_template_is_not_read(self):
        """The same again for a REGEX-borne backtick — the eighth vacuity.

        The regex's backtick opened a phantom template frame which the decoy's own opening
        backtick closed, so the decoy was anchored as if it were code and its members were
        compared against the route. As above, the live union carries the extra member
        deliberately: this must read `onepager` rather than merely disagree with the decoy,
        or it would pass on a parser that read nothing at all.
        """
        source = (
            "const backtickMatcher = /`/\n"
            "const historical = `export type DocType = 'prd' | 'legacy'`\n"
            "const secondMatcher = /`/\n"
            "export type DocType = 'prd' | 'prfaq' | 'onepager'\n"
        )
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

    def test_a_union_inside_a_class_desynced_template_is_not_read(self):
        """The same again where the regex's terminator is inside a CHARACTER CLASS — the
        ninth vacuity.

        `/[/`]/` is legal, so a body scanned to the first `/` stopped at the class's own
        slash and left the backtick after it live, opening a phantom template frame. As in
        the two cases above the live union carries the extra member deliberately: this must
        read `onepager` rather than merely disagree with the decoy, or it would pass on a
        parser that read nothing at all.
        """
        source = (
            "const backtickMatcher = /[/`]/\n"
            "const historical = `export type DocType = 'prd' | 'legacy'`\n"
            "const secondMatcher = /[/`]/\n"
            "export type DocType = 'prd' | 'prfaq' | 'onepager'\n"
        )
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

    @pytest.mark.parametrize(
        'desync', CONTROL_HEAD_DESYNCS.values(), ids=CONTROL_HEAD_DESYNCS
    )
    def test_a_union_inside_a_control_head_desynced_template_is_not_read(self, desync):
        """The same again for a regex in STATEMENT position — the tenth vacuity, and the
        ELEVENTH in the `for_await` case.

        `_REGEX_MAY_FOLLOW` excludes `)` because `(a + b) / 2` divides, so a regex after a
        `for`/`if`/`while` head's `)` was read as a division and its backtick stayed live
        to open a phantom template frame. As in the three cases above the live union
        carries the extra member deliberately: this must read `onepager` rather than merely
        disagree with the decoy, or it would pass on a parser that read nothing at all.

        Parametrised over both openers rather than duplicated, because they are one defect
        read at two depths: `for await` ends in `await`, so a check reading only the word
        before the `(` reopened this exactly as the tenth had.
        """
        source = (
            f'{desync}'
            "const historical = `export type DocType = 'prd' | 'legacy'`\n"
            f'{desync}'
            "export type DocType = 'prd' | 'prfaq' | 'onepager'\n"
        )
        assert _doc_type_union(source) == frozenset({'prd', 'prfaq', 'onepager'})

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


class TestThePinMatcher:
    """`_declaration_offset` — what `test_the_type_level_pins_are_present` locates the
    pins with, on synthetic sources.

    Its own controls, for the same reason `TestTheUnionParser` has them: every defect
    ever found in the pin guards was the matcher accepting something that did not
    declare the pin, and each fix to it was silently revertible — reverting either of
    the two made in the fifth round left all 30 tests here green, which is the "green
    result meaning did not check" this file exists to refuse, applied to its own
    machinery. A positive assertion sits beside every negative one so none of these
    can pass by rejecting everything.
    """

    # A pin's shape, without depending on the live ones: those are pinned as exact text
    # elsewhere, and a fixture that tracked them would fail for a legitimate edit to
    # them rather than for a defect in the matcher.
    PIN = "export type X = MustBeTrue<BothWays<Body['doc_type'], DocType>>"

    def test_a_declaration_inside_a_template_literal_is_not_pinned(self):
        """A string is not a declaration — the fifth vacuity, and the general form of
        the four before it.

        A copy in an exported template literal survives comment-stripping, survives
        `noUnusedLocals`, and can carry newlines. Measured on the shipped tree: with
        the pins matched against comment-stripped text only, the real pin could be
        DELETED, a copy left in such a literal, and the field it guards widened, with
        `tsc` at exit 0 and every test here green.
        """
        decoy = f'export const historical = `\n{self.PIN}\n`\n'
        assert not _pinned(self.PIN, decoy)
        # The control: the same text as real code must still be found, or this would
        # pass by matching nothing.
        assert _pinned(self.PIN, f'{self.PIN}\n')

    # 🔑 A NESTED template literal — the seventh vacuity. `${` re-enters code, so the
    # backtick that opens the inner template used to CLOSE the outer one, and everything
    # after it was code again: this decoy sat in the blanked view as if it were real
    # source. Every case below is red when `_without_comments`'s frame stack is reverted
    # to a single quote character.
    NESTED_DECOY_OPEN = 'export const historical = `kept: ${`\n'
    NESTED_DECOY_CLOSE = '`}`\n'

    def test_a_declaration_inside_a_nested_template_literal_is_not_pinned(self):
        """The seventh vacuity, and the one with no compiler backstop.

        Measured on the tree that shipped it: the real pin DELETED, a copy left in a
        nested template literal (one `// eslint-disable-next-line
        sonarjs/no-nested-template-literals` away from lint-clean), and the field it
        guards widened — `tsc` exit 0, eslint clean, every test here green. Unlike the
        inline-literal cases the parameter pin backstops, nothing else in either language
        compares `GenerateDocumentBody.doc_type` to `DocType`, so this one was the whole
        guard.
        """
        decoy = f'{self.NESTED_DECOY_OPEN}{self.PIN}\n{self.NESTED_DECOY_CLOSE}'
        assert not _pinned(self.PIN, decoy)
        # The control, as everywhere here: real code must still be found.
        assert _pinned(self.PIN, f'{self.PIN}\n')

    def test_a_directive_inside_a_nested_template_literal_is_not_the_live_one(self):
        """The same decoy against the `@ts-expect-error` lookup: it carried both the
        control's text and a directive above it, so the live control could have neither.
        """
        decoy = (
            f'{self.NESTED_DECOY_OPEN}// {EXPECT_ERROR_DIRECTIVE} historical\n'
            f'{self.PIN}\n{self.NESTED_DECOY_CLOSE}'
        )
        assert not _carries_expect_error(self.PIN, f'{decoy}{self.PIN}\n')
        assert _carries_expect_error(
            self.PIN, f'{decoy}// {EXPECT_ERROR_DIRECTIVE} live\n{self.PIN}\n'
        )

    # 🔑 A REGEX literal containing a backtick — the EIGHTH vacuity, and the same root
    # cause as the seventh one construct over: the scan had no notion of a regex, so this
    # backtick opened a phantom template frame that the DECOY's opening backtick then
    # closed, and the pin body was emitted as code. The trailing regex resynchronises the
    # scan, which is what makes it a clean evasion rather than a noisy one: a bare desync
    # runs to EOF and incidentally swallows whatever follows, so the first attempt at this
    # shape went red by accident rather than by design.
    REGEX_DESYNC = 'const backtickMatcher = /`/\n'
    REGEX_RESYNC = 'const secondMatcher = /`/\n'

    def test_a_declaration_inside_a_regex_desynced_template_is_not_pinned(self):
        """The eighth vacuity, on the pin with no compiler backstop.

        Measured on the tree that shipped it: `DocTypeFieldIsExactlyTheUnion` DELETED
        outright, a copy left in a template literal that a regex-borne backtick had
        desynchronised, and the field it guards widened — `tsc` exit 0, eslint clean, and
        every test here green. Unlike the nested-template shape no lint rule stands in the
        way, since nothing here is nested.
        """
        decoy = (
            f'{self.REGEX_DESYNC}export const historical = `\n{self.PIN}\n`\n'
            f'{self.REGEX_RESYNC}'
        )
        assert not _pinned(self.PIN, decoy)
        # The controls: a real declaration must still be found, and must still be found
        # with a genuine regex above it — reading regexes must not cost the live pin.
        assert _pinned(self.PIN, f'{self.PIN}\n')
        assert _pinned(self.PIN, f'{self.REGEX_DESYNC}{self.PIN}\n')

    # 🔑 A `/` inside a CHARACTER CLASS — the NINTH vacuity, and the eighth's root cause
    # one delimiter deeper: `/[/`]/` is legal JavaScript (confirmed with `node`: it
    # compiles and matches a backtick), but a body scanned to the first `/` ends at the
    # class's own slash, so the backtick after it opened a phantom template frame exactly
    # as an unread regex did. The trailing regex resynchronises the scan, as above.
    CLASS_DESYNC = 'const backtickMatcher = /[/`]/\n'
    CLASS_RESYNC = 'const secondMatcher = /[/`]/\n'

    def test_a_declaration_inside_a_class_desynced_template_is_not_pinned(self):
        """The ninth vacuity, again on the pin with no compiler backstop.

        Measured on the tree that shipped it: `DocTypeFieldIsExactlyTheUnion` DELETED
        outright, a copy left in a template literal opened by a class-borne backtick, and
        the field it guards widened to `DocType | 'onepager'` — `tsc` exit 0, eslint
        clean, and every test here green. A character class needs no lint suppression, so
        nothing stood in the way of this one either.
        """
        decoy = (
            f'{self.CLASS_DESYNC}export const historical = `\n{self.PIN}\n`\n'
            f'{self.CLASS_RESYNC}'
        )
        assert not _pinned(self.PIN, decoy)
        # The controls: a real declaration must still be found, and still be found with a
        # genuine class-bearing regex above it — reading classes must not cost the live
        # pin, which is the false-FAILURE direction of this fix.
        assert _pinned(self.PIN, f'{self.PIN}\n')
        assert _pinned(self.PIN, f'{self.CLASS_DESYNC}{self.PIN}\n')

    @pytest.mark.parametrize(
        'desync', CONTROL_HEAD_DESYNCS.values(), ids=CONTROL_HEAD_DESYNCS
    )
    def test_a_declaration_inside_a_control_head_desynced_template_is_not_pinned(
        self, desync
    ):
        """The tenth vacuity, again on the pin with no compiler backstop — and the ELEVENTH
        in the `for_await` case, which is why this is parametrised rather than duplicated.

        Both measured on the tree that shipped each: `DocTypeFieldIsExactlyTheUnion` DELETED
        outright, a copy left in a template literal opened by the backtick of a regex in
        STATEMENT position, and the field it guards widened to `DocType | 'onepager'` —
        `tsc` exit 0, eslint clean, and every test here green. Nothing for a lint rule to
        object to either: unlike `if (x) /`/`, a `for` head assigning `.lastIndex` raises
        no `sonarjs/no-ignored-return` and no TS2774.

        The `for_await` case is the same defect one word further out — the head keyword is
        not the word before the `(` — so it needs no separate body, only the other opener.
        """
        decoy = (
            f'{desync}export const historical = `\n{self.PIN}\n`\n'
            f'{desync}'
        )
        assert not _pinned(self.PIN, decoy)
        # The controls: a real declaration must still be found, and still be found with a
        # genuine statement-position regex above it — reading those must not cost the live
        # pin, which is the false-FAILURE direction of this fix.
        assert _pinned(self.PIN, f'{self.PIN}\n')
        assert _pinned(self.PIN, f'{desync}{self.PIN}\n')

    def test_an_expression_division_is_not_read_as_a_regex(self):
        """The wrong side of the control-head fix, which is a different mistake from the
        wrong side of the class fix and so is pinned separately.

        `(w + h) / 2 + (i + j) / 3` closes two GROUPS, not two control heads, and both
        `/`s divide. Admitting a regex after every `)` — the obvious over-broad fix — would
        make the first `/` swallow through to the second and blank the code between them: a
        false FAILURE, the opposite error from the vacuity above. `_closes_control_head`
        reads the word before the matching `(` for exactly this reason.
        """
        divided = 'const a = (w + h) / 2 + (i + j) / 3\n'
        assert _declarations(divided) == divided
        # The control: a statement-position regex body IS still blanked, so this cannot
        # pass by never reading a regex after `)` at all — which is the vacuity above.
        assert _declarations('for (const c of []) /`/.test(c)\n') == (
            'for (const c of []) / /.test(c)\n'
        )

    def test_a_call_expression_is_not_a_control_head(self):
        """A function whose NAME happens to be a control keyword's neighbour must not open
        a regex: `foo(bar) / 2` divides, and so does `matchAll(re) / n`.

        Pinned separately from the group case above because the two reach
        `_closes_control_head` by different routes — a group's `(` is preceded by an
        operator, a call's by an identifier — and only the second could be admitted by a
        rule that looked at the preceding word without checking it against a fixed set.
        """
        divided = 'const a = foo(bar) / 2 + baz(qux) / 3\n'
        assert _declarations(divided) == divided
        # The control, as above: a real control head must still admit one.
        assert _declarations('if (x) /`/.test(y)\n') == 'if (x) / /.test(y)\n'

    def test_an_awaited_group_is_not_a_control_head(self):
        """The wrong side of the ELEVENTH fix, and the reason it is a MAPPING rather than
        one more member of `_REGEX_MAY_FOLLOW_HEAD`.

        `await` leads an expression as well as modifying a `for` head, so
        `await (w + h) / 2` is a legal DIVISION — `node` evaluates it — while
        `for await (…) /re/` is a regex. The one-word fix cannot tell them apart: adding
        `await` to the head set blanks the code after the first `/` here, which is the same
        false FAILURE `test_an_expression_division_is_not_read_as_a_regex` pins for the
        grouped case, reached by a different route. Requiring the word BEFORE the modifier
        to be a head that admits it is what discriminates.

        Neither existing wrong-side control catches this: both are green under the one-word
        fix, measured, because neither fixture contains an awaited group.
        """
        divided = 'const a = await (w + h) / 2 + await (i + j) / 3\n'
        assert _declarations(divided) == divided
        # 🔑 The MAPPING's second half, which the fixture above structurally cannot see: its
        # token before `await` is `=`, so `_TRAILING_WORD` finds no word and a check weakened
        # to `keyword is not None` still answers False. Here the preceding word is `return` —
        # a keyword `await` may follow, but NOT a head that admits it as a modifier — so only
        # the `in admitted_by` membership test keeps this line dividing. `node` evaluates it
        # (to 5 for 2, 2, 6, 3), and `await` is already in `_REGEX_MAY_FOLLOW_KEYWORD`, so a
        # keyword-led awaited group is a shape this module models rather than a contrivance.
        keyword_led = 'return await (w + h) / 2 + await (i + j) / 3\n'
        assert _declarations(keyword_led) == keyword_led
        # The control: the MODIFIED head must still admit a regex, so neither assertion above
        # can pass on a rule that refuses `await` everywhere and reopens the eleventh vacuity.
        assert _declarations('for await (const c of []) /`/.test(c)\n') == (
            'for await (const c of []) / /.test(c)\n'
        )

    def test_an_indexed_division_is_not_read_as_a_character_class(self):
        """The wrong side of the class fix, which is a different mistake from the wrong
        side of the regex fix and so is pinned separately.

        `x[i] / 2 + y[j] / 3` has brackets AND two divisions. If `[` were taken to open a
        class wherever it appears, the first `/` would no longer close the body and the
        code between the divisions would be blanked — a false FAILURE, the opposite error
        from the vacuity above. The brackets here are an index, not a class, because
        `_regex_allowed_here` never lets a `/` after `]` open a regex in the first place.
        """
        indexed = 'const a = x[i] / 2 + y[j] / 3\n'
        assert _declarations(indexed) == indexed
        # The control: a class-bearing regex body IS still blanked, so this cannot pass by
        # never reading a regex at all — which is what would reopen the vacuity above.
        assert _declarations('const m = /[/`]/\n') == 'const m = /    /\n'

    def test_a_division_is_not_read_as_a_regex(self):
        """The conservative direction of `_regex_allowed_here`, pinned from the other side.

        TWO divisions on one line are what discriminates: read as a regex, the first `/`
        swallows through to the second and the code BETWEEN them is blanked. That is a
        false FAILURE rather than a false pass — the opposite error from the eighth
        vacuity — and it is bounded to the one line a regex body may occupy, which is why
        the two mistakes are not symmetric and this scan errs toward reading less.
        """
        divided = 'const mid = width / 2 + height / 2\n'
        assert _declarations(divided) == divided
        # The control: a genuine regex body IS blanked, so this cannot pass by never
        # reading a regex at all — which would reopen the vacuity above.
        assert _declarations('const m = /`/\n') == 'const m = / /\n'

    def test_a_keyword_led_regex_is_still_read_as_one(self):
        """Why the check consults the trailing WORD and not just the last character:
        `return /`/` ends in `n`, so a character-only rule would read it as a division,
        leave its backtick live, and desynchronise the scan exactly as the eighth vacuity
        did."""
        assert not _pinned(
            self.PIN,
            f'const t = () => {{ return /`/.test(x) }}\nexport const h = `\n'
            f'{self.PIN}\n`\n{self.REGEX_RESYNC}',
        )
        assert _pinned(self.PIN, f'{self.PIN}\n')

    def test_blanking_preserves_length_through_a_nested_template(self):
        """The frame stack must not change how much it emits: every offset this module
        computes is found in the blanked view and read back from the raw text, so a
        length change would silently misread the pin at that offset rather than fail."""
        source = (
            f'{self.NESTED_DECOY_OPEN}{self.PIN}\n{self.NESTED_DECOY_CLOSE}{self.PIN}\n'
        )
        assert len(_declarations(source)) == len(source)
        assert len(_without_comments(source)) == len(source)

    def test_a_declaration_inside_a_comment_is_not_pinned(self):
        """The same for a commented-out copy, which is the shape a maintainer actually
        produces — disabling a pin by commenting it out, rather than by building a
        decoy."""
        assert not _pinned(self.PIN, f'// {self.PIN}\n')
        assert _pinned(self.PIN, f'{self.PIN}\n')

    def test_a_decoy_above_the_live_declaration_does_not_mask_it(self):
        """Both copies blank to the same shape, so the FIRST candidate offset is the
        decoy's. Examining only that one would fail the exact-text step and report the
        live pin missing — a false failure, and the reason the search continues past a
        candidate that does not match rather than stopping at it."""
        source = f'export const historical = `\n{self.PIN}\n`\n{self.PIN}\n'
        assert _pinned(self.PIN, source)

    def test_a_pinned_literal_may_not_be_swapped_for_another_of_equal_length(self):
        """🔑 Blanking string bodies compares quoted operands by LENGTH, so this is
        what compares them by CONTENT.

        Measured on the shipped tree before this existed: swapping the widened
        control's `'not-a-doc-type'` for `'AAAAAAAAAAAAAA'` left `tsc` at exit 0 with
        every test here green, because the two blank to the same fourteen spaces. The
        compiler does not backstop it — one arbitrary non-member is as good as another
        to `BothWays`, so the control keeps working and nothing else looks at the
        literal. A pin whose operands are read by length is a guard reporting success
        while comparing less than it names.
        """
        same_length = self.PIN.replace("'doc_type'", "'bogusKey'")
        assert len(same_length) == len(self.PIN), 'fixture must differ only in content'
        assert not _pinned(self.PIN, f'{same_length}\n')
        assert _pinned(self.PIN, f'{self.PIN}\n')

    def test_a_line_that_merely_mentions_the_directive_is_not_one(self):
        """`@ts-expect-error` in prose is not a directive.

        Several comments in `types.ts` and `projectsApi.ts` discuss the mechanism by
        name — this file's own docstrings do too — so a substring test over the
        preceding line is satisfied by explanatory text. Measured before this existed:
        with such a line above each control, both real directives could be deleted and
        `extends true` dropped from a verdict helper, disabling both pins and all four
        controls, with `tsc` at exit 0 and every test here green.
        """
        prose = f'// the control below relies on {EXPECT_ERROR_DIRECTIVE} to assert it\n'
        assert not _carries_expect_error(self.PIN, f'{prose}{self.PIN}\n')
        assert _carries_expect_error(
            self.PIN, f'// {EXPECT_ERROR_DIRECTIVE} must not compare equal\n{self.PIN}\n'
        )

    def test_a_directive_above_a_quoted_copy_does_not_count_for_the_live_one(self):
        """The other half of the same defect: the directive was found by an index into
        the RAW source, so a decoy copy of the control carrying a directive was the
        first match and its line was the one inspected. The live declaration could then
        have no directive at all.

        Both halves had to be reverted together to reopen it, which is why they are one
        function now — and why this asserts on `_carries_expect_error` rather than on
        the index.
        """
        decoy = (
            f'export const historical = `\n'
            f'// {EXPECT_ERROR_DIRECTIVE} historical\n{self.PIN}\n`\n'
        )
        assert not _carries_expect_error(self.PIN, f'{decoy}{self.PIN}\n')
        # Same decoy, but the LIVE declaration keeps its directive: still true, so this
        # rejects the decoy rather than anything that merely follows one.
        assert _carries_expect_error(
            self.PIN, f'{decoy}// {EXPECT_ERROR_DIRECTIVE} live\n{self.PIN}\n'
        )

    @pytest.mark.parametrize(
        'desync', CONTROL_HEAD_DESYNCS.values(), ids=CONTROL_HEAD_DESYNCS
    )
    def test_a_directive_inside_a_control_head_desynced_template_is_not_the_live_one(
        self, desync
    ):
        """The directive lookup's version of the tenth vacuity, and of the ELEVENTH in the
        `for_await` case: the desynced decoy carried both the control's text and a directive
        above it, so it was the offset inspected and the live control could have no
        directive at all.
        """
        decoy = (
            f'{desync}export const historical = `\n'
            f'// {EXPECT_ERROR_DIRECTIVE} historical\n{self.PIN}\n`\n'
            f'{desync}'
        )
        assert not _carries_expect_error(self.PIN, f'{decoy}{self.PIN}\n')
        assert _carries_expect_error(
            self.PIN, f'{decoy}// {EXPECT_ERROR_DIRECTIVE} live\n{self.PIN}\n'
        )

    # ⚠️ The ratio cases below use the LIVE `GENERATE_DOCUMENT_SIGNATURE`, unlike `PIN`
    # above, and that is not an inconsistency: `_generate_document_ratio` counts by the
    # module constants rather than taking the text as an argument, so a synthetic
    # fixture would exercise nothing. Accepted knowingly — a legitimate rename of that
    # constant also edits these fixtures, where for `PIN` it would not.
    def test_a_signature_inside_a_template_literal_is_not_counted(self):
        """The ratio guard's own version of the fifth vacuity — the same defect, in the
        last text guard that still read comment-stripped text rather than
        `_declarations(...)`.

        A copy of the signature in an exported template literal counted toward BOTH
        sides of the ratio, so pairing it with a respelled colon on the real method
        (below) let the real parameter go inline with the ratio still holding. Measured
        on the shipped tree: `tsc` exit 0, eslint clean, every test here green.
        """
        decoy = f'export const historical = `\n  {GENERATE_DOCUMENT_SIGNATURE}\n`\n'
        assert _generate_document_ratio(decoy) == (0, 0)
        # The control: the same text as real code must still be counted on both sides,
        # or this would pass by counting nothing at all.
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    def test_a_signature_inside_a_nested_template_literal_is_not_counted(self):
        """The ratio's version of the seventh vacuity: paired with the respelled colon
        below, the real method vanished from the left side while this decoy supplied one
        of each, so the ratio held with `tsc` exit 0, eslint clean and every test green.
        """
        decoy = (
            f'{self.NESTED_DECOY_OPEN}  {GENERATE_DOCUMENT_SIGNATURE}\n'
            f'{self.NESTED_DECOY_CLOSE}'
        )
        assert _generate_document_ratio(decoy) == (0, 0)
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    def test_a_signature_inside_a_regex_desynced_template_is_not_counted(self):
        """The ratio's version of the eighth vacuity, which the desync reopened along with
        every other text guard here — the decoy supplied one of each side on its own.
        """
        decoy = (
            f'{self.REGEX_DESYNC}export const historical = `\n'
            f'  {GENERATE_DOCUMENT_SIGNATURE}\n`\n{self.REGEX_RESYNC}'
        )
        assert _generate_document_ratio(decoy) == (0, 0)
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    def test_a_signature_inside_a_class_desynced_template_is_not_counted(self):
        """The ratio's version of the ninth vacuity: the regex's terminator sat inside a
        character class, so the body ended early and the backtick after it desynchronised
        the scan just as an unread regex did.
        """
        decoy = (
            f'{self.CLASS_DESYNC}export const historical = `\n'
            f'  {GENERATE_DOCUMENT_SIGNATURE}\n`\n{self.CLASS_RESYNC}'
        )
        assert _generate_document_ratio(decoy) == (0, 0)
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    @pytest.mark.parametrize(
        'desync', CONTROL_HEAD_DESYNCS.values(), ids=CONTROL_HEAD_DESYNCS
    )
    def test_a_signature_inside_a_control_head_desynced_template_is_not_counted(
        self, desync
    ):
        """The ratio's version of the tenth vacuity, and of the ELEVENTH in the `for_await`
        case: a regex in statement position was read as a division, so its backtick stayed
        live and the decoy supplied one of each side on its own — the same shape as the three
        cases above, one delimiter over.
        """
        decoy = (
            f'{desync}export const historical = `\n'
            f'  {GENERATE_DOCUMENT_SIGNATURE}\n`\n{desync}'
        )
        assert _generate_document_ratio(decoy) == (0, 0)
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    def test_a_respelled_colon_is_not_counted_as_a_declaration(self):
        """`generateDocument:(` — no space — is legal TypeScript and lints clean, but is
        not the exact opener counted, so the real method disappears from the LEFT side.

        Deliberately not tolerated by widening the pattern: the point is that the ratio
        cannot be read as "the method is fine" when the method was never seen. The
        `declared >= 1` floor is what refuses it, and its message says so, because
        not-FOUND and found-and-unpinned want different fixes.
        """
        respelled = GENERATE_DOCUMENT_SIGNATURE.replace(
            'generateDocument: (', 'generateDocument:('
        )
        assert _generate_document_ratio(f'  {respelled}\n') == (0, 0)
        assert _generate_document_ratio(f'  {GENERATE_DOCUMENT_SIGNATURE}\n') == (1, 1)

    def test_an_inline_literal_leaves_its_opener_counted_but_unpinned(self):
        """The respelling this guard exists to refuse: the declaration stays visible on
        the left while the right loses its signature, so the ratio breaks.

        This is the positive direction of the guard — without it the two tests above
        could pass by the counter never counting anything.
        """
        inline = 'generateDocument: (projectId: string, data: { doc_type: DocType }) =>'
        assert _generate_document_ratio(f'  {inline}\n') == (1, 0)

    def test_a_quoted_member_inside_the_pin_still_matches(self):
        """The reason both sides are blanked at all: the pins contain string literals,
        so blanking only the source would never match one. The negative cases above
        are only meaningful if this positive one holds — otherwise they would pass by
        the matcher rejecting every pin, live ones included."""
        assert _pinned(self.PIN, f'const before = 1\n{self.PIN}\nconst after = 2\n')


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

        Deliberately TEXT and not a parse: it compares one fixed string against the
        source. No method location, no parameter-list extent, no model of TypeScript,
        so none of the ways the deleted scanner mis-read legal code apply here.

        EVERY DECLARATION, not "the shared type appears somewhere" — because three
        successively weaker spellings were each measured to permit the inline
        respelling they were named as forbidding:

          * `GenerateDocumentBody in source`, the bare NAME. In `projectsApi.ts` the
            type-level pin block at the foot of the file names the type three times, so
            the assertion holds whatever the signature says. An inline literal left
            `tsc` at exit 0 and every test here green.
          * `data: GenerateDocumentBody`, the ANNOTATION — but searched over the whole
            file, so ANY occurrence satisfies it. One unrelated line
            (`const _probe = (data: GenerateDocumentBody) => data`) plus the inline
            literal was again `tsc` exit 0 and 29 passed.
          * The whole signature, required to be PRESENT, or present exactly ONCE. Still
            evadable, because a decoy can be a full COPY: a `const _decoy = {
            generateDocument: (projectId: string, data: GenerateDocumentBody) => ... }`
            above the real method satisfies both forms while the real parameter is an
            inline literal. Measured: `tsc` exit 0, 29 passed.

        All three are one defect — an EXISTENCE check over a file asks whether SOME
        construct supplies the string, never whether the one that matters does; a count
        of one is the same check with one more way to be satisfied. So the property
        asserted is a RATIO: the number of declarations of this method equals the number
        that take the shared body. No added text can satisfy that, because a decoy
        declaration adds to the left side too. A decoy that itself takes the shared type
        adds to both and passes, which is correct — it is not a respelling of the
        contract.

        🔑 The ratio is counted over `_declarations(...)`, not over comment-stripped
        text, and that WAS the fourth measured defect of this guard: `_without_comments`
        leaves string bodies intact, so a copy of the signature inside an exported
        template literal counted toward BOTH sides. Paired with respelling the real
        method's colon (`generateDocument:(` — legal, lint-clean, and not the exact
        opener counted), the real declaration went inline while the decoy supplied one of
        each: `tsc` exit 0, eslint clean, every test here green. Same root cause as the
        pins' own fourth vacuity, which is why both now read one view. The `declared >= 1`
        floor catches the colon half and its message distinguishes not-FOUND from
        found-and-unpinned, since those want different fixes.

        Not an enumeration of legal TypeScript, the thing this file refuses: there is
        one string per side, and the method is either declared here or it is not.

        LIMIT, and it is narrow: this pins the parameter's REFERENCE to the shared
        type, not the type's shape. Widening `GenerateDocumentBody` itself does not
        match a different string, and neither does a widening spelled INSIDE the
        annotation (`Omit<GenerateDocumentBody, 'doc_type'> & { ... }`) — the latter
        fails this test, but only incidentally, by no longer being this exact
        signature. What positively refuses a widened parameter in ANY spelling is
        `GenerateDocumentTakesTheSharedBody`, a type-level comparison of the method's
        parameter against the interface, kept present by
        `test_the_type_level_pins_are_present`. This test's job is the reference; the
        pin's job is the shape.
        """
        for relative in GENERATE_DOCUMENT_CLIENTS:
            path = _repo_root() / relative
            assert path.is_file(), f'{relative} moved — update GENERATE_DOCUMENT_CLIENTS'
            raw = path.read_text(encoding='utf-8')
            assert 'generateDocument' in _declarations(raw), (
                f'{relative} no longer mentions generateDocument. If the method '
                f'moved, point GENERATE_DOCUMENT_CLIENTS at its new home; if this '
                f'client dropped it, drop the entry.'
            )
            declared, shared = _generate_document_ratio(raw)
            assert declared >= 1, (
                f'{relative} declares no `{GENERATE_DOCUMENT_DECLARATION}...`, so '
                f'there is nothing here to pin — the method was not FOUND, which is a '
                f'different failure from found-and-unpinned below.\n'
                f'The opener is matched as exact text, so a respelled colon '
                f'(`generateDocument:(`, no space) is legal TypeScript that lints '
                f'clean and is not counted at all. That was measured to combine with a '
                f'decoy to defeat the ratio: with the real declaration invisible, a '
                f'copy of the signature elsewhere supplied one of each side and the '
                f'ratio held. This assertion is the floor that catches it.\n'
                f'So: if the colon was respelled, restore `'
                f'{GENERATE_DOCUMENT_DECLARATION}`; if the method genuinely changed '
                f'shape, update GENERATE_DOCUMENT_DECLARATION; if this client dropped '
                f'it, drop the entry from GENERATE_DOCUMENT_CLIENTS.'
            )
            assert shared == declared, (
                f'{relative} declares generateDocument {declared} time(s) but only '
                f'{shared} of those take the shared request body. Every declaration '
                f'must be, exactly:\n'
                f'    {GENERATE_DOCUMENT_SIGNATURE}\n'
                f'A declaration that is not means its body is restated inline — the '
                f'exact edit issue #381 removed — and in projectsApi.ts nothing else '
                f'in either language catches it: a structurally identical literal '
                f'compares EQUAL to the interface, so the parameter pin stays green '
                f'too, and the request goes out with whatever the literal admits. Take '
                f'{REQUEST_BODY_TYPE} (declared in {DOC_TYPE_UNION_SOURCE}) as the '
                f'parameter type, and widen the contract there if that is what is '
                f'wanted. Keep the signature on ONE line — it is matched as exact '
                f'text.\n'
                f'This is a RATIO rather than a presence check because presence was '
                f'measured to be satisfiable by a decoy: an unrelated '
                f'`data: GenerateDocumentBody` line, or a second copy of the whole '
                f'signature, left this guard green while the real parameter was an '
                f'inline literal.'
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

        Text, not a parse — but text with four lessons in it, one per review round,
        which is why what it requires is now each WHOLE DECLARATION, matched against
        code rather than against anything that merely contains the same characters.
        Each weaker version was satisfiable while the pin did nothing:

          * The pin NAMES alone. Stub both a pin and its control to bare constants
            (`= true` / `= false`), delete the helper types so no unused-local fires,
            and `tsc` exits 0 with every test here green while the guarded field is
            widened.
          * `MustBeTrue<`. That substring is in the HELPER'S OWN DECLARATION, so the
            stub just keeps the helpers and exports them — every gate green again.
          * `MustBeTrue<BothWays<`. Says nothing about the comparison's OPERANDS:
            repointing the alias the left side was read through at the interface made
            the pin compare that interface to itself, trivially equal forever, with the
            fragment still present and both controls still green because they read the
            same alias. `tsc` exit 0, every test here green, and a caller able to send
            a value the route 400s.

          * All of the above, matched against COMMENT-stripped source only. A copy
            inside an exported template literal satisfied any of them — it survives
            stripping and `noUnusedLocals`, and its newlines redirect a `find` index —
            so the real pin could be DELETED outright and the field widened, with `tsc`
            at exit 0 and every test here green. That is why the match is now against
            `_declarations(...)`, which blanks string bodies too.

        So the operands are part of what is pinned, the alias is gone, and the match is
        against code. That the comparisons BITE is still the compiler's job; this says a
        real one is spelled, in a place that can actually declare something.

        TWO controls per pin, both required. `MustBeTrue<BothWays<...>>` is satisfied
        by a `BothWays` that degenerates to `true`, and by one collapsed to its
        ONE-WAY form — and those need different controls, because a widened-side
        control cannot see the second: a superset fails `[Left] extends [Right]` under
        either form, so both forms look identical to it. Measured — collapsing
        `BothWays` to `[Left] extends [Right]` left `tsc` at exit 0 with every test
        here green. The narrowed-side controls (`...WouldSeeNarrowing`) are what refuse
        that. Each compares the SAME operand as its own pin against a DERIVED wider
        type, so it is a control on that pin rather than a second detector of a collapse
        in the shared `BothWays`: the signature one used `never`, and deleting it was
        measured to leave the collapse reported only by the other file.

        AND each control's `@ts-expect-error`, which is what makes the verdict helper's
        `extends true` self-checking. A control applies the same helper as the pin and
        expects to be rejected, so dropping that constraint — one edit that disables
        the pin and all four controls at once, measured to leave `tsc` at exit 0 with
        every test here green — turns each directive into a TS2578. Without the
        directive pinned, that edit could be paired with deleting the directives and
        nothing would notice.
        """
        pin, controls = TYPE_LEVEL_PINS[relative]
        path = _repo_root() / relative
        assert path.is_file(), f'{relative} moved — update TYPE_LEVEL_PINS'
        raw = path.read_text(encoding='utf-8')
        # Both checks take the RAW source. `_pinned` and `_carries_expect_error` do the
        # blanking themselves — a declaration is located in the comment-and-string-blanked
        # view and then matched exactly against the raw text there, and a directive is a
        # comment so it only exists raw. Kept inside those helpers rather than spelled
        # here because `TestThePinMatcher` can then pin them, which is what two rounds of
        # silently revertible repairs to this lookup argued for.
        assert _pinned(pin, raw), (
            f'{relative} no longer declares, exactly:\n'
            f'    {pin}\n'
            f'That is the only check on its half of this contract — nothing else in '
            f'either language covers it (see this test\'s docstring), so without it '
            f'the doc_type it guards can be widened past the route\'s allowlist with '
            f'tsc, eslint and this whole file green. The OPERANDS are part of what is '
            f'pinned: reading the left side through an alias was measured to let the '
            f'pin compare a type to itself while every gate stayed green. Keep it on '
            f'ONE line. Restore it, or widen DocType and GENERATED_DOC_TYPES '
            f'together, which is the supported way to change the contract.'
        )
        for control in controls:
            assert _pinned(control, raw), (
                f'{relative} declares its pin but not this control, exactly:\n'
                f'    {control}\n'
                f'The pin is satisfied both by a comparison that degenerates to `true` '
                f'and by one collapsed to a one-way `extends`, each of which passes '
                f'while measuring less than it claims; the controls are what refuse '
                f'those, the same way TestContractDriftIsCaught does for the parser '
                f'here. A widened-side control cannot detect the one-way collapse, '
                f'so the narrowed-side one is not redundant.'
            )
            # The directive on the line directly above, read from the RAW source — the
            # declarations are pinned against the blanked view, but a directive IS a
            # comment, so it only exists here. Both the location and the "must BE the
            # directive" rule live in `_carries_expect_error`, and are pinned by
            # `TestThePinMatcher`: each half of this lookup was silently revertible
            # while it was spelled inline here.
            assert _carries_expect_error(control, raw), (
                f'{relative} declares the control\n'
                f'    {control}\n'
                f'but the line above it is not a `{EXPECT_ERROR_DIRECTIVE}`. That '
                f'directive is what asserts the control\'s comparison FAILS, and it is '
                f'also what makes the verdict helper\'s `extends true` self-checking: '
                f'drop that constraint — one edit that disables the pin and every '
                f'control at once, measured to leave tsc at exit 0 with every test '
                f'here green — and each directive becomes an unused-directive error '
                f'instead. The line must BE the directive: merely MENTIONING it, and a '
                f'decoy copy of the control in a comment or template literal that this '
                f'lookup once landed on instead, were both measured to pass.\n'
                f'Found instead: {(_directive_above(control, raw) or "").strip()!r}'
            )
