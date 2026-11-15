"""The hard delete's comments child (of the projects entry) and its docshares entry, on moto (docs/multi-workspace.md,
the project plan, 3e; 7.35.00): a workspace's comment partitions, found from each registered project's list of its
commented series, and its review links, found from its registry, each routing row released only while it names the
workspace; nothing of the other workspace or the deployment is touched, and a stop anywhere resumes."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest

from jobs.workspace_delete import handler, sweeps
from jobs.workspace_delete.test.conftest import (
    OTHER,
    WS,
    World,
    project_id_of,
    request_job,
    seed_deployment,
    seed_workspace,
)
from jobs.workspace_delete.test.test_sweeps import _delete, _stopped_partway, run
from shared.document_comments import put_thread, thread_item, user_author
from shared.document_share import create_share
from shared.project_keys import comments_pk, project_pk, review_link_key, review_link_registry_pk
from shared.review_share_audience import share_key
from shared.ws_repo import WorkspaceScope

SERIES = ('ser_' + 'a' * 24, 'ser_' + 'b' * 24)
DOCUMENT = {'document_id': 'doc_1', 'version': 1}
ANYONE = {'audience': {'mode': 'anyone', 'domains': [], 'emails': []}, 'expires_in_days': 30}


@pytest.fixture
def seeded(world: World) -> Iterator[World]:
    seed_workspace(world, WS, status='deleting')
    seed_workspace(world, OTHER, status='active')
    seed_deployment(world)
    request_job(world)
    with patch.dict('os.environ', {'PROJECTS_TABLE': world.projects.name}):
        yield world


def _rows(world: World, pk: str) -> list[dict]:
    return world.projects.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


def _scope(ws: str | None) -> WorkspaceScope | None:
    return WorkspaceScope(ws) if ws else None


def _comment(world: World, ws: str | None, project_id: str, series_id: str, text: str = 'Fridays are late') -> None:
    scope = _scope(ws)
    put_thread(world.projects, thread_item(project_id=project_id, series_id=series_id, document=DOCUMENT,
                                           author=user_author('sub-ada', 'Ada'), text=text, anchor=None,
                                           workspace=scope), workspace=scope)


def _share(world: World, ws: str | None, project_id: str, series_id: str = SERIES[0]) -> str:
    share, _created = create_share(world.projects, project_id=project_id, document_id='doc_1', creator={'sub': 's'},
                                   series={'series_id': series_id, 'document_type': 'prd', 'base_title': 'Plan'},
                                   values=ANYONE, workspace=_scope(ws))
    return str(share['share_id'])


def _seed_comments(world: World) -> dict[str, list[str]]:
    """Two series of the workspace's project with threads, one of the other workspace's, one of the deployment's
    project; the comment partitions, by owner."""
    project, other = project_id_of(WS), project_id_of(OTHER)
    for series_id in SERIES:
        for n in range(3):
            _comment(world, WS, project, series_id, f'note {n}')
    _comment(world, OTHER, other, SERIES[0])
    _comment(world, None, 'proj_d', SERIES[0])
    return {'ws': [comments_pk(project, s, workspace=WorkspaceScope(WS)) for s in SERIES],
            'other': [comments_pk(other, SERIES[0], workspace=WorkspaceScope(OTHER))],
            'deployment': [comments_pk('proj_d', SERIES[0])]}


class TestComments:
    """The projects entry's comments child: every series a registered project lists, its comment partition in full,
    before the project's own partitions (which hold the list)."""

    def test_every_listed_series_comment_partition_goes_and_no_other(self, seeded):
        partitions = _seed_comments(seeded)
        counts = run(seeded, 'projects')
        assert [_rows(seeded, pk) for pk in partitions['ws']] == [[], []]
        assert [len(_rows(seeded, pk)) for pk in partitions['other'] + partitions['deployment']] == [1, 1]
        assert counts['comment_series'] == 2
        # The list went with the project's own partition.
        assert _rows(seeded, project_pk(project_id_of(WS), workspace=WorkspaceScope(WS))) == []

    def test_a_links_pointer_in_its_series_partition_goes_with_it(self, seeded):
        _share(seeded, WS, project_id_of(WS))
        pointer = comments_pk(project_id_of(WS), SERIES[0], workspace=WorkspaceScope(WS))
        assert [row['sk'] for row in _rows(seeded, pointer)] == ['SHARE']
        run(seeded, 'projects')
        assert _rows(seeded, pointer) == []

    def test_a_stop_anywhere_resumes_from_the_list(self, seeded, monkeypatch):
        partitions = _seed_comments(seeded)
        monkeypatch.setattr(sweeps, 'PAGE', 2)
        _stopped_partway(seeded, 'projects')
        assert sum(len(_rows(seeded, pk)) for pk in partitions['ws']) == 4
        run(seeded, 'projects')
        assert [_rows(seeded, pk) for pk in partitions['ws']] == [[], []]
        assert [len(_rows(seeded, pk)) for pk in partitions['other'] + partitions['deployment']] == [1, 1]

    @pytest.mark.parametrize('bad', ['ser_short', 'ser_' + 'A' * 24, 'x#y'])
    def test_a_listed_series_not_shaped_like_one_is_counted_and_reaches_nothing(self, seeded, bad):
        project = project_id_of(WS)
        scope = WorkspaceScope(WS)
        seeded.projects.put_item(Item={'pk': project_pk(project, workspace=scope), 'sk': f'COMMENT_SERIES#{bad}'})
        decoy = {'pk': comments_pk(project, bad, workspace=scope), 'sk': 'C#dc_decoy'}
        seeded.projects.put_item(Item=decoy)
        counts = run(seeded, 'projects')
        assert counts['comment_series_malformed'] == 1
        assert 'Item' in seeded.projects.get_item(Key=decoy)


