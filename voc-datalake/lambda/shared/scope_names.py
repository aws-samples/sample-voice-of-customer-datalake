"""Category NAMES a restricted reader must not be shown, and the text that names them.

``shared.category_access`` decides which reviews a caller sees by their category id. Text
that people or the model wrote — a memory statement, a company objective, the vision — has
no category id, yet it can still name another category ("Hardware Quality complaints doubled").
The owner's rule (2026-10-21) is that a restricted caller never sees another category's
reviews, counts or NAMES, so such text is withheld from them.

Provenance comes first: a memory's ``categories`` tags are checked by
``memory_store.visible_to``. This module is the fallback for text without (or beyond) its
tags: it lists the configured categories the scope does NOT admit and matches their names —
the stored id and its display label (``shared.display_labels``), plus the ids and labels of
their subcategories — case-insensitively and word-bounded, with any run of separators
(space, ``_``, ``-``, ``/``, ``&``, ``+``, ``,`` or "and") between the words, so
``software_firmware``, "Software & Firmware" and "software/firmware" all match one name.

Not matched, on purpose:

- the fallback category ``other`` (its name is an ordinary word, not another team's area);
- a name that a VISIBLE category also uses (the reader may see it anyway);
- names shorter than ``MIN_NAME_CHARS`` letters.

A one-word name ("Pricing") matches that word anywhere: the rule errs towards hiding a
statement from a restricted reader rather than leaking a name. Admins and unrestricted
callers get ``None`` and see everything unchanged.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.category_access import FALLBACK_CATEGORY, CategoryScope, admits
from shared.category_gate import read_categories_config
from shared.display_labels import category_label, mapping_entries, subcategory_label

__all__ = [
    'HIDE_ALL',
    'HiddenNames',
    'hidden_names_for',
    'named_category_ids',
    'scoped_company_context',
    'scoped_design_system',
]

MIN_NAME_CHARS: Final = 3
_WORD: Final = re.compile(r'[^\W_]+', re.UNICODE)
_CONNECTORS: Final = frozenset({'and'})
# Between two words of a name: separators, optionally around an "and".
_SEPARATOR: Final = r'(?:[\s_/&+,\-]+(?:and[\s_/&+,\-]+)?)'

#: The token lists of an extracted design system (shared/extracted_design.py reads them from here).
DESIGN_TOKEN_GROUPS: Final = ('colors', 'typography', 'spacing', 'radius')


def _name(entry: Mapping[str, Any]) -> str:
    value = entry.get('name')
    return value if isinstance(value, str) else ''


def _words(text: str) -> tuple[str, ...]:
    return tuple(word for word in _WORD.findall(text.casefold()) if word not in _CONNECTORS)


def _category_terms(entry: Mapping[str, Any], config: list[Mapping[str, Any]]) -> set[tuple[str, ...]]:
    """Every name one category goes by: id, label, and its subcategories' ids and labels."""
    name = _name(entry)
    texts = [name, category_label(name, config)]
    for sub in mapping_entries(entry.get('subcategories')):
        sub_name = _name(sub)
        if sub_name:
            texts += [sub_name, subcategory_label(sub_name, name, config)]
    return {words for words in map(_words, texts) if words and len(''.join(words)) >= MIN_NAME_CHARS}


def _pattern(terms: Iterable[tuple[str, ...]]) -> re.Pattern[str] | None:
    # Longest first, so "hardware quality" wins over a shorter name inside it.
    alternatives = sorted({_SEPARATOR.join(map(re.escape, words)) for words in terms}, key=len, reverse=True)
    if not alternatives:
        return None
    return re.compile(rf'(?<![^\W_])(?:{"|".join(alternatives)})(?![^\W_])', re.IGNORECASE | re.UNICODE)


@dataclass(frozen=True)
class HiddenNames:
    """The names of the categories one reader may not see (``pattern`` None = none configured).

    ``everything`` is the fail-closed value (``HIDE_ALL``): used when the categories config
    cannot be read, so every non-empty text counts as naming a hidden category.
    """

    pattern: re.Pattern[str] | None
    everything: bool = False

    @property
    def hides_nothing(self) -> bool:
        return self.pattern is None and not self.everything

    def named_in(self, text: object) -> bool:
        """True when ``text`` names a hidden category."""
        if not isinstance(text, str):
            return False
        if self.everything:
            return bool(text.strip())
        return bool(self.pattern and self.pattern.search(text))


#: Hide every statement (the categories config could not be read).
HIDE_ALL: Final = HiddenNames(None, everything=True)


def hidden_names(scope: CategoryScope | None, categories_config: object) -> HiddenNames | None:
    """The hidden category names for ``scope``; None when its category rule hides nothing.

    ``categories_config`` is the stored categories list (entries checked, not trusted).
    """
    if scope is None or scope.categories_all:
        return None
    config = mapping_entries(categories_config)
    visible: set[tuple[str, ...]] = set()
    hidden: set[tuple[str, ...]] = set()
    for entry in config:
        name = _name(entry)
        if not name or name == FALLBACK_CATEGORY:
            continue
        (visible if admits(scope, name) else hidden).update(_category_terms(entry, config))
    return HiddenNames(_pattern(hidden - visible))


