"""The workspace's own objects in its export (slice 4b; docs/multi-workspace.md, "Export and delete", step 2).

Every current object under ``ws/{ws}/`` except the workspace's exports (``raw/``, ``silver/``, and any other folder
the workspace has) goes into the zip as ``objects/{its key without ws/{ws}/}``, read through the layer's read-only
``WorkspaceObjects`` (shared/ws_repo.py), in key order, one listing page at a time. The job's checkpoint is the last
key it handled (``after``): a resumed listing starts right after it (``StartAfter``), so no object is repeated or
skipped, whether the hand-over fell mid-page or between pages. Each object is its current version when the listing
reached it: the manifest says the older versions are not exported.

The rules this module holds:

* **The entry's name** comes from the key, which is user data: zip_stream.py ``entry_name``'s rules (no empty, ``.``
  or ``..`` segment, also once trailing dots and spaces are dropped, so no absolute path; no backslash; no control,
  format (bidi, zero-width) or separator character; valid UTF-8; at most 65,535 bytes). A key that fails is skipped
  and listed in the manifest with the reason; the export never fails on it.
* **DEFLATE or STORE** (``stored``): STORE only for bytes already compressed, on first principles: images
  (``image/*`` but SVG, which is text), the zip family (zip, the office formats docx, xlsx, pptx, odt, ods, odp, and
  epub and jar, all zip containers) and gzip, by content type, else by the key's extension. Everything else is
  DEFLATE (at worst a few bytes larger than STORE).
* **Size and time**: an entry ends inside one invocation, so an object is copied whole or not started. An object
  over ``MAX_OBJECT_BYTES`` (3 GiB) is never included (``too_large``). Before any other object the job allows
  ``MARGIN`` (twice) its estimate at the rate measured so far for its kind (STORE or DEFLATE, across every
  invocation of the export, ``ObjectsState.rates``, from copies of at least ``MIN_MEASURED_COPY`` only;
  ``CONSERVATIVE_RATE`` until ``MEASURED_AFTER_BYTES`` of that kind are measured, and never faster than it for an
  object over ``LARGE_OBJECT_BYTES``). One whose allowance exceeds a
  fresh invocation's whole budget (the handler's ``FRESH_BUDGET_MS``: judged by time, not by what this invocation
  wrote) is listed ``too_slow`` instead of started; one that fits a fresh invocation but not the time left here is
  handed over. So the export never starts what it cannot finish, and never hands over forever.
* **The run state** crosses each hand-over in a Lambda event of at most 256 KB, so the manifest's list of objects
  not included keeps at most ``MAX_LISTED_SKIPS`` entries, each key cut to ``MAX_LISTED_KEY`` characters
  (``truncated``), and at most ``MAX_LISTED_BYTES`` of them serialized; past that it counts them only.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from jobs.workspace_export.zip_stream import BadEntryName, entry_name
from shared.design_assets import SVG_TYPE
from shared.ws_repo import WorkspaceScope, s3_prefix

__all__ = ['ENTITY', 'MAX_OBJECT_BYTES', 'ObjectsState', 'entry_for', 'manifest_section', 'stored']

#: The entity's name: its folder in the zip, its count and phase.
ENTITY: Final = 'objects'
#: The largest object an export includes (3 GiB): at ``CONSERVATIVE_RATE`` about 307 seconds, and twice that (the
#: ``MARGIN``) still inside a fresh invocation's budget. A larger one is not split across invocations: an entry never
#: crosses one (DEFLATE's state does not travel), and a split object is not the object.
MAX_OBJECT_BYTES: Final = 3 * 1024 ** 3
#: The copy rate assumed until one is measured: an S3 read plus DEFLATE level 6 on one vCPU, conservatively.
CONSERVATIVE_RATE: Final = 10 * 1024 * 1024
#: An object is started only when this many times its estimate fits (a rate measured on JSON is no promise for an
#: incompressible file of the same kind).
MARGIN: Final = 2.0
#: Past this size an object is estimated at the slower of its kind's measured rate and ``CONSERVATIVE_RATE``.
LARGE_OBJECT_BYTES: Final = 256 * 1024 * 1024
#: The bytes of one kind copied before its measured rate replaces the conservative one.
MEASURED_AFTER_BYTES: Final = 16 * 1024 * 1024
#: Only a copy at least this large counts toward the measured rate (``ObjectsState.measured``).
MIN_MEASURED_COPY: Final = 8 * 1024 * 1024
#: The body is read in chunks of this size (the zip's part buffer holds up to 64 MiB on top).
CHUNK: Final = 1024 * 1024
#: The objects-not-included list in the run state and the manifest: entries, characters a key, serialized bytes.
MAX_LISTED_SKIPS: Final = 50
MAX_LISTED_KEY: Final = 256
MAX_LISTED_BYTES: Final = 32 * 1024

#: Content types of bytes already compressed (beside ``image/*``): the zip family and gzip.
_STORED_TYPES: Final = frozenset({
    'application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-gzip',
    'application/epub+zip', 'application/java-archive',
})
#: The office formats are zip containers (OOXML and OpenDocument): their content types start so.
_STORED_TYPE_PREFIXES: Final = ('application/vnd.openxmlformats-officedocument.',
                                'application/vnd.oasis.opendocument.')
#: Extensions of those, for an object stored without a useful content type.
_STORED_EXTENSIONS: Final = frozenset({
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'ico',
    'zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'gz', 'tgz',
})

TOO_LARGE: Final = 'too_large'
TOO_SLOW: Final = 'too_slow'
BAD_NAME: Final = 'bad_name'
GONE: Final = 'gone'
_REASONS: Final = {
    TOO_LARGE: 'Larger than 3 GiB: too large to copy within one invocation of the export job.',
    TOO_SLOW: 'Too slow to copy within one invocation of the export job at the rate this export measured.',
    BAD_NAME: 'Its key cannot be a file name in a zip',
    GONE: 'Deleted while the export ran.',
}
#: The kinds a copy rate is measured for.
STORE: Final = 'store'
DEFLATE: Final = 'deflate'


def stored(content_type: str, key: str) -> bool:
    """Whether an object's bytes go in as STORE (already compressed) rather than DEFLATE (the module docstring)."""
    kind = content_type.split(';', 1)[0].strip().lower()
    if kind == SVG_TYPE:  # an image that is text
        return False
    if kind.startswith(('image/', *_STORED_TYPE_PREFIXES)) or kind in _STORED_TYPES:
        return True
    base, dot, extension = key.rsplit('/', 1)[-1].rpartition('.')
    return bool(base and dot) and extension.lower() in _STORED_EXTENSIONS


