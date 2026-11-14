"""Which icons of a captured page are copied locally (``shared.design_icons`` does the copying).

In this order, de-duplicated by URL and capped there: the ``<link rel=icon | apple-touch-icon | mask-icon>``
links in page order (with their ``sizes``), the web manifest's icons, and ``/favicon.ico`` at the site root when the
page declares no ``icon`` link (what a browser would fetch). ``og:image`` is a share card, never copied.
Only https URLs are kept here; every download is checked again by the fetch.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Final
from urllib.parse import urlparse

from page_styles import PageStyles

from shared.design_icons import IconRef, clean_sizes

_REL_KINDS: Final = (('apple-touch-icon', 'touch-icon'), ('mask-icon', 'mask-icon'), ('icon', 'icon'))


def _kind(rel: str) -> str | None:
    words = rel.lower().split()
    for word, kind in _REL_KINDS:
        if any(w.startswith(word) for w in words):
            return kind
    return None


def _link_refs(styles: PageStyles) -> list[IconRef]:
    refs = []
    for link in styles.icons:
        url, kind = link.get('url', ''), _kind(link.get('rel', ''))
        if kind and url.startswith('https://'):
            refs.append(IconRef(url, kind, clean_sizes(link.get('sizes'))))
    return refs


def _favicon(styles: PageStyles, links: list[IconRef]) -> list[IconRef]:
    if any(ref.kind == 'icon' for ref in links):
        return []
    parsed = urlparse(styles.url)
    return [IconRef(f'https://{parsed.netloc}/favicon.ico', 'favicon')] if parsed.scheme == 'https' and parsed.netloc else []


def icon_refs(styles: PageStyles, manifest_refs: Callable[[str], list[IconRef]]) -> list[IconRef]:
    """The page's icons to copy, in the order above. ``manifest_refs`` reads the manifest (one capped fetch)."""
    links = _link_refs(styles)
    manifest = manifest_refs(styles.manifest) if styles.manifest.startswith('https://') else []
    return [*links, *manifest, *_favicon(styles, links)]
