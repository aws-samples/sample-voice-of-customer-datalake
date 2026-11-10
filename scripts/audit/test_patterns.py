"""patterns.py: every rule finds a PLANTED instance and stays quiet on a legitimate look-alike (temp-dir fixtures)."""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

import patterns as pt
import pytest
from audit_common import EXIT_CLEAN, EXIT_ERROR, EXIT_FINDINGS, read_allowlist

L = 'voc-datalake/lambda/api/thing.py'
H = 'voc-datalake/lambda/api/thing_handler.py'
UI = 'voc-datalake/frontend/src/pages/Thing/Thing.tsx'

#: rule id -> (path, planted text that must be reported, look-alike text that must not)
CASES: dict[str, tuple[str, str, str]] = {
    'dynamo-paging-loop': (L, '''
def rows(table, kw):
    out = []
    while True:
        page = table.query(**kw)
        out.extend(page.get('Items', []))
        if not page.get('LastEvaluatedKey'):
            return out
        kw['ExclusiveStartKey'] = page['LastEvaluatedKey']
''', '''
from shared.dynamo_paging import query_all
# LastEvaluatedKey handled by the pager
def rows(table, kw):
    """Follows LastEvaluatedKey through query_all."""
    return query_all(table, kw)
'''),
    'decimal-plain-copy': (L, '''
def plain(v):
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return v
''', '''
def whole(raw):
    return isinstance(raw, Decimal) and raw == raw.to_integral_value()
'''),
    'boto3-in-function': (L, '''
import boto3
def start(arn):
    boto3.client('stepfunctions').start_execution(stateMachineArn=arn)
''', '''
import boto3
from functools import lru_cache
_s3 = boto3.client('s3')
_clients = {}
_sqs = None
@lru_cache(maxsize=1)
def _sfn():
    return boto3.client('stepfunctions')
def _sqs_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client('sqs')
    return _sqs
def _table(name):
    if name not in _clients:
        resource = boto3.resource('dynamodb')
        _clients[name] = resource.Table(name)
    return _clients[name]
'''),
    'lazy-getter-without-warm': (H, '''
import boto3
_cognito = None
def _cognito_client():
    global _cognito
    if _cognito is None:
        _cognito = boto3.client('cognito-idp')
    return _cognito
def lambda_handler(event, context):
    return _cognito_client()
''', '''
import boto3
from shared.warm_init import warm_at_init
_cognito = None
def _cognito_client():
    global _cognito
    if _cognito is None:
        _cognito = boto3.client('cognito-idp')
    return _cognito
warm_at_init(_cognito_client)
'''),
    'swallowed-exception': (L, '''
def read(x):
    try:
        return x()
    except Exception:
        return None
''', '''
def read(x):
    try:
        return x()
    except KeyError:
        return None
    except Exception:
        logger.exception('read failed')
        return None
'''),
    'inline-admin-check': (L, '''
def allowed(event):
    return 'admins' in get_caller_groups(event)
''', '''
def allowed(event):
    return is_admin(event)  # 'admins' membership lives in shared.api
ROLES = ['admins', 'users']
'''),
    'raw-bedrock-call': (L, '''
def ask(client, body):
    return client.invoke_model(modelId='m', body=body)
''', '''
def ask(text):
    return converse(prompt=text, surface='utilities', call_label='client.converse()')
'''),
    'stream-raw-bedrock-command': ('voc-datalake/lambda/stream/src/tools/thing.ts', '''
export const cmd = (id: string) => new ConverseCommand({ modelId: id, messages: [] })
''', '''
// new ConverseCommand( lives in bedrock/
export const cmd = (id: string) => buildRequest(id)
'''),
    'ui-tofixed': (UI, '''
export const Score = ({ v }: { v: number }) => <span>{v.toFixed(1)}</span>
''', '''
// never .toFixed( here: formatDecimal knows the decimal mark
export const Score = ({ v, lang }: { v: number; lang: string }) => <span>{formatDecimal(v, lang, 1)}</span>
'''),
    'ui-locale-less-format': (UI, '''
export const Count = ({ n }: { n: number }) => <span>{n.toLocaleString()}</span>
''', '''
export const Count = ({ n, lang }: { n: number; lang: string }) => <span>{n.toLocaleString(lang)}</span>
'''),
    'local-date-formatter': (UI, '''
export const When = ({ d }: { d: Date }) => <time>{d.toLocaleDateString('en', { month: 'short' })}</time>
''', '''
export const When = ({ d, lang }: { d: Date; lang: string }) => <time>{formatDate(d, lang)}</time>
'''),
    'raw-clipboard': (UI, '''
export const copy = (text: string) => navigator.clipboard.writeText(text)
''', '''
export function Copy({ text }: { text: string }) {
  const { copy } = useCopyToClipboard()
  return <button onClick={() => copy(text)}>copy</button>
}
'''),
    'locale-raw-count': ('voc-datalake/frontend/public/locales/en/thing.json', '''
{"items_one": "{{count}} item", "items_other": "{{count}} items"}
''', '''
{"items_one": "{{count, number}} item", "review": "Review {{n}}"}
'''),
    'utc-now-iso': (L, '''
from datetime import UTC, datetime
def touch(item):
    item['updated_at'] = datetime.now(UTC).isoformat()
''', '''
from datetime import UTC, datetime
from shared.timestamps import now_iso
def touch(item, started):
    item['updated_at'] = now_iso()
    item['started'] = started.isoformat()   # a given moment, not "now"
    item['day'] = datetime.now(UTC).date().isoformat()
'''),
    'ts-inline-is-record': (UI, '''
export const isPlain = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
''', '''
import { isRecord } from '../lib/typeGuards'
export const isList = (v: unknown) => typeof v === 'object' && v !== null && Array.isArray(v)
'''),
    'ts-local-request-init': ('voc-datalake/frontend/src/api/thingApi.ts', '''
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
''', '''
import { post } from './client'
const patch = (next: Partial<State>) => setState((prev) => ({ ...prev, ...next }))
'''),
    'locale-manual-plural': ('voc-datalake/frontend/public/locales/en/thing.json', '''
{"import_other": "Import {{count, number}} item{{plural}}", "upload": "Uploading file(s)"}
''', '''
{"import_one": "Import {{count, number}} item", "import_other": "Import {{count, number}} items"}
'''),
    'ts-manual-plural': (UI, '''
export const label = (n: number) => t('items', { count: n, plural: n === 1 ? '' : 's' })
''', '''
// never pass plural: let count pick the form
export const label = (n: number) => t('items', { count: n })
'''),
    'ts-json-equality': (UI, '''
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
''', '''
import { sameJson } from '../lib/sameJson'
export const same = (a: unknown, b: unknown) => sameJson(a, b) && JSON.stringify(a).length > 0
'''),
    'py-cast': (L, '''
from typing import cast
def size(value):
    return cast(int, value)
''', '''
def forecast(value):
    return value
def broadcast(values, column):
    column.cast('int')  # a method named cast, not typing.cast
    return [forecast(v) for v in values]
def size(value):
    if not isinstance(value, int):
        raise TypeError('cast(int, value) would have hidden this')
    return value
'''),
    'noqa-reason': (L, '''
import os  # noqa: F401
''', '''
import os  # noqa: F401 — re-exported for the handler
import sys  # noqa: F401,E402 - kept for the CLI entry point
# A comment line may mention a bare noqa or `# noqa: S603` without being one.
'''),
    'shared-imports-handler': ('voc-datalake/lambda/shared/thing.py', '''
from metrics_handler import list_feedback
''', '''
from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.middleware_factory import lambda_handler_decorator
from shared.api import api_handler
import shared.batch as batch_tools
'''),
}


