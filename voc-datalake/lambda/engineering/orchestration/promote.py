"""``npm run orchestration:promote-pending``: a card's pending tools and broker operations, once the platform offers them.

A card lists in ``pending_tools`` the tools its SKILL.md names that the harness does not offer its role yet, and in
``pending_broker_ops`` the broker operations the broker does not grant it yet (``validate`` fails once one is offered,
so the card cannot lag behind). This command makes the move: each entry the harness's ``role_specs(role)`` or the
broker's ``permitted(role, op)`` now offers goes into ``tools`` (before the housekeeping tools, report_progress,
save_checkpoint and finish) or ``broker_ops``; the card's template version and its SKILL.md's go up by one; both
bundle copies are compiled again. What is still not offered stays pending. It prints what moved.

The card is edited as text, key by key (the YAML's comments and layout kept): a top-level key's value runs to the
next line that is not indented.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from engineering.connectors.broker import permitted
from engineering.orchestration.compile import compile_bundle, load, render, write
from engineering.orchestration.schema import ROOT, read_yaml
from engineering.runtime.harness.tools import READ_TOOLS, role_specs

#: The tools every role has but its checkout's reads: promoted tools go before them.
HOUSEKEEPING: Final = tuple(spec.name for spec in READ_TOOLS if spec.name not in ('read_file', 'list_files'))
WIDTH: Final = 120
_TEMPLATE_VERSION: Final = re.compile(r'(voc-template-version: )(\d+)')


@dataclass(frozen=True)
class Promoted:
    role: str
    tools: tuple[str, ...]
    broker_ops: tuple[str, ...]
    version: int

    def __str__(self) -> str:
        moved = [*(f'tool {tool}' for tool in self.tools), *(f'broker op {op}' for op in self.broker_ops)]
        return f'{self.role}: {", ".join(moved)} (template version {self.version - 1} -> {self.version})'


def _block(key: str) -> re.Pattern[str]:
    return re.compile(rf'^{re.escape(key)}:.*(?:\n[ \t]+.*)*\n?', re.MULTILINE)


def _flow_list(key: str, values: Sequence[str]) -> str:
    """``key: [a, b, ...]``, wrapped at ``WIDTH`` with its continuation lines under the first value."""
    lines, line, indent = [], f'{key}: [', ' ' * (len(key) + 3)
    for index, value in enumerate(values):
        item = value + (', ' if index + 1 < len(values) else ']')
        if len(line) + len(item.rstrip()) > WIDTH and line.strip():
            lines.append(line.rstrip())
            line = indent
        line += item
    return '\n'.join([*lines, line if values else f'{key}: []']) + '\n'


def set_key(text: str, key: str, values: Sequence[str] | None) -> str:
    """``text`` with its top-level ``key`` set to ``values`` (a flow list), or removed (None)."""
    pattern = _block(key)
    if values is None:
        return pattern.sub('', text, count=1)
    return pattern.sub(lambda _match: _flow_list(key, values), text, count=1)


def _with(tools: Sequence[str], added: Sequence[str]) -> list[str]:
    at = next((index for index, tool in enumerate(tools) if tool in HOUSEKEEPING), len(tools))
    return [*tools[:at], *added, *tools[at:]]


def _promote_card(directory: Path) -> Promoted | None:
    card_file, skill_file = directory / 'agent.yaml', directory / 'SKILL.md'
    card = read_yaml(card_file, directory)
    role, version = str(card['id']), int(card['version'])
    if card.get('harness') == 'learn':
        return None
    offered = {spec.name for spec in role_specs(role)}
    tools = [tool for tool in card.get('pending_tools', []) if tool in offered]
    ops = [op for op in card.get('pending_broker_ops', []) if permitted(role, op)]
    if not tools and not ops:
        return None
    text = card_file.read_text(encoding='utf-8')
    if tools:
        text = set_key(text, 'tools', _with(card['tools'], tools))
        still = [tool for tool in card['pending_tools'] if tool not in tools]
        text = set_key(text, 'pending_tools', still or None)
    if ops:
        text = set_key(text, 'broker_ops', [*card['broker_ops'], *ops])
        still = [op for op in card['pending_broker_ops'] if op not in ops]
        text = set_key(text, 'pending_broker_ops', still or None)
    text = re.sub(r'^version: \d+$', f'version: {version + 1}', text, count=1, flags=re.MULTILINE)
    card_file.write_text(text, encoding='utf-8')
    skill_file.write_text(_TEMPLATE_VERSION.sub(lambda m: f'{m[1]}{version + 1}', skill_file.read_text(encoding='utf-8'),
                                                count=1), encoding='utf-8')
    return Promoted(role, tuple(tools), tuple(ops), version + 1)


def promote(root: Path = ROOT) -> tuple[Promoted, ...]:
    """Every card's promotions under ``root``, written, and the bundle compiled again when any moved."""
    moved = tuple(found for directory in sorted((root / 'agents').iterdir())
                  if directory.is_dir() and (found := _promote_card(directory)) is not None)
    if moved:
        write(render(compile_bundle(load(root))), root)
    return moved
