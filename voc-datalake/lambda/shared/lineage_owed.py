"""Why a retention run owes its lineage marks, as words and as a code (7.97.00, projects 3g-ui).

The retention worker (``jobs/retention/registries.py``) writes, on an owing run's job and audit rows, the English
``incomplete_reason`` and, since 7.97.00, ``lineage_owed_reason`` (one of ``OWED_CODES``) and ``lineage_owed_mode``.
Settings' erasure view (``api/settings_handler.py`` ``erasure_job_view``) derives the code for a row written before
it (7.93.00, 7.94.00), with ``owed_code``, the worker's one rule, so an owe that could not be recorded always reads
``owe_failed``. The web app's list of the codes (``frontend/src/api/sourceProfilesApi.ts`` ``LINEAGE_OWED_REASONS``)
is held to ``OWED_CODES`` by a test.
"""
from __future__ import annotations

from typing import Final

__all__ = [
    'OWED_CODES', 'OWED_MODE', 'OWED_REASON', 'OWE_FAILED_REASON', 'REGISTRIES_COMPLETE', 'REGISTRIES_INCOMPLETE',
    'REGISTRIES_NOT_BACKFILLED', 'owed_code',
]

#: The ``review_registries`` results (the ``registries`` phase's).
REGISTRIES_COMPLETE: Final = 'complete'
REGISTRIES_NOT_BACKFILLED: Final = 'not_backfilled'
REGISTRIES_INCOMPLETE: Final = 'incomplete'
#: The rows' fields: why (a code), and the run's mode (which later run makes the marks).
OWED_REASON: Final = 'lineage_owed_reason'
OWED_MODE: Final = 'lineage_owed_mode'
OWED_NOT_BACKFILLED: Final = 'not_backfilled'
OWED_INCOMPLETE: Final = 'incomplete'
OWED_FAILED_BEFORE_MARKS: Final = 'failed_before_marks'
OWED_OWE_FAILED: Final = 'owe_failed'
OWED_CODES: Final = (OWED_NOT_BACKFILLED, OWED_INCOMPLETE, OWED_FAILED_BEFORE_MARKS, OWED_OWE_FAILED)
#: Why a failed run owes its marks when the owed row could not be written: no later run replays them, so the reason
#: says where its sources are.
OWE_FAILED_REASON: Final = ("this run's lineage marks are owed but could not be recorded, so no later run makes them "
                            "on its own: the sources it erased from are on its audit row; ask the deployment's "
                            "operator to read the worker's logs for the cause")


def owed_code(incomplete_reason: object, registries_result: object) -> str:
    """Why a run owes its marks, as one of ``OWED_CODES``: its owe could not be recorded (``OWE_FAILED_REASON``), it
    failed before its lineage pass (registries complete), or its registries were incomplete or not backfilled."""
    if incomplete_reason == OWE_FAILED_REASON:
        return OWED_OWE_FAILED
    if registries_result == REGISTRIES_COMPLETE:
        return OWED_FAILED_BEFORE_MARKS
    return OWED_INCOMPLETE if registries_result == REGISTRIES_INCOMPLETE else OWED_NOT_BACKFILLED
