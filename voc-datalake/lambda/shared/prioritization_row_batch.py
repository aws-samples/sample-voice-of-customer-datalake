"""Batched default-row ensure for `POST /projects/prioritization/rows`.

The Prioritization page asks the route to ensure one default row per project it
shows. One request per project meant N round trips on every load, so the route also
accepts `{project_ids: [...]}` and answers every project in one response:

    {"success": true,
     "rows":   [{"project_id", "created", "row"}, ...],
     "errors": [{"project_id", "status", "error"}, ...]}

EVERY ITEM GOES THROUGH THE SAME SINGLE-PROJECT PATH (`ensure_one`), so each one gets
exactly the access check, existence check and idempotent write the single-row shape
gets — the batch adds no shortcut around any of them. An item that fails is reported
under `errors` with the status the single-row shape would have answered, and the rest
of the batch still succeeds (partial failure per item, never all-or-nothing).

NO LEAK: a project the caller cannot view answers 404 with the same wording as a
project that does not exist (the access gate's own message), so a batch tells a caller
nothing a single-row request would not. An item never appears under `rows` unless its
own access check passed.

A write route: never memoized and never given an ETag (docs/caching.md covers GETs only).
"""
from collections.abc import Callable
from typing import Any

from shared.exceptions import ApiError, ValidationError
from shared.logging import logger
from shared.row_ids import validated_row_id

# How many projects one batch may name. Each item costs a META read, one document
# query and one conditional write, run one after another inside the API Gateway's
# 29-second limit; 25 keeps the worst case a few seconds. Mirrored by the frontend's
# `ROW_ENSURE_BATCH_LIMIT`, which splits a longer list into several requests.
MAX_ROW_ENSURE_BATCH = 25

# What a failure the route did not anticipate reads as. Never the exception text,
# which can carry table names or keys.
UNEXPECTED_ITEM_ERROR = 'Failed to create the prioritization row'


def batch_project_ids(raw: Any) -> list[str]:
    """`project_ids` as a de-duplicated list of valid ids, or a ValidationError.

    Refused rather than truncated past the cap: a silently shortened batch would leave
    the projects past the cut with no row and no error saying why.
    """
    if not isinstance(raw, list) or not raw:
        raise ValidationError('project_ids must be a non-empty list')
    if len(raw) > MAX_ROW_ENSURE_BATCH:
        raise ValidationError(f'project_ids must name at most {MAX_ROW_ENSURE_BATCH} projects')
    ids = [validated_row_id(value, field='project_ids') for value in raw]
    return list(dict.fromkeys(ids))


def _ensure_item(project_id: str, ensure_one: Callable[[str], dict]) -> tuple[dict | None, dict | None]:
    """`(rows entry, None)` on success, `(None, errors entry)` on failure.

    An `ApiError` keeps the status and wording the single-row shape would answer.
    Anything else is logged and reported as a generic 500, so one bad item never
    fails the rest of the batch.
    """
    try:
        answer = ensure_one(project_id)
    except ApiError as error:
        return None, {'project_id': project_id, 'status': error.status_code, 'error': error.message}
    except Exception:
        logger.exception('Unexpected failure ensuring the prioritization row of %s', project_id)
        return None, {'project_id': project_id, 'status': 500, 'error': UNEXPECTED_ITEM_ERROR}
    entry = {
        'project_id': project_id,
        'created': answer.get('created') is True,
        'row': answer.get('row'),
    }
    return entry, None


def ensure_rows_batch(project_ids: list[str], ensure_one: Callable[[str], dict]) -> dict:
    """Run `ensure_one` per project and gather one answer per project.

    `ensure_one` returns the single-row shape (`{'created', 'row', ...}`) or raises.
    """
    outcomes = [_ensure_item(project_id, ensure_one) for project_id in project_ids]
    return {
        'success': True,
        'rows': [row for row, _ in outcomes if row is not None],
        'errors': [error for _, error in outcomes if error is not None],
    }