def hidden_names_for(scope: CategoryScope | None, aggregates_table: Any) -> HiddenNames | None:
    """``hidden_names`` against the stored categories config, read strongly.

    Raises ``ServiceError`` when the config cannot be read (callers fail closed: a route
    answers 500, prompt grounding uses ``HIDE_ALL``). No read for an unrestricted scope.
    """
    if scope is None or scope.categories_all:
        return None
    return hidden_names(scope, read_categories_config(aggregates_table))


def named_category_ids(text: object, categories_config: object) -> list[str]:
    """Configured category ids whose names ``text`` contains, in config order.

    Used to TAG a memory with the categories its statement names, so provenance (the tags)
    carries the access rule even where the model left the tags out. ``other`` is never tagged.
    """
    if not isinstance(text, str) or not text.strip():
        return []
    config = mapping_entries(categories_config)
    named: list[str] = []
    for entry in config:
        name = _name(entry)
        pattern = _pattern(_category_terms(entry, config)) if name and name != FALLBACK_CATEGORY else None
        if pattern is not None and pattern.search(text) and name not in named:
            named.append(name)
    return named


# ── Company context (vision + objectives) ────────────────────────────────────
_PARAGRAPH_BREAK: Final = re.compile(r'\n\s*\n')


def _without_named_paragraphs(text: str, hidden: HiddenNames) -> str:
    """``text`` without the paragraphs that name a hidden category (unchanged when none does)."""
    if not hidden.named_in(text):
        return text
    kept = [part for part in _PARAGRAPH_BREAK.split(text) if not hidden.named_in(part)]
    return '\n\n'.join(part.strip() for part in kept if part.strip())


def _objective_text(objective: Mapping[str, Any]) -> str:
    return ' '.join(str(objective.get(key) or '') for key in ('title', 'description'))


def scoped_company_context(company: Mapping[str, Any], hidden: HiddenNames | None) -> dict[str, Any]:
    """``company`` (vision + objectives) without what names a hidden category.

    A vision paragraph that names one is dropped (the rest is kept); an objective whose title
    or description names one is dropped whole. ``hidden`` None returns an unchanged copy.
    """
    result = dict(company)
    if hidden is None or hidden.hides_nothing:
        return result
    vision = company.get('vision')
    if isinstance(vision, str):
        result['vision'] = _without_named_paragraphs(vision, hidden)
    objectives = company.get('objectives')
    if isinstance(objectives, list):
        result['objectives'] = [o for o in objectives
                                if not (isinstance(o, Mapping) and hidden.named_in(_objective_text(o)))]
    return result


# ── Design system (tokens + guidelines + reference summaries) ────────────────


def _names_hidden(entry: object, hidden: HiddenNames) -> bool:
    """True when any text field of a token / reference entry names a hidden category."""
    if not isinstance(entry, Mapping):
        return False
    return any(hidden.named_in(value) for value in entry.values() if isinstance(value, str))


def _scoped_tokens(tokens: object, hidden: HiddenNames) -> object:
    if not isinstance(tokens, Mapping):
        return tokens
    return {key: [e for e in value if not _names_hidden(e, hidden)]
            if key in DESIGN_TOKEN_GROUPS and isinstance(value, list) else value
            for key, value in tokens.items()}


def scoped_design_system(design: Mapping[str, Any], hidden: HiddenNames | None) -> dict[str, Any]:
    """``design`` without what names a hidden category — the company-context rule applied to design text.

    A guidelines paragraph that names one is dropped (the rest is kept); a token entry, a
    component (name, description, variant names) or a reference whose title, url or extracted
    summary names one is dropped whole. Colours, fonts
    and lengths themselves never match (no letters long enough to be a category name, or plain
    CSS words), so an ordinary design system passes through unchanged. ``hidden`` None returns
    an unchanged copy.
    """
    result = dict(design)
    if hidden is None or hidden.hides_nothing:
        return result
    result['tokens'] = _scoped_tokens(design.get('tokens'), hidden)
    guidelines = design.get('guidelines')
    if isinstance(guidelines, str):
        result['guidelines'] = _without_named_paragraphs(guidelines, hidden)
    references = design.get('references')
    if isinstance(references, list):
        result['references'] = [r for r in references if not _names_hidden(r, hidden)]
    components = design.get('components')
    if isinstance(components, list):
        result['components'] = [c for c in components if not component_names_hidden(c, hidden)]
    return result


def component_names_hidden(component: object, hidden: HiddenNames) -> bool:
    """True when a design component's name, description or a variant name names a hidden category."""
    if not isinstance(component, Mapping):
        return False
    texts = [component.get('name'), component.get('description')]
    variants = component.get('variants')
    if isinstance(variants, list):
        texts.extend(v.get('name') for v in variants if isinstance(v, Mapping))
    return any(isinstance(text, str) and hidden.named_in(text) for text in texts)
