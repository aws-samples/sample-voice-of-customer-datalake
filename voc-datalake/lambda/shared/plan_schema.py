"""Plan mode: the ``voc-plan/1`` validator for the Agents API and the conductor.

Mirrors ``lambda/stream/src/assistant/plan/{schema,validate}.ts`` (docs/assistant-plan-mode.md).
Python cannot import the TypeScript, so the tables — limits, patterns, tool → pack, admin-only
tools, never-pre-approvable tools, free-text fields — come from ``plan_contract.json``, which is
GENERATED from the TypeScript contract (regenerate with the command in its ``$comment``; a test on
each side pins it). The shared fixtures in ``test/fixtures/plans/`` are validated here and by both
TypeScript validators.

:func:`validate_plan` applies rules 1-5 of ``validate.ts`` (shape, limits and size, ids and the
dependency graph, packs/tools/admin gating, placeholders). It does NOT check literal arguments
against each tool's schema (rule 6, zod-only): the stream validated them when it proposed the plan,
and every write is re-validated by its REST route when it runs. Errors are
``{'step'?, 'field'?, 'message'}`` with the same ``step``/``field`` as TypeScript; messages may differ.

String bounds follow zod: lengths in UTF-16 code units after JavaScript ``trim()`` where the TS
schema trims, and the returned plan carries the trimmed strings, as ``planSchema.parse`` does.
Regexes are compiled with ``re.ASCII`` so ``\\d``/``\\w`` mean what they mean in JavaScript.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from shared.plan_canonical import CanonicalJsonError, canonical_json, js_length, js_trim

CONTRACT: Final[dict[str, Any]] = json.loads(Path(__file__).with_name('plan_contract.json').read_text(encoding='utf-8'))

PLAN_SCHEMA: Final[str] = CONTRACT['schema']
PLAN_LIMITS: Final[dict[str, int]] = CONTRACT['limits']
FIELD_LIMITS: Final[dict[str, int]] = CONTRACT['field_limits']
PLAN_STEP_STATUSES: Final[tuple[str, ...]] = tuple(CONTRACT['step_statuses'])
PLAN_STATUSES: Final[tuple[str, ...]] = tuple(CONTRACT['plan_statuses'])
NEVER_PREAPPROVABLE_TOOLS: Final[frozenset[str]] = frozenset(CONTRACT['never_preapprovable_tools'])
CARD_ONLY_WRITE_TOOLS: Final[frozenset[str]] = frozenset(CONTRACT['card_only_write_tools'])
FREE_TEXT_FIELDS: Final[dict[str, list[str]]] = CONTRACT['free_text_fields']
PACKS: Final[tuple[str, ...]] = tuple(CONTRACT['packs'])
ADMIN_ONLY_PACKS: Final[frozenset[str]] = frozenset(CONTRACT['admin_only_packs'])
WRITE_TOOLS: Final[dict[str, list[str]]] = CONTRACT['write_tools']
ADMIN_ONLY_WRITE_TOOLS: Final[frozenset[str]] = frozenset(CONTRACT['admin_only_write_tools'])
# Packs holding an admin-only read tool (``get_source_run``, ``analyze_scraper_url``, the user listings).
ADMIN_READ_PACKS: Final[frozenset[str]] = frozenset(CONTRACT['admin_read_packs'])
FREE_PLACEHOLDER: Final[str] = CONTRACT['free_placeholder']
# The output a think step's answer is keyed under when it declares no ``produces``.
THINK_DEFAULT_OUTPUT: Final[str] = CONTRACT['think_default_output']

_PATTERNS: Final = {name: re.compile(source, re.ASCII) for name, source in CONTRACT['patterns'].items()}
PLAN_ID_RE: Final = _PATTERNS['plan_id']
_STEP_ID_RE: Final = _PATTERNS['step_id']
_OUTPUT_RE: Final = _PATTERNS['output_name']
_REFERENCE_RE: Final = _PATTERNS['reference']
_WAIT_VALUE_RE: Final = _PATTERNS['wait_value']
_SOURCE_RE: Final = _PATTERNS['source_id']

_STEP_KINDS: Final = frozenset(CONTRACT['step_kinds'])
_STEP_BASE_KEYS: Final = frozenset({'id', 'pack', 'title', 'after', 'produces', 'kind'})
_WAIT_FIELDS: Final = {
    'source_run': ('source', 'execution_id'),
    'project_job': ('project_id', 'job_id'),
    'scraper_run': ('scraper_id', 'execution_id'),
}
_TOOL_NAME_MAX: Final = 64

PlanError = dict[str, str]  # pragma: no mutate  type alias, only read by deferred annotations


def is_plan_id(value: object) -> bool:
    """``pl_<12 hex>`` — never an agent id (``ag_…``)."""
    return isinstance(value, str) and PLAN_ID_RE.fullmatch(value) is not None


def _error(message: str, step: str | None = None, field: str | None = None) -> PlanError:
    error = {'message': message}
    if step is not None:
        error['step'] = step
    if field:
        error['field'] = field
    return error


# ── Shape (planSchema) ────────────────────────────────────────────────────


class _Shape:
    """Collects shape errors for one step (or the plan) while normalising it."""

    def __init__(self, step: str | None) -> None:
        self.step = step
        self.errors: list[PlanError] = []

    def fail(self, field: str | None, message: str) -> None:
        self.errors.append(_error(message, self.step, field))

    def text(self, value: object, field: str, max_chars: int) -> str | None:
        if not isinstance(value, str):
            self.fail(field, 'must be a string')
            return None
        text = js_trim(value)
        if not 1 <= js_length(text) <= max_chars:
            self.fail(field, f'must be 1-{max_chars} characters')
            return None
        return text

    def strict_keys(self, value: Mapping[str, Any], allowed: frozenset[str] | set[str], field: str | None) -> None:
        if set(value) - set(allowed):
            self.fail(field, f'unknown keys: {", ".join(sorted(set(value) - set(allowed)))}')

    def pattern_list(self, value: object, field: str, pattern: re.Pattern[str], max_items: int) -> None:
        if value is None:
            return
        if not isinstance(value, list) or len(value) > max_items:
            self.fail(field, f'must be a list of at most {max_items}')
            return
        for index, item in enumerate(value):
            if not isinstance(item, str) or pattern.fullmatch(item) is None:
                self.fail(f'{field}.{index}', 'invalid value')


def _optional_timeout(shape: _Shape, wait: Mapping[str, Any]) -> None:
    timeout = wait.get('timeout_minutes')
    if timeout is None:
        return
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= FIELD_LIMITS['waitTimeoutMinutesMax']:
        shape.fail('wait.timeout_minutes', 'must be a whole number of minutes')


def _wait_shape(shape: _Shape, wait: object) -> None:
    if not isinstance(wait, dict):
        shape.fail('wait', 'must be an object')
        return
    wait_for = wait.get('for')
    fields = _WAIT_FIELDS.get(wait_for) if isinstance(wait_for, str) else None
    if fields is None:
        shape.fail('wait.for', f'must be one of {", ".join(_WAIT_FIELDS)}')
        return
    shape.strict_keys(wait, {'for', 'timeout_minutes', *fields}, 'wait')
    for name in fields:
        value = wait.get(name)
        pattern = _SOURCE_RE if name == 'source' else _WAIT_VALUE_RE
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            shape.fail(f'wait.{name}', 'must be an id or a {{step.output}} reference')
    _optional_timeout(shape, wait)


def _write_shape(shape: _Shape, write: object) -> None:
    if not isinstance(write, dict):
        shape.fail('write', 'must be an object')
        return
    shape.strict_keys(write, {'tool', 'args'}, 'write')
    tool = write.get('tool')
    if not isinstance(tool, str) or not 1 <= js_length(tool) <= _TOOL_NAME_MAX:
        shape.fail('write.tool', 'must be a tool name')
    args = write.get('args')
    if not isinstance(args, dict):
        shape.fail('write.args', 'must be an object')
        return
    for key in args:
        if not isinstance(key, str) or not 1 <= js_length(key) <= FIELD_LIMITS['argKeyChars']:
            shape.fail(f'write.args.{key}', 'invalid argument name')


def _think_shape(shape: _Shape, think: object) -> dict[str, Any] | None:
    if not isinstance(think, dict):
        shape.fail('think', 'must be an object')
        return None
    shape.strict_keys(think, {'brief'}, 'think')
    return {**think, 'brief': shape.text(think.get('brief'), 'think.brief', FIELD_LIMITS['briefChars'])}


def _payload_shape(shape: _Shape, kind: str, step: Mapping[str, Any], normalised: dict[str, Any]) -> None:
    payload = step.get(kind)
    if kind == 'write':
        _write_shape(shape, payload)
    elif kind == 'wait':
        _wait_shape(shape, payload)
    else:
        normalised['think'] = _think_shape(shape, payload)


def _step_shape(raw: object, index: int) -> tuple[dict[str, Any] | None, list[PlanError]]:
    if not isinstance(raw, dict):
        return None, [_error('must be an object', None, f'steps.{index}')]
    step_id = raw.get('id') if isinstance(raw.get('id'), str) else None
    shape = _Shape(step_id)
    kind = raw.get('kind')
    if not isinstance(kind, str) or kind not in _STEP_KINDS:
        shape.fail('kind' if step_id else f'steps.{index}.kind', 'must be write, wait or think')
        return None, shape.errors
    shape.strict_keys(raw, _STEP_BASE_KEYS | {kind}, None)
    if step_id is None or _STEP_ID_RE.fullmatch(step_id) is None:
        shape.fail('id' if step_id else f'steps.{index}.id', 'must be s<digits>')
    if raw.get('pack') not in PACKS:
        shape.fail('pack', 'unknown pack')
    normalised = dict(raw)
    normalised['title'] = shape.text(raw.get('title'), 'title', FIELD_LIMITS['titleChars'])
    shape.pattern_list(raw.get('after'), 'after', _STEP_ID_RE, FIELD_LIMITS['afterItems'])
    shape.pattern_list(raw.get('produces'), 'produces', _OUTPUT_RE, FIELD_LIMITS['producesItems'])
    _payload_shape(shape, kind, raw, normalised)
    return normalised, shape.errors


def _plan_shape(raw: object) -> tuple[dict[str, Any] | None, list[PlanError]]:
    shape = _Shape(None)
    if not isinstance(raw, dict):
        shape.fail(None, 'a plan must be a JSON object')
        return None, shape.errors
    shape.strict_keys(raw, {'schema', 'goal', 'steps'}, None)
    if raw.get('schema') != PLAN_SCHEMA:
        shape.fail('schema', f'must be {PLAN_SCHEMA}')
    goal = shape.text(raw.get('goal'), 'goal', FIELD_LIMITS['goalChars'])
    steps = raw.get('steps')
    if not isinstance(steps, list) or not 1 <= len(steps) <= PLAN_LIMITS['steps']:
        shape.fail('steps', f'must be 1-{PLAN_LIMITS["steps"]} steps')
        return None, shape.errors
    results = [_step_shape(step, index) for index, step in enumerate(steps)]
    errors = shape.errors + [error for _, step_errors in results for error in step_errors]
    return {**raw, 'goal': goal, 'steps': [step for step, _ in results]}, errors


# ── Cross-step rules (validate.ts 2-5) ─────────────────────────────────────


def _limit_errors(plan: Mapping[str, Any]) -> list[PlanError]:
    kinds = [step['kind'] for step in plan['steps']]
    errors = [_error(f'at most {PLAN_LIMITS[key]} {kind} steps', None, 'steps')
              for kind, key in (('write', 'writes'), ('wait', 'waits'), ('think', 'thinks'))
              if kinds.count(kind) > PLAN_LIMITS[key]]
    try:
        size = js_length(canonical_json(plan))
    except CanonicalJsonError:
        return [*errors, _error('the plan contains text that is not valid Unicode')]
    if size > FIELD_LIMITS['planJsonChars']:
        errors.append(_error(f'the plan is {size} characters of JSON; the limit is {FIELD_LIMITS["planJsonChars"]}'))
    return errors


def _duplicates(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for index, value in enumerate(values) if value in values[:index]))


def _layer(steps: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(steps in dependency order, steps that can never become ready)."""
    ordered: list[dict[str, Any]] = []
    pending = list(steps)
    while True:
        done = {step['id'] for step in ordered}
        ready = [step for step in pending if all(dep in done for dep in step.get('after') or [])]
        if not ready:
            return ordered, pending
        ordered += ready
        pending = [step for step in pending if step not in ready]


