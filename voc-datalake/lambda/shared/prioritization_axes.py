"""The prioritization scoring setup: which metrics a ballot scores, and how they weigh.

THE one source of truth for the axes both prioritization Lambdas read
(`projects_handler` for the signed-in board, `ballots_handler` for the room's
phones). Neither bundle may import the other, so everything they must agree on
lives here: the default setup, the stored shape, the validation of an admin's
edit, the ids minted for new metrics, and the composite formula.

One WORKSPACE-level setup (docs/prioritization.md): the board ranks rows of
every project against each other, so every reviewer scores with the same
metrics. Admins edit it; everyone scores with it.

Stored as ONE item in voc-aggregates, ``pk=PRIORITIZATION, sk=CONFIG``:
``{axes: [Axis], config_version: int, updated_at, updated_by}``. No item means
the default setup at ``config_version`` 0 — today's four built-in axes with
today's ids and weights, which is why ballots stored before this module existed
read unchanged: a ballot stores each axis as a top-level number named by its id,
and the default ids are the ids those ballots already carry.

The default is pinned against ``schemas/prioritization-default-axes.json`` (the
frontend's offline default) by ``test_prioritization_default_axes_lockstep.py``.
``schemas/`` is not bundled into the Lambdas, hence the copy below.
"""
from __future__ import annotations

import copy
import math
import re
import unicodedata
from collections.abc import Iterable, Mapping
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ConflictError, ValidationError
from shared.prioritization_keys import PRIORITIZATION_PK

CONFIG_SK: Final = 'CONFIG'

# The 1-5 scale is fixed; only names, weights and directions are configurable.
# 0 (anything below SCALE_MIN) is "not scored", never a value on the scale.
SCALE_MIN: Final = 1
SCALE_MAX: Final = 5

MAX_ACTIVE_AXES: Final = 8
MAX_AXES: Final = 20
MIN_WEIGHT: Final = 0
MAX_WEIGHT: Final = 100
MAX_LABEL_LEN: Final = 40
MAX_DESCRIPTION_LEN: Final = 160
MAX_END_LABEL_LEN: Final = 24
MAX_ID_LEN: Final = 32

HIGHER_BETTER: Final = 'higher_better'
LOWER_BETTER: Final = 'lower_better'
DIRECTIONS: Final = (HIGHER_BETTER, LOWER_BETTER)

AXIS_ID_PATTERN: Final = re.compile(r'^[a-z][a-z0-9_]{1,31}\Z')

BUILTIN_AXIS_IDS: Final = ('impact', 'time_to_market', 'strategic_fit', 'confidence')

# Never an axis id. A ballot stores each axis as a top-level attribute named by
# its id, beside these fields, and an aggregate row carries each axis mean beside
# its counters — so an axis named like one of them would overwrite it.
RESERVED_AXIS_IDS: Final = frozenset({
    # ballot stamp + record fields (both handlers)
    'notes', 'row_id', 'reviewer', 'updated_at', 'voting_session', 'display_name',
    'ballot_id', 'document_id', 'ttl', 'pk', 'sk',
    # response / aggregate fields
    'score', 'scores', 'composite', 'reviewer_count', 'score_spread', 'axis_counts',
    'axes', 'config_version', 'rows', 'aggregates',
})

_DEFAULT_WEIGHTS: Final = {'impact': 40, 'time_to_market': 30, 'strategic_fit': 20, 'confidence': 10}


def _builtin_axis(axis_id: str) -> dict:
    return {
        'id': axis_id,
        'builtin': True,
        'label': None,
        'description': None,
        'weight': _DEFAULT_WEIGHTS[axis_id],
        'direction': HIGHER_BETTER,
        'low_label': None,
        'high_label': None,
        'archived': False,
    }


DEFAULT_AXES: Final = tuple(_builtin_axis(axis_id) for axis_id in BUILTIN_AXIS_IDS)

_AXIS_FIELDS: Final = (
    'id', 'builtin', 'label', 'description', 'weight', 'direction', 'low_label', 'high_label', 'archived',
)
_PUBLIC_FIELDS: Final = ('id', 'label', 'description', 'low_label', 'high_label', 'direction', 'builtin')


def default_axes() -> list[dict]:
    """A fresh copy of the default setup (callers may mutate it)."""
    return copy.deepcopy(list(DEFAULT_AXES))


