"""The saved title of a research report: its name plus the UTC time it was created.

Research is not versioned, so two runs on the same question would otherwise
share a title; the creation date AND time tell them apart. One helper, used by
the Step Functions save step and the synchronous fallback alike.
"""
import re
from datetime import UTC, datetime

# Characters of the question the default title quotes.
DEFAULT_TITLE_QUESTION_CHARS = 50
TITLE_STAMP_FORMAT = '%Y-%m-%d %H:%M UTC'
TITLE_STAMP_SEPARATOR = ' — '

# An ISO date, optionally with a time (and seconds, fraction, UTC/Z/offset), not
# glued to other digits. The stamp this module writes matches it too, so
# re-stamping a title replaces the old stamp instead of adding a second.
_ISO_DATE_TIME = re.compile(
    r'(?<!\d)\d{4}-\d{2}-\d{2}'
    r'(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*UTC|Z|[+-]\d{2}:?\d{2})?)?'
    r'(?!\d)'
)


def research_document_title(title: object, question: str, created: datetime) -> str:
    """``title`` (or ``'Research: <question>'`` when blank) carrying ``created`` in UTC.

    A date already in the title is replaced in place by the date and time; a
    title without one gets the stamp appended after an em dash.
    """
    base = title.strip() if isinstance(title, str) else ''
    if not base:
        base = f'Research: {question[:DEFAULT_TITLE_QUESTION_CHARS]}'
    stamp = created.astimezone(UTC).strftime(TITLE_STAMP_FORMAT)
    if _ISO_DATE_TIME.search(base):
        return _ISO_DATE_TIME.sub(stamp, base, count=1)
    return f'{base}{TITLE_STAMP_SEPARATOR}{stamp}'
