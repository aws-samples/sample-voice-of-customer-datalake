"""Python and stream must enforce the same project-chat selection bounds."""

import re
from pathlib import Path

from projects import (
    MAX_CHAT_CONTEXT_ID_LENGTH,
    MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS,
)

_SCHEMA_SOURCE = (
    Path(__file__).resolve().parents[2] / 'stream' / 'src' / 'schema.ts'
).read_text()


def _typescript_number(name: str) -> int:
    match = re.search(
        rf'export const {name}\s*=\s*([\d_]+);',
        _SCHEMA_SOURCE,
    )
    assert match is not None, f'{name} is not an exported numeric constant'
    return int(match.group(1).replace('_', ''))


def test_selected_document_count_bound_matches_stream():
    assert MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS == _typescript_number(
        'MAX_PERSONAS_DOCS_ARRAY'
    )


def test_project_and_document_id_bound_matches_stream():
    assert MAX_CHAT_CONTEXT_ID_LENGTH == _typescript_number('MAX_ID_LENGTH')
