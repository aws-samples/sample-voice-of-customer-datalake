"""The ratchet: the layers each kind of done item needs, its gaps, and docs/feature-tests/allowed-gaps.json.

What a done item needs (docs/feature-tests/README.md, "What each kind needs"):
  feature       an accepted unit (pytest or vitest) AND an accepted e2e (Playwright)
  fix           an accepted regression test (unit or e2e)
  plumbing      an accepted unit
  no-behaviour  a review: an accepted test or a reviewed exemption
A reviewed exemption of a closing kind (no-user-flow, no-behaviour) closes its own layer (``all``: every layer;
``review`` is closed by any). A ``platform-only`` or ``live-only`` one is "checked elsewhere": listed, it closes nothing.
A planned item needs nothing yet.

The allowed list only shrinks: a gap that is not on it fails (a new gap), a listed gap that is closed fails until
``baseline --shrink`` drops it, and the list may hold nothing the base branch's own list does not. An item refined into
its ``<version>/<slice>`` items (a reviewed decision) hands its allowed gaps to each of them (``expand``).
"""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import registry

ALLOWED = 'docs/feature-tests/allowed-gaps.json'
NEEDS = {'feature': ['unit', 'e2e'], 'fix': ['regression'], 'plumbing': ['unit'], 'no-behaviour': ['review']}
SHRINK = '`python3 scripts/feature_gate.py baseline --shrink`'
Gaps = dict[str, list[str]]
Accepted = Callable[[str, dict[str, Any]], bool]   # (item id, test entry) -> its acceptance holds
Exempted = Callable[[dict[str, Any]], bool]        # item -> its exemption's review holds


def needs(kind: str) -> list[str]:
    return list(NEEDS.get(kind, []))


def _not_reviewed(_item: dict[str, Any]) -> bool:
    return False


def _exemption_closes(item: dict[str, Any], layer: str, exempted: Exempted) -> bool:
    ex = item.get('exemption')
    return (isinstance(ex, dict) and ex.get('kind') in registry.CLOSING_EXEMPTIONS and exempted(item)
            and (ex.get('layer') in (layer, 'all') or layer == 'review'))


def _closed(layer: str, item: dict[str, Any], accepted: Accepted, exempted: Exempted) -> bool:
    if _exemption_closes(item, layer, exempted):
        return True
    item_id = str(item.get('id'))
    units = any(accepted(item_id, e) for e in item.get('unit', []))
    e2es = any(accepted(item_id, e) for e in item.get('e2e', []))
    return {'unit': units, 'e2e': e2es}.get(layer, units or e2es)


def item_gaps(item: dict[str, Any], accepted: Accepted, exempted: Exempted = _not_reviewed) -> list[str]:
    if item.get('status') != 'done':
        return []
    return [layer for layer in needs(str(item.get('kind'))) if not _closed(layer, item, accepted, exempted)]


def elsewhere(item: dict[str, Any]) -> str | None:
    """``platform-only`` / ``live-only`` when the item is checked elsewhere, else None."""
    ex = item.get('exemption')
    kind = ex.get('kind') if isinstance(ex, dict) else None
    return kind if kind in registry.ELSEWHERE else None


def all_gaps(items: list[dict[str, Any]], accepted: Accepted, exempted: Exempted = _not_reviewed) -> Gaps:
    return {str(it['id']): gaps for it in items if (gaps := item_gaps(it, accepted, exempted))}


def count(gaps: Gaps) -> int:
    return sum(len(v) for v in gaps.values())


def _pairs(gaps: Gaps) -> list[tuple[str, str]]:
    return [(item_id, layer) for item_id, layers in gaps.items() for layer in layers]


def expand(gaps: Gaps, refined: dict[str, list[str]]) -> Gaps:
    """The list with each refined item's layers handed to every one of its slice items."""
    out = {k: list(v) for k, v in gaps.items() if k not in refined}
    for item_id, slices in refined.items():
        for sub in slices:
            out.setdefault(sub, list(gaps.get(item_id, [])))
    return {k: v for k, v in out.items() if v}


def compare(current: Gaps, allowed: Gaps, base: Gaps | None) -> list[str]:
    """The ratchet's findings (an empty list passes)."""
    out = [f'{item_id}: new gap {layer} (register an accepted test or a reviewed exemption)'
           for item_id, layer in _pairs(current) if layer not in allowed.get(item_id, [])]
    out += [f'{item_id}: {layer} is no longer a gap; run {SHRINK}'
            for item_id, layer in _pairs(allowed) if layer not in current.get(item_id, [])]
    if base is not None:
        out += [f'{item_id}: allowed gap {layer} is not allowed on the base branch (the list only shrinks)'
                for item_id, layer in _pairs(allowed) if layer not in base.get(item_id, [])]
    return out


def shrink(allowed: Gaps, current: Gaps) -> Gaps:
    """The allowed list without the gaps that closed; never a new one."""
    out: Gaps = {}
    for item_id, layers in allowed.items():
        kept = [layer for layer in layers if layer in current.get(item_id, [])]
        if kept:
            out[item_id] = kept
    return out


def read_allowed(text: str) -> Gaps:
    """The list from its file's text (ValueError when it is not ``{"gaps": {<item>: [<layer>…]}}``)."""
    data = json.loads(text)
    gaps = data.get('gaps') if isinstance(data, dict) else None
    if not isinstance(gaps, dict) or not all(
            isinstance(v, list) and all(isinstance(x, str) for x in v) for v in gaps.values()):
        raise ValueError(f'{ALLOWED}: "gaps" must map each item to a list of layers')
    return {str(k): list(v) for k, v in gaps.items()}


def load_allowed(root: Path) -> Gaps | None:
    path = root / ALLOWED
    return read_allowed(path.read_text(encoding='utf-8')) if path.exists() else None


def save_allowed(root: Path, gaps: Gaps) -> None:
    data = {
        '$comment': 'The roadmap gate\'s allowed gaps (docs/feature-tests/README.md): it only shrinks. Written by '
                    'scripts/feature_gate.py baseline; never add a line by hand.',
        'gaps': {k: gaps[k] for k in sorted(gaps)},
    }
    registry.write_file(root / ALLOWED, json.dumps(data, indent=2) + '\n', root)
