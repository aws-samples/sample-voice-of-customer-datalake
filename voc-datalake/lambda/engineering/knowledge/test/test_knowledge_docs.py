"""The knowledge docs as approved (7.52.00, knowledge/docs.py) on moto: an approval records the docs it renders, and
the records render them again."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest

from engineering.board.test.table import TABLE
from engineering.knowledge.docs import ApprovedDocs, KnowledgeDocs
from engineering.knowledge.notes import Note
from engineering.knowledge.reduce import reduce_package
from engineering.knowledge.render_docs import INDEX_PATH, REPOSITORY_PATH
from engineering.knowledge.store import APPROVED, Actor, PackConflict, PackStore
from engineering.knowledge.tenets import TenetsStore
from engineering.knowledge.test.fixtures import SHA_A, pack_tables
from engineering.knowledge.workspaces import ROOT, Package

CONN = 'conn-harbor'
WEB = 'packages/web'
AGENT = Actor('understander-0', 'agent')
ADMIN = Actor('admin-sub-1', 'person', admin=True)
AT = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)


@dataclass
class World:
    client: Any
    packs: PackStore
    docs: KnowledgeDocs


@pytest.fixture
def world() -> Iterator[World]:
    with pack_tables() as (client, _s3, workspace):
        packs = PackStore(client, TABLE, workspace, now=lambda: AT)
        yield World(client, packs, KnowledgeDocs(packs))


def _publish(world: World, package: str, claim: str) -> int:
    listed = [Package(WEB, '@harbor/web', ('npm',), '.', ())] if package == ROOT else []
    pack = reduce_package(package, [Note('convention', package, claim, (SHA_A,), 'style')], packages=listed)
    return world.packs.publish('default', CONN, pack, author=AGENT, reason='refresh', built_from=SHA_A).version


def _row(world: World, sk: str) -> dict[str, Any]:
    return world.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#REPO#{CONN}'},
                                                       'sk': {'S': sk}})['Item']


def test_an_approval_records_the_docs_it_renders(world: World) -> None:
    _publish(world, WEB, 'Two spaces.')
    approved, rendering = world.docs.approve('default', CONN, WEB, 1, ADMIN)
    assert rendering is not None
    assert approved.status == APPROVED
    assert approved.rendering_digest == rendering.digest
    assert (rendering.version, rendering.packages, rendering.source) == (1, {WEB: 1}, f'{WEB}@v1')
    log = _row(world, 'KPACKLOG#packages=2Fweb#000001#approved')
    assert log['rendering_digest']['S'] == rendering.digest
    assert _row(world, 'KDOCS')['digest']['S'] == rendering.digest
    assert _row(world, 'KDOCSLOG#000001')['approved_by']['S'] == 'admin-sub-1'
    again = world.docs.approved('default', CONN)
    assert again is not None
    assert again.matches
    assert again.rendering.paths() == (INDEX_PATH, 'docs/agents/packages/web.md')


def test_the_overview_brings_its_packages_and_each_approval_is_the_next_rendering(world: World) -> None:
    _publish(world, WEB, 'Two spaces.')
    world.docs.approve('default', CONN, WEB, 1, ADMIN)
    _publish(world, ROOT, 'One repository.')
    _approved, rendering = world.docs.approve('default', CONN, ROOT, 1, ADMIN)
    assert rendering is not None
    assert (rendering.version, rendering.packages) == (2, {ROOT: 1, WEB: 1})
    found = world.docs.approved('default', CONN)
    assert found is not None
    assert found.matches
    assert found.rendering.paths() == (INDEX_PATH, REPOSITORY_PATH, 'docs/agents/packages/web.md')
    assert _row(world, 'KDOCSLOG#000001')['version']['N'] == '1'   # (the first rendering's log stays: D1)
    assert world.docs.approve('default', CONN, ROOT, 1, ADMIN)[1] == found.recorded   # (again: as it is)


def test_two_approvals_racing_on_one_rendering_number_leave_one(world: World) -> None:
    _publish(world, WEB, 'Two spaces.')
    _publish(world, ROOT, 'One repository.')
    world.docs.approve('default', CONN, WEB, 1, ADMIN)
    stale = KnowledgeDocs(world.packs)
    object.__setattr__(stale, 'recorded', lambda _ws, _connection: None)   # (read before the other approval)
    with pytest.raises(PackConflict):
        stale.approve('default', CONN, ROOT, 1, ADMIN)   # (it read no rendering: the KDOCS row says 1 since)
    assert world.packs.version('default', CONN, ROOT, 1).status == 'draft'   # (nothing of it was written)


def test_the_stored_records_render_again_to_the_approved_digest(world: World) -> None:
    _publish(world, WEB, 'Two spaces.')
    _approved, rendering = world.docs.approve('default', CONN, WEB, 1, ADMIN)
    docs = ApprovedDocs(world.docs, TenetsStore(world.client, TABLE))
    found = docs.approved('default', CONN, 'knowledge')
    assert found is not None
    assert rendering is not None
    assert (found.recorded.digest, found.rendering.digest) == (rendering.digest, rendering.digest)
    assert docs.approved('default', CONN, 'tenets') is None   # (none accepted)
