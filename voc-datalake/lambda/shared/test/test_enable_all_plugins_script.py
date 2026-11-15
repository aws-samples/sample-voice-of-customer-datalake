"""scripts/workspaces/enable_all_plugins.py: every plugin on in the workspaces created before 7.40.00 (moto)."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'workspaces' / 'enable_all_plugins.py'
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
DELETING = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
PLUGINS = '["webscraper", "web_reviews"]'


@pytest.fixture
def table():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        made = resource.create_table(
            TableName='workspaces', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])
        for ws, status, slug in ((WS, 'active', 'acme'), (DELETING, 'deleting', 'gone')):
            made.put_item(Item={'pk': 'WORKSPACES', 'sk': f'{slug}#{ws}', 'workspace_id': ws, 'name': slug,
                                'slug': slug, 'status': status})
            made.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': slug, 'slug': slug, 'status': status})
        # An admin enabled the web scraper already.
        made.put_item(Item={'pk': 'PLUGIN#webscraper', 'sk': f'WS#{WS}', 'enabled_by': 'sub-ada', 'enabled_at': 'x'})
        yield made


def _rows(table, pk):
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


def _run(*argv):
    script = load_module_from_path('enable_all_plugins', _SCRIPT)
    return script.main(['--table', 'workspaces', '--region', 'us-east-1', '--plugins', PLUGINS, *argv])


def test_a_dry_run_writes_nothing(table, capsys):
    before = table.scan()['Items']
    assert _run() == 0
    assert table.scan()['Items'] == before
    assert 'would enable web_reviews in acme' in capsys.readouterr().out


def test_apply_enables_the_missing_plugins_of_active_workspaces_only_and_audits_each(table, capsys):
    assert _run('--apply') == 0
    assert [row['sk'] for row in _rows(table, 'PLUGIN#web_reviews')] == [f'WS#{WS}']
    # The admin's own row is kept as it was; the deleting workspace gets nothing.
    assert _rows(table, 'PLUGIN#webscraper')[0]['enabled_by'] == 'sub-ada'
    assert _rows(table, f'AUDIT#WS#{DELETING}') == []
    audits = _rows(table, f'AUDIT#WS#{WS}')
    assert [row.get('actor') for row in audits] == ['script:enable-all-plugins']
    assert '1 enabled' in capsys.readouterr().out


@pytest.mark.usefixtures('table')
def test_a_second_run_enables_nothing(capsys):
    _run('--apply')
    capsys.readouterr()
    assert _run('--apply') == 0
    assert '0 enabled' in capsys.readouterr().out
