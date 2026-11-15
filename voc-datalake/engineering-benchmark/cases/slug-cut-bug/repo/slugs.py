"""Turn a title into a short URL slug."""

import re

_SEPARATORS = re.compile(r'[^a-z0-9]+')


def slugify(title: str, max_length: int = 40) -> str:
    """Lower-case words joined by single hyphens, cut at a word boundary to at most max_length characters."""
    words = [word for word in _SEPARATORS.split(title.lower()) if word]
    slug = ''
    for word in words:
        candidate = f'{slug}-{word}' if slug else word
        if len(candidate) >= max_length:
            break
        slug = candidate
    return slug
