"""The image types the CLIENT offers must be the ones the server can read.

Same shape of problem, and the same approach, as
``test_image_limits_lockstep.py``: read the other language as SOURCE TEXT rather
than importing it, so a Python test can pin a TypeScript constant.

WHAT IS PINNED AND WHY IT MATTERS. ``frontend/src/utils/imageInput.ts`` now holds
the single client-side copy of the accepted image types, and everything the user
meets is derived from it — the picker's ``accept``, the drag-and-drop filter, the
paste filter, the synthesized filename for a pasted bitmap, and the extension
list a refusal names, in BOTH the persona-import modal and the product-docs pane.
Its docblock asserts the set equals ``CONVERSE_IMAGE_FORMATS``, which
``lambda/shared/persona_import.py`` enforces at the API. Nothing held the two
together, so the drift had a direction and both directions are bad:

  - server WIDENED, client not: a format the model can now read is unpickable and
    a drop of it is refused with "not an image we can read", which is false;
  - client WIDENED, server not: the picker offers a type, the browser prepares it
    and the API refuses it after submission — the "upload appears to work, then
    fails" shape this repo has removed twice already.

Only the KEYS are compared. The values deliberately differ (extensions here,
Converse ``format`` strings there) and that divergence is pinned below, the same
way ``TestTheTwoImageMapsStayDeliberate`` pins the server's own two maps.
"""
import re
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


FRONTEND_SOURCE = 'frontend/src/utils/imageInput.ts'


def _frontend_mime_map(name: str, source: str = FRONTEND_SOURCE) -> dict[str, str]:
    """Read a MIME-keyed object literal out of a frontend source file.

    Regex over source text, because the frontend is not importable from Python and
    a TypeScript ``as const`` object is not JSON (unquoted-ish keys are quoted
    here, but there is no trailing-comma tolerance in json.loads, and comments sit
    inside these literals in other files).

    Asserts rather than returning a default: a regex that stops matching has to
    fail loudly, otherwise the test keeps passing while comparing against a value
    nobody is reading any more.
    """
    path = _repo_root() / source
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test. Same precedent as ``_frontend_int_const``.
        pytest.skip(f'{source} not present in this tree')
    block = re.search(
        rf'export const {name} = \{{(.*?)\}} as const',
        path.read_text(encoding='utf-8'),
        re.DOTALL,
    )
    assert block, f'{name} object literal not found in {source}'
    pairs = re.findall(r"'([^']+)'\s*:\s*'([^']+)'", block.group(1))
    assert pairs, f'{name} in {source} parsed as empty — has its shape changed?'
    return dict(pairs)


class TestClientAcceptedImageTypesLockstep:
    """The client's accepted set and the server's readable set must be equal."""

    def test_the_client_offers_exactly_what_converse_can_read(self):
        from shared.image_limits import CONVERSE_IMAGE_FORMATS

        client = _frontend_mime_map('IMAGE_MIME_EXTENSIONS')
        assert set(client) == set(CONVERSE_IMAGE_FORMATS), (
            f'{FRONTEND_SOURCE} accepts {sorted(client)} but the API can read '
            f'{sorted(CONVERSE_IMAGE_FORMATS)}. A type only the client offers is '
            'prepared in the browser and then refused by persona_import.py after '
            'submission; a type only the server reads is unpickable and is refused '
            'client-side with a message that is untrue. Change both, or neither.'
        )

    def test_the_client_map_is_not_empty_which_would_pass_nothing(self):
        """Control for the assertion above.

        An ``IMAGE_MIME_EXTENSIONS`` that parsed as ``{}`` would make a set
        comparison fail loudly, but a future refactor of the reader could quietly
        start returning a subset. Four is the number the whole argument rests on.
        """
        assert len(_frontend_mime_map('IMAGE_MIME_EXTENSIONS')) == 4

    def test_the_client_names_jpeg_dot_jpg_which_converse_rejects(self):
        """The one value that must NOT be shared, pinned so nobody unifies them.

        JPEG's MIME subtype is 'jpeg' and Converse's ``format`` is 'jpeg', while
        every filename this platform builds for that type ends '.jpg' — including
        the name synthesized for a pasted bitmap, which the user reads back. So the
        client map's VALUES are extensions and cannot be derived from, or replaced
        by, the Converse formats even though the keys are identical.
        """
        from shared.image_limits import CONVERSE_IMAGE_FORMATS, IMAGE_CONTENT_TYPE_EXTENSIONS

        client = _frontend_mime_map('IMAGE_MIME_EXTENSIONS')
        assert client['image/jpeg'] == '.jpg'
        assert CONVERSE_IMAGE_FORMATS['image/jpeg'] == 'jpeg'
        # Leading dot aside, the client is naming the same thing the S3 key does.
        assert client['image/jpeg'].lstrip('.') == IMAGE_CONTENT_TYPE_EXTENSIONS['image/jpeg']

    def test_every_client_extension_matches_the_storage_extension(self):
        """Extends the JPEG check to all four, since only that one is famous.

        The persona-import request carries a filename built from this map, and the
        product-doc upload builds an S3 key from ``IMAGE_CONTENT_TYPE_EXTENSIONS``
        for the same content type. Two extensions for one type would put '.jpeg'
        in front of the user and '.jpg' in the bucket.
        """
        from shared.image_limits import IMAGE_CONTENT_TYPE_EXTENSIONS

        client = _frontend_mime_map('IMAGE_MIME_EXTENSIONS')
        assert {mime: ext.lstrip('.') for mime, ext in client.items()} == IMAGE_CONTENT_TYPE_EXTENSIONS
