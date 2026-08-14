"""
Persona-import input contract: the single source of what can actually be read.

Both layers that have to agree import this. The API boundary
(``api/projects_handler.py``) refuses before a job row exists, so a bad request
costs nothing; the job (``jobs/persona_importer/handler.py``) validates again
because it cannot assume the boundary ran — a replayed async invoke, or a job row
queued before that boundary shipped, arrives at the job directly. Two
independently maintained copies of this list would drift, and the drift that
matters is the API accepting something the job refuses.

Nothing here is substituted or guessed. The importer used to fall back to a
placeholder sentence for input it could not read and let the model invent a
persona from it; every branch below exists so that no input reaches the model
without its own content behind it.

Imports only sibling constants and exception classes, so both Lambdas can take it
without pulling in a new dependency.
"""

from shared.exceptions import ValidationError
from shared.image_limits import IMAGE_CONTENT_TYPE_EXTENSIONS

# The only two things the importer can turn into prompt content: text the user
# pasted, and an image sent as a Converse image block.
SUPPORTED_INPUT_TYPES = ('text', 'image')

# Intended, but not possible yet: nothing in this repo extracts text from a PDF.
# Kept separate from "unsupported" (mirroring
# ``product_context.DEFERRED_CONTENT_TYPES``) because "not yet" and "never" are
# different answers and a caller has to be able to tell them apart.
DEFERRED_INPUT_TYPES = {'pdf': 'PDF'}

# Absent or blank keeps this endpoint's long-standing default, so no caller that
# worked before starts failing.
DEFAULT_INPUT_TYPE = 'text'

_ACCEPTS = 'Persona import accepts pasted text or an image.'

# Derived, so adding a format in shared/image_limits.py cannot leave the message
# naming a set it no longer describes.
_IMAGE_FORMATS_LABEL = ', '.join(sorted(set(IMAGE_CONTENT_TYPE_EXTENSIONS.values())))

UNSUPPORTED_TYPE_MESSAGE = f'Unsupported import type. {_ACCEPTS}'

EMPTY_CONTENT_MESSAGE = (
    'There was nothing to read. Paste the persona description, or upload an '
    'image, and try again.'
)

UNSUPPORTED_IMAGE_MESSAGE = (
    f'That image could not be read. Accepted formats: {_IMAGE_FORMATS_LABEL}.'
)


def deferred_type_message(input_type: str) -> str:
    """The "not yet" refusal, distinct from the "never" one by construction."""
    return f'{DEFERRED_INPUT_TYPES[input_type]} import is not supported yet. {_ACCEPTS}'


def normalise_input_type(raw: object) -> str:
    """Trimmed, lowercased input type; `''` for anything that is not a string.

    A non-string is deliberately NOT coerced. ``str(123)`` would be answered as
    if the caller had asked for a type called "123", and ``raw in
    DEFERRED_INPUT_TYPES`` on an unhashable body value (a list, an object) raises
    TypeError, surfacing as a 500 for what is plainly a bad request. `''` falls
    through to the unsupported branch, which is the right answer for both.
    """
    if raw is None:
        return DEFAULT_INPUT_TYPE
    if not isinstance(raw, str):
        return ''
    return raw.strip().lower() or DEFAULT_INPUT_TYPE


def validate_import_config(raw_input_type: object, content: object,
                           media_type: object) -> str:
    """The normalised input type, or ValidationError naming what IS accepted.

    Type is checked before content, so a PDF is told it is a PDF rather than
    being told it is empty.
    """
    input_type = normalise_input_type(raw_input_type)

    if input_type in DEFERRED_INPUT_TYPES:
        raise ValidationError(deferred_type_message(input_type))
    if input_type not in SUPPORTED_INPUT_TYPES:
        raise ValidationError(UNSUPPORTED_TYPE_MESSAGE)

    # Empty content is the same fabrication by a second route: the model invents
    # from nothing. There is no input for which it is valid.
    if not (content if isinstance(content, str) else '').strip():
        raise ValidationError(EMPTY_CONTENT_MESSAGE)

    # An image's format is taken from media_type, so an unreadable one cannot be
    # waved through: 'application/pdf' here would otherwise pass the type
    # allowlist and reach Converse as an image block claiming format 'pdf'.
    # Blank is refused rather than assumed to be PNG — guessing the format is a
    # silent wrong answer, and these four are exactly what the picker advertises.
    if input_type == 'image':
        normalised = media_type.strip().lower() if isinstance(media_type, str) else ''
        if normalised not in IMAGE_CONTENT_TYPE_EXTENSIONS:
            raise ValidationError(UNSUPPORTED_IMAGE_MESSAGE)

    return input_type
