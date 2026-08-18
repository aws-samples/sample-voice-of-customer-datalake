"""Lockstep test: an anonymous ballot's key and input bounds are spelled out in
three files that must agree.

`lambda/api/ballots_handler.py` is the one unauthenticated writer into the
PRIORITIZATION partition. `lambda/api/projects_handler.py` owns that partition:
it writes a signed-in reviewer's ballot and it is the only reader, splitting every
sort key back apart to compute the team's combined score. The two are packaged as
SEPARATE Lambda bundles, so neither may import the other — the key constants are
duplicated by necessity, and this file is what keeps the copies honest. The
frontend's `pages/Vote/ballotBounds.ts` holds the two input bounds the public
ballot page enforces before it submits.

Both `ballots_handler` and `ballotBounds.ts` name this test file in their own
comments as the thing that pins them. It did not exist; these are the assertions
those comments promise.

WHY EACH ASSERTION IS HERE, IN ORDER OF WHAT IT COSTS TO GET WRONG
------------------------------------------------------------------

  * THE KIND NAMESPACE (`anon` vs `user`). The reviewer half of a ballot sort key
    is `{kind}:{subject}`. If the two kinds ever coincide, an anonymous ballot
    from a stranger's phone lands on the sort key of a signed-in reviewer's
    ballot and DynamoDB's upsert destroys that reviewer's vote — silently, with
    no error anywhere and nothing to reconstruct it from. This is the assertion
    the whole file exists for, and the reason the anonymous write path was given
    its own kind rather than a reserved subject.

  * THE PARTITION KEY AND SORT-KEY PREFIX. Get either wrong and every anonymous
    ballot is written somewhere the aggregate never reads. Nothing fails: the
    room votes, each phone says "thanks", and the team's score does not move.

  * THE SORT-KEY SHAPE. The reader splits `BALLOT#{row_id}#{kind}:{subject}`
    on its LAST '#'. That is only unambiguous while neither half contains a '#',
    so both writers must construct the key the same way and refuse a '#' in a
    row id.

    The first half is a ROW id — a prioritization row is a project's set of
    documents, so a room scores a whole proposal. Both writers must agree on THAT
    UNIT too, not merely on the shape: a session opened against a document id
    while the page reads rows would collect ballots that appear nowhere, which is
    the silent version of the same defect the partition-key assertion covers.

  * NO `ttl` ON A BALLOT. The aggregates table expires any item carrying the
    expiry attribute. The session record should have one; a ballot must never,
    or the team's score quietly loses ballots weeks after the meeting. Cheap to
    write by accident next to a session write that needs one, and invisible until
    a historical score has drifted.

  * THE NOTE BOUND. The API REFUSES an over-long note rather than truncating it,
    so a frontend copy that is larger turns Submit into a button that appears to
    do nothing, in front of a room.

Every value is read as SOURCE TEXT, not imported: the assertion must not be
satisfiable by whatever either module happens to resolve at import time, and
reading text needs neither the AWS-shaped Python import graph nor a bundler.

Pattern follows test_visual_selection_bound_lockstep.py (same directory).
"""
import re
from pathlib import Path

BALLOTS_SOURCE = 'lambda/api/ballots_handler.py'
PROJECTS_SOURCE = 'lambda/api/projects_handler.py'
FRONTEND_BOUNDS_SOURCE = 'frontend/src/pages/Vote/ballotBounds.ts'


def _read(relative: str) -> str:
    # lambda/api/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? '
        f'If so, update the path constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _single(source: str, pattern: str, where: str, what: str) -> str:
    """The one match for `pattern`, or a failure naming what drifted.

    Exactly one is required deliberately: a second assignment of the same
    constant is itself the drift this file exists to prevent, and taking the
    first match would hide it.
    """
    matches = re.findall(pattern, source, re.MULTILINE)
    assert len(matches) == 1, (
        f'Expected exactly one {what} assignment in {where}; found {len(matches)}. '
        f'A second copy is the drift this test exists to prevent — if the '
        f'declaration was restructured, update the pattern in this test file.'
    )
    return matches[0]


