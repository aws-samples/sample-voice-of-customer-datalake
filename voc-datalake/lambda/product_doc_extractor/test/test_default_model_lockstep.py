"""The extractor's DEFAULT_MODEL_ID must match the `documents` surface default.

The extractor cannot import `shared/model_config.py` — that module reaches
powertools through `shared/logging.py`, which would force this Lambda onto a
layer and drag container bundling into CoreStack. So the default arrives as an
environment variable set in `lib/stacks/core-stack.ts`, which makes it a SECOND
copy of a value whose first copy is `SURFACE_DEFAULTS['documents']`.

Drift there is silent and expensive: the extractor would describe images with a
different model than every other `documents`-surface caller, and nothing would
report a discrepancy — the grant covers the whole allowlist, so the call still
succeeds. Same failure shape, and the same remedy, as
`test_avatar_image_model_lockstep.py`: read the CDK source as text and pin it.
"""
import json
import re
from pathlib import Path

from shared.model_config import ALLOWED_MODEL_IDS, SURFACE_DEFAULTS


def _repo_root() -> Path:
    # lambda/product_doc_extractor/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _core_stack_source() -> str:
    return (_repo_root() / 'lib' / 'stacks' / 'core-stack.ts').read_text(encoding='utf-8')


def _extractor_env_value(name: str) -> str:
    """Read one `NAME: <value>,` entry out of the extractor's environment block."""
    source = _core_stack_source()
    start = source.index('ProductDocExtractorLambda')
    block = source[start:source.index('logGroup: new logs.LogGroup(this, \'ProductDocExtractorLambdaLogs\'', start)]
    match = re.search(rf'^\s*{name}: (.+),$', block, re.MULTILINE)
    assert match, f'{name} not found in the ProductDocExtractorLambda environment'
    return match.group(1).strip()


class TestDefaultModelLockstep:
    def test_cdk_default_matches_the_documents_surface_default(self):
        match = re.search(
            r"const documentsSurfaceDefaultModelId = '([^']+)';", _core_stack_source()
        )
        assert match, 'documentsSurfaceDefaultModelId not found in core-stack.ts'

        assert match.group(1) == SURFACE_DEFAULTS['documents']

    def test_cdk_default_is_allowlisted(self):
        """A non-allowlisted default would be ignored by _allowlisted() at
        runtime AND not covered by the IAM grant, so it must be in the list."""
        match = re.search(
            r"const documentsSurfaceDefaultModelId = '([^']+)';", _core_stack_source()
        )
        assert match.group(1) in ALLOWED_MODEL_IDS

    def test_env_uses_that_constant_rather_than_a_third_literal(self):
        assert _extractor_env_value('DEFAULT_MODEL_ID') == 'documentsSurfaceDefaultModelId'

    def test_allowlist_env_is_derived_from_the_shared_allowlist(self):
        """MODEL_ALLOWLIST must be rendered FROM ALLOWED_MODEL_IDS, not retyped —
        a literal array here is a copy that goes stale the next time the picker
        gains a model, and the handler would then reject a legitimate choice."""
        assert _extractor_env_value('MODEL_ALLOWLIST') == 'JSON.stringify(ALLOWED_MODEL_IDS)'

    def test_image_caps_are_derived_from_the_shared_constants(self):
        assert _extractor_env_value('MAX_IMAGE_BYTES') == 'String(MAX_IMAGE_BYTES)'
        assert _extractor_env_value('MAX_IMAGE_DIMENSION_PX') == 'String(MAX_IMAGE_DIMENSION_PX)'

    def test_handler_reads_the_same_allowlist_it_is_given(self):
        """End-to-end on the env contract: the ids the stack would inject are the
        ids the handler accepts."""
        from product_doc_extractor import handler

        # What core-stack.ts renders: JSON.stringify over the TS allowlist.
        injected = json.dumps(sorted(ALLOWED_MODEL_IDS))
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'MODEL_ALLOWLIST': injected}):
            assert handler._allowlist() == set(ALLOWED_MODEL_IDS)


class TestExtractorTimeoutLockstep:
    def test_timeout_stays_under_the_api_stall_deadline(self):
        """product_context.py fails a record that has not been extracted within
        EXTRACTION_STALL_SECONDS. A Lambda timeout at or above that value would
        mark SUCCESSFUL extractions failed, so the two numbers move together."""
        from api.product_context import EXTRACTION_STALL_SECONDS

        match = re.search(
            r"ProductDocExtractorLambda'.*?timeout: cdk\.Duration\.seconds\((\d+)\)",
            _core_stack_source(),
            re.DOTALL,
        )
        assert match, 'extractor timeout not found in core-stack.ts'

        timeout_seconds = int(match.group(1))
        assert timeout_seconds == 120
        assert timeout_seconds * 2 <= EXTRACTION_STALL_SECONDS
