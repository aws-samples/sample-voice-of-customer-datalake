"""The Unicode categories of characters that can disguise text: one set, for every check that refuses them.

Controls (Cc: C0 including tab, CR and LF, DEL, and C1 such as NEL), format characters (Cf: the bidi overrides such
as U+202E, the zero-width joiners and spaces, the byte order mark) and the line and paragraph separators (Zl, Zp).
Text holding one can display differently from what it is: a link that goes elsewhere than it reads
(shared/ingest_schemas.py), a file name in a workspace's export that reads as another (the zip writer,
jobs/workspace_export/zip_stream.py).
"""
from __future__ import annotations

from typing import Final

__all__ = ['DISGUISING_CATEGORIES']

DISGUISING_CATEGORIES: Final = frozenset({'Cc', 'Cf', 'Zl', 'Zp'})
