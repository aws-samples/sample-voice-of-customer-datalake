"""Per-user category access: which categories of reviews a caller may see.

The pure policy, in the style of ``shared.project_access``: no AWS clients, so
every reader — the metrics API, chat, the feedback-form submissions, the
research/persona/document jobs and the category-edit route — reaches the same
answer from the same inputs. ``shared.category_gate`` does the one read.

Model:

- An access row in the aggregates table, ``pk='CATEGORY_ACCESS'``,
  ``sk='USER#{sub}'``, ``{categories: ['*'] | [names...], updated_by,
  updated_at}``.
- **No row means every category.** Deploying this module therefore hides
  nothing from anyone until an admin restricts a user.
- Workspace admins always see every category.
- A category's product owners (``owners[].sub`` in the categories config) see
  that category even when their row does not list it.
- A restricted caller sees an item only when its category is in scope. An item
  with no category reads as ``'other'``, so legacy items are hidden too unless
  ``'other'`` is granted.

An MCP credential acts as its minter (``voc:acting_subject``, resolved by
``project_access.caller_from_claims``) and is never an admin; a credential with
no minter on record sees nothing.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from shared.project_access import Caller

ACCESS_PK: Final = 'CATEGORY_ACCESS'
ACCESS_SK_PREFIX: Final = 'USER#'
WILDCARD: Final = '*'
FALLBACK_CATEGORY: Final = 'other'
MAX_ACCESS_CATEGORIES: Final = 50


def access_key(subject: str) -> dict[str, str]:
    """The aggregates-table key of ``subject``'s access row."""
    return {'pk': ACCESS_PK, 'sk': f'{ACCESS_SK_PREFIX}{subject}'}


@dataclass(frozen=True)
class CategoryScope:
    """What a caller may see: a category rule AND a source rule.

    ``all`` is True only when NEITHER rule hides anything, so every existing
    ``if not scope.all:`` aggregate-vs-item decision stays correct when only
    the source rule restricts. The category rule alone is ``categories_all`` /
    ``categories`` (``admits`` checks it); the source rule is ``source_allow``
    (an explicit grant list, or None) and ``source_deny`` (restricted sources
    hidden from a caller with no explicit grant). ``CategoryScope(all=False,
    categories=...)`` keeps its old meaning: a category restriction, every source.
    """

    all: bool
    categories: frozenset[str] = field(default_factory=frozenset)
    categories_all: bool | None = None
    source_allow: frozenset[str] | None = None
    source_deny: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        categories_all = self.all if self.categories_all is None else self.categories_all
        object.__setattr__(self, 'categories_all', categories_all)
        object.__setattr__(self, 'all', categories_all and self.sources_all)

    @property
    def sources_all(self) -> bool:
        """True when the source rule hides nothing."""
        return self.source_allow is None and not self.source_deny

    def to_dict(self) -> dict[str, Any]:
        """The ``GET /feedback/access`` body.

        ``all`` / ``categories`` keep their category meaning (``categories`` empty
        when every category is visible); ``sources_all`` says whether any source is
        hidden and ``sources`` lists the explicit grants (empty without a list).
        ``source_rule`` names the source rule so a reader that filters rows itself
        (the stream assistant) can apply it: ``all`` (nothing hidden), ``allow``
        (only ``sources``) or ``deny`` (everything except ``sources_denied``).
        """
        return {
            'all': bool(self.categories_all),
            'categories': [] if self.categories_all else sorted(self.categories),
            'sources_all': self.sources_all,
            'sources': sorted(self.source_allow or ()),
            'source_rule': self.source_rule,
            'sources_denied': [] if self.source_allow is not None else sorted(self.source_deny),
        }

    @property
    def source_rule(self) -> str:
        """``'all'``, ``'allow'`` (an explicit grant list) or ``'deny'`` (restricted sources hidden)."""
        if self.source_allow is not None:
            return SOURCE_RULE_ALLOW
        return SOURCE_RULE_DENY if self.source_deny else SOURCE_RULE_ALL


SOURCE_RULE_ALL: Final = 'all'
SOURCE_RULE_ALLOW: Final = 'allow'
SOURCE_RULE_DENY: Final = 'deny'

UNRESTRICTED: Final = CategoryScope(all=True)
NOTHING: Final = CategoryScope(all=False)


def item_category(item: Mapping[str, Any]) -> str:
    """The category an item is filed under, ``'other'`` when it has none."""
    value = item.get('category')
    return value if isinstance(value, str) and value else FALLBACK_CATEGORY


def admits(scope: CategoryScope, category: object) -> bool:
    """True when ``scope``'s CATEGORY rule may see reviews filed under ``category``."""
    if scope.categories_all:
        return True
    name = category if isinstance(category, str) and category else FALLBACK_CATEGORY
    return name in scope.categories