def _graph_errors(plan: Mapping[str, Any]) -> list[PlanError]:
    steps = plan['steps']
    ids = [step['id'] for step in steps]
    errors = [_error(f'step id {sid} is used more than once', sid, 'id') for sid in _duplicates(ids)]
    for step in steps:
        for dep in step.get('after') or []:
            if dep == step['id'] or dep not in ids:
                message = 'a step cannot run after itself' if dep == step['id'] else f'unknown step {dep}'
                errors.append(_error(message, step['id'], 'after'))
        errors += [_error(f'output {name} is declared twice', step['id'], 'produces')
                   for name in _duplicates(list(step.get('produces') or []))]
    if errors:
        return errors
    return [_error('the step is on or behind a dependency cycle', step['id'], 'after') for step in _layer(steps)[1]]


def _ancestors(steps: list[dict[str, Any]]) -> dict[str, set[str]]:
    known: dict[str, set[str]] = {}
    for step in _layer(steps)[0]:
        parents = step.get('after') or []
        known[step['id']] = {*parents, *(grand for parent in parents for grand in known.get(parent, set()))}
    return known


def _pack_errors(step: Mapping[str, Any], is_admin: bool, packs_allowed: frozenset[str]) -> list[PlanError]:
    pack = step['pack']
    if pack not in packs_allowed or (pack in ADMIN_ONLY_PACKS and not is_admin):
        return [_error(f'pack {pack} is not available to you', step['id'], 'pack')]
    if step['kind'] != 'write':
        return []
    tool = step['write']['tool']
    if tool not in WRITE_TOOLS.get(pack, []):
        return [_error(f'{tool} is not a write tool of pack {pack}', step['id'], 'write.tool')]
    if tool in ADMIN_ONLY_WRITE_TOOLS and not is_admin:
        return [_error(f'{tool} is only available to administrators', step['id'], 'write.tool')]
    return []