def _str_const(source: str, name: str, where: str) -> str:
    return _single(source, rf"^{name}\s*=\s*'([^']*)'", where, name)


def _int_const(source: str, name: str, where: str) -> int:
    return int(_single(source, rf'^{name}\s*=\s*(\d+)', where, name))


def _ts_int_const(source: str, name: str, where: str) -> int:
    return int(_single(source, rf'^export const {name}\s*=\s*(\d+)', where, name))


class TestTheAnonymousKindCanNeverCollideWithASignedInReviewer:
    """The assertion that protects real reviewers' ballots from anonymous ones."""

    def test_the_two_kinds_are_different_strings(self):
        anon = _str_const(_read(BALLOTS_SOURCE), 'REVIEWER_KIND_ANON', BALLOTS_SOURCE)
        user = _str_const(_read(PROJECTS_SOURCE), 'REVIEWER_KIND_USER', PROJECTS_SOURCE)
        assert anon != user, (
            f"REVIEWER_KIND_ANON ({anon!r}) equals REVIEWER_KIND_USER ({user!r}). "
            f'An anonymous ballot would land on a signed-in reviewer sort key and '
            f"overwrite that reviewer's vote with no error anywhere."
        )

    def test_neither_kind_prefixes_the_other(self):
        # Distinct is not sufficient on its own: the reviewer half is
        # `{kind}:{subject}`, so kinds where one is a prefix of the other are
        # only kept apart by the ':' that follows. Requiring non-prefix keeps
        # that safety from resting on the delimiter alone.
        anon = _str_const(_read(BALLOTS_SOURCE), 'REVIEWER_KIND_ANON', BALLOTS_SOURCE)
        user = _str_const(_read(PROJECTS_SOURCE), 'REVIEWER_KIND_USER', PROJECTS_SOURCE)
        assert not anon.startswith(user) and not user.startswith(anon), (
            f'One reviewer kind prefixes the other ({anon!r}, {user!r}); keeping '
            f'anonymous and signed-in ballots apart should not depend on the '
            f"':' delimiter alone."
        )

    def test_neither_kind_contains_a_key_delimiter(self):
        # A '#' in a kind would break the reader's rpartition; a ':' would make
        # the kind/subject split ambiguous.
        anon = _str_const(_read(BALLOTS_SOURCE), 'REVIEWER_KIND_ANON', BALLOTS_SOURCE)
        user = _str_const(_read(PROJECTS_SOURCE), 'REVIEWER_KIND_USER', PROJECTS_SOURCE)
        for kind, where in ((anon, BALLOTS_SOURCE), (user, PROJECTS_SOURCE)):
            assert kind, f'an empty reviewer kind in {where} namespaces nothing'
            assert '#' not in kind, f'{kind!r} in {where} contains the sort-key delimiter'
            assert ':' not in kind, f'{kind!r} in {where} contains the kind delimiter'


