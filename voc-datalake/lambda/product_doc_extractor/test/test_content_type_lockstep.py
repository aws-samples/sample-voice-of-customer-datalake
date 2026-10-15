"""The extractor's content-type maps must cover exactly the upload boundary's set.

`handler.py` splits the processable types across two module constants —
`TEXT_CONTENT_TYPES` (a decode is the whole extraction) and
`CONVERSE_IMAGE_FORMATS` (content type -> Bedrock Converse `format` token) — and
its docstring states the contract outright: "mirroring ALLOWED_CONTENT_TYPES in
lambda/api/product_context.py (the upload boundary refuses everything else, so an
unlisted type here means the two have drifted)".

That claim is the specification, and nothing was enforcing it. Drift is silent in
BOTH directions, and each direction has its own failure:

  * a type the boundary ACCEPTS but this handler does not reach falls through
    `_process_record`'s else branch to "This file type cannot be processed." —
    the upload succeeds, the record fails, and the user is told the platform
    cannot handle a file the platform just said it would;
  * a type this handler lists but the boundary REFUSES is dead code that reads as
    support, and will be cited as evidence the type works.

The extractor cannot import product_context to check this at runtime (that module
reaches powertools and boto3 through `shared/`), but a TEST can — the same
approach `test_default_model_lockstep.py` takes for the model default, which is
why the pattern is already established next door.
"""
from api.product_context import ALLOWED_CONTENT_TYPES

from product_doc_extractor.handler import CONVERSE_IMAGE_FORMATS, TEXT_CONTENT_TYPES


class TestProcessableContentTypesLockstep:
    def test_the_two_halves_together_cover_exactly_the_accepted_set(self):
        extractor_types = set(TEXT_CONTENT_TYPES) | set(CONVERSE_IMAGE_FORMATS)
        accepted = set(ALLOWED_CONTENT_TYPES)

        assert extractor_types == accepted, (
            'The upload boundary accepts '
            f'{sorted(accepted - extractor_types)} that the extractor cannot '
            'process, and/or the extractor lists '
            f'{sorted(extractor_types - accepted)} that the boundary refuses. '
            'The first arrives as a successful upload whose record then fails '
            'with "This file type cannot be processed."; the second is dead code '
            'that reads as support. Change both, in the same commit.'
        )

    def test_the_two_halves_do_not_overlap(self):
        """`_process_record` tests text first, so an overlap would route an image
        into the decode branch and pass its raw bytes through as if they were the
        extraction — a `ready` record holding mojibake."""
        assert not (set(TEXT_CONTENT_TYPES) & set(CONVERSE_IMAGE_FORMATS))

    def test_neither_half_is_empty(self):
        """Vacuity guard: two empty sets would satisfy the equality above if the
        boundary's map were ever emptied too."""
        assert TEXT_CONTENT_TYPES
        assert CONVERSE_IMAGE_FORMATS
        assert ALLOWED_CONTENT_TYPES

    def test_the_image_half_maps_to_converse_format_tokens_not_extensions(self):
        """The values are a different contract from the boundary's, and must not
        be "fixed" to agree with it: `ALLOWED_CONTENT_TYPES['image/jpeg']` is the
        file extension `jpg`, while Converse answers a bare 400 for `jpg` and
        needs `jpeg`. Only the KEYS are in lockstep."""
        assert CONVERSE_IMAGE_FORMATS['image/jpeg'] == 'jpeg'
        assert ALLOWED_CONTENT_TYPES['image/jpeg'] == 'jpg'
