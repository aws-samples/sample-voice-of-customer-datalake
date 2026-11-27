"""voc-retention attributes each workspace it enters (7.84.00, the follow-up of 7.76.00; TENETS.md D8).

The deployment's erasure by email and the retention window run as the deployment (``DEPLOYMENT``), but walk every
workspace's items, projects, participants, test responses, memberships and exports. While a step works inside one
workspace, the shared logger's ``workspace_id`` (shared/usage_meter.py, the Bedrock meter's attribution) is that
workspace's, so a line it writes about the workspace's rows shows in that workspace's trail, never in the deployment
admins' System logs; after the step it is the deployment's again (``workspaces.inside``).
"""
from __future__ import annotations

import logging.handlers
from collections.abc import Callable, Iterator
from typing import Any, Final
from unittest.mock import patch

import pytest

from jobs.retention import exports, form_tests, handler, members, participants, workspaces
from jobs.retention.test.conftest import days_ago, erasure_job, put_feedback
from jobs.retention.test.test_export_erasure import _seed_exports
from jobs.retention.test.test_participant_erasure import _person, people  # noqa: F401  (the fixture)
from jobs.retention.test.test_project_erasure import _list_workspace
from jobs.retention.test.test_workspace_erasure import BASIS, JOB_ID, WS, WS_TWO, put_workspace_feedback
from shared import retention, usage_meter
from shared.logging import logger
from shared.ws_repo import WorkspaceScope

ADDRESS: Final = 'jane.reviewer@example.com'
DEPLOYMENT: Final = usage_meter.DEPLOYMENT


@pytest.fixture
def lines() -> Iterator[_Lines]:
    """The probe lines the shared logger writes (``_Lines.probes``: what, and its ``workspace_id`` tag)."""
    handler_ = logging.handlers.BufferingHandler(capacity=100_000)   # keeps every record (never flushed here)
    logger._logger.addHandler(handler_)
    usage_meter.reset()
    try:
        yield _Lines(handler_)
    finally:
        logger._logger.removeHandler(handler_)
        usage_meter.reset()


class _Lines:
    """The probe lines, read when asked (the handler keeps filling them)."""

    def __init__(self, records: logging.handlers.BufferingHandler) -> None:
        self._records = records

    def probes(self) -> list[tuple[str, object]]:
        return [(str(record.msg).removeprefix('probe '), getattr(record, 'workspace_id', None))
                for record in self._records.buffer if str(record.msg).startswith('probe ')]


def _expected(scope: object) -> str:
    return scope.ws if isinstance(scope, WorkspaceScope) else DEPLOYMENT


def _probe(what: str, real: Callable[..., Any], scope_of: Callable[..., object]) -> Callable[..., Any]:
    """``real`` that first logs one line naming ``what`` and the scope it works in."""
    def probed(*args: Any, **kwargs: Any) -> Any:
        logger.info(f'probe {what} {_expected(scope_of(*args, **kwargs))}')
        return real(*args, **kwargs)
    return probed


def _fail(message: str) -> None:
    """A step's failure (a call, so the line after the block reads as reachable)."""
    raise RuntimeError(message)


class TestInside:
    def test_it_attributes_the_workspace_inside_and_the_one_before_after(self):
        usage_meter.attribute(None)
        with workspaces.inside(WorkspaceScope(WS)):
            assert usage_meter.current_attribution() == WS
            with workspaces.inside(WorkspaceScope(WS_TWO)):
                assert usage_meter.current_attribution() == WS_TWO
            assert usage_meter.current_attribution() == WS
        assert usage_meter.current_attribution() == DEPLOYMENT

    def test_the_deployment_s_own_rows_keep_the_attribution_as_it_is(self):
        usage_meter.attribute(WS)  # a workspace's own job
        with workspaces.inside(None):
            assert usage_meter.current_attribution() == WS
        usage_meter.attribute(None)
        with workspaces.inside(None):
            assert usage_meter.current_attribution() == DEPLOYMENT

    def test_a_step_that_raises_still_resets_it(self):
        usage_meter.attribute(None)
        with pytest.raises(RuntimeError, match='a failed step'), workspaces.inside(WorkspaceScope(WS)):
            _fail('a failed step')
        assert usage_meter.current_attribution() == DEPLOYMENT

    def test_a_line_logged_inside_carries_the_workspace_and_one_after_the_deployment(self, lines):
        usage_meter.attribute(None)
        with workspaces.inside(WorkspaceScope(WS)):
            logger.info('probe inside')
        logger.info('probe after')
        assert lines.probes() == [('inside', WS), ('after', DEPLOYMENT)]