def _route(world: World, share_id: str) -> dict:
    """The ``DOCSHARE#{id}`` row (``{}`` when there is none)."""
    return world.projects.get_item(Key=share_key(share_id)).get('Item') or {}


class TestDocshares:
    """The docshares entry: every link id the registry lists, its routing row released only while it names the
    workspace, its own row, then its registry row last."""

    def test_every_link_of_the_workspace_goes_and_the_others_stay(self, seeded):
        mine = [_share(seeded, WS, project_id_of(WS), series) for series in SERIES]
        theirs, deployments = _share(seeded, OTHER, project_id_of(OTHER)), _share(seeded, None, 'proj_d')
        counts = run(seeded, 'docshares')
        scope, other = WorkspaceScope(WS), WorkspaceScope(OTHER)
        assert [(_route(seeded, share_id), seeded.projects.get_item(Key=review_link_key(share_id, workspace=scope))
                 .get('Item')) for share_id in mine] == [({}, None), ({}, None)]
        assert _rows(seeded, review_link_registry_pk(scope)) == []
        assert _route(seeded, theirs)['workspace_id'] == OTHER
        assert [row['sk'] for row in _rows(seeded, review_link_registry_pk(other))] == [theirs]
        assert _route(seeded, deployments)['share_id'] == deployments
        assert (counts['share_ids'], counts['share_routes_released']) == (2, 2)

    @pytest.mark.parametrize('expired', ['route', 'route-and-link'])
    def test_a_registry_row_whose_link_has_expired_is_still_swept(self, seeded, expired):
        """The registry row has no ttl, so it outlives its link: a route (or a route and its link) DynamoDB already
        removed at their ttl leaves the registry row, and the delete finds it, deletes what is left and the row."""
        share_id = _share(seeded, WS, project_id_of(WS))
        scope = WorkspaceScope(WS)
        seeded.projects.delete_item(Key=share_key(share_id))
        if expired == 'route-and-link':
            seeded.projects.delete_item(Key=review_link_key(share_id, workspace=scope))
        counts = run(seeded, 'docshares')
        assert (counts['share_ids'], counts['share_routes_not_released']) == (1, 1)
        assert _rows(seeded, review_link_registry_pk(scope)) == []
        assert _rows(seeded, f'WS#{WS}#DOCSHARE#{share_id}') == []

    def test_a_route_naming_another_workspace_is_kept(self, seeded):
        """A registry row whose id another workspace's route holds: this workspace's rows go, the route stays
        (release_share_route's condition), counted."""
        share_id = _share(seeded, OTHER, project_id_of(OTHER))
        scope = WorkspaceScope(WS)
        seeded.projects.put_item(Item={'pk': review_link_registry_pk(scope), 'sk': share_id})
        counts = run(seeded, 'docshares')
        assert _route(seeded, share_id)['workspace_id'] == OTHER
        assert _rows(seeded, review_link_registry_pk(scope)) == []
        assert counts['share_routes_not_released'] == 1

    def test_the_deployments_own_link_is_never_deleted(self, seeded):
        share_id = _share(seeded, None, 'proj_d')
        seeded.projects.put_item(Item={'pk': review_link_registry_pk(WorkspaceScope(WS)), 'sk': share_id})
        run(seeded, 'docshares')
        assert _route(seeded, share_id)['share_id'] == share_id

    def test_a_stop_between_the_release_and_the_registry_row_resumes(self, seeded):
        share_id = _share(seeded, WS, project_id_of(WS))
        real = sweeps._remove

        def fail_on_the_registry(view: Any, keys: Any) -> int:
            listed = list(keys)
            if any(str(key.get('pk')).endswith('#DOCSHARE_IDS') for key in listed):
                raise RuntimeError('stopped before the registry row')
            return real(view, listed)

        check = dict(handler.VERIFY_CHECKS)['docshares']
        with patch.object(sweeps, '_remove', fail_on_the_registry), pytest.raises(RuntimeError, match='registry'):
            run(seeded, 'docshares')
        assert (_route(seeded, share_id), check(_delete(seeded), None)) == ({}, (1, None))
        counts = run(seeded, 'docshares')
        assert check(_delete(seeded), None) == (0, None)
        assert (counts['share_ids'], counts['share_routes_not_released']) == (1, 1)

    @pytest.mark.parametrize('bad', ['shr_short', 'DOCSHARE#x', 'shr_' + 'A' * 32])
    def test_a_registry_id_not_shaped_like_a_link_id_is_counted_and_its_row_deleted(self, seeded, bad):
        scope = WorkspaceScope(WS)
        seeded.projects.put_item(Item={'pk': review_link_registry_pk(scope), 'sk': bad})
        with patch.object(sweeps, 'logger') as logger:
            counts = run(seeded, 'docshares')
        assert counts['share_ids_malformed'] == 1
        assert _rows(seeded, review_link_registry_pk(scope)) == []
        [warning] = logger.warning.call_args_list
        assert bad not in repr(warning)
