"""Every environment variable the memory / agents / company-context code reads
is one the CDK actually sets.

A handler that reads a name the stack never sets does not fail at deploy: it
silently gets ``''`` and degrades (``MEMORY_QUEUE_URL`` vs the stack's
``MEMORY_EXTRACT_QUEUE_URL`` once meant no import or session was ever queued
for extraction). This scan reads the Python sources and the stack sources as
text, so a rename on either side fails CI instead of the live feature.
"""
from __future__ import annotations

import re
from pathlib import Path

from shared.embeddings import EMBED_MODEL_ID

ROOT = Path(__file__).resolve().parents[3]
LAMBDA = ROOT / 'lambda'

# Packages read whole, plus single modules shared with older features.
_PACKAGES = ('memory', 'agents', 'briefing')
_MODULES = (
    'api/memory_handler.py', 'api/agents_handler.py', 'api/settings_handler.py',
    'api/users_handler.py', 'shared/memory_store.py', 'shared/agents_store.py',
    'shared/embeddings.py', 'shared/company_context.py', 'shared/design_references.py',
    'shared/user_flags.py', 'shared/mcp_delegate.py', 'shared/assist_jobs.py',
    'shared/briefing_subscription.py', 'shared/briefing_requests.py',
    'api/radar_handler.py', 'jobs/radar_scan/handler.py',
)
# Names that are legitimately absent from the stack, each with its reason.
_NOT_SET_BY_CDK = {
    'AWS_LAMBDA_FUNCTION_NAME': 'provided by the Lambda runtime',
}

_ENV_READ = re.compile(r"environ(?:\.get)?[(\[]\s*'([A-Z0-9_]+)'")
_ENV_CONSTANT = re.compile(r"^[A-Z0-9_]+_ENV(?::\s*Final)?\s*=\s*'([A-Z0-9_]+)'", re.MULTILINE)


def _sources() -> list[Path]:
    files = [
        path for package in _PACKAGES for path in (LAMBDA / package).rglob('*.py')
        if 'test' not in path.relative_to(LAMBDA).parts
    ]
    return files + [LAMBDA / module for module in _MODULES]


def _env_names_read() -> dict[str, set[str]]:
    names: dict[str, set[str]] = {}
    for path in _sources():
        text = path.read_text()
        for pattern in (_ENV_READ, _ENV_CONSTANT):
            for match in pattern.finditer(text):
                names.setdefault(match.group(1), set()).add(str(path.relative_to(ROOT)))
    return names


def _stack_text() -> str:
    return '\n'.join(
        path.read_text() for path in (ROOT / 'lib').rglob('*.ts')
        if not path.name.endswith('.test.ts')
    )


# `export const ASSIST_WORKER_ENV = 'ASSIST_WORKER_FUNCTION';` … `[ASSIST_WORKER_ENV]: name`
_TS_NAME_CONSTANT = re.compile(r"\bconst ([A-Z0-9_]+)\s*=\s*'([A-Z0-9_]+)'")


def _names_set_by(stacks: str) -> set[str]:
    """Env names the stacks set under a literal key, or under a computed key naming a constant."""
    literal = set(re.findall(r'\b([A-Z][A-Z0-9_]*)\s*:', stacks))
    computed = {
        name for constant, name in _TS_NAME_CONSTANT.findall(stacks)
        if re.search(rf'\[{constant}\]\s*:', stacks)
    }
    return literal | computed


def test_the_scan_sees_the_feature_code():
    # Guards the guard: a moved package must not turn this into a vacuous pass.
    names = _env_names_read()
    assert {'MEMORY_TABLE', 'AGENTS_TABLE', 'MEMORY_EXTRACT_QUEUE_URL'} <= names.keys()


def test_every_env_name_read_is_set_by_some_stack():
    set_by_stacks = _names_set_by(_stack_text())
    unset = {
        name: sorted(files) for name, files in _env_names_read().items()
        if name not in _NOT_SET_BY_CDK and name not in set_by_stacks
    }
    assert unset == {}


def test_a_computed_key_counts_only_when_it_is_used():
    stacks = "export const FOO_ENV = 'FOO_NAME';\nconst BAR_ENV = 'BAR_NAME';\nenvironment: { [FOO_ENV]: x, PLAIN: y }"
    assert {'FOO_NAME', 'PLAIN'} <= _names_set_by(stacks)
    assert 'BAR_NAME' not in _names_set_by(stacks)


def test_allowed_absences_are_still_read():
    # A stale exemption would hide a future real gap under the same name.
    assert set(_NOT_SET_BY_CDK) <= _env_names_read().keys()


def test_python_embedding_default_mirrors_the_cdk_allowlist():
    allowlist = (ROOT / 'lib' / 'utils' / 'model-allowlist.ts').read_text()
    match = re.search(r"export const EMBEDDING_MODEL_ID = '([^']+)'", allowlist)
    assert match is not None
    assert match.group(1) == EMBED_MODEL_ID
