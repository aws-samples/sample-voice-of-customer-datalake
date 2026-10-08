"""One review's dimension values and tags: where each value comes from, and who may change it.

Shared by the feedback processor (new reviews), the category-reprocess worker
(``mode: 'dimensions'``) and ``PUT /feedback/{id}/dimensions`` (manual edits), so
the three cannot disagree about which value wins.

Resolution order for a new review (first wins per key, everything through
``shared.dimension_config.resolve_dimensions``):

1. the message's own ``dimensions`` (``'source'``: a CSV column, a form embed option),
   then the message's ``metadata`` and ``metadata.custom_fields`` entries whose key IS a
   configured dimension key (also ``'source'``; explicit ``dimensions`` win);
2. the source profile's ``dimension_defaults`` (``'profile'``);
3. the category config's ``product`` when a dimension keyed ``product`` exists and
   admits that value (``'category'``);
4. the model's answer, for dimensions with ``infer: true`` only (``'ai'``).

Keys are resolved parent-first, so a child value naming a ``parent_value`` is kept
only when the parent resolved (from any layer) to exactly that value.

Values set by a person or by the data's own producer (``LOCKED_SOURCES``) are
never overwritten by a re-inference.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Final

from shared.dimension_config import MAX_TAGS, allowed_values, resolve_dimensions, validate_tags

__all__ = [
    'DIMENSION_SOURCE_AI',
    'DIMENSION_SOURCE_CATEGORY',
    'DIMENSION_SOURCE_MANUAL',
    'DIMENSION_SOURCE_PROFILE',
    'DIMENSION_SOURCE_REPROCESS',
    'DIMENSION_SOURCE_SOURCE',
    'LOCKED_SOURCES',
    'PRODUCT_DIMENSION_KEY',
    'apply_dimension_edit',
    'category_product',
    'inferable_dimensions',
    'merged_tags',
    'reinfer_dimensions',
    'resolve_item_dimensions',
]

DIMENSION_SOURCE_SOURCE: Final = 'source'
DIMENSION_SOURCE_PROFILE: Final = 'profile'
DIMENSION_SOURCE_CATEGORY: Final = 'category'
DIMENSION_SOURCE_AI: Final = 'ai'
DIMENSION_SOURCE_MANUAL: Final = 'manual'
DIMENSION_SOURCE_REPROCESS: Final = 'reprocess'
# A re-inference keeps these: the producer or a person said so.
LOCKED_SOURCES: Final = frozenset({DIMENSION_SOURCE_SOURCE, DIMENSION_SOURCE_PROFILE, DIMENSION_SOURCE_MANUAL})

# The dimension a category's configured `product` feeds.
PRODUCT_DIMENSION_KEY: Final = 'product'

# One layer of candidate values and the provenance a value taken from it records.
Layer = tuple[Mapping[str, Any], str]


def _parent_first(config: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(config, key=lambda dimension: 'parent' in dimension)


def _accepts(config: list[dict[str, Any]], assigned: Mapping[str, str], key: str, value: object) -> str | None:
    """The canonical spelling of ``value`` for ``key`` given the values already assigned, or None."""
    if value is None:
        return None
    resolved = resolve_dimensions(config, {**assigned, key: value})
    return resolved.get(key)


def _resolve_layers(
    config: list[dict[str, Any]], layers: Sequence[Layer], assigned: Mapping[str, str],
    sources: Mapping[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    """``assigned`` plus, per unassigned key (parent-first), the first layer value the config admits."""
    dimensions, provenance = dict(assigned), dict(sources)
    for dimension in _parent_first(config):
        key = dimension['key']
        if key in dimensions:
            continue
        for candidate, source in layers:
            if source == DIMENSION_SOURCE_AI and dimension.get('infer') is False:
                continue
            value = _accepts(config, dimensions, key, candidate.get(key))
            if value is not None:
                dimensions[key], provenance[key] = value, source
                break
    return dimensions, provenance


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def category_product(categories_config: Iterable[Mapping[str, Any]], category: object) -> str | None:
    """The ``product`` the categories config files ``category`` under, or None."""
    for entry in categories_config:
        if entry.get('name') == category:
            product = entry.get('product')
            return product if isinstance(product, str) and product.strip() else None
    return None


def _metadata_layers(metadata: object) -> list[Layer]:
    """The message's ``metadata`` then its ``custom_fields``, both recorded as ``'source'``.

    Only keys equal to a configured dimension key are ever read (``_resolve_layers``
    walks the config's keys), and every value still has to be allowed.
    """
    flat = _as_mapping(metadata)
    return [(flat, DIMENSION_SOURCE_SOURCE), (_as_mapping(flat.get('custom_fields')), DIMENSION_SOURCE_SOURCE)]


def _category_layer(product: str | None) -> dict[str, str]:
    return {PRODUCT_DIMENSION_KEY: product} if product else {}


def resolve_item_dimensions(
    config: list[dict[str, Any]],
    *,
    message: object = None,
    metadata: object = None,
    profile_defaults: object = None,
    product: str | None = None,
    ai: object = None,
) -> tuple[dict[str, str], dict[str, str]]:
    """``(dimensions, dimension_sources)`` for a new review, per the module's order."""
    if not config:
        return {}, {}
    layers: list[Layer] = [
        (_as_mapping(message), DIMENSION_SOURCE_SOURCE),
        *_metadata_layers(metadata),
        (_as_mapping(profile_defaults), DIMENSION_SOURCE_PROFILE),
        (_category_layer(product), DIMENSION_SOURCE_CATEGORY),
        (_as_mapping(ai), DIMENSION_SOURCE_AI),
    ]
    return _resolve_layers(config, layers, {}, {})


def _stored(item: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    dimensions = {k: v for k, v in _as_mapping(item.get('dimensions')).items() if isinstance(v, str)}
    sources = {k: v for k, v in _as_mapping(item.get('dimension_sources')).items() if isinstance(v, str)}
    return dimensions, sources


def reinfer_dimensions(
    config: list[dict[str, Any]], item: Mapping[str, Any], *, product: str | None, ai: object,
) -> tuple[dict[str, str], dict[str, str]]:
    """A stored review's dimensions after a re-inference.

    Locked keys (source / profile / manual) are kept verbatim, whatever today's
    config says; every other key is recomputed from the category's product and the
    model's new answer (recorded as ``'reprocess'``), or dropped.
    """
    dimensions, sources = _stored(item)
    locked = {k: v for k, v in dimensions.items() if sources.get(k) in LOCKED_SOURCES}
    locked_sources = {k: sources[k] for k in locked}
    layers: list[Layer] = [
        (_category_layer(product), DIMENSION_SOURCE_CATEGORY),
        (_as_mapping(ai), DIMENSION_SOURCE_AI),
    ]
    resolved, provenance = _resolve_layers(config, layers, locked, locked_sources)
    return resolved, {
        k: DIMENSION_SOURCE_REPROCESS if v == DIMENSION_SOURCE_AI else v for k, v in provenance.items()
    }


def _edit_value(by_key: Mapping[str, Mapping[str, Any]], key: object, value: object) -> str | None:
    """The validated new value of one edited key (None removes it); ValueError when unknown."""
    if not isinstance(key, str) or key not in by_key:
        raise ValueError(f'"{key}" is not a configured dimension')
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f'The value of dimension "{key}" must be a string or null')
    match = next((name for name in allowed_values(by_key[key]) if name.casefold() == value.strip().casefold()), None)
    if match is None:
        raise ValueError(f'"{value}" is not a value of dimension "{key}"')
    return match


def apply_dimension_edit(
    config: list[dict[str, Any]], item: Mapping[str, Any], edits: Mapping[str, Any],
) -> tuple[dict[str, str], dict[str, str]]:
    """A review's dimensions after a manual edit, or ValueError (client-safe).

    Each edited key becomes ``'manual'`` (null removes it). An edited child whose
    value does not belong under its parent's resulting value is refused; a child
    nobody edited that no longer fits its parent is dropped.
    """
    by_key = {dimension['key']: dimension for dimension in config}
    dimensions, sources = _stored(item)
    for key, value in edits.items():
        new_value = _edit_value(by_key, key, value)
        if new_value is None:
            dimensions.pop(key, None)
            sources.pop(key, None)
        else:
            dimensions[key], sources[key] = new_value, DIMENSION_SOURCE_MANUAL
    configured = {k: v for k, v in dimensions.items() if k in by_key}
    resolved = resolve_dimensions(config, configured)
    refused = [key for key in edits if key in configured and key not in resolved]
    if refused:
        raise ValueError(f'The value of dimension "{refused[0]}" does not belong under its parent value')
    kept = {**{k: v for k, v in dimensions.items() if k not in by_key}, **resolved}
    return kept, {k: v for k, v in sources.items() if k in kept}


def merged_tags(*groups: object) -> list[str]:
    """The union of tag lists (first spelling wins, case-insensitively), capped at ``MAX_TAGS``.

    Never raises: a group that is not a list of strings contributes nothing, and a
    tag ``validate_tags`` would refuse is dropped rather than failing the review.
    """
    seen: set[str] = set()
    union: list[str] = []
    for group in groups:
        for tag in group if isinstance(group, list) else []:
            if not isinstance(tag, str) or not tag.strip() or tag.strip().casefold() in seen:
                continue
            try:
                valid = validate_tags([tag])
            except ValueError:
                continue
            seen.add(tag.strip().casefold())
            union.extend(valid)
    return union[:MAX_TAGS]


def inferable_dimensions(config: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The dimensions the model is asked about: ``infer`` true and at least one value."""
    return [d for d in config if d.get('infer') is not False and allowed_values(d)]
