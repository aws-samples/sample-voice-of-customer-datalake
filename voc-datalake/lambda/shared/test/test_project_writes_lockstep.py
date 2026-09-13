"""Python and stream must reject the same project tombstone states."""

import re
from pathlib import Path

from shared.project_writes import (
    PROJECT_DELETION_ATTRIBUTE,
    PROJECT_TERMINAL_STATUSES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
)

_STREAM_TOOL = (
    Path(__file__).resolve().parents[2]
    / 'stream'
    / 'src'
    / 'tools'
    / 'update-document.ts'
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


def test_stream_create_fence_matches_python_tombstone_contract():
    source = _STREAM_TOOL.read_text(encoding='utf-8')
    match = re.search(
        r'export async function executeCreateDocument\b(?P<body>.*?)(?=^export |\Z)',
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match is not None, 'executeCreateDocument export not found'
    create_source = match.group('body')
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