def _leaves(value: object, path: tuple[str | int, ...] = ()) -> list[tuple[tuple[str | int, ...], str]]:
    """Every placeholder-bearing string under ``value``: (path, string)."""
    if isinstance(value, str):
        return [(path, value)] if '{{' in value or '}}' in value else []
    if isinstance(value, list):
        return [leaf for index, item in enumerate(value) for leaf in _leaves(item, (*path, index))]
    if isinstance(value, dict):
        return [leaf for key, member in value.items() for leaf in _leaves(member, (*path, key))]
    return []


def _dotted(path: tuple[str | int, ...]) -> str:
    return '.'.join(str(part) for part in path)


def _is_free_field(tool: str | None, path: tuple[str | int, ...]) -> bool:
    if any(isinstance(part, int) for part in path):
        return False
    return tool is not None and _dotted(path) in FREE_TEXT_FIELDS.get(tool, [])


def _reference_error(step_id: str, target_id: str, output: str, tool: str | None, path: tuple[str | int, ...],
                     facts: tuple[Mapping[str, Mapping[str, Any]], Mapping[str, set[str]]]) -> str | None:
    by_id, ancestors = facts
    target = by_id.get(target_id)
    if target is None or target_id not in ancestors.get(step_id, set()):
        return f'{{{{{target_id}.{output}}}}} must name a step this one runs after'
    if output not in (target.get('produces') or []):
        return f'step {target_id} does not produce {output}'
    if target['kind'] == 'think' and not _is_free_field(tool, path):
        return f'the text output of think step {target_id} may only fill a free-text field'
    return None