def admits_source(scope: CategoryScope, source: object) -> bool:
    """True when ``scope``'s SOURCE rule may see reviews from ``source`` (a ``source_platform``)."""
    name = source if isinstance(source, str) else ''
    if scope.source_allow is not None:
        return name in scope.source_allow
    return name not in scope.source_deny


def admits_item(scope: CategoryScope, item: Mapping[str, Any]) -> bool:
    """True when both rules admit ``item`` (its category and its ``source_platform``)."""
    if scope.all:
        return True
    return admits(scope, item_category(item)) and admits_source(scope, item.get('source_platform'))


def filter_items(scope: CategoryScope, items: Iterable[Mapping[str, Any]]) -> list:
    """``items`` the scope may see, in their original order."""
    items = list(items)
    if scope.all:
        return items
    return [item for item in items if admits_item(scope, item)]


def visible_categories(scope: CategoryScope, names: Iterable[str]) -> list[str]:
    """``names`` the scope may see, in their original order."""
    return [name for name in names if admits(scope, name)]


def category_owner_subs(category: Mapping[str, Any]) -> frozenset[str]:
    """The owner subs recorded on one categories-config entry (malformed dropped)."""
    owners = category.get('owners')
    if not isinstance(owners, list):
        return frozenset()
    return frozenset(
        owner['sub'] for owner in owners
        if isinstance(owner, Mapping) and isinstance(owner.get('sub'), str) and owner['sub']
    )


def owned_categories(subject: str, categories_config: Iterable[Any]) -> frozenset[str]:
    """Names of the categories ``subject`` is a product owner of."""
    if not subject:
        return frozenset()
    return frozenset(
        category['name'] for category in categories_config
        if isinstance(category, Mapping)
        and isinstance(category.get('name'), str) and category['name']
        and subject in category_owner_subs(category)
    )


def stored_categories(access_row: Mapping[str, Any] | None) -> list[str] | None:
    """The row's ``categories`` as stored, or None for no row (= all).

    A row without a ``categories`` field (one that only grants sources) also
    reads as None; a present but malformed value reads as ``[]``.
    """
    if not isinstance(access_row, Mapping) or 'categories' not in access_row:
        return None
    raw = access_row.get('categories')
    if not isinstance(raw, list):
        return []
    return [name for name in raw if isinstance(name, str) and name]


def needs_categories_config(caller: Caller, access_row: Mapping[str, Any] | None) -> bool:
    """True when ``resolve_scope`` will consult the categories config (owner grants).

    Lets the gate skip that read for admins, unrestricted rows and no-row callers.
    """
    if (caller.is_admin and not caller.delegated) or not caller.subject:
        return False
    names = stored_categories(access_row)
    return names is not None and WILDCARD not in names


def stored_sources(access_row: Mapping[str, Any] | None) -> list[str] | None:
    """The row's ``sources`` grant as stored; None when the row (or the field) is absent.

    A present but malformed value reads as ``[]`` (no source), failing closed.
    """
    if not isinstance(access_row, Mapping) or 'sources' not in access_row:
        return None
    raw = access_row.get('sources')
    if not isinstance(raw, list):
        return []
    return [name for name in raw if isinstance(name, str) and name]


def needs_restricted_sources(caller: Caller, access_row: Mapping[str, Any] | None) -> bool:
    """True when ``resolve_scope`` will consult the restricted source ids (no explicit grant)."""
    if (caller.is_admin and not caller.delegated) or not caller.subject:
        return False
    return stored_sources(access_row) is None


def _source_rule(access_row: Mapping[str, Any] | None,
                 restricted_sources: Iterable[str]) -> tuple[frozenset[str] | None, frozenset[str]]:
    """``(source_allow, source_deny)`` for a non-admin caller's row."""
    granted = stored_sources(access_row)
    if granted is None:
        return None, frozenset(restricted_sources)
    if WILDCARD in granted:
        return None, frozenset()
    return frozenset(granted), frozenset()


def resolve_scope(
    caller: Caller,
    access_row: Mapping[str, Any] | None,
    categories_config: Iterable[Any],
    restricted_sources: Iterable[str] = (),
) -> CategoryScope:
    """The scope ``caller`` sees, from their access row, the categories config and the
    ids of the restricted sources.

    Category rule: no row (or ``['*']``) = every category, else the listed ones
    plus the ones the caller owns; a malformed ``categories`` fails closed (owned
    only). Source rule: ``sources: ['*']`` = every source incl. restricted ones; a
    list = exactly those; no ``sources`` field (or no row) = every source that is
    not restricted. Admins (not delegated) see everything.
    """
    if caller.is_admin and not caller.delegated:
        return UNRESTRICTED
    if not caller.subject:
        return NOTHING
    source_allow, source_deny = _source_rule(access_row, restricted_sources)
    names = stored_categories(access_row)
    if names is None or WILDCARD in names:
        return CategoryScope(all=True, source_allow=source_allow, source_deny=source_deny)
    return CategoryScope(
        all=False,
        categories=frozenset(names) | owned_categories(caller.subject, categories_config),
        source_allow=source_allow, source_deny=source_deny,
    )


