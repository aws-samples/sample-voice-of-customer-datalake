"""Python and stream must reject the same project tombstone states."""

import re
from pathlib import Path

from shared.project_writes import (
    PROJECT_DELETION_ATTRIBUTE,
    PROJECT_TERMINAL_STATUSES,
)

_STREAM_TOOL = (
    Path(__file__).resolve().parents[2]
    / 'stream'
    / 'src'
    / 'tools'
    / 'update-document.ts'
)


def test_stream_create_fence_matches_python_tombstone_contract():
    source = _STREAM_TOOL.read_text(encoding='utf-8')
    create_source = source.split(
        'export async function executeCreateDocument', 1,
    )[1]
    placeholders = dict(re.findall(
        r"'(:\w+Status)': '([^']+)'",
        create_source,
    ))

    assert set(placeholders.values()) == set(PROJECT_TERMINAL_STATUSES)
    assert f"'#deleting': '{PROJECT_DELETION_ATTRIBUTE}'" in create_source
    assert "'#status': 'status'" in create_source
    assert 'attribute_not_exists(#status)' in create_source
    for placeholder in placeholders:
        assert f'#status <> {placeholder}' in create_source