@pytest.fixture(scope='module')
def rules() -> dict[str, pt.Rule]:
    return {r.id: r for r in pt.load_rules(pt.DEFAULT_RULES)}


def _write(root: Path, rel: str, text: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')


def _findings(root: Path, rule: pt.Rule, entries: list[dict] | None = None) -> list[pt.Finding]:
    return pt.run(root, [rule], entries or []).findings


def test_every_rule_has_a_planted_case_and_a_look_alike(rules):
    assert set(CASES) == set(rules), 'a new rule needs a CASES entry (planted hit + look-alike)'


@pytest.mark.parametrize('rule_id', sorted(CASES))
def test_the_planted_instance_is_reported(tmp_path, rules, rule_id):
    rel, planted, _ = CASES[rule_id]
    _write(tmp_path, rel, planted)
    found = _findings(tmp_path, rules[rule_id])
    assert [f.path for f in found] == [rel]


@pytest.mark.parametrize('rule_id', sorted(CASES))
def test_the_legitimate_look_alike_is_not(tmp_path, rules, rule_id):
    rel, _, look_alike = CASES[rule_id]
    _write(tmp_path, rel, look_alike)
    assert _findings(tmp_path, rules[rule_id]) == []


@pytest.mark.parametrize(('line', 'reported'), [
    ("const s = date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })", True),
    ("const s = new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(d)", True),
    ('const s = count.toLocaleString(language)', False),  # a number in the app language
    ("const s = count.toLocaleString(language, { maximumFractionDigits: 1 })", False),
])
def test_a_date_formatted_through_to_locale_string_is_a_local_formatter(tmp_path, rules, line, reported):
    _write(tmp_path, UI, f'{line}\n')
    assert bool(_findings(tmp_path, rules['local-date-formatter'])) is reported


@pytest.mark.parametrize(('line', 'reported'), [
    ('from metrics_handler import app', True),
    ('from api.metrics_handler import app', True),
    ('from processor.handler import record_handler', True),
    ('import metrics_handler', True),
    ('import processor.handler', True),
    ('from api import metrics_handler', True),
    ('from processor import handler', True),
    ("module = importlib.import_module('metrics_handler')", True),
    ('from aws_lambda_powertools.event_handler import APIGatewayRestResolver', False),
    ('import aws_lambda_powertools.event_handler', False),
    ('from shared.api import api_handler', False),  # a decorator, not a handler module
    ('from shared.handler_kit import wrap', False),
])
def test_every_way_of_importing_a_handler_into_shared_is_seen(tmp_path, rules, line, reported):
    _write(tmp_path, 'voc-datalake/lambda/shared/thing.py', f'{line}\n')
    assert bool(_findings(tmp_path, rules['shared-imports-handler'])) is reported


@pytest.mark.parametrize(('line', 'reported'), [
    ('x = 1  # noqa', True),
    ('x = 1  # NOQA: E501', True),
    ('x = 1  # noqa: E501,W291', True),
    ('x = 1  # noqa:E501 long fixture literal', False),
    ('x = 1  # noqa: E501, W291 — long fixture literal', False),
])
def test_a_noqa_needs_a_code_and_a_reason(tmp_path, rules, line, reported):
    _write(tmp_path, L, f'{line}\n')
    assert bool(_findings(tmp_path, rules['noqa-reason'])) is reported


def test_the_helpers_home_is_excluded_by_the_rule(tmp_path, rules):
    _write(tmp_path, 'voc-datalake/lambda/shared/dynamo_paging.py', CASES['dynamo-paging-loop'][1])
    assert _findings(tmp_path, rules['dynamo-paging-loop']) == []


def test_tests_are_skipped_unless_asked(tmp_path, rules):
    _write(tmp_path, 'voc-datalake/lambda/api/test/test_thing.py', CASES['dynamo-paging-loop'][1])
    rule = rules['dynamo-paging-loop']
    assert pt.run(tmp_path, [rule], []).findings == []
    assert len(pt.run(tmp_path, [rule], [], include_tests=True).findings) == 1


def test_a_python_finding_is_reported_once_per_function_with_its_scope(tmp_path, rules):
    method = CASES['dynamo-paging-loop'][1].replace('def rows(table', 'def rows(self, table')
    _write(tmp_path, L, 'class Store:\n' + textwrap.indent(method, '    '))
    [finding] = _findings(tmp_path, rules['dynamo-paging-loop'])  # two matching lines, one finding
    assert finding.scope == 'Store.rows'


def test_an_allowlist_entry_matches_rule_path_scope_and_contains(tmp_path, rules):
    rel, planted, _ = CASES['dynamo-paging-loop']
    _write(tmp_path, rel, planted)
    rule = rules['dynamo-paging-loop']
    base = {'rule': rule.id, 'path': 'voc-datalake/lambda/**', 'reason': 'kept'}
    assert _findings(tmp_path, rule, [base]) == []
    assert _findings(tmp_path, rule, [{**base, 'scope': 'rows'}]) == []
    assert len(_findings(tmp_path, rule, [{**base, 'scope': 'other'}])) == 1
    assert len(_findings(tmp_path, rule, [{**base, 'contains': 'no such text'}])) == 1
    assert len(_findings(tmp_path, rule, [{**base, 'rule': 'ui-tofixed'}])) == 1


def test_a_stale_allowlist_entry_is_listed(tmp_path, rules):
    _write(tmp_path, L, 'x = 1\n')
    report = pt.run(tmp_path, [rules['dynamo-paging-loop']], [{'rule': 'dynamo-paging-loop', 'path': L, 'reason': 'r'}])
    assert len(report.stale) == 1


def _rules_file(tmp_path: Path, rule: dict) -> Path:
    file = tmp_path / 'rules.json'
    file.write_text(json.dumps({'rules': [rule]}))
    return file


GOOD_RULE = {'id': 'r', 'language': 'python', 'include': ['**'], 'regex': 'x', 'message': 'm', 'use': 'u'}


@pytest.mark.parametrize('broken', [
    {k: v for k, v in GOOD_RULE.items() if k != 'use'},
    {**GOOD_RULE, 'predicate': 'boto3_in_function'},
    {**{k: v for k, v in GOOD_RULE.items() if k != 'regex'}, 'predicate': 'no_such_check'},
    {**GOOD_RULE, 'language': 'cobol'},
    {**GOOD_RULE, 'exclude': [{'glob': 'a.py'}]},
])
def test_a_malformed_rule_is_refused(tmp_path, broken):
    with pytest.raises(pt.AuditError):
        pt.load_rules(_rules_file(tmp_path, broken))


def test_main_exit_codes(tmp_path):
    rules = _rules_file(tmp_path, {**GOOD_RULE, 'regex': 'FORBIDDEN', 'include': ['voc-datalake/**']})
    allow = tmp_path / 'allow.json'
    _write(tmp_path, 'voc-datalake/a.py', 'ok = 1\n')
    args = ['--root', str(tmp_path), '--rules', str(rules), '--allowlist', str(allow), '--min-files', '1']
    assert pt.main(args) == EXIT_CLEAN
    _write(tmp_path, 'voc-datalake/b.py', 'FORBIDDEN = 1\n')
    assert pt.main(args) == EXIT_FINDINGS
    assert pt.main([*args, '--min-files', '50']) == EXIT_ERROR  # vacuous scan
    allow.write_text(json.dumps({'entries': [{'rule': 'r', 'path': 'voc-datalake/b.py'}]}))
    assert pt.main(args) == EXIT_ERROR  # an entry without a reason


def test_a_rule_whose_scope_matches_nothing_is_an_error(tmp_path):
    rules = _rules_file(tmp_path, {**GOOD_RULE, 'include': ['voc-datalake/nowhere/**']})
    _write(tmp_path, 'voc-datalake/a.py', 'x = 1\n')
    assert pt.main(['--root', str(tmp_path), '--rules', str(rules), '--min-files', '1',
                    '--allowlist', str(tmp_path / 'none.json')]) == EXIT_ERROR


def test_the_real_tree_is_a_plausible_scan(rules):
    """Vacuity guard: hundreds of files, every rule's scope matches something, the allowlist has no stale entry."""
    entries = read_allowlist(pt.DEFAULT_ALLOWLIST, ('rule', 'path'))
    report = pt.run(pt.REPO, list(rules.values()), entries)
    assert report.files >= pt.DEFAULT_MIN_FILES
    assert report.empty_rules == []
    assert report.stale == []
