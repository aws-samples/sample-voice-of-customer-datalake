"""shared/plan_schema.py + plan_canonical.py against the fixtures the TypeScript validators share.

The fixtures (test/fixtures/plans/*.json, test/fixtures/plan-fingerprints.json) are also read by
lambda/stream/src/assistant/plan/*.test.ts and frontend/src/assistant/plan/plan.lockstep.test.ts, so a
case that passes here and there means the three validators agree. ``needs_args_schema`` fixtures are
caught only by a validator holding the tools' zod schemas: Python must accept them (rule 6 is TS-only).
"""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from shared.plan_canonical import CanonicalJsonError, canonical_json, canonical_write_fingerprint, js_length, js_trim
from shared.plan_schema import (
    CONTRACT,
    NEVER_PREAPPROVABLE_TOOLS,
    PLAN_STATUSES,
    PLAN_STEP_STATUSES,
    WRITE_TOOLS,
    is_plan_id,
    validate_plan,
)

FIXTURES = Path(__file__).parent / 'fixtures'
PLAN_CASES = sorted((FIXTURES / 'plans').glob('*.json'))
FINGERPRINTS = json.loads((FIXTURES / 'plan-fingerprints.json').read_text(encoding='utf-8'))['cases']
CONTRACT_FILE = Path(__file__).parent.parent / 'plan_contract.json'


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def _keys(errors: list[dict]) -> list[dict]:
    return [{key: error[key] for key in ('step', 'field') if key in error} for error in errors]


def _validate(case: dict) -> tuple[dict | None, list[dict]]:
    return validate_plan(case['plan'], is_admin=case['ctx']['isAdmin'], packs_allowed=case['ctx']['packsAllowed'])


def test_shared_fixtures_are_present():
    names = [path.stem for path in PLAN_CASES]
    assert sum(name.startswith('invalid-') for name in names) >= 10
    assert 'valid-example' in names


@pytest.mark.parametrize('path', [p for p in PLAN_CASES if _load(p)['valid'] or _load(p)['needs_args_schema']], ids=lambda p: p.stem)
def test_accepts_valid_and_schema_only_fixtures(path):
    plan, errors = _validate(_load(path))
    assert errors == []
    assert plan is not None


@pytest.mark.parametrize('path', [p for p in PLAN_CASES if not _load(p)['valid'] and not _load(p)['needs_args_schema']], ids=lambda p: p.stem)
def test_rejects_invalid_fixtures_at_the_expected_step_and_field(path):
    case = _load(path)
    plan, errors = _validate(case)
    assert plan is None
    assert all(expected in _keys(errors) for expected in case['errors']), _keys(errors)


@pytest.mark.parametrize('case', FINGERPRINTS, ids=lambda case: case['tool'])
def test_fingerprint_is_byte_identical_to_typescript(case):
    assert canonical_json({'tool': case['tool'], 'args': case['args']}) == case['canonical']
    assert canonical_write_fingerprint(case['tool'], case['args']) == case['sha256']


def test_fingerprint_reads_dynamodb_decimals_like_json_numbers():
    as_json = canonical_write_fingerprint('generate_personas', {'persona_count': 4, 'ratio': 0.5})
    assert canonical_write_fingerprint('generate_personas', {'persona_count': Decimal(4), 'ratio': Decimal('0.5')}) == as_json


@pytest.mark.parametrize('value', [float('nan'), '\ud800', object(), {1: 'x'}])
def test_canonical_json_refuses_values_with_no_canonical_form(value):
    with pytest.raises(CanonicalJsonError):
        canonical_json(value)


def test_validated_plan_carries_zod_trimmed_strings():
    raw = _load(FIXTURES / 'plans' / 'valid-small-non-admin.json')
    raw['plan']['steps'][0]['title'] = '  Create the project \u3000'
    plan, _ = _validate(raw)
    assert plan is not None
    assert plan['steps'][0]['title'] == 'Create the project'


def test_string_bounds_count_utf16_code_units_like_javascript():
    assert js_length('a\U0001F680') == 3
    assert js_trim('\x1c x \x85') == '\x1c x \x85'


def test_plan_ids_are_pl_and_twelve_lowercase_ascii_hex():
    assert is_plan_id('pl_0123456789ab')
    assert not any(is_plan_id(value) for value in ('ag_0123456789ab', 'pl_0123456789AB', 'pl_\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669ab', 7))


def test_contract_tables_are_consistent():
    all_writes = {tool for tools in WRITE_TOOLS.values() for tool in tools}
    assert all_writes >= NEVER_PREAPPROVABLE_TOOLS
    assert all_writes >= set(CONTRACT['free_text_fields'])
    assert 'needs_approval' in PLAN_STEP_STATUSES
    assert 'completed_with_errors' in PLAN_STATUSES


def test_contract_file_is_the_typescript_generators_exact_output_format():
    # The TS spec pins the content; this pins that nobody hand-edited the format (2-space JSON + newline).
    text = CONTRACT_FILE.read_text(encoding='utf-8')
    assert text == json.dumps(json.loads(text), indent=2, ensure_ascii=False) + '\n'
    assert 'write-plan-contract' in CONTRACT['$comment']
