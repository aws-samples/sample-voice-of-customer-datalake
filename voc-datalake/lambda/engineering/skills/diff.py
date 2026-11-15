"""What changed between two versions of a skill, for a person to read, and the one line that announces it.

``diff`` is stable (the same two versions always give the same diff, in the order the lines appear) and made from
the records alone: the instructions line by line (lines added and removed, in order; blank lines are not counted),
the examples one by one, the tools the policy adds and drops, and the model and harness when they move. ``summary``
is the announcement's line ("Fixer rewrote its skill: v7 → v8, two more examples, one more instruction line"),
made from the diff by rule, never by a model; it carries counts, tool names and model ids, never the skill's text,
and fits a bus message's summary.
"""
from __future__ import annotations

from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Final, Literal

from engineering.bus.schema import MAX_SUMMARY_BYTES
from engineering.skills.model import Example, SkillContent, SkillError

#: The agent catalog's names (docs/autonomous-engineering.md, "The agent catalog"), by role.
ROLE_NAMES: Final[Mapping[str, str]] = {
    'mapper': 'Mapper', 'understander': 'Issue understander', 'hunter': 'Bug hunter', 'fixer': 'Fixer',
    'builder': 'Feature builder', 'committer': 'Committer', 'commit-reviewer': 'Commit reviewer',
    'gate-runner': 'Gate runner', 'pr-author': 'PR author', 'pr-reviewer': 'PR reviewer', 'final-go': 'Final go',
    'coordinator': 'Run coordinator', 'coach': 'Coach',
}
_WORDS: Final = ('no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten')
Op = Literal['+', '-']
Event = Literal['proposed', 'accepted', 'rolled_back']


@dataclass(frozen=True)
class SkillDiff:
    """``instructions`` and ``examples``: each change in order, ``-`` (removed) or ``+`` (added). ``model`` and
    ``harness``: (from, to) when it moved, ``from`` empty for a first version."""

    instructions: tuple[tuple[Op, str], ...] = ()
    examples: tuple[tuple[Op, Example], ...] = ()
    tools_added: tuple[str, ...] = ()
    tools_removed: tuple[str, ...] = ()
    tools_reordered: bool = False
    model: tuple[str, str] | None = None
    harness: tuple[str, str] | None = None
    first: bool = False

    def count(self, part: Literal['instructions', 'examples'], op: Op) -> int:
        changes: Sequence[tuple[Op, object]] = getattr(self, part)
        return sum(1 for change, _ in changes if change == op)

    @property
    def empty(self) -> bool:
        return not (self.instructions or self.examples or self.tools_added or self.tools_removed
                    or self.tools_reordered or self.model or self.harness)


def _changes[T: Hashable](base: Sequence[T], new: Sequence[T]) -> list[tuple[Op, T]]:
    out: list[tuple[Op, T]] = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(a=base, b=new, autojunk=False).get_opcodes():
        if tag != 'equal':
            out.extend(('-', item) for item in base[i1:i2])
            out.extend(('+', item) for item in new[j1:j2])
    return out


def _lines(text: str) -> list[str]:
    """The non-blank lines: a blank line added or removed is layout, not a change a person reviews."""
    return [line.rstrip() for line in text.splitlines() if line.strip()]


def diff(base: SkillContent | None, new: SkillContent) -> SkillDiff:
    """What ``new`` changes from ``base`` (None: a first version, everything added)."""
    instructions = tuple(_changes(_lines(base.instructions) if base else [], _lines(new.instructions)))
    examples = tuple(_changes(base.examples if base else (), new.examples))
    old_tools = base.tool_policy if base else ()
    added = tuple(name for name in new.tool_policy if name not in old_tools)
    removed = tuple(name for name in old_tools if name not in new.tool_policy)
    reordered = not added and not removed and old_tools != new.tool_policy and base is not None
    model = (base.model if base else '', new.model) if base is None or base.model != new.model else None
    harness = (base.harness if base else '', new.harness) if base is None or base.harness != new.harness else None
    return SkillDiff(instructions, examples, added, removed, reordered, model, harness, first=base is None)