def default_config() -> dict:
    """The setup answered when nothing is stored."""
    return {'axes': default_axes(), 'config_version': 0, 'updated_at': None, 'updated_by': None}


# ============================================
# Reading a stored setup (defensively — a read must never take the board down)
# ============================================


def _stored_int(raw: Any) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, (Decimal, float)) and math.isfinite(raw) and raw == int(raw):
        return int(raw)
    return None


def _stored_text(raw: Any, max_len: int) -> str | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()[:max_len]
    return text or None


def _stored_axis(raw: Any) -> dict | None:
    """One stored axis in wire shape, or None when it cannot be read."""
    if not isinstance(raw, Mapping):
        return None
    axis_id = raw.get('id')
    if not isinstance(axis_id, str) or not is_axis_id(axis_id):
        return None
    weight = _stored_int(raw.get('weight'))
    direction = raw.get('direction')
    return {
        'id': axis_id,
        'builtin': axis_id in BUILTIN_AXIS_IDS,
        'label': _stored_text(raw.get('label'), MAX_LABEL_LEN),
        'description': _stored_text(raw.get('description'), MAX_DESCRIPTION_LEN),
        'weight': min(max(weight, MIN_WEIGHT), MAX_WEIGHT) if weight is not None else MIN_WEIGHT,
        'direction': direction if direction in DIRECTIONS else HIGHER_BETTER,
        'low_label': _stored_text(raw.get('low_label'), MAX_END_LABEL_LEN),
        'high_label': _stored_text(raw.get('high_label'), MAX_END_LABEL_LEN),
        'archived': raw.get('archived') is True,
    }


def stored_axes(raw: Any) -> list[dict] | None:
    """The axes of a stored setup, or None when the stored list is unusable.

    Unreadable entries and repeated ids are skipped. A list left with no active
    axis is unusable (nothing could be scored), and the caller falls back to the
    default rather than showing a board nobody can score.
    """
    if not isinstance(raw, list):
        return None
    axes: list[dict] = []
    seen: set[str] = set()
    for entry in raw:
        axis = _stored_axis(entry)
        if axis is None or axis['id'] in seen:
            continue
        seen.add(axis['id'])
        axes.append(axis)
    return axes if any(not axis['archived'] for axis in axes) else None


def config_from_item(item: Any) -> dict:
    """The setup a stored CONFIG item describes; the default when there is none."""
    if not isinstance(item, Mapping):
        return default_config()
    axes = stored_axes(item.get('axes'))
    version = _stored_int(item.get('config_version'))
    updated_at = item.get('updated_at')
    updated_by = item.get('updated_by')
    return {
        'axes': axes if axes is not None else default_axes(),
        'config_version': version if version is not None and version >= 0 else 0,
        'updated_at': updated_at if isinstance(updated_at, str) else None,
        'updated_by': updated_by if isinstance(updated_by, str) else None,
    }


def config_from_partition(items: Iterable[Any]) -> dict:
    """The setup out of an already-read PRIORITIZATION partition (the GET's one query)."""
    for item in items:
        if isinstance(item, Mapping) and item.get('sk') == CONFIG_SK:
            return config_from_item(item)
    return default_config()


def read_config(table: Any, *, consistent: bool = False) -> dict:
    """The stored setup, one keyed read. Raises on a failed read: scoring with a
    guessed setup could accept a metric that was archived, or refuse one that exists."""
    response = table.get_item(Key={'pk': PRIORITIZATION_PK, 'sk': CONFIG_SK}, ConsistentRead=consistent)
    return config_from_item(response.get('Item'))


# ============================================
# Views of a setup
# ============================================


def is_axis_id(value: str) -> bool:
    return bool(AXIS_ID_PATTERN.match(value)) and value not in RESERVED_AXIS_IDS