class TestBothWritersAgreeOnWhereABallotLives:
    """Same partition, same sort-key prefix — or the aggregate never sees it."""

    def test_the_partition_key_matches(self):
        ballots = _str_const(_read(BALLOTS_SOURCE), 'PRIORITIZATION_PK', BALLOTS_SOURCE)
        projects = _str_const(_read(PROJECTS_SOURCE), 'PRIORITIZATION_PK', PROJECTS_SOURCE)
        assert ballots == projects, (
            f'PRIORITIZATION_PK differs: {ballots!r} in {BALLOTS_SOURCE} vs '
            f'{projects!r} in {PROJECTS_SOURCE}. Anonymous ballots would be written '
            f'to a partition the team score never reads — the room votes and the '
            f'number does not move.'
        )

    def test_the_ballot_sort_key_prefix_matches(self):
        ballots = _str_const(_read(BALLOTS_SOURCE), 'BALLOT_SK_PREFIX', BALLOTS_SOURCE)
        projects = _str_const(_read(PROJECTS_SOURCE), 'BALLOT_SK_PREFIX', PROJECTS_SOURCE)
        assert ballots == projects, (
            f'BALLOT_SK_PREFIX differs: {ballots!r} vs {projects!r}. '
            f'`_parse_ballot_sk` skips anything without the prefix it knows, so '
            f'anonymous ballots would be silently ignored by the aggregate.'
        )

    def test_both_build_the_sort_key_in_the_same_shape(self):
        # The reader splits on the LAST '#', so the shape — prefix, ROW id, '#',
        # kind-namespaced subject — has to be identical in both writers.
        # Compared as source text because the two live in different bundles.
        ballots_key = _single(
            _read(BALLOTS_SOURCE),
            r"^\s*return f'\{BALLOT_SK_PREFIX\}(.+)'$",
            BALLOTS_SOURCE,
            'ballot sort-key f-string',
        )
        projects_key = _single(
            _read(PROJECTS_SOURCE),
            r"^\s*return f'\{BALLOT_SK_PREFIX\}(.+)'$",
            PROJECTS_SOURCE,
            'ballot sort-key f-string',
        )
        # `{row_id}#` then the reviewer segment: projects_handler delegates the
        # segment to `_reviewer_segment`, ballots_handler inlines `{kind}:{id}`.
        #
        # The interpolated NAME is asserted, not just the shape, and that is the
        # point of this pair: a room whose session names a document while the page
        # keys ballots to rows votes into a key nothing reads, and every phone
        # still says "thanks".
        assert ballots_key.startswith('{row_id}#'), (
            f'{BALLOTS_SOURCE} builds a ballot key as {ballots_key!r}; the reader '
            f"expects the ROW id first, then '#'."
        )
        assert projects_key.startswith('{row_id}#'), (
            f'{PROJECTS_SOURCE} builds a ballot key as {projects_key!r}; the reader '
            f"expects the ROW id first, then '#'."
        )
        assert ballots_key.count('#') == projects_key.count('#') == 1, (
            f'A ballot sort key must contain exactly one "#" after its prefix, or '
            f"the reader's rpartition splits in the wrong place: "
            f'{ballots_key!r} vs {projects_key!r}.'
        )

    def test_the_anonymous_writer_refuses_a_hash_in_a_row_id(self):
        # The no-'#' invariant the split rests on is ENFORCED by the public writer,
        # not assumed of it — this is the one caller-supplied half of the key on
        # the unauthenticated path.
        #
        # BOTH guards are required, because a row id reaches the key by two
        # routes: the facilitator names it when opening a session
        # (`_validated_row_id`), and the read path re-checks the value it
        # read back off the session record before the submit uses it
        # (`_session_row_id`). Asserting the rule appears merely SOMEWHERE would
        # keep passing with either one deleted.
        #
        # Either spelling counts. The two guards read in opposite senses — one
        # raises when the delimiter IS present, the other answers "no usable row"
        # when it is NOT absent — and pinning one phrasing would fail a rename that
        # kept the invariant, which is the sort of failure that gets a lockstep test
        # deleted rather than heeded. What is pinned is that TWO places refuse it.
        source = _read(BALLOTS_SOURCE)
        guards = source.count("'#' in row_id") + source.count("'#' not in row_id")
        assert guards >= 2, (
            f"{BALLOTS_SOURCE} enforces \"no '#' in a row id\" in {guards} "
            f'place(s); both the session-creation validator and the submit path '
            f'must check it. The sort-key split of every ballot in the partition '
            f'depends on it, and this is the one unauthenticated writer.'
        )


