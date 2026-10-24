"""The names a model sees for categories, subcategories and sources — never their ids.

Model-written text (research reports, PRDs, PR/FAQs, personas, memories) repeats what
its prompt says. A prompt that says ``software_firmware`` or ``web_trustpilot_acme``
gets a document that says it too, so every prompt that lists feedback names a category,
subcategory and source the way the dashboard does (``shared.display_labels``) and carries
``LABEL_INSTRUCTION``. Ids stay where code needs them (queries, filters, citations).

Pure (no I/O) so ``shared.feedback`` can import it; ``shared.prompt_labels_store.load_prompt_labels``
reads the config, best effort: the category config (``shared.api``'s 5-minute
cache) and the source profiles (one item read) are read
from ``AGGREGATES_TABLE`` when it is set; without it, or on any error, the labels are the
humanised ids (``ease_of_use`` → ``Ease of use``) — still never a raw id.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared.display_labels import category_label, source_label, subcategory_label

__all__ = ['LABEL_INSTRUCTION', 'PromptLabels']

LABEL_INSTRUCTION: Final = (
    'Refer to categories, subcategories and sources by these names, never by their ids.'
)


@dataclass(frozen=True)
class PromptLabels:
    """The category config and source profiles a prompt's labels are read from (empty = humanised ids)."""

    categories: Sequence[Mapping[str, Any]] = field(default_factory=tuple)
    profiles: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    def category(self, category_id: object) -> str:
        return category_label(str(category_id or 'other'), self.categories)

    def subcategory(self, sub_id: object, parent: object = None) -> str:
        return subcategory_label(str(sub_id), str(parent) if parent else None, self.categories) if sub_id else ''

    def source(self, source_id: object) -> str:
        return source_label(str(source_id or 'unknown'), self.profiles)