def active_axes(axes: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [axis for axis in axes if not axis.get('archived')]


def active_axis_ids(axes: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    return tuple(str(axis['id']) for axis in active_axes(axes))


def all_axis_ids(axes: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    return tuple(str(axis['id']) for axis in axes)


def weighted_axis_ids(axes: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    """Active axes that count in the composite (weight > 0).

    "Fully scored" is asked over these: an axis weighted 0 is shown and may be
    scored, but leaving it blank changes no composite, so it cannot make two
    ballots incomparable.
    """
    return tuple(str(axis['id']) for axis in active_axes(axes) if axis.get('weight', 0) > 0)


def public_axes(axes: Iterable[Mapping[str, Any]]) -> list[dict]:
    """What the public ballot page may see: active axes, no weights."""
    return [{field: axis.get(field) for field in _PUBLIC_FIELDS} for axis in active_axes(axes)]


def wire_axes(axes: Iterable[Mapping[str, Any]]) -> list[dict]:
    return [{field: axis.get(field) for field in _AXIS_FIELDS} for axis in axes]


# ============================================
# The composite — THE formula (the frontend's helper is the same arithmetic)
# ============================================


def oriented_value(value: float, direction: Any) -> float:
    """A scale value with "better" pointing up: 6 - v for a lower-is-better metric."""
    return (SCALE_MIN + SCALE_MAX - value) if direction == LOWER_BETTER else value


def composite(values: Mapping[str, float | None], axes: Iterable[Mapping[str, Any]]) -> float | None:
    """``Σ w·v' / Σ w`` over the active axes ``values`` scored; None if no weight counts.

    An unscored axis (absent, None, or below the scale's first position) is left
    out of BOTH sums, so a partial ballot is the composite of what it said rather
    than being dragged down by zeros nobody entered.
    """
    numerator = 0.0
    denominator = 0
    for axis in active_axes(axes):
        value = values.get(str(axis['id']))
        if value is None or value < SCALE_MIN:
            continue
        weight = int(axis.get('weight') or 0)
        numerator += weight * oriented_value(float(value), axis.get('direction'))
        denominator += weight
    return numerator / denominator if denominator else None


# ============================================
# An admin's edit (PUT /projects/prioritization/config)
# ============================================


def _input_text(raw: Any, field: str, max_len: int) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError(f'{field} must be text')
    text = raw.strip()
    if len(text) > max_len:
        raise ValidationError(f'{field} must be at most {max_len} characters')
    return text or None


def _input_weight(raw: Any) -> int:
    if (isinstance(raw, bool) or not isinstance(raw, (int, float))
            or not math.isfinite(raw) or raw != int(raw)):
        raise ValidationError(f'weight must be a whole number from {MIN_WEIGHT} to {MAX_WEIGHT}')
    weight = int(raw)
    if not MIN_WEIGHT <= weight <= MAX_WEIGHT:
        raise ValidationError(f'weight must be a whole number from {MIN_WEIGHT} to {MAX_WEIGHT}')
    return weight


def _input_flag(raw: Any) -> bool:
    if raw is None:
        return False
    if not isinstance(raw, bool):
        raise ValidationError('archived must be true or false')
    return raw


def _input_direction(raw: Any) -> str:
    if raw is None:
        return HIGHER_BETTER
    if raw not in DIRECTIONS:
        raise ValidationError('direction must be higher_better or lower_better')
    return str(raw)


def _slug_base(label: str) -> str:
    ascii_text = unicodedata.normalize('NFKD', label).encode('ascii', 'ignore').decode('ascii')
    slug = re.sub(r'[^a-z0-9]+', '_', ascii_text.lower()).strip('_')
    if not slug or not slug[0].isalpha():
        slug = f'metric_{slug}'.rstrip('_')
    return slug[:MAX_ID_LEN].rstrip('_')


def mint_axis_id(label: str | None, taken: Iterable[str]) -> str:
    """A new metric's id, from its label: a slug, unique, never reserved.

    ``"Ease of build"`` → ``ease_of_build``; a collision (with an existing id, a
    built-in or a reserved word) gets ``_2``, ``_3``… Labels with no Latin letters
    (``"影响"``) fall back to ``metric``.
    """
    used = set(taken)
    base = _slug_base(label or '')
    if len(base) < 2:
        base = 'metric'
    candidate = base
    suffix = 1
    while candidate in used or not is_axis_id(candidate):
        suffix += 1
        tail = f'_{suffix}'
        candidate = base[:MAX_ID_LEN - len(tail)].rstrip('_') + tail
    return candidate


def _input_axis(raw: Any, existing_ids: set[str]) -> dict:
    """One AxisInput, validated; ``id`` is None for a new metric (minted later)."""
    if not isinstance(raw, Mapping):
        raise ValidationError('each metric must be an object')
    axis_id = raw.get('id')
    if axis_id is not None and (not isinstance(axis_id, str) or axis_id not in existing_ids):
        raise ValidationError('a metric names an id that does not exist; leave id out for a new metric')
    builtin = axis_id in BUILTIN_AXIS_IDS
    label = _input_text(raw.get('label'), 'label', MAX_LABEL_LEN)
    if label is None and not builtin:
        raise ValidationError('every metric needs a name')
    return {
        'id': axis_id,
        'builtin': builtin,
        'label': label,
        'description': _input_text(raw.get('description'), 'description', MAX_DESCRIPTION_LEN),
        'weight': _input_weight(raw.get('weight')),
        'direction': _input_direction(raw.get('direction')),
        'low_label': _input_text(raw.get('low_label'), 'low_label', MAX_END_LABEL_LEN),
        'high_label': _input_text(raw.get('high_label'), 'high_label', MAX_END_LABEL_LEN),
        'archived': _input_flag(raw.get('archived')),
    }


def _check_counts(axes: list[dict]) -> None:
    active = active_axes(axes)
    if not active:
        raise ValidationError('keep at least one metric that is not archived')
    if len(active) > MAX_ACTIVE_AXES:
        raise ValidationError(f'at most {MAX_ACTIVE_AXES} metrics can be in use at once; archive one first')
    if not any(axis['weight'] > 0 for axis in active):
        raise ValidationError('at least one metric in use needs a weight above 0')


def _check_ids(axes: list[dict], current_ids: list[str]) -> None:
    sent = [axis['id'] for axis in axes if axis['id'] is not None]
    if len(sent) != len(set(sent)):
        raise ValidationError('each metric may appear only once')
    if any(axis_id not in sent for axis_id in current_ids):
        raise ValidationError('a metric cannot be removed; archive it instead')


def validated_axes_update(raw_axes: Any, current_axes: Iterable[Mapping[str, Any]]) -> list[dict]:
    """The new axis list for an admin's PUT, ids minted for new metrics.

    Refusals are ValidationError (400) with a message an admin can act on; the
    values themselves are never echoed.
    """
    if not isinstance(raw_axes, list):
        raise ValidationError('axes must be a list of metrics')
    if len(raw_axes) > MAX_AXES:
        raise ValidationError(f'a scoring setup holds at most {MAX_AXES} metrics, archived ones included')
    current_ids = list(all_axis_ids(current_axes))
    existing_ids = set(current_ids) | set(BUILTIN_AXIS_IDS)
    axes = [_input_axis(entry, existing_ids) for entry in raw_axes]
    _check_ids(axes, current_ids)
    _check_counts(axes)
    taken = existing_ids | {axis['id'] for axis in axes if axis['id'] is not None}
    for axis in axes:
        if axis['id'] is None:
            axis['id'] = mint_axis_id(axis['label'], taken)
            taken.add(axis['id'])
    return axes


def validated_base_version(raw: Any) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValidationError('base_version must be the config_version you started editing from')
    return raw


def write_config(table: Any, axes: list[dict], base_version: int, *, now: str, updated_by: str) -> dict:
    """Store the setup iff the stored version is still ``base_version``; 409 otherwise.

    The condition is the authority (two admins saving at once: one wins, the other
    is told to reload), so no read-then-write window exists.
    """
    item = {
        'pk': PRIORITIZATION_PK, 'sk': CONFIG_SK, 'axes': wire_axes(axes),
        'config_version': base_version + 1, 'updated_at': now, 'updated_by': updated_by,
    }
    condition: dict[str, Any] = (
        {'ConditionExpression': 'attribute_not_exists(sk)'} if base_version == 0 else {
            'ConditionExpression': 'config_version = :base',
            'ExpressionAttributeValues': {':base': base_version},
        }
    )
    try:
        table.put_item(Item=item, **condition)
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise ConflictError('Someone else changed the scoring setup; reload it and try again') from e
        raise
    return config_from_item(item)


# ============================================
# Ballots: which keys a save may carry
# ============================================


def refused_ballot_keys(entry: Mapping[str, Any], axes: Iterable[Mapping[str, Any]],
                        allowed_fields: Iterable[str]) -> list[str]:
    """Keys of a ballot body that name a metric that cannot be scored now.

    An archived metric, or an id-shaped key that is no metric and no known field,
    carrying a value. Null is "leave alone" and never refused. Keys that cannot be
    ids (other spellings, reserved words) are ignored as before.
    """
    axes = list(axes)
    active = set(active_axis_ids(axes))
    allowed = set(allowed_fields)
    return sorted(
        key for key, value in entry.items()
        if value is not None and key not in active and key not in allowed
        and is_axis_id(key)
    )
