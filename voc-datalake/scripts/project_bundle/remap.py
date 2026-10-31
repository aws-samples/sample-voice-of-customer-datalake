"""Rewrite a project's rows and objects for another deployment.

Three kinds of reference change between deployments, and all are rewritten as whole TOKENS
(never inside a longer id: `persona_x_1` is not rewritten inside `persona_x_10`), in every
string value, every map key, every sort key and every S3 key:

* the raw bucket name (`s3://<bucket>/avatars/…` URIs);
* the owner's and members' Cognito subs (matched to the target user pool by email);
* with `--new-ids`, every id the project owns: the project id, persona ids, document ids, the
  comment series ids and prototype pin form ids derived from them.

`--new-ids` derives the new ids with the platform's own helpers (`lambda/shared`), so a
derived id (a versioned document id, a series id, a pin form id) is exactly what the
platform would compute for the new project; those helpers are imported only then.
"""
from __future__ import annotations

import hashlib
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

# Characters an id is made of: a match must not touch one on either side.
_ID_CHARS = r'A-Za-z0-9_\-'
LEGACY_ASSIGNMENT_PREFIX = 'LEGACY_ASSIGNMENT#'


class Rewriter:
    """Replace whole tokens by a fixed map, recursively through a DynamoDB item."""

    def __init__(self, mapping: Mapping[str, str]) -> None:
        self.mapping = {old: new for old, new in mapping.items() if old and old != new}
        alternatives = '|'.join(re.escape(old) for old in sorted(self.mapping, key=len, reverse=True))
        self._pattern = (re.compile(f'(?<![{_ID_CHARS}])(?:{alternatives})(?![{_ID_CHARS}])')
                         if alternatives else None)

    def text(self, value: str) -> str:
        if self._pattern is None:
            return value
        return self._pattern.sub(lambda match: self.mapping[match.group(0)], value)

    def value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {self.text(key) if isinstance(key, str) else key: self.value(member)
                    for key, member in value.items()}
        if isinstance(value, list):
            return [self.value(member) for member in value]
        if isinstance(value, set):
            return {self.value(member) for member in value}
        return value


def fix_legacy_assignment(item: dict[str, Any]) -> dict[str, Any]:
    """Re-derive a legacy version assignment's sort key from its (rewritten) source sk.

    The key is `LEGACY_ASSIGNMENT#{counter sk}#{sha256(source_document_sk)}`
    (`shared/document_versions.py` `_legacy_assignment_key`), so a new document id changes it.
    """
    sk, source = str(item.get('sk', '')), item.get('source_document_sk')
    if not sk.startswith(LEGACY_ASSIGNMENT_PREFIX) or not isinstance(source, str):
        return item
    counter_part = sk.removeprefix(LEGACY_ASSIGNMENT_PREFIX).rsplit('#', 1)[0]
    digest = hashlib.sha256(source.encode()).hexdigest()
    return {**item, 'sk': f'{LEGACY_ASSIGNMENT_PREFIX}{counter_part}#{digest}'}


def _shared_helpers() -> SimpleNamespace:
    """`lambda/` on the path, then the id helpers (they need the repo's virtualenv)."""
    lambda_dir = str(Path(__file__).resolve().parents[2] / 'lambda')
    if lambda_dir not in sys.path:
        sys.path.insert(0, lambda_dir)
    from shared import document_history, document_series, document_versions, ids, prototype_pins

    return SimpleNamespace(history=document_history, series=document_series, versions=document_versions,
                           ids=ids, pins=prototype_pins)


def _fresh(ids: Any, old: str) -> str:
    prefix = old.split('_', 1)[0] if '_' in old else 'doc'
    return ids.timestamped_id(prefix)


def _is_document_row(item: dict[str, Any], pk: str) -> bool:
    document_id = item.get('document_id')
    return (item.get('pk') == pk and isinstance(document_id, str) and bool(document_id)
            and str(item.get('sk', '')).endswith(f'#{document_id}') and item.get('sk') != 'META')


def _allocated_ids(versions: Any, rows: list[dict[str, Any]], old_pid: str, new_pid: str) -> dict[str, str]:
    """A versioned document's id is derived from the project id and its allocation."""
    found = {}
    for item in rows:
        allocation, document_type, document_id = (item.get('allocation_id'), item.get('document_type'),
                                                  item.get('document_id'))
        if item.get('pk') == f'{versions.VERSION_COUNTER_PREFIX}{old_pid}' and allocation and document_id:
            found[str(document_id)] = versions.versioned_document_id(new_pid, str(document_type), str(allocation))
    return found


def _series_ids(helpers: SimpleNamespace, documents: list[dict[str, Any]], old_pid: str, new_pid: str,
                rewrite: Rewriter) -> dict[str, str]:
    history, series, versions = helpers.history, helpers.series, helpers.versions
    mapped = {}
    for document in documents:
        document_type = versions.managed_document_type(document)
        if document_type in series.COMMENTABLE_TYPES:
            base_old = history.series_base(document)
            base_new = history.series_base(rewrite.value(document))
            mapped[series.series_id(old_pid, document_type, base_old)] = series.series_id(new_pid, document_type, base_new)
    return mapped


def new_id_map(rows: list[dict[str, Any]], old_pid: str) -> dict[str, str]:
    """Every id the project owns -> a fresh one (the `--new-ids` map)."""
    helpers = _shared_helpers()
    versions, ids, pins = helpers.versions, helpers.ids, helpers.pins
    new_pid = _fresh(ids, old_pid)
    pk = f'PROJECT#{old_pid}'
    mapping = {old_pid: new_pid}
    for item in rows:
        sk = str(item.get('sk', ''))
        persona_id = sk.removeprefix('PERSONA#')
        if item.get('pk') == pk and persona_id != sk and persona_id and '#' not in persona_id:
            mapping[persona_id] = _fresh(ids, persona_id)
    documents = [item for item in rows if _is_document_row(item, pk)]
    allocated = _allocated_ids(versions, rows, old_pid, new_pid)
    for document in documents:
        old_doc = str(document['document_id'])
        mapping[old_doc] = allocated.get(old_doc) or _fresh(ids, old_doc)
        mapping[pins.pin_form_id(old_doc)] = pins.pin_form_id(mapping[old_doc])
    mapping.update(_series_ids(helpers, documents, old_pid, new_pid, Rewriter(mapping)))
    return mapping