def render(change: SkillDiff) -> str:
    """The diff as a person reads it: one line per change, ``-`` removed and ``+`` added."""
    if change.empty:
        return 'No change.'
    out: list[str] = []
    if change.instructions:
        out += ['Instructions:', *(f'{op} {line}' for op, line in change.instructions)]
    if change.examples:
        out += ['Examples:', *(f'{op} When: {e.situation} | Do: {e.action}' for op, e in change.examples)]
    if change.tools_added or change.tools_removed or change.tools_reordered:
        tools = [f'+ {name}' for name in change.tools_added] + [f'- {name}' for name in change.tools_removed]
        out.append('Tool policy: ' + (', '.join(tools) if tools else 'the same tools, reordered'))
    for name, moved in (('Model', change.model), ('Harness', change.harness)):
        if moved:
            out.append(f'{name}: {moved[0] or "(none)"} → {moved[1]}')
    return '\n'.join(out)


def to_json(change: SkillDiff) -> dict[str, Any]:
    return {'instructions': [[op, line] for op, line in change.instructions],
            'examples': [[op, {'situation': e.situation, 'action': e.action}] for op, e in change.examples],
            'tools_added': list(change.tools_added), 'tools_removed': list(change.tools_removed),
            'tools_reordered': change.tools_reordered,
            'model': list(change.model) if change.model else None,
            'harness': list(change.harness) if change.harness else None, 'first': change.first}


def _op(value: object) -> Op:
    if value == '+':
        return '+'
    if value == '-':
        return '-'
    raise SkillError('a stored diff is not readable')


def _pair(value: object) -> tuple[str, str] | None:
    if value is None:
        return None
    if isinstance(value, list) and len(value) == 2 and all(isinstance(v, str) for v in value):
        return str(value[0]), str(value[1])
    raise SkillError('a stored diff is not readable')


def from_json(data: Mapping[str, Any]) -> SkillDiff:
    try:
        return SkillDiff(
            instructions=tuple((_op(op), str(line)) for op, line in data['instructions']),
            examples=tuple((_op(op), Example(str(e['situation']), str(e['action']))) for op, e in data['examples']),
            tools_added=tuple(str(name) for name in data['tools_added']),
            tools_removed=tuple(str(name) for name in data['tools_removed']),
            tools_reordered=bool(data['tools_reordered']), model=_pair(data['model']),
            harness=_pair(data['harness']), first=bool(data['first']))
    except (KeyError, TypeError, ValueError) as exc:
        raise SkillError('a stored diff is not readable') from exc


def _number(n: int) -> str:
    return _WORDS[n] if n < len(_WORDS) else str(n)


def _counted(n: int, noun: str) -> str:
    return f'{_number(n)} {noun}{"" if n == 1 else "s"}'


def _more_or_fewer(added: int, removed: int, noun: str) -> list[str]:
    if added and removed:
        return [f'{_counted(added, noun)} added and {_number(removed)} removed']
    if added:
        return [f'{_number(added)} more {noun}{"" if added == 1 else "s"}']
    if removed:
        return [f'{_counted(removed, noun)} fewer']
    return []


def _parts(change: SkillDiff) -> list[str]:
    if change.first:
        return ['its first version']
    if change.empty:
        return ['the same skill']
    parts = _more_or_fewer(change.count('examples', '+'), change.count('examples', '-'), 'example')
    parts += _more_or_fewer(change.count('instructions', '+'), change.count('instructions', '-'), 'instruction line')
    tools = []
    if change.tools_added:
        tools.append('adds ' + ', '.join(change.tools_added))
    if change.tools_removed:
        tools.append('drops ' + ', '.join(change.tools_removed))
    if tools:
        parts.append('the tool policy ' + ' and '.join(tools))
    elif change.tools_reordered:
        parts.append('the tool policy reordered')
    parts += [f'the {name} {moved[0]} → {moved[1]}' for name, moved in (('model', change.model),
                                                                       ('harness', change.harness)) if moved]
    return parts


def summary(role: str, event: Event, from_label: str, to_label: str, change: SkillDiff, *,
            restores: int = 0, scope: str = '') -> str:
    """The announcement's one line: who, what happened, from → to, then what changed (counts and names only).
    ``from_label`` is empty when there was no version before; ``scope`` names a connection's own skill."""
    name = ROLE_NAMES.get(role)
    if name is None:
        raise SkillError('not an agent role')
    where = f' for {scope}' if scope else ''
    head = {'proposed': f'{name} skill{where} proposed', 'accepted': f'{name} rewrote its skill{where}',
            'rolled_back': f'{name} rolled its skill{where} back to v{restores}'}[event]
    head += f': {from_label} → {to_label}' if from_label else f': {to_label}'
    parts = _parts(change)
    line = ', '.join([head, *parts])
    while len(line.encode('utf-8')) > MAX_SUMMARY_BYTES and parts:
        parts.pop()
        line = ', '.join([head, *parts, 'and more'])
    return line
