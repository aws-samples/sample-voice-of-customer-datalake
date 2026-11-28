"""A reviewed record: an item's decision.md (a change the base branch's registry would refuse) or exemption.md.

Both live in the item's verdict folder and are written like a verdict (verdict.py): front matter ``item``, ``change``,
``proposed_by``, ``reviewer``, ``sha``, ``tree``, then a ``## Reasons`` section. The reviewer is another session than
the one that proposed the change (no shared root), and the sha a commit HEAD descends from (gitio.py); a decision
that covers a change against the base branch also descends from the base branch's commit, so a record never carries
over to a later change of the same words. ``tree`` is informational (the staged tree the reviewer saw). The
``change`` is the program's own words for it, so a record holds for exactly one change:

  decision   ``kind feature -> plumbing``, ``status done -> planned`` (joined by ``; `` when both),
             ``removed``, ``refine -> 7.44.01/a (feature), 7.44.01/b (plumbing)``
  exemption  ``exemption <layer> <kind> <first 12 hex digits of sha256 of its reason>``

``propose-change`` writes a decision record with its proposer and reasons; ``review-change`` fills in its reviewer,
sha and tree (cli.py).
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from . import registry, verdict

DECISION = 'decision.md'
EXEMPTION = 'exemption.md'
FRONT = ('item', 'change', 'proposed_by', 'reviewer', 'sha', 'tree')


def exemption_change(ex: dict[str, object]) -> str:
    reason = hashlib.sha256(str(ex.get('reason', '')).encode('utf-8')).hexdigest()[:12]
    return f'exemption {ex.get("layer")} {ex.get("kind")} {reason}'


def retire_name(test_id: str) -> str:
    """The record that lets a rejected test leave the registry (its change: ``retire <test id>``)."""
    return f'retire-{hashlib.sha256(test_id.encode("utf-8")).hexdigest()[:12]}.md'


def rewrite_name(test_id: str) -> str:
    """The record that clears the rewrite bar after two REJECTs (its change: ``rewrite <test id>``)."""
    return f'rewrite-{hashlib.sha256(test_id.encode("utf-8")).hexdigest()[:12]}.md'


def write(root: Path, rel: str, front: dict[str, str], reasons: str) -> None:
    lines = ['---', *[f'{key}: {front.get(key, "")}' for key in FRONT], '---', '', '## Reasons', '', reasons.strip(), '']
    registry.write_file(root / rel, '\n'.join(lines), root=root)


def read(root: Path, rel: str) -> verdict.Verdict | None:
    v, _ = _read(root, rel)
    return v


def _read(root: Path, rel: str) -> tuple[verdict.Verdict | None, list[str]]:
    v, error = verdict.read_file(root, rel, 'record')
    return v, [error] if error else []


def _who(front: dict[str, str], proposer: str | None, reviewer: str | None) -> list[str]:
    out = []
    got_proposer, got_reviewer = front.get('proposed_by', ''), front.get('reviewer', '')
    if proposer is not None and got_proposer != proposer:
        out.append(f"the record's proposer {got_proposer} is not {proposer}")
    if reviewer is not None and got_reviewer != reviewer:
        out.append(f"the record's reviewer {got_reviewer} is not the session {reviewer}")
    if not registry.is_session(got_proposer) or not registry.is_session(got_reviewer):
        out.append('the record names its proposer and its reviewer by session id')
    elif registry.session_root(got_reviewer) == registry.session_root(got_proposer):
        out.append(f"the reviewer {got_reviewer} shares the proposer {got_proposer}'s root: another session reviews it")
    return out


def problems(root: Path, rel: str, *, item_id: str, change: str, proposer: str | None = None,
             reviewer: str | None = None) -> tuple[list[str], dict[str, str]]:
    """Why the record does not hold for this item and change, and its front matter."""
    v, out = _read(root, rel)
    if v is None:
        return out, {}
    front = v.front
    out = [f'{rel}: missing {key}' for key in FRONT if not front.get(key)]
    if front.get('item') != item_id:
        out.append(f'the record {rel} names {front.get("item")}, not {item_id}')
    if front.get('change') != change:
        out.append(f'the record {rel} says {front.get("change")!r}, not {change!r}')
    out += _who(front, proposer, reviewer)
    if 'sha' in front and not registry.is_sha(front['sha']):
        out.append(f"the record's sha {front['sha']!r} is not a commit sha")
    if 'tree' in front and not registry.TREE_RE.fullmatch(front['tree']):
        out.append(f"the record's tree {front['tree']!r} is not a tree id (git write-tree)")
    if not v.sections.get('Reasons'):
        out.append(f'{rel}: Reasons: empty')
    return out, front
