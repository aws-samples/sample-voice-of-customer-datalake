"""Copying personas between containers: a project, or the company library (shared.company_personas).

Copy, never link (so editing one never changes another): each copy is an independent persona with a new id, its own
avatar object and ``copied_from`` provenance. Research notes are never copied in either direction.

The avatar is COPIED to the new persona's own key and stamped with the target container as its
owner. The copy never points at the source object: a project delete sweeps the avatar objects it
owns, so a shared object would vanish from the library when its source project went.
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Final, Literal

from shared.avatar import AVATAR_CACHE_CONTROL, AVATAR_KEY_PREFIX, AVATAR_OWNER_METADATA_KEY, avatar_key_from_uri
from shared.exceptions import NotFoundError
from shared.ids import timestamped_id
from shared.logging import logger
from shared.persona_save import ProjectNotWritableError, save_persona_items, store_persona_count
from shared.project_gate import PROJECT_NOT_FOUND

SourceScope = Literal['project', 'company']

PERSONA_NOT_FOUND: Final = 'Persona not found'
#: Stored fields a copy never carries over: keys, identity, timestamps, notes, provenance, the avatar.
NOT_COPIED: Final = frozenset({
    'pk', 'sk', 'gsi1pk', 'gsi1sk', 'persona_id', 'created_at', 'updated_at',
    'research_notes', 'copied_from', 'avatar_url',
})
#: The content type a copied avatar gets when the source HEAD reports none.
DEFAULT_AVATAR_CONTENT_TYPE: Final = 'image/jpeg'


def read_source_personas(table: Any, container: str, persona_ids: Sequence[str]) -> list[dict]:
    """Each source persona row, in request order; 404 when one is not in ``container``."""
    personas = []
    for persona_id in persona_ids:
        item = table.get_item(
            Key={'pk': f'PROJECT#{container}', 'sk': f'PERSONA#{persona_id}'}, ConsistentRead=True,
        ).get('Item')
        if not isinstance(item, dict):
            raise NotFoundError(PERSONA_NOT_FOUND)
        personas.append(item)
    return personas


def copied_from(
    source: dict, *, scope: SourceScope, project_id: str, project_name: str, copied_by: str, now: str,
) -> dict[str, str]:
    """The provenance a copy carries (replaced, never nested, on a copy of a copy)."""
    provenance = {'scope': scope, 'persona_id': str(source.get('persona_id') or ''),
                  'copied_at': now, 'copied_by': copied_by}
    if scope == 'project':
        provenance.update(project_id=project_id, project_name=project_name)
    return provenance


def _copy_avatar(s3: Any, bucket: str, source_uri: object, new_id: str, target: str) -> str | None:
    """``s3://`` URI of the new persona's own copy of the source avatar, or None (logged)."""
    source_key = avatar_key_from_uri(source_uri, bucket) if bucket else None
    if source_key is None:
        return None
    target_key = f'{AVATAR_KEY_PREFIX}{new_id}/{source_key.rsplit("/", 1)[-1]}'
    try:
        head = s3.head_object(Bucket=bucket, Key=source_key)
        s3.copy_object(
            Bucket=bucket, Key=target_key, CopySource={'Bucket': bucket, 'Key': source_key},
            MetadataDirective='REPLACE', Metadata={AVATAR_OWNER_METADATA_KEY: target},
            ContentType=str(head.get('ContentType') or DEFAULT_AVATAR_CONTENT_TYPE),
            CacheControl=str(head.get('CacheControl') or AVATAR_CACHE_CONTROL),
        )
    except Exception:  # noqa: BLE001 - a failed avatar copy leaves the copy without one; it still succeeds
        logger.warning('[PERSONA_COPY] Could not copy an avatar; the copy is saved without one',
                       extra={'persona_id': new_id})
        return None
    return f's3://{bucket}/{target_key}'


def _sweep_copied_avatars(s3: Any, bucket: str, items: list[dict]) -> None:
    """Best effort: remove the avatar objects this copy made for rows that were never saved."""
    for item in items:
        key = avatar_key_from_uri(item.get('avatar_url'), bucket)
        if key is None:
            continue
        try:
            s3.delete_object(Bucket=bucket, Key=key)
        except Exception:  # noqa: BLE001 - cleanup must not mask the 404
            logger.warning('[PERSONA_COPY] Could not remove a copied avatar', extra={'key': key})


def _new_item(source: dict, target: str, new_id: str, now: str, provenance: dict) -> dict:
    return {
        **{field: value for field, value in source.items() if field not in NOT_COPIED},
        'pk': f'PROJECT#{target}', 'sk': f'PERSONA#{new_id}',
        'gsi1pk': f'PROJECT#{target}#PERSONAS', 'gsi1sk': now,
        'persona_id': new_id, 'created_at': now, 'updated_at': now,
        'research_notes': [], 'copied_from': provenance, 'avatar_url': None,
    }


def copy_personas(
    table: Any, s3: Any, bucket: str, *, source_container: str, source_scope: SourceScope,
    source_project_name: str, persona_ids: Sequence[str], target_container: str, copied_by: str,
    now: datetime | None = None,
) -> list[dict]:
    """Copy ``persona_ids`` from ``source_container`` into ``target_container``; the new rows.

    Every source is read before anything is written (one missing id is a 404 with no side
    effect). A target that is gone or being deleted is a 404, and the avatars copied for it
    are removed again.
    """
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    stamp = moment.isoformat()
    items: list[dict] = []
    for source in read_source_personas(table, source_container, persona_ids):
        new_id = timestamped_id('persona', moment)
        provenance = copied_from(source, scope=source_scope, project_id=source_container,
                                 project_name=source_project_name, copied_by=copied_by, now=stamp)
        item = _new_item(source, target_container, new_id, stamp, provenance)
        item['avatar_url'] = _copy_avatar(s3, bucket, source.get('avatar_url'), new_id, target_container)
        items.append(item)
    try:
        saved = save_persona_items(table, target_container, items)
        store_persona_count(table, target_container, stamp)
    except ProjectNotWritableError as error:
        _sweep_copied_avatars(s3, bucket, items)
        raise NotFoundError(PROJECT_NOT_FOUND) from error
    except Exception:
        # Any other failure (throttling, a non-condition ClientError) may leave rows unsaved: remove
        # the avatar copies no saved row points at, then let the error through.
        _sweep_copied_avatars(s3, bucket, _unsaved(table, items))
        raise
    return saved


def _unsaved(table: Any, items: list[dict]) -> list[dict]:
    """The copies whose row is not stored (an unreadable row counts as stored: never sweep a live avatar)."""
    unsaved = []
    for item in items:
        try:
            stored = table.get_item(Key={'pk': item['pk'], 'sk': item['sk']}, ConsistentRead=True).get('Item')
        except Exception:  # noqa: BLE001 - unknown means keep the avatar
            logger.warning('[PERSONA_COPY] Could not read back a copy; its avatar is kept',
                           extra={'persona_id': item.get('persona_id')})
            continue
        if not isinstance(stored, dict):
            unsaved.append(item)
    return unsaved