class TestABallotNeverCarriesAnExpiry:
    """A ballot that expires removes itself from the team's score, later, quietly."""

    def test_the_session_record_expires_but_the_ballot_write_does_not(self):
        source = _read(BALLOTS_SOURCE)
        # The literal attribute name, spelled as the table's expiry field. Not read
        # from a constant because the handler writes it inline on the session and
        # the point here is that this exact string is absent from the ballot write.
        ttl_attribute = 'ttl'
        # The ballot write is `_write_ballot`; slice from it to the next
        # top-level def and assert the expiry attribute is absent from it.
        match = re.search(
            r'^def _write_ballot\(.*?(?=^(?:def |@app\.|class ))',
            source,
            re.MULTILINE | re.DOTALL,
        )
        assert match is not None, (
            f'_write_ballot not found in {BALLOTS_SOURCE} — if it was renamed, '
            f'update this test: what it pins (a ballot carries no expiry) still '
            f'holds.'
        )
        # The docstring EXPLAINS that no expiry is assigned, so asserting over the
        # raw text would match its own prose. Strip the docstring and assert on the
        # code, which is what actually writes the item.
        body = re.sub(r'""".*?"""', '', match.group(0), count=1, flags=re.DOTALL)
        assert '"""' not in body, (
            f'failed to strip _write_ballot\'s docstring in {BALLOTS_SOURCE}; this '
            f'test would otherwise assert against prose rather than code.'
        )
        assert ttl_attribute not in body, (
            f'_write_ballot sets {ttl_attribute!r}. The aggregates table expires any '
            f'item carrying it, so ballots would disappear from the team score '
            f'weeks after the meeting, with no trace of why the number changed.'
        )


class TestTheNoteBoundIsTheSameNumberOnBothSidesOfTheBoundary:
    """The API refuses an over-long note; the page must not offer one."""

    def test_the_frontend_note_bound_matches_the_api(self):
        api = _int_const(_read(BALLOTS_SOURCE), 'MAX_BALLOT_NOTE_LEN', BALLOTS_SOURCE)
        frontend = _ts_int_const(
            _read(FRONTEND_BOUNDS_SOURCE), 'MAX_BALLOT_NOTE_LENGTH', FRONTEND_BOUNDS_SOURCE,
        )
        assert api == frontend, (
            f'MAX_BALLOT_NOTE_LEN is {api} in {BALLOTS_SOURCE} but '
            f'MAX_BALLOT_NOTE_LENGTH is {frontend} in {FRONTEND_BOUNDS_SOURCE}. The '
            f'API REFUSES a longer note rather than truncating it, so a larger '
            f'frontend bound makes Submit appear to do nothing, in front of a room.'
        )

    def test_the_anonymous_note_bound_matches_the_signed_in_one(self):
        # Both write the same `notes` attribute on the same kind of record, read
        # back on the same page, so one bound would be arbitrary.
        anon = _int_const(_read(BALLOTS_SOURCE), 'MAX_BALLOT_NOTE_LEN', BALLOTS_SOURCE)
        signed_in = _int_const(_read(PROJECTS_SOURCE), 'MAX_BALLOT_NOTE_LEN', PROJECTS_SOURCE)
        assert anon == signed_in, (
            f'MAX_BALLOT_NOTE_LEN is {anon} in {BALLOTS_SOURCE} but {signed_in} in '
            f'{PROJECTS_SOURCE}. The two paths write the same attribute on the same '
            f'record and it is rendered by the same page.'
        )

    def test_the_frontend_display_name_bound_matches_the_api(self):
        api = _int_const(_read(BALLOTS_SOURCE), 'MAX_DISPLAY_NAME_LEN', BALLOTS_SOURCE)
        frontend = _ts_int_const(
            _read(FRONTEND_BOUNDS_SOURCE),
            'MAX_BALLOT_DISPLAY_NAME_LENGTH',
            FRONTEND_BOUNDS_SOURCE,
        )
        assert api == frontend, (
            f'MAX_DISPLAY_NAME_LEN is {api} in {BALLOTS_SOURCE} but '
            f'MAX_BALLOT_DISPLAY_NAME_LENGTH is {frontend} in '
            f'{FRONTEND_BOUNDS_SOURCE}. The API truncates rather than refuses here, '
            f'so the drift is silent: a submitter watches characters they typed '
            f'vanish from their own name.'
        )
