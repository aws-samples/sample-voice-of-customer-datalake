"""Upload/image size limits must be single-sourced across three languages.

Same shape of problem as ``test_avatar_image_model_lockstep.py``, and the same
approach: read the other language as SOURCE TEXT rather than importing it, so a
Python test can pin a TypeScript constant.

Two sets of numbers are pinned here.

1. The Bedrock Converse image limits. ``lib/utils/model-allowlist.ts`` is the
   source of truth (it sits next to the model allowlist the limits are argued
   against) and ``lambda/shared/image_limits.py`` mirrors them for the Lambdas.

2. ``MAX_FILE_BYTES``, the upload cap. This duplication PREDATES visual
   grounding: ``lambda/api/product_context.py`` and
   ``frontend/src/pages/ProjectDetail/ProductDocsUpload.tsx`` have each carried
   their own ``10 * 1024 * 1024`` with nothing holding them together, so lowering
   the server cap would leave the client happily starting uploads that the API
   then rejects. It is closed here opportunistically because that is precisely
   the class of drift this file exists to catch, and the image cap it now has to
   coexist with makes the client/server disagreement newly consequential.
"""
import os
import re
import sys
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _cdk_source() -> str:
    return (_repo_root() / 'lib' / 'utils' / 'model-allowlist.ts').read_text(encoding='utf-8')


def _ts_num_const(name: str) -> int:
    """Read a single exported NUMERIC constant out of the CDK source.

    The sibling ``_ts_const`` in test_avatar_image_model_lockstep.py only matches
    single-quoted strings. This tolerates TypeScript numeric separators
    (``3_750_000``), and asserts rather than returning a default: a regex that
    stops matching has to fail loudly, otherwise the test keeps passing while
    comparing against a value nobody is reading any more.
    """
    match = re.search(rf'export const {name} = ([\d_]+);', _cdk_source())
    assert match, f'{name} not found in model-allowlist.ts'
    return int(match.group(1).replace('_', ''))


FRONTEND_SOURCE = 'frontend/src/pages/ProjectDetail/ProductDocsUpload.tsx'


def _frontend_int_const(name: str) -> int:
    """Read a plain-multiplication int constant out of a .tsx file.

    Handles ``const NAME = 10 * 1024 * 1024`` rather than requiring a literal, so
    the frontend keeps the form that documents where the number comes from.
    """
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test. Same precedent as test_feedback_page_limit_lockstep.py.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    # Trailing `;` optional: prettier's config here omits it, but a formatting
    # change must not turn this into a failure about the number being missing.
    match = re.search(
        rf'const {name} = ([\d_]+(?:\s*\*\s*[\d_]+)*)\s*;?\s*$',
        path.read_text(encoding='utf-8'),
        re.MULTILINE,
    )
    assert match, f'{name} not found in {FRONTEND_SOURCE}'
    value = 1
    for factor in match.group(1).split('*'):
        value *= int(factor.strip().replace('_', ''))
    return value


def _product_context():
    """Import the upload boundary, adding lambda/api to sys.path if needed.

    Explicit rather than relying on lambda/api/test/conftest.py having already
    run: collection order makes that true today, but this file must also pass
    when run on its own.
    """
    api_dir = str(_repo_root() / 'lambda' / 'api')
    if api_dir not in sys.path:
        sys.path.insert(0, api_dir)
    os.environ.setdefault('PROJECTS_TABLE', 'test-projects')
    import product_context
    return product_context


class TestConverseImageLimitsLockstep:
    """The Python mirror must equal the TypeScript source of truth."""

    def test_max_image_bytes_matches_cdk_source(self):
        from shared.image_limits import MAX_IMAGE_BYTES

        assert MAX_IMAGE_BYTES == _ts_num_const('MAX_IMAGE_BYTES')

    def test_max_image_dimension_matches_cdk_source(self):
        from shared.image_limits import MAX_IMAGE_DIMENSION_PX

        assert MAX_IMAGE_DIMENSION_PX == _ts_num_const('MAX_IMAGE_DIMENSION_PX')

    def test_max_images_per_message_matches_cdk_source(self):
        from shared.image_limits import MAX_IMAGES_PER_MESSAGE

        assert MAX_IMAGES_PER_MESSAGE == _ts_num_const('MAX_IMAGES_PER_MESSAGE')

    def test_image_byte_cap_uses_the_decimal_reading_of_3_75_mb(self):
        """Pinned against the binary reading specifically.

        3.75 MB is ambiguous; 3_932_160 (binary) would exceed the limit if the
        docs mean decimal, and a Converse call rejected at the API is worse than a
        4.6% conservative cap. An edit "correcting" the value upward has to fail
        here rather than in production.
        """
        from shared.image_limits import MAX_IMAGE_BYTES

        assert MAX_IMAGE_BYTES == 3_750_000
        assert MAX_IMAGE_BYTES < 3_932_160


class TestUploadCapLockstep:
    """The client-side and server-side upload caps must be the same number."""

    def test_server_max_file_bytes_matches_the_frontend(self):
        server = _product_context().MAX_FILE_BYTES
        client = _frontend_int_const('MAX_FILE_BYTES')
        assert server == client, (
            f'product_context.MAX_FILE_BYTES is {server} but ProductDocsUpload.tsx '
            f'uses {client}. The client pre-check and the server cap have to agree, '
            'or one of them is either rejecting files the other accepts or waving '
            'through files the other refuses. Change both, or neither.'
        )

    def test_the_image_cap_is_stricter_than_the_file_cap(self):
        """A property, not a value: whichever way either number moves, the image
        cap has to stay the tighter one. If it ever exceeded MAX_FILE_BYTES the
        per-type image check would be unreachable — every image large enough to
        trip it would already have been refused by the general file cap — and the
        Converse limit would silently stop being enforced.
        """
        from shared.image_limits import MAX_IMAGE_BYTES

        assert MAX_IMAGE_BYTES < _product_context().MAX_FILE_BYTES
