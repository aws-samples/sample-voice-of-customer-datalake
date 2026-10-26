"""
Guard tests for the DynamoDB GSI-name single source of truth (issue #213).

lib/stacks/core-stack.ts defines the indexes; lambda/shared/indexes.py (and
the streaming Lambda's src/indexes.ts) mirror the names. These tests parse
the CDK source and assert the mirrors match, so a rename or addition on
either side fails CI instead of the live API — the #140 failure mode, where
a handler queried a never-existing index name and every Data Explorer delete
500'd. Same pattern as the model-allowlist TS↔Python mirror test.
"""

import re

from shared import indexes
from shared.test.repo_paths import repo_root

# Every GSI-name constant shared.indexes declares. Collected by naming convention
# rather than listed, so a constant added there joins the comparison without a
# second edit here — the same "an addition on either side fails CI" property.
ALL_INDEX_NAMES = frozenset(
    value for name, value in vars(indexes).items() if name.endswith('_INDEX')
)

# Stack indexes no Lambda queries, so shared.indexes declares no constant for them.
# Listed here so set equality still holds: an index added to the stack, or one of
# these gaining a Python consumer, still has to be a deliberate edit.
STACK_ONLY_INDEXES = frozenset({
    'gsi1-by-status',  # voc-jobs table
})



def _stack_index_names() -> set[str]:
    # Assumes every GSI lives in core-stack.ts (true today — all seven tables
    # are defined there). If an index is ever added in another stack file,
    # widen this to glob lib/stacks/*.ts.
    source = (repo_root() / 'lib' / 'stacks' / 'core-stack.ts').read_text()
    return set(re.findall(r"indexName:\s*'([^']+)'", source))


class TestIndexMirror:
    def test_python_mirror_matches_the_stack_exactly(self):
        """Set equality both ways: a stack rename breaks the constant, and a
        new stack index without a constant keeps the mirror incomplete."""
        stack = _stack_index_names()
        assert stack, 'parsed no indexName entries from core-stack.ts — parser drift?'
        mirrored = set(ALL_INDEX_NAMES) | STACK_ONLY_INDEXES
        assert stack == mirrored, (
            f'stack-only: {stack - mirrored}, '
            f'python-only: {mirrored - stack}'
        )
        assert not ALL_INDEX_NAMES & STACK_ONLY_INDEXES, (
            'an index with a shared.indexes constant is not stack-only'
        )

    def test_stream_mirror_names_exist_in_the_stack(self):
        """The streaming Lambda declares only the indexes it uses — every one
        of them must exist in the stack (subset, not equality)."""
        stream_source = (
            repo_root() / 'lambda' / 'stream' / 'src' / 'indexes.ts'
        ).read_text()
        stream_names = set(re.findall(r"=\s*'(gsi[^']+)'", stream_source))
        assert stream_names, 'parsed no index constants from stream/src/indexes.ts'
        missing = stream_names - _stack_index_names()
        assert not missing, f'stream declares indexes the stack does not define: {missing}'

    # Two literal shapes to catch:
    # 1. Names following the stack's gsiN-by-* convention, wherever they appear.
    # 2. ANY string literal passed straight to an IndexName=/index_name= kwarg —
    #    the actual #140 failure was IndexName='feedback-id-index', a name that
    #    matches no convention at all, so a convention-only scan misses it.
    _GSI_CONVENTION = re.compile(r"['\"](gsi\d+-by-[a-z-]+)['\"]")
    _INDEX_KWARG_LITERAL = re.compile(r"(?:IndexName|index_name)\s*=\s*['\"]([^'\"]+)['\"]")

    def test_no_new_hardcoded_index_literals_in_python(self):
        """Handlers must use shared.indexes — a fresh GSI-name string literal
        outside indexes.py reintroduces the drift this issue killed."""
        lambda_dir = repo_root() / 'lambda'
        offenders = []
        for py in lambda_dir.rglob('*.py'):
            rel = py.relative_to(lambda_dir)
            parts = rel.parts
            if 'test' in parts or any(p.startswith('test_') for p in parts):
                continue
            if rel.as_posix() == 'shared/indexes.py':
                continue
            if '__pycache__' in parts or 'layers' in parts:
                continue
            source = py.read_text()
            for pattern in (self._GSI_CONVENTION, self._INDEX_KWARG_LITERAL):
                for m in pattern.finditer(source):
                    line = source[: m.start()].count('\n') + 1
                    offenders.append(f'{rel.as_posix()}:{line} ({m.group(1)})')
        assert not offenders, (
            'Hardcoded GSI-name literal(s) found — import from shared.indexes '
            f'instead (#213): {offenders}'
        )