def _item_scope(_table: Any, _s3: Any, _bucket: str, item: dict[str, Any]) -> object:
    return retention.item_scope(item)


def _member_scope(_table: Any, row: dict[str, Any]) -> object:
    return WorkspaceScope(str(row['pk']).removeprefix('WS#'))


@pytest.mark.usefixtures('people')
def test_every_workspace_step_of_the_deployment_s_erasure_logs_as_that_workspace(aws, people, lines,  # noqa: F811
                                                                                worker_context):
    """The deployment's erasure by email over the deployment's and two workspaces' rows: its items, form test
    responses, memberships, projects' walk, participants, exports and lineage marks each log, inside a workspace, as
    that workspace; the deployment's rows, and every line after the run, as the deployment."""
    for ws, name in ((WS, 'Alpha'), (WS_TWO, 'Beta')):
        _list_workspace(aws, ws, name)
        _seed_exports(aws, ws)
        put_workspace_feedback(aws, ws, f'fb_{name.lower()}', metadata={'email': ADDRESS})
        aws['workspaces'].put_item(Item={'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-jane', 'email': ADDRESS,
                                         'role': 'viewer'})
        _person(people, ADDRESS, WorkspaceScope(ws))
    put_feedback(aws, 'fb_deployment', metadata={'email': ADDRESS})
    _person(people, ADDRESS, None)
    probes = [
        patch.object(retention, 'delete_item', _probe('item', retention.delete_item, _item_scope)),
        patch.object(members, 'deidentify', _probe('member', members.deidentify, _member_scope)),
        patch.object(workspaces, 'registry_step',
                     _probe('projects', workspaces.registry_step, lambda _t, _r, scope, *_a, **_k: scope)),
        patch.object(participants.ParticipantEraser, '_people',
                     _probe('participant', participants.ParticipantEraser._people, lambda _self, scope: scope)),
        patch.object(form_tests.FormTestEraser, '_page',
                     _probe('form_tests', form_tests.FormTestEraser._page, lambda _self, scope, _start: scope)),
        patch.object(exports, 'release_after_erasure',
                     _probe('exports', exports.release_after_erasure, lambda *_a: _current_workspace())),
    ]
    for probe in probes:
        probe.start()
    try:
        result = handler.handle_event(erasure_job(aws, JOB_ID, 'email', ADDRESS, legal_basis=BASIS,
                                                  started_by_sub='sub-admin'), worker_context)
    finally:
        for probe in probes:
            probe.stop()
    logger.info('probe after the run')

    assert result['status'] == 'completed'
    seen = lines.probes()
    # Each probe line names the scope its step worked in; its tag must be that scope's.
    for what, tag in seen[:-1]:
        assert what.rsplit(' ', 1)[1] == tag, (what, tag)
    kinds = {(what.split(' ')[0], tag) for what, tag in seen[:-1]}
    for kind in ('item', 'member', 'projects', 'participant', 'form_tests'):
        assert {(kind, WS), (kind, WS_TWO)} <= kinds, kind
    assert {('item', DEPLOYMENT), ('participant', DEPLOYMENT), ('form_tests', DEPLOYMENT)} <= kinds
    assert {('exports', WS), ('exports', WS_TWO)} <= kinds
    assert seen[-1] == ('after the run', DEPLOYMENT)


def _current_workspace() -> object:
    """The scope the attribution says (the probe of a call that takes no scope of its own)."""
    current = usage_meter.current_attribution()
    return WorkspaceScope(current) if current.startswith('ws_') else None


def test_the_retention_window_logs_each_workspace_s_item_as_that_workspace(aws, lines, worker_context):
    from jobs.retention.test.test_handler import _profiles  # the deployment's source profiles
    _profiles(aws, {'id': 'web', 'retention_days': 30})
    put_feedback(aws, 'fb_old', date=days_ago(400))
    put_workspace_feedback(aws, WS, 'fb_ws_old', date=days_ago(400))

    with patch.object(retention, 'delete_item', _probe('item', retention.delete_item, _item_scope)):
        assert handler.handle_event({'mode': 'retention'}, worker_context)['status'] == 'completed'

    assert sorted(lines.probes()) == sorted([(f'item {DEPLOYMENT}', DEPLOYMENT), (f'item {WS}', WS)])
