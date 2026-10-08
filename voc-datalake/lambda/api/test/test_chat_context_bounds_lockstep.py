"""Python and stream must agree on the chat-context selection bounds.

The only stream caller of `POST /projects/{id}/chat-context` is now the
assistant's `get_documents` tool (`assistant/tools/server/project.ts`), whose
ids are validated by `idSchema` in `assistant/tools/spec.ts`. A stream bound
looser than Python's would turn a valid-looking tool call into a 400.
"""

import re
from pathlib import Path

from projects import (
    MAX_CHAT_CONTEXT_ID_LENGTH,
    MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS,
)

_TOOLS_DIR = (
    Path(__file__).resolve().parents[2] / 'stream' / 'src' / 'assistant' / 'tools'
)
_SPEC_SOURCE = (_TOOLS_DIR / 'spec.ts').read_text()
_PROJECT_TOOLS_SOURCE = (_TOOLS_DIR / 'server' / 'project.ts').read_text()
_PROJECTS_SOURCE = (Path(__file__).resolve().parents[1] / 'projects.py').read_text()


def _typescript_number(source: str, name: str) -> int:
    # `export` is optional: the dead-code gate un-exports constants only read here.
    match = re.search(rf'(?:export )?const {name}\s*=\s*([\d_]+);', source)
    assert match is not None, f'{name} is not a numeric constant'
    return int(match.group(1).replace('_', ''))


def test_get_documents_never_selects_more_documents_than_python_accepts():
    per_read = _typescript_number(_PROJECT_TOOLS_SOURCE, 'MAX_DOCUMENTS_PER_READ')
    assert 1 <= per_read <= MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS


def test_tool_id_bound_matches_python_id_bound():
    assert _typescript_number(_SPEC_SOURCE, 'MAX_TOOL_ID_LENGTH') == MAX_CHAT_CONTEXT_ID_LENGTH


def test_selected_document_count_bound_is_applied_on_both_sides():
    assert 'len(raw) > MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS' in _PROJECTS_SOURCE
    assert '.max(MAX_DOCUMENTS_PER_READ)' in _PROJECT_TOOLS_SOURCE


def test_id_bound_is_applied_on_both_sides():
    assert 'len(value) > MAX_CHAT_CONTEXT_ID_LENGTH' in _PROJECTS_SOURCE
    assert '.max(MAX_TOOL_ID_LENGTH)' in _SPEC_SOURCE
