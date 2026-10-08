"""Lockstep test: the two marks a ballot stamps on its ROW are spelled in two
separate Lambda bundles and must agree.

`ballots_handler.py` is the one unauthenticated writer into the PRIORITIZATION
partition; `projects_handler.py` owns it — it writes a signed-in reviewer's ballot,
it is the only reader, and it is where a composition change and a row delete assert
these attributes. The two are packaged as SEPARATE bundles, so neither may import
the other and the constants are duplicated by necessity. This file is what keeps the
copies honest, exactly as `test_anon_ballot_key_lockstep.py` does for the sort key.

WHAT EACH DRIFT COSTS, WHICH IS WHY THIS IS A TEST AND NOT A COMMENT
--------------------------------------------------------------------

  * `first_ballot_at` UNDER ANOTHER NAME IS A FREEZE THAT DOES NOT FREEZE.
    `api_recompose_prioritization_row` refuses a change by asserting
    `attribute_not_exists(first_ballot_at)`. If the anonymous writer stamps a
    differently-named attribute, a row whose only ballots were cast in a room stays
    recomposable — and recomposing it leaves every one of those ballots describing
    documents the room never saw. That is the invariant #339 records as
    database-enforced, with the hole placed exactly where the votes are least
    attributable.

  * `ballot_writes` UNDER ANOTHER NAME IS A FENCE THAT DOES NOT FENCE.
    `_transact_delete_row` asserts that attribute still reads what it read when the
    row's ballots were enumerated. If the anonymous writer moves something else, a
    room ballot landing in that window is orphaned by a delete that commits anyway —
    the #342 fault the fence exists to close.

  * THE TRANSACTION'S ROW INDEX. Both handlers read `CancellationReasons` at the
    position of the row's write to tell a vanished row from a write conflict. Two
    items each, row second, in both — a disagreement means one of them reads a reason
    belonging to the other item and answers a transient conflict as a settled fact.

Neither of the first two failures is loud. Nothing errors, no log line appears: the
room votes, every phone says thanks, and an invariant the API advertises is quietly
not true.

Every value is read as SOURCE TEXT rather than imported, for the reason
`test_anon_ballot_key_lockstep.py` records: the assertion must not be satisfiable by
whatever either module happens to resolve at import time.
"""
import re

# `read_source` ASSERTS a missing file rather than skipping, and the difference
# from `test_prioritization_row_payload_lockstep.py` is deliberate. BOTH files this
# reads are backend sources in this same tree, packaged and checked out together
# with the test — so an absent one means the file MOVED, which is a real drift
# this test should report rather than step around.
#
# The locksteps that skip reach ACROSS into the frontend tree, which can
# legitimately be absent (packaging a lambda bundle, a partial checkout): there is
# nothing to compare, and skipping beats a failure that says nothing about the code
# under test. Neither policy is the general rule; which one is right follows from
# whether a missing file is possible without anything having gone wrong.
from lockstep_fixtures import py_int_const, py_str_const, read_source

BALLOTS_SOURCE = 'lambda/api/ballots_handler.py'
PROJECTS_SOURCE = 'lambda/api/projects_handler.py'


class TestTheFreezeMarkIsOneAttributeInBothBundles:
    """The mark a composition change asserts the absence of."""

    def test_both_writers_name_the_same_attribute(self):
        anon = py_str_const(read_source(BALLOTS_SOURCE), 'ROW_FROZEN_AT_FIELD', BALLOTS_SOURCE)
        owner = py_str_const(read_source(PROJECTS_SOURCE), 'ROW_FROZEN_AT_FIELD',
                           PROJECTS_SOURCE)

        assert anon == owner, (
            f'ROW_FROZEN_AT_FIELD is {anon!r} in {BALLOTS_SOURCE} and {owner!r} in '
            f'{PROJECTS_SOURCE}. The recompose route asserts the absence of the '
            f"OWNER'S spelling, so a row whose only ballots came from a room would "
            f'stay recomposable — and those ballots would end up describing '
            f'documents nobody who cast them ever saw. Nothing errors when this '
            f'drifts.'
        )

    def test_the_recompose_condition_asserts_that_attribute(self):
        """That the constant AGREES is not the contract; that the refusal is built on
        it is. A condition naming the attribute literally would satisfy the assertion
        above while ignoring the constant entirely."""
        source = read_source(PROJECTS_SOURCE)

        assert re.search(
            r'attribute_not_exists\(\{?ROW_FROZEN_AT_FIELD\}?\)', source
        ), (
            f'{PROJECTS_SOURCE} declares ROW_FROZEN_AT_FIELD but no condition '
            f'asserts its absence. An unapplied constant is a comment: the freeze '
            f'would be a stored attribute nothing refuses a change on.'
        )

    def test_the_anonymous_writer_stamps_it_with_if_not_exists(self):
        """`if_not_exists` is what makes the mark a FREEZE INSTANT rather than a
        last-modified stamp. A plain assignment would move it on every correction, so
        "the first ballot froze this" would name whichever phone submitted last."""
        source = read_source(BALLOTS_SOURCE)

        assert re.search(r'if_not_exists\(#frozen_at, :now\)', source), (
            f'{BALLOTS_SOURCE} does not stamp the freeze mark with `if_not_exists`. '
            f'A plain assignment turns the freeze instant into a last-modified stamp.'
        )


