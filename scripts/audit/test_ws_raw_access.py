"""ws_raw_access counts planted raw table access and S3 writes, skips the layer and tests, and ratchets the counts."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from audit_common import CDK_DIR, AuditError
from ws_raw_access import Use, compare, main, python_uses, read_ratchet, scan_tree, table_getters, ts_uses

from conftest import TreeMaker

TABLES = '''
from shared.aws import get_dynamodb_resource
_cache = {}

def _get_table(env_var):
    _cache[env_var] = get_dynamodb_resource().Table(env_var)
    return _cache[env_var]

def cached_table(resource, name):
    return resource.Table(name)

def get_feedback_table():
    return _get_table('FEEDBACK_TABLE')

def configured_table(table, name):
    return table
'''
GETTERS = frozenset({'_get_table', 'cached_table', 'get_feedback_table'})
HANDLER = '''
import boto3
from shared import tables
from shared.tables import cached_table as _table, configured_table, get_feedback_table

dynamodb = boto3.resource('dynamodb')
feedback = dynamodb.Table('voc-feedback')
low_level = boto3.client(service_name='dynamodb')
s3 = boto3.client('s3')

def save(table, item):
    table.put_item(Item=item)                       # a handle's use: counted where it was built
    s3.put_object(Bucket='b', Key='raw/x', Body=b'')
    s3.generate_presigned_url('put_object', Params={})
    s3.generate_presigned_url('get_object', Params={})   # a read
    s3.get_object(Bucket='b', Key='raw/x')                # a read
    boto3.resource('s3').Object('b', 'k').put(Body=b'')
    configured_table(get_feedback_table(), 'feedback')
    _table(dynamodb, 'voc-radar')
    tables.get_feedback_table()
    "s3.put_object(Bucket='label')"                 # text, not a call
'''
STREAM = '''
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { PutObjectCommand } from '@aws-sdk/client-s3'
// new PutCommand( in a comment does not count
export async function save(doc, s3) {
  await doc.send(new GetCommand({ TableName: 't', Key: {} }))
  await doc.send(new PutCommand({ TableName: 't', Item: {} }))
  await s3.send(new PutObjectCommand({ Bucket: 'b', Key: 'k' }))
}
'''
NO_SDK = "export const label = 'new PutCommand(' + 'new GetCommand('\n"


def _kinds(source: str) -> list[str]:
    return sorted(use.kind for use in python_uses(source, GETTERS))


def test_table_getters_are_the_functions_that_build_a_table(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/shared/tables.py': TABLES})
    assert table_getters(root) == {'_get_table', 'cached_table', 'get_feedback_table'}


def test_python_uses_counts_handles_clients_getters_and_s3_writes() -> None:
    assert _kinds(HANDLER) == sorted(['dynamodb-client', 'table', 'dynamodb-client', 's3-change', 's3-change',
                                      's3-change', 'table-getter', 'table-getter', 'table-getter'])


@pytest.mark.parametrize(('source', 'kinds'), [
    ('import boto3 as b\nb.resource("dynamodb")\n', ['dynamodb-client']),
    ('from boto3 import resource as r, client\nr("dynamodb")\nclient("dynamodb")\nclient("s3")\n',
     ['dynamodb-client', 'dynamodb-client']),
    ('import boto3\nboto3.session.Session().client("dynamodb")\n', ['dynamodb-client']),
    ('from shared.aws import get_dynamodb_resource as res\ndb = res()\n', ['dynamodb-resource']),
    ('from shared import aws\naws.get_dynamodb_resource()\n', ['dynamodb-resource']),
    ('def f(table, resource):\n    table.meta.client.batch_get_item()\n    resource.meta.client\n',
     ['meta-client', 'meta-client']),
    ('import shared.tables as t\nt.get_feedback_table()\n', ['table-getter']),
    ('import shared.tables\nshared.tables.get_feedback_table()\n', ['table-getter']),
    ('from shared.tables import get_feedback_table\nfetch = get_feedback_table\nfetch()\n', ['table-getter']),
    ('def f(scoped):\n    scoped._unscoped_table.put_item(Item={})\n', ['layer-private']),
    ("def f(scoped):\n    getattr(scoped, '_unscoped_table')\n    vars(scoped)['_unscoped_table']\n",
     ['layer-private', 'layer-private']),
    (('from shared.ws_repository import ws_table\nt = ws_table(ws, "FEEDBACK_TABLE")\nt._prefix\nt._schema\n'
      't.__dict__\nvars(t)\nobject.__setattr__(t, "_prefix", "x")\nt.get_item(Key={})\n'),
     ['layer-private'] * 5),
    (('import botocore.session\nbotocore.session.get_session().create_client("dynamodb")\n'
      'botocore.session.get_session().create_client(service_name="s3")\n'), ['dynamodb-client', 's3-client']),
], ids=['boto3-alias', 'boto3-factories', 'session', 'resource-getter', 'resource-getter-attribute', 'meta-client',
        'tables-module-alias', 'tables-module-dotted', 'getter-bound', 'layer-private', 'layer-private-by-name',
        'layer-handle-private-state', 'create-client'])
def test_python_uses_counts_the_evasive_forms(source: str, kinds: list[str]) -> None:
    assert _kinds(source) == sorted(kinds)


@pytest.mark.parametrize(('source', 'count'), [
    ("s3.delete_object(Bucket='b', Key='k')\ns3.delete_objects(Bucket='b', Delete={})\n", 2),
    ("s3.copy({'Bucket': 'b', 'Key': 'k'}, 'b2', 'k2')\ns3.copy(CopySource={}, Bucket='b', Key='k')\n", 2),
    ("s3.Object('b', 'k').copy_from(CopySource={})\ns3.Object('b', 'k').delete()\n", 2),
    ("s3.put_object_tagging(Bucket='b', Key='k', Tagging={})\n", 1),
    (("s3.generate_presigned_url('delete_object', Params={})\n"
      "s3.generate_presigned_url(ClientMethod='put_object', Params={})\n"), 2),
    ("import copy\nrow = {}.copy()\ncopy.copy(row)\nrow.copy()\n", 0),
    ("import shutil\nimport shutil as sh\nshutil.copy('a', 'b')\nsh.copy('a', 'b')\n", 0),
    ("obj = s3.Object('b', 'k')\nobj.put(Body=b'')\nobj.delete()\nobj.copy_from(CopySource={})\nrow.put(1)\n", 3),
    (("bucket = s3.Bucket('b')\nbucket.objects.filter(Prefix='raw/').delete()\nbucket.object_versions.all().delete()\n"
      "s3.Bucket('b').multipart_uploads.delete()\nbucket.delete()\nrows.delete()\n"), 4),
    (("s3.Object('b', 'k').upload_file('/tmp/x')\ns3.Bucket('b').put_object(Key='k')\n"
      "s3.Bucket('b').delete_objects(Delete={})\n"), 3),
], ids=['deletes', 'managed-copy', 'object-copy-and-delete', 'tagging', 'presigned', 'not-s3-copies', 'shutil',
        'bound-object', 'collection-deletes', 'resource-writes'])
def test_python_uses_counts_s3_deletes_and_copies(source: str, count: int) -> None:
    assert _kinds(source) == ['s3-change'] * count


def test_ts_uses_needs_the_sdk_import_and_skips_comments() -> None:
    assert [(u.line, u.kind) for u in ts_uses(STREAM)] == [(6, 'dynamodb-command'), (7, 'dynamodb-command'),
                                                          (8, 's3-change')]
    assert ts_uses(NO_SDK) == []


def test_ts_uses_skips_trailing_and_block_comments_and_counts_s3_deletes() -> None:
    source = '\n'.join([
        "import { DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'",
        "const url = 'https://example.com/a'  // was new DeleteObjectCommand(",
        '/* new DeleteObjectCommand(',
        '   new DeleteObjectsCommand( */',
        'await s3.send(new DeleteObjectCommand({}))',
        'await s3.send(new DeleteObjectsCommand({})) /* new DeleteObjectCommand( */',
    ])
    assert [(u.line, u.kind) for u in ts_uses(source)] == [(5, 's3-change'), (6, 's3-change')]


@pytest.mark.parametrize(('source', 'kinds'), [
    (("import { DynamoDBClient } from '@aws-sdk/client-dynamodb'\n"
      "import { DynamoDBDocumentClient, DynamoDBDocument } from '@aws-sdk/lib-dynamodb'\n"
      'const a = DynamoDBDocumentClient.from(new DynamoDBClient({}))\nconst b = DynamoDBDocument.from(raw)\n'),
     ['dynamodb-client', 'dynamodb-client', 'dynamodb-client']),
    ("import { S3Client } from '@aws-sdk/client-s3'\nconst s3 = new S3Client({})\n", ['s3-client']),
    (("import { ExecuteStatementCommand, BatchExecuteStatementCommand, ExecuteTransactionCommand }\n"
      "  from '@aws-sdk/client-dynamodb'\n"
      'send(new ExecuteStatementCommand({}))\nsend(new BatchExecuteStatementCommand({}))\n'
      'send(new ExecuteTransactionCommand({}))\n'), ['dynamodb-command'] * 3),
    ("import { PutCommand as P } from '@aws-sdk/lib-dynamodb'\nsend(new P({}))\nsend(new PutCommand({}))\n",
     ['dynamodb-command']),
    ("import * as d from '@aws-sdk/lib-dynamodb'\nsend(new d.PutCommand({}))\nd.DynamoDBDocumentClient.from(c)\n",
     ['dynamodb-command', 'dynamodb-client']),
    ("const { DeleteObjectCommand: Del } = require('@aws-sdk/client-s3')\nsend(new Del({}))\n", ['s3-change']),
    ("const s3sdk = require('@aws-sdk/client-s3')\nnew s3sdk.S3Client({})\n", ['s3-client']),
    ("import { PutCommand } from './local-wrapper'\nsend(new PutCommand({}))\n", []),
    ("import { PutCommand } from '@aws-sdk/lib-dynamodb'\nsend(new\n  PutCommand({}))\nsend(new (PutCommand)({}))\n",
     ['dynamodb-command', 'dynamodb-command']),
    ("import sdk from '@aws-sdk/client-s3'\nnew sdk.S3Client({})\n", ['s3-client']),
    ("import lib, { PutCommand } from '@aws-sdk/lib-dynamodb'\nnew PutCommand({})\nnew lib.GetCommand({})\n",
     ['dynamodb-command', 'dynamodb-command']),
], ids=['dynamodb-clients', 's3-client', 'partiql', 'named-alias', 'namespace', 'require-alias', 'require-namespace',
        'not-the-sdk', 'across-lines-and-parenthesised', 'default-import', 'default-and-named-import'])
def test_ts_uses_counts_clients_partiql_and_follows_aliases(source: str, kinds: list[str]) -> None:
    assert sorted(use.kind for use in ts_uses(source)) == sorted(kinds)


def test_scan_tree_skips_the_layer_tests_and_the_template(make_tree: TreeMaker) -> None:
    raw = "import boto3\nboto3.resource('dynamodb').Table('t')\n"
    root = make_tree({
        'lambda/shared/tables.py': TABLES,
        'lambda/api/x_handler.py': raw,
        'lambda/shared/ws_repository.py': raw,
        'lambda/api/test/test_x.py': raw,
        'plugins/_template/handler.py': raw,
        'lambda/stream/src/tools/store.ts': STREAM,
        'lambda/stream/src/tools/store.test.ts': STREAM,
    })
    found, _ = scan_tree(root)
    assert {path: len(uses) for path, uses in found.items()} == {
        'lambda/api/x_handler.py': 2, 'lambda/shared/tables.py': 3, 'lambda/stream/src/tools/store.ts': 3}


def _uses(count: int) -> list[Use]:
    return [Use(line, 'table') for line in range(1, count + 1)]


def test_the_ratchet_fails_a_new_file_a_growth_and_a_drop() -> None:
    found = {'lambda/new.py': _uses(1), 'lambda/grew.py': _uses(3), 'lambda/dropped.py': _uses(1),
             'lambda/same.py': _uses(2)}
    allowed = {'lambda/grew.py': 2, 'lambda/dropped.py': 2, 'lambda/same.py': 2, 'lambda/gone.py': 1}
    assert [(f.kind, f.key) for f in compare(found, allowed)] == [
        ('count-dropped', 'lambda/dropped.py'), ('count-dropped', 'lambda/gone.py'),
        ('count-grew', 'lambda/grew.py'), ('raw-access', 'lambda/new.py')]


def _ratchet(tmp_path: Path, entries: object) -> Path:
    file = tmp_path / 'ratchet.json'
    file.write_text(json.dumps({'entries': entries}), encoding='utf-8')
    return file


def test_read_ratchet_flattens_the_groups(tmp_path: Path) -> None:
    file = _ratchet(tmp_path, [{'group': 'a', 'reason': 'r', 'files': {'x.py': 1}},
                               {'group': 'b', 'reason': 'r', 'files': {'y.py': 2}}])
    assert read_ratchet(file) == {'x.py': 1, 'y.py': 2}


@pytest.mark.parametrize('entries', [
    [{'group': 'a', 'files': {'x.py': 1}}],
    [{'group': 'a', 'reason': 'r'}],
    [{'group': 'a', 'reason': 'r', 'files': {'x.py': 0}}],
    [{'group': 'a', 'reason': 'r', 'files': {'x.py': True}}],
    [{'group': 'a', 'reason': 'r', 'files': {'x.py': 1}}, {'group': 'b', 'reason': 'r', 'files': {'x.py': 1}}],
], ids=['no-reason', 'no-files', 'zero', 'not-a-count', 'listed-twice'])
def test_a_malformed_ratchet_cannot_run(tmp_path: Path, entries: object) -> None:
    file = _ratchet(tmp_path, entries)
    with pytest.raises(AuditError):
        read_ratchet(file)


def test_the_real_tree_matches_its_allowlist() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0


def test_the_real_tree_fails_until_a_dropped_count_is_lowered(tmp_path: Path) -> None:
    allowed = read_ratchet(Path(__file__).parent / 'allowlists' / 'ws_raw_access.json')
    path = min(allowed)
    stale = {**allowed, path: allowed[path] + 1}
    file = _ratchet(tmp_path, [{'group': 'all', 'reason': 'r', 'files': stale}])
    assert main(['--cdk-dir', str(CDK_DIR), '--allowlist', str(file)]) == 1