def _leaf_error(step: Mapping[str, Any], path: tuple[str | int, ...], value: str, tool: str | None,
                facts: tuple[Mapping[str, Mapping[str, Any]], Mapping[str, set[str]]]) -> str | None:
    if value == FREE_PLACEHOLDER:
        return None if _is_free_field(tool, path) else '{{free}} is only allowed on a free-text field of the tool'
    match = _REFERENCE_RE.fullmatch(value)
    if match is None:
        return 'a value containing {{ or }} must be exactly {{free}} or {{s<n>.<output>}}'
    return _reference_error(step['id'], match.group(1), match.group(2), tool, path, facts)


def _placeholder_errors(step: Mapping[str, Any], facts: tuple[Mapping[str, Mapping[str, Any]], Mapping[str, set[str]]]) -> list[PlanError]:
    kind = step['kind']
    prefix, value, tool = ('write.args', step['write']['args'], step['write']['tool']) if kind == 'write' else (kind, step[kind], None)
    errors = []
    for path, text in _leaves(value):
        message = _leaf_error(step, path, text, tool, facts)
        if message is not None:
            errors.append(_error(message, step['id'], f'{prefix}.{_dotted(path)}'))
    return errors


def validate_plan(raw: object, *, is_admin: bool, packs_allowed: list[str] | tuple[str, ...] | frozenset[str]) -> tuple[dict[str, Any] | None, list[PlanError]]:
    """``(plan, [])`` for a valid plan (strings trimmed as zod does), else ``(None, errors)``."""
    plan, errors = _plan_shape(raw)
    if plan is None or errors:
        return None, errors
    structural = _limit_errors(plan) + _graph_errors(plan)
    if structural:
        return None, structural
    allowed = frozenset(packs_allowed)
    facts = ({step['id']: step for step in plan['steps']}, _ancestors(plan['steps']))
    errors = [error for step in plan['steps']
              for error in (*_pack_errors(step, is_admin, allowed), *_placeholder_errors(step, facts))]
    return (None, errors) if errors else (plan, [])
