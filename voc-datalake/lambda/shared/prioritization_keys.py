"""The Prioritization partition of voc-aggregates, declared once for its two writers.

``projects_handler`` (rows, signed-in ballots, the page read) and ``ballots_handler``
(anonymous room ballots) are separate Lambda bundles that cannot import each other, but
both ship ``lambda/shared``. Each used to spell these keys itself, pinned in lockstep by a
test; they import them from here instead.

    pk = PRIORITIZATION
    sk = ROW#{row_id}                        one record per row (a project's documents)
    sk = BALLOT#{row_id}#{kind}:{subject}    one ballot per reviewer per row

Rows sit in the SAME partition as their ballots on purpose: the page reads the partition
whole, so rows arrive with the ballots in one query, and a row and the ballots keyed to it
stay in one place (a row delete removes both).
"""
from typing import Final

PRIORITIZATION_PK: Final = 'PRIORITIZATION'
BALLOT_SK_PREFIX: Final = 'BALLOT#'
ROW_SK_PREFIX: Final = 'ROW#'

# The mark a row carries once a ballot has landed on it: the freeze's race half. A
# composition change is one conditional update carrying `attribute_not_exists(first_ballot_at)`,
# so the DATABASE refuses a change racing the first ballot. Both ballot writers stamp it with
# `if_not_exists` in the ballot's own transaction, so it records the FIRST ballot. Under another
# name it would be a freeze that does not freeze: a row balloted only in a room would stay
# recomposable (#339).
ROW_FROZEN_AT_FIELD: Final = 'first_ballot_at'

# How many ballot writes a row has taken (``ADD`` in every ballot transaction). A row DELETE is
# fenced on it not having moved since the read that listed the row's ballots; under another
# name a ballot landing in that window would be orphaned by a delete that committed (#342).
ROW_BALLOT_WRITES_FIELD: Final = 'ballot_writes'

# Where the ROW's write sits in a ballot transaction (the ballot's own write first, the row's
# second). Both ballot writers read `CancellationReasons` at this index to tell a vanished row
# (its condition failed) from a write conflict: the ballot's own half carries no condition, so a
# reason reported against index 0 is not a fact about the row.
BALLOT_TRANSACT_ROW_INDEX: Final = 1
