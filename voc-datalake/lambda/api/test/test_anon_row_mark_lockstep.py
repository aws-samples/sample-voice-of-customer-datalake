"""Lockstep test: the two marks a ballot stamps on its ROW are spelled in two
separate Lambda bundles and must agree.

`ballots_handler.py` is the one unauthenticated writer into the PRIORITIZATION
partition; `projects_handler.py` owns it — it writes a signed-in reviewer's ballot,
it is the only reader, and it is where a composition change and a row delete assert
these attributes. The two are packaged as SEPARATE bundles, so neither may import
the other; both take these names from `shared.prioritization_keys` (both bundles ship
`lambda/shared`), and this file pins that and how each writer applies them.

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

The handlers are read as SOURCE TEXT rather than imported: the assertion must not be
satisfiable by whatever either module happens to resolve at import time.
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
from lockstep_fixtures import assert_imported_not_defined, read_source

from shared import prioritization_keys as keys

BALLOTS_SOURCE = 'lambda/api/ballots_handler.py'
PROJECTS_SOURCE = 'lambda/api/projects_handler.py'


class TestTheFreezeMarkIsOneAttributeInBothBundles:
    """The mark a composition change asserts the absence of."""

    def test_both_writers_take_it_from_its_one_home(self):
        """The recompose route asserts the absence of this attribute, so a room ballot stamping
        another name would leave its row recomposable, with nothing erroring."""
        for where in (BALLOTS_SOURCE, PROJECTS_SOURCE):
            assert_imported_not_defined(read_source(where), 'shared.prioritization_keys',
                                        ('ROW_FROZEN_AT_FIELD',), where)

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

    def test_both_writers_take_it_from_its_one_home(self):
        """The row delete fences on this counter, so a room ballot moving another name would
        be orphaned by a delete that commits anyway (#342)."""
        for where in (BALLOTS_SOURCE, PROJECTS_SOURCE):
            assert_imported_not_defined(read_source(where), 'shared.prioritization_keys',
                                        ('ROW_BALLOT_WRITES_FIELD',), where)

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
        assert keys.ROW_FROZEN_AT_FIELD != keys.ROW_BALLOT_WRITES_FIELD


class TestBothBundlesReadTheCancellationReasonAtTheSamePosition:
    """Two items each, the row's write second, in both handlers."""

    def test_both_writers_take_the_row_index_from_its_one_home(self):
        """Both read the cancellation reason at that position to tell a vanished row from a
        write conflict; a disagreement would answer contention as a settled 404."""
        for where in (BALLOTS_SOURCE, PROJECTS_SOURCE):
            assert_imported_not_defined(read_source(where), 'shared.prioritization_keys',
                                        ('BALLOT_TRANSACT_ROW_INDEX',), where)

    def test_the_index_names_the_second_of_two_items(self):
        """Stated as a number rather than derived, so a transaction that grew a third
        participant — or reordered the two — fails here."""
        assert keys.BALLOT_TRANSACT_ROW_INDEX == 1
