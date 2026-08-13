"""
Bedrock Converse image limits and the image types this platform accepts.

Python mirror of the image-limits section of ``lib/utils/model-allowlist.ts``.
``lambda/shared/test/test_image_limits_lockstep.py`` reads that TypeScript file as
source text and pins every constant below against it, so the two cannot drift.

WHY THESE NUMBERS ARE SAFE TO HARDCODE, given the admin model picker: they are
limits of the Converse API's ``Message.content`` shape, not of any single model
(at most 20 images per message, each <= 3.75 MB and <= 8000 px per side). The
constraint sits above the model, so repointing a surface through the picker
cannot move it. Every id in the picker's allowlist is an Anthropic Claude, and
Anthropic's own vision limits (5 MB, 8000x8000) are looser-or-equal, so the API
figure binds for the whole allowlist and for any Claude added later. See the
TypeScript file for the reference link and the full argument.

MAX_IMAGE_BYTES is the DECIMAL reading of an ambiguous "3.75 MB"; the binary
reading would be 3_932_160. The decimal one is 4.6% lower and therefore correct
under either interpretation — do not raise it.

IMPORTS NOTHING ON PURPOSE. A Lambda that needs only the caps (the extractor, the
upload boundary) must be able to import this without pulling in
``shared/logging.py`` and its aws-lambda-powertools dependency.
"""

# Max bytes for one image in a Converse message (decimal reading of 3.75 MB).
MAX_IMAGE_BYTES = 3_750_000

# Max pixels on either side of an image in a Converse message.
MAX_IMAGE_DIMENSION_PX = 8000

# Max images in one Converse message. Not load-bearing yet — the extractor sends
# one image per call — but defined here so a later rung attaching several visuals
# to a single prompt does not invent its own number.
MAX_IMAGES_PER_MESSAGE = 20

# Image content types this platform accepts, mapped to the file extension used
# for the S3 object key. These are exactly the four formats Converse understands,
# so accepting anything else would mean storing a file no prompt can ever use.
IMAGE_CONTENT_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}
