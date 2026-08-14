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
#
# STORAGE, not readability. Do not use this as the "can the model read it?" set:
# widening it to store a new type (an avatar format, say) would silently widen
# every prompt path that borrowed it. CONVERSE_IMAGE_FORMATS below is that set.
IMAGE_CONTENT_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

# The same four content types mapped to the `format` a Converse image block wants.
# Separate from the map above for two reasons, both load-bearing:
#
#  1. The VALUES genuinely differ. Converse names JPEG 'jpeg'; the S3 extension is
#     'jpg', which Converse rejects. Deriving one from the other by string
#     surgery (`content_type.split('/')[-1]`) happens to work for three of four.
#  2. The two answer different questions — "where do I store it?" and "can the
#     model read it?" — and a path that needs the second must not be widened by a
#     change made for the first.
#
# test_image_limits_lockstep.py asserts the two keep the same KEYS, so adding a
# type to one is a loud decision about the other rather than a silent one.
CONVERSE_IMAGE_FORMATS = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}


def converse_image_format(media_type: object) -> str | None:
    """The Converse `format` for a media type, or None if the model cannot read it.

    The single place a media type becomes a format. Lives here, beside the map it
    reads, rather than in a caller: it is a property of the Converse image block,
    and any prompt path that attaches an image needs it.

    Callers used to derive this as ``media_type.split('/')[-1]``, which is right for
    three of the four accepted types and wrong for the fourth — JPEG's subtype is
    'jpeg' while its S3 extension is 'jpg', and the two maps sit side by side above.

    Returns None rather than raising: the answer "the model cannot read this" is a
    normal result at a validation boundary, and each caller words its own refusal.
    """
    if not isinstance(media_type, str):
        return None
    return CONVERSE_IMAGE_FORMATS.get(media_type.strip().lower())