def validate_access_categories(value: object, known: Iterable[str]) -> list[str]:
    """Validate a ``PUT /users/{username}/category-access`` ``categories`` value.

    ``['*']`` grants everything; otherwise a list of distinct configured
    category names (an empty list is allowed: the user then sees only the
    categories they own). Raises ValueError with a client-safe message.
    """
    return _validated_grant(value, known, 'categories', 'category names', MAX_ACCESS_CATEGORIES)


MAX_ACCESS_SOURCES: Final = 50


def validate_access_sources(value: object, known: Iterable[str]) -> list[str]:
    """Validate a ``PUT /users/{username}/category-access`` ``sources`` value.

    ``['*']`` grants every source including restricted ones; otherwise a list of
    distinct configured source-profile ids (``[]`` = no source at all). Raises
    ValueError with a client-safe message.
    """
    return _validated_grant(value, known, 'sources', 'source ids', MAX_ACCESS_SOURCES)


def _validated_grant(value: object, known: Iterable[str], noun: str, what: str, limit: int) -> list[str]:
    """``['*']`` or a list of distinct known names, at most ``limit``; ValueError naming ``noun``."""
    if not isinstance(value, list):
        raise ValueError(f"{noun} must be a list of {what} or ['*']")
    if any(not isinstance(name, str) or not name for name in value):
        raise ValueError(f'{noun} must contain only non-empty strings')
    if WILDCARD in value:
        if len(value) != 1:
            raise ValueError(f"'*' cannot be combined with other {noun}")
        return [WILDCARD]
    if len(value) > limit:
        raise ValueError(f'At most {limit} {noun} can be granted')
    if len(set(value)) != len(value):
        raise ValueError(f'{noun} must not repeat')
    known_names = set(known)
    unknown = [name for name in value if name not in known_names]
    if unknown:
        raise ValueError(f'{len(unknown)} {noun} are not configured')
    return list(value)


# --------------------------------------------------------------------------
# Jobs: a job captures its starter's scope and carries it in its config.
# --------------------------------------------------------------------------

SCOPE_CONFIG_KEY: Final = 'category_scope'


def scope_to_config(scope: CategoryScope) -> dict[str, Any]:
    """JSON-safe form of ``scope`` to store in a job's config.

    ``all`` / ``categories`` keep their legacy meaning for an older reader:
    ``all`` is False whenever anything is hidden, so an older reader fails
    closed to the listed categories rather than open.
    """
    config: dict[str, Any] = {'all': scope.all, 'categories': sorted(scope.categories)}
    if not scope.sources_all:
        config.update({
            'categories_all': bool(scope.categories_all),
            'source_allow': None if scope.source_allow is None else sorted(scope.source_allow),
            'source_deny': sorted(scope.source_deny),
        })
    return config


def _names(value: object) -> frozenset[str] | None:
    """A list of names as a frozenset; None when ``value`` is not a list."""
    if not isinstance(value, list):
        return None
    return frozenset(n for n in value if isinstance(n, str) and n)


def _source_scope_from_config(value: Mapping[str, Any], categories: frozenset[str]) -> CategoryScope:
    allow_raw = value.get('source_allow')
    allow = None if allow_raw is None else _names(allow_raw)
    deny = _names(value.get('source_deny'))
    categories_all = value.get('categories_all')
    if (allow_raw is not None and allow is None) or deny is None or not isinstance(categories_all, bool):
        return NOTHING
    return CategoryScope(all=categories_all, categories=frozenset() if categories_all else categories,
                         source_allow=allow, source_deny=deny)


def scope_from_config(value: object) -> CategoryScope | None:
    """The scope a job config carries; None when it carries none (a legacy job).

    A value that is present but malformed fails closed to NOTHING.
    """
    if value is None:
        return None
    if not isinstance(value, Mapping):
        return NOTHING
    if value.get('all') is True:
        return UNRESTRICTED
    names = _names(value.get('categories'))
    if value.get('all') is not False or names is None:
        return NOTHING
    if 'source_deny' in value or 'source_allow' in value:
        return _source_scope_from_config(value, names)
    return CategoryScope(all=False, categories=names)


def intersect_requested(scope: CategoryScope | None, requested: list[str] | None) -> list[str] | None:
    """The category filter a scoped read should apply.

    Returns the requested list unchanged when the scope's CATEGORY rule is
    unrestricted (or there is no scope); otherwise the requested names the scope
    admits, or every scoped name when nothing was requested. An empty list means
    "nothing is visible" — callers must return no items rather than treat it as
    "no filter". The source rule is applied per item (``filter_items``).
    """
    if scope is None or scope.categories_all:
        return requested
    if requested:
        return [name for name in requested if name in scope.categories]
    return sorted(scope.categories)
