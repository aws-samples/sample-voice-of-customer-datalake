"""The Python write fence must reject exactly the project tombstone states.

The stream half was removed: the stream Lambda no longer writes projects (every
assistant write is an approval-gated client tool executed by the SPA through the
Projects API), so there is no second fence to keep in lockstep.
"""

import re

from shared.project_writes import (
    PROJECT_TERMINAL_STATUSES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
)


def test_python_write_fence_matches_python_tombstone_contract():
    assert set(PROJECT_WRITABLE_ATTRIBUTE_VALUES.values()) == set(
        PROJECT_TERMINAL_STATUSES,
    )
    for placeholder in PROJECT_WRITABLE_ATTRIBUTE_VALUES:
        assert re.search(
            rf'#status <> {re.escape(placeholder)}\b',
            PROJECT_WRITABLE_CONDITION,
        )