class TestTheDeleteFenceIsOneAttributeInBothBundles:
    """The counter a row delete asserts has not moved."""

    def test_both_writers_name_the_same_attribute(self):
        anon = py_str_const(read_source(BALLOTS_SOURCE), 'ROW_BALLOT_WRITES_FIELD',
                          BALLOTS_SOURCE)
        owner = py_str_const(read_source(PROJECTS_SOURCE), 'ROW_BALLOT_WRITES_FIELD',
                           PROJECTS_SOURCE)

        assert anon == owner, (
            f'ROW_BALLOT_WRITES_FIELD is {anon!r} in {BALLOTS_SOURCE} and {owner!r} '
            f'in {PROJECTS_SOURCE}. The row delete fences on the OWNER\'S spelling, '
            f'so an anonymous ballot landing between the enumeration and the delete '
            f'would not move it — and the delete would commit, leaving that ballot '
            f'orphaned. That is the #342 fault the fence exists to close.'
        )

    def test_the_anonymous_writer_moves_it_with_ADD(self):
        """`ADD` rather than a read-then-increment, so a room of phones submitting at
        once each move it and none of them reads it first."""
        source = read_source(BALLOTS_SOURCE)

        assert re.search(r'ADD #ballot_writes :one', source), (
            f'{BALLOTS_SOURCE} does not ADD to the fence counter. An increment that '
            f'reads first loses exactly the concurrent case this feature is for.'
        )

    def test_neither_attribute_is_the_other(self):
        """One name for both marks would make the freeze instant and the write count
        the same field: the freeze would be overwritten by a counter, and the fence
        would compare timestamps."""
        source = read_source(PROJECTS_SOURCE)
        frozen = py_str_const(source, 'ROW_FROZEN_AT_FIELD', PROJECTS_SOURCE)
        writes = py_str_const(source, 'ROW_BALLOT_WRITES_FIELD', PROJECTS_SOURCE)

        assert frozen != writes


class TestBothBundlesReadTheCancellationReasonAtTheSamePosition:
    """Two items each, the row's write second, in both handlers."""

    def test_the_row_index_agrees(self):
        anon = py_int_const(read_source(BALLOTS_SOURCE), 'BALLOT_TRANSACT_ROW_INDEX',
                          BALLOTS_SOURCE)
        owner = py_int_const(read_source(PROJECTS_SOURCE), 'BALLOT_TRANSACT_ROW_INDEX',
                           PROJECTS_SOURCE)

        assert anon == owner, (
            f'BALLOT_TRANSACT_ROW_INDEX is {anon} in {BALLOTS_SOURCE} and {owner} in '
            f'{PROJECTS_SOURCE}. Both read the cancellation reason at that position '
            f'to tell a vanished row from a write conflict, so a disagreement means '
            f'one of them answers contention as a settled 404 and drops a ballot.'
        )

    def test_the_index_names_the_second_of_two_items(self):
        """Stated as a number rather than derived, so a transaction that grew a third
        participant — or reordered the two — fails here."""
        for source, where in ((read_source(BALLOTS_SOURCE), BALLOTS_SOURCE),
                              (read_source(PROJECTS_SOURCE), PROJECTS_SOURCE)):
            assert py_int_const(source, 'BALLOT_TRANSACT_ROW_INDEX', where) == 1
