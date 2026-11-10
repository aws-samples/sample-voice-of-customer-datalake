"""The company persona library: a reserved persona container (docs/project-workspace.md → Company personas).

Company personas reuse the project persona machinery (generation, import, avatars, job rows,
counts) under ONE reserved container id, ``COMPANY_PERSONAS_CONTAINER``: personas are
``PROJECT#company_personas`` / ``PERSONA#{id}`` rows, jobs live in voc-jobs under the same
partition, and avatar objects are stamped with the container as their owner.

The container is NOT a project. Its META row has no ``gsi1pk``, so no project list ever shows
it, and the projects API refuses the id on every ``/projects/{id}/...`` route, for admins too
(``projects_handler._project_access_for``). It is reached only through ``/company-personas``
(``shared.company_personas_routes``), where every write is an admin's.
"""
from __future__ import annotations

from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.logging import logger
from shared.project_access import VISIBILITY_PRIVATE
from shared.project_writes import project_meta_key
from shared.timestamps import now_iso

COMPANY_PERSONAS_CONTAINER: Final = 'company_personas'
CONTAINER_KIND: Final = 'company_personas'
CONTAINER_NAME: Final = 'Company personas'
#: Never a Cognito sub (a UUID) and synthetic-looking, so it can never match a caller.
CONTAINER_OWNER: Final = 'system:company'


def is_company_container(project_id: object) -> bool:
    """True for the reserved container id (refused wherever a project id is expected)."""
    return project_id == COMPANY_PERSONAS_CONTAINER


def ensure_company_personas_meta(table: Any) -> None:
    """Create the container's META row on the first company write; a no-op afterwards.

    Conditional (``attribute_not_exists``), so two first writes racing each other both
    succeed and the row is written once. The persona-save writable check and
    ``store_persona_count`` need the row to exist.
    """
    now = now_iso()
    try:
        table.put_item(
            Item={
                **project_meta_key(COMPANY_PERSONAS_CONTAINER),
                'project_id': COMPANY_PERSONAS_CONTAINER,
                'kind': CONTAINER_KIND,
                'name': CONTAINER_NAME,
                'visibility': VISIBILITY_PRIVATE,
                'owner_sub': CONTAINER_OWNER,
                'persona_count': 0,
                'created_at': now,
                'updated_at': now,
            },
            ConditionExpression='attribute_not_exists(pk)',
        )
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
        return
    logger.info('[COMPANY_PERSONAS] Created the company persona library container')


def _created_at(item: dict) -> str:
    return str(item.get('created_at') or '')


def company_persona_items(table: Any) -> list[dict]:
    """Every company persona row, newest ``created_at`` first."""
    rows = list(iter_query(table, {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{COMPANY_PERSONAS_CONTAINER}')
        & Key('sk').begins_with('PERSONA#'),
    }))
    return sorted(rows, key=_created_at, reverse=True)


def without_copier(provenance: dict) -> dict:
    """``copied_from`` without ``copied_by`` (a user id), for readers other than admins."""
    return {key: value for key, value in provenance.items() if key != 'copied_by'}


def persona_summary(persona: dict) -> dict:
    """``{persona_id, name, tagline, avatar_url, copied_from?}`` of an (already signed) persona."""
    summary = {
        'persona_id': persona.get('persona_id'),
        'name': persona.get('name') or '',
        'tagline': persona.get('tagline') or '',
        'avatar_url': persona.get('avatar_url') or None,
    }
    if isinstance(persona.get('copied_from'), dict):
        summary['copied_from'] = without_copier(persona['copied_from'])
    return summary
