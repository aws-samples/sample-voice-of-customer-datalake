"""briefing/build.py → shared/job_notices.py: a built (or failed) brief tells its reader; best effort."""
import json
from unittest.mock import MagicMock

import pytest

from briefing import build, writer
from briefing.test.conftest import NOW
from briefing.todos import Reader

ANA = Reader(sub='sub-ana', username='ana', name='Ana', is_admin=False)
REFRESH = build.BuildRequest(sub='sub-ana', username='ana', reason='refresh')
DAY = '2026-10-17'


@pytest.fixture
def published(monkeypatch):
    publish = MagicMock(return_value=True)
    monkeypatch.setattr(build.job_notices.realtime, 'publish', publish)
    monkeypatch.setattr(writer, 'converse',
                        MagicMock(return_value=json.dumps({'headline': 'Hi', 'summary': 'Quiet', 'cards': []})))
    monkeypatch.setattr('shared.grounding._recall', lambda *_, **__: [])
    return publish


def test_a_built_brief_tells_its_reader(world, published, monkeypatch):
    monkeypatch.setattr(build, 'lookup_reader', lambda *_: ANA)
    assert build.build_for_user(world.tables, REFRESH, NOW)['outcome'] == 'built'
    published.assert_called_once_with('jobs', 'sub-ana', {
        'type': 'job', 'job_id': f'brief_{DAY}', 'status': 'ready', 'job_type': 'morning_brief'})


def test_a_reader_who_is_gone_hears_the_failure(world, published, monkeypatch):
    monkeypatch.setattr(build, 'lookup_reader', lambda *_: None)
    assert build.build_for_user(world.tables, REFRESH, NOW)['outcome'] == 'reader_gone'
    assert published.call_args.args[2]['status'] == 'failed'


def test_a_lost_notice_still_stores_the_brief(world, published, monkeypatch):
    published.return_value = False
    monkeypatch.setattr(build, 'lookup_reader', lambda *_: ANA)
    assert build.build_for_user(world.tables, REFRESH, NOW)['outcome'] == 'built'