def entry_for(scope: WorkspaceScope, key: str) -> tuple[str | None, str | None]:
    """``(entry name, None)`` for a key the zip can name (``objects/{key without ws/{ws}/}``), or ``(None, why)``."""
    name = f'{ENTITY}/{key.removeprefix(s3_prefix(scope))}'
    try:
        entry_name(name)
    except BadEntryName as error:
        return None, f'{_REASONS[BAD_NAME]}: {error}.'
    return name, None


def _listed_key(key: str) -> tuple[str, bool]:
    """A key as the list shows it: escaped where it is not valid UTF-8 (the manifest is UTF-8 JSON), cut to
    ``MAX_LISTED_KEY`` characters; and whether it was cut."""
    shown = key.encode('utf-8', 'backslashreplace').decode('utf-8')
    return shown[:MAX_LISTED_KEY], len(shown) > MAX_LISTED_KEY


@dataclass
class ObjectsState:
    """What the objects carry across hand-overs: the last key handled, the bytes copied, the objects not included,
    and the copy rate measured for each kind (``{kind: [bytes, seconds]}``)."""

    after: str | None = None
    copied_bytes: int = 0
    skipped: list[dict[str, Any]] = field(default_factory=list)
    skipped_count: int = 0
    rates: dict[str, list[float]] = field(default_factory=dict)

    @classmethod
    def from_json(cls, value: object) -> ObjectsState:
        if not isinstance(value, Mapping):
            return cls()
        after, skipped, rates = value.get('after'), value.get('skipped'), value.get('rates')
        return cls(after=after if isinstance(after, str) else None, copied_bytes=int(value.get('copied_bytes') or 0),
                   skipped=[dict(item) for item in skipped if isinstance(item, Mapping)]
                   if isinstance(skipped, list) else [],
                   skipped_count=int(value.get('skipped_count') or 0),
                   rates={str(kind): [float(measured[0]), float(measured[1])]
                          for kind, measured in rates.items() if isinstance(measured, list) and len(measured) == 2}
                   if isinstance(rates, Mapping) else {})

    def to_json(self) -> dict[str, Any]:
        return {'after': self.after, 'copied_bytes': self.copied_bytes, 'skipped': [dict(item) for item in self.skipped],
                'skipped_count': self.skipped_count, 'rates': {kind: list(m) for kind, m in self.rates.items()}}

    def skip(self, key: str, size: int, reason: str, why: str | None = None) -> None:
        """List ``key`` as not included, within the list's caps (module docstring); every one is counted."""
        self.skipped_count += 1
        if len(self.skipped) >= MAX_LISTED_SKIPS:
            return
        shown, cut = _listed_key(key)
        item: dict[str, Any] = {'key': shown, 'size': size, 'reason': reason, 'detail': why or _REASONS[reason],
                                **({'truncated': True} if cut else {})}
        # Serialized as the hand-over's event is (json's default escapes): the list stays under its byte cap.
        if len(json.dumps([*self.skipped, item])) <= MAX_LISTED_BYTES:
            self.skipped.append(item)

    def seconds_for(self, size: int, store: bool) -> float:
        """The seconds to allow for copying an object of ``size`` bytes: ``MARGIN`` times its estimate at its kind's
        measured rate (``CONSERVATIVE_RATE`` until ``MEASURED_AFTER_BYTES`` of that kind are measured; for an object
        over ``LARGE_OBJECT_BYTES``, never faster than ``CONSERVATIVE_RATE``)."""
        copied, seconds = self.rates.get(STORE if store else DEFLATE, [0.0, 0.0])
        rate = copied / seconds if copied >= MEASURED_AFTER_BYTES and seconds > 0 else CONSERVATIVE_RATE
        if size > LARGE_OBJECT_BYTES:
            rate = min(rate, CONSERVATIVE_RATE)
        return MARGIN * size / max(rate, 1.0)

    def measured(self, store: bool, size: int, seconds: float) -> None:
        """Add one copy to its kind's measured rate, when it is at least ``MIN_MEASURED_COPY``: a small copy's time is
        mostly its fixed cost (the request), and would measure a rate far slower than a large object copies at."""
        if size < MIN_MEASURED_COPY:
            return
        copied, spent = self.rates.get(STORE if store else DEFLATE, [0.0, 0.0])
        self.rates[STORE if store else DEFLATE] = [copied + size, spent + seconds]


def manifest_section(count: int, state: ObjectsState) -> dict[str, Any]:
    """The manifest's ``objects``: the count and bytes included, what was not included and why, and what a reader
    of the zip should know."""
    return {
        'count': count,
        'bytes': state.copied_bytes,
        'not_included': list(state.skipped),
        'not_included_count': state.skipped_count,
        'versions': ("Each object is its current version when the export's listing reached it; older versions "
                     '(S3 versioning) are not exported.'),
        'note': ("Every current object under the workspace's folder (raw/, silver/, and any other), except its "
                 'exports, as objects/<its key without ws/<workspace id>/>.'),
        'reading': ('Already-compressed objects are STORED entries with a data descriptor (their CRC is known only '
                    'after they are read), which some streaming readers reject; readers of the central directory '
                    '(most unzip tools) open them. Keys that differ only in letter case or Unicode normalisation can '
                    'overwrite each other when extracted on a case-insensitive file system (macOS, Windows).'),
    }
