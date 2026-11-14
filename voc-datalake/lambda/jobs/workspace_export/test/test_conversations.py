"""voc-workspace-export, 7.24.00 (jobs/workspace_export/conversations.py): the members' conversations are not
included; the manifest gives only how many people have any. The owners are read from the workspace's list (``sk``
only), each owner's partition asked with one ``Select COUNT`` of at most one ``CONV#`` row; another workspace's and
the deployment's partitions are never read, and no subject, conversation id, message or conversation count reaches
the zip."""
from __future__ import annotations

import json
from typing import Any, Final
from unittest.mock import MagicMock

import pytest

from jobs.workspace_export import conversations, entities, handler
from jobs.workspace_export.test.conftest import OTHER, WS, Budget, World, queue, seed
from jobs.workspace_export.test.test_handler import _row, _unzip
from jobs.workspace_export.test.test_memory import _run
from shared.conversations import (
    CONVERSATION_SK_PREFIX,
    conversant_key,
    conversation_partition,
    record_conversant,
)
from shared.ws_repo import WorkspaceScope, conversants_pk, ws_table

#: Conversation owners who are not in the seeded members (a former member's conversations stay theirs too), so no
#: subject is anywhere else in the export.
FERN, GALE, HAL, IVY = 'sub-fern-5b1c', 'sub-gale-7d2e', 'sub-hal-8e3f', 'sub-ivy-9f4a'
#: Fern keeps three conversations; Gale is listed but keeps none now (only a run's cancel marker).
FERN_CONVERSATIONS: Final = ('conv_fern_1', 'conv_fern_2', 'conv_fern_3')
SECRET_TEXT: Final = 'the private thing fern told the assistant'
FIRST_AT: Final = '2026-11-01T00:00:00+00:00'
SCOPE: Final = WorkspaceScope(WS)
OWNERS_KEY: Final = {'pk': f'WS#{WS}#CONVERSANTS', 'sk': FERN}


def _conversation(pk: str, conversation_id: str) -> dict[str, Any]:
    return {'pk': pk, 'sk': f'{CONVERSATION_SK_PREFIX}{conversation_id}', 'kind': 'assistant',
            'title': f'Title of {conversation_id}', 'messages': json.dumps([{'role': 'user', 'text': SECRET_TEXT}]),
            'updated_at': FIRST_AT}


def seed_owner(world: World, sub: str, conversation_ids: tuple[str, ...]) -> None:
    """``sub`` listed among the workspace's owners by the list's own writer, then their conversations, written with
    the real key builder."""
    view = ws_table(SCOPE, world.conversations)
    record_conversant(view, sub, FIRST_AT)
    for conversation_id in conversation_ids:
        view.put_item(_conversation(conversation_partition(sub, SCOPE), conversation_id))


def seed_conversations(world: World) -> None:
    """Fern (three), Gale (none), Hal (two); another workspace's and the deployment's conversations beside them."""
    seed_owner(world, FERN, FERN_CONVERSATIONS)
    seed_owner(world, GALE, ())
    seed_owner(world, HAL, ('conv_hal_1', 'conv_hal_2'))
    view = ws_table(SCOPE, world.conversations)
    view.put_item({'pk': conversation_partition(FERN, SCOPE), 'sk': 'RUNCANCEL#conv_fern_1', 'at': FIRST_AT})
    view.put_item({'pk': conversation_partition(GALE, SCOPE), 'sk': 'RUNCANCEL#conv_gale_gone', 'at': FIRST_AT})
    other = WorkspaceScope(OTHER)
    record_conversant(ws_table(other, world.conversations), IVY, FIRST_AT)
    for n in range(4):
        world.conversations.put_item(Item=_conversation(conversation_partition(IVY, other), f'conv_other_{n}'))
    for n in range(5):
        world.conversations.put_item(Item=_conversation(conversation_partition(GALE, None), f'conv_own_{n}'))


def _queried(world: World) -> list[dict[str, Any]]:
    """Every Query of voc-conversations the export sends (botocore's own parameters, before the call)."""
    seen: list[dict[str, Any]] = []

    def record(params: dict[str, Any], **_kwargs: Any) -> None:
        if params.get('TableName') == world.conversations.name:
            seen.append(dict(params))

    world.conversations.meta.client.meta.events.register('provide-client-params.dynamodb.Query', record)
    return seen


def _counted(files: dict[str, bytes]) -> dict[str, Any]:
    return json.loads(files['manifest.json'])['conversations']


def test_the_manifest_gives_how_many_people_have_any_and_nothing_else(world):
    """Fern and Hal have conversations, Gale is listed with none (cancel markers only): two people. Another
    workspace's owner and Gale's own conversations outside the workspace are not counted."""
    seed(world)
    seed_conversations(world)
    _run(world)
    assert _counted(_unzip(world)) == {'counted': True, 'people': 2, 'note': entities.CONVERSATIONS_NOTE}


@pytest.mark.parametrize('people', [0, 1, 2, 3])
def test_people_is_given_as_it_is_at_any_size(world, people):
    """No total, so no threshold: the number says only how many people have any (the note says what comparing two
    exports shows)."""
    seed(world)
    seed_owner(world, GALE, ())
    for n, sub in enumerate((FERN, HAL, IVY)[:people]):
        seed_owner(world, sub, tuple(f'conv_{n}_{m}' for m in range(n + 1)))
    _run(world)
    assert _counted(_unzip(world))['people'] == people


def test_the_note_says_what_the_number_reveals_and_promises_nothing():
    assert 'not included' in entities.CONVERSATIONS_NOTE
    assert 'no copy of their own' in entities.CONVERSATIONS_NOTE
    assert 'started using the assistant' in entities.CONVERSATIONS_NOTE
    assert 'planned' not in json.dumps([entities.CONVERSATIONS_NOTE, entities.CONVERSATIONS_NOT_COUNTED,
                                        entities.EXCLUDED['conversations']])


def test_no_subject_conversation_id_message_or_total_is_anywhere_in_the_zip(world):
    seed(world)
    seed_conversations(world)
    _run(world)
    files = _unzip(world)
    every = json.dumps({name: body.decode('utf-8', 'replace') for name, body in files.items()})
    leaked = [text for text in (FERN, GALE, HAL, IVY, SECRET_TEXT, 'conv_fern', 'conv_gale', 'conv_hal',
                                'conv_other', 'conv_own', 'RUNCANCEL#', 'CONVERSANTS') if text in every]
    assert leaked == []
    assert not [name for name in files if name.startswith('conversations/')]
    assert set(_counted(files)) == {'counted', 'people', 'note'}
    assert 'conversations' in json.loads(files['manifest.json'])['excluded']


def test_another_workspaces_and_the_deployments_conversations_are_never_read(world):
    seed(world)
    seed_conversations(world)
    queried = _queried(world)
    _run(world)
    partitions = [str(params['ExpressionAttributeValues'][':p']) for params in queried]
    assert sorted(partitions) == sorted([conversants_pk(SCOPE), *(conversation_partition(sub, SCOPE)
                                                                  for sub in (FERN, GALE, HAL))])
    assert all(partition.startswith(f'WS#{WS}#') for partition in partitions)


def test_the_owner_list_is_read_for_its_keys_only_and_each_owner_asked_for_one_row(world):
    """What the grants allow (lib/stacks/workspace-export-worker.ts): the list projected to ``sk`` with
    ``SPECIFIC_ATTRIBUTES``; an owner's partition with ``Select COUNT``, ``Limit`` 1, exactly the ``CONV#`` key
    condition, no start key, no filter. IAM holds none of the last four: only this code does."""
    seed(world)
    seed_conversations(world)
    queried = _queried(world)
    _run(world)
    # The owner list's one page, then one Query each for Fern, Gale and Hal.
    assert len(queried) == 4
    owners = conversants_pk(SCOPE)
    for params in queried:
        names = params['ExpressionAttributeNames']
        if params['ExpressionAttributeValues'][':p'] == owners:
            assert (params['Select'], params['ProjectionExpression'], names['#sk']) == ('SPECIFIC_ATTRIBUTES', '#sk',
                                                                                         'sk')
        else:
            assert (params['Select'], params['Limit']) == ('COUNT', 1)
            assert params['KeyConditionExpression'] == '#p = :p AND begins_with(#sk, :conversation)'
            assert params['ExpressionAttributeValues'] == {':p': params['ExpressionAttributeValues'][':p'],
                                                           ':conversation': CONVERSATION_SK_PREFIX}
            assert 'ProjectionExpression' not in params
            assert 'ExclusiveStartKey' not in params
        assert 'FilterExpression' not in params


def test_the_owners_request_is_exactly_one_conversation_row_counted():
    """Pinned: a ``begins_with`` or ``BETWEEN`` on a longer prefix, or no limit, would probe a person's conversation
    ids or count them, which the COUNT grant cannot refuse."""
    assert conversations._CONVERSATION_ROWS == {
        'sort_condition': 'begins_with(#sk, :conversation)', 'Select': 'COUNT', 'Limit': 1,
        'ExpressionAttributeNames': {'#sk': 'sk'}, 'ExpressionAttributeValues': {':conversation': 'CONV#'}}


def test_hand_overs_between_owners_resume_without_counting_twice(world):
    """An invocation of two Queries: the count hands over between owners, the owners still to do in the checkpoint,
    and every person is counted once."""
    seed(world)
    seed_conversations(world)
    seed_owner(world, IVY, ('conv_ivy_1',))
    event = {**queue(world), 'run': {'generation': 0, 'phase': handler.CONVERSATION_COUNTS}}
    payloads: list[dict[str, Any]] = []
    result: dict[str, Any] = {}
    for _ in range(40):
        world.invoke.reset_mock()
        result = handler.handle_event(event, Budget(1))
        if result['status'] != 'continued':
            break
        [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
        payloads.append(event)
    assert result['status'] == 'completed'
    states = [payload['run']['conversation_count'] for payload in payloads]
    assert any(0 < len(state['subs']) < 4 for state in states)
    assert _counted(_unzip(world))['people'] == 3


def test_a_count_stops_after_a_query_when_the_time_is_gone_and_goes_on_from_its_checkpoint():
    """One Query at least, then a stop with more to do; the state, carried as JSON and checked as the handler checks
    it, goes on from the next owner."""
    view = MagicMock()
    view.query.side_effect = [{'Items': [{'sk': FERN}, {'sk': GALE}], 'LastEvaluatedKey': OWNERS_KEY},
                              {'Count': 1}, {'Count': 0}, {'Items': []}]
    source = conversations.ConversationCount(SCOPE, view)
    state = conversations.fresh_state()
    assert source.count(state, lambda: False) is False
    assert (state['subs'], state['owners'], state['owners_done']) == ([FERN, GALE], OWNERS_KEY, False)
    carried = conversations.carried_state(json.loads(json.dumps(state)), SCOPE)
    assert source.count(carried, lambda: False) is False
    assert (carried['subs'], carried['people']) == ([GALE], 1)
    carried = conversations.carried_state(json.loads(json.dumps(carried)), SCOPE)
    assert source.count(carried, lambda: True) is True
    assert (carried['people'], carried['done']) == (1, True)
    assert view.query.call_args_list[1].args == ('pk', f'WS#{WS}#USER#{FERN}')
    assert view.query.call_args_list[3].kwargs['ExclusiveStartKey'] == OWNERS_KEY


@pytest.mark.parametrize(('broken', 'message'), [
    ({'subs': 'sub-fern'}, 'subs is not a page of owners'),
    ({'subs': [FERN, '']}, 'subs is not a page of owners'),
    ({'subs': [FERN, 7]}, 'subs is not a page of owners'),
    ({'subs': [f'sub-{n}' for n in range(conversations.OWNER_PAGE + 1)]}, 'subs is not a page of owners'),
    ({'people': -1}, 'people is not a count'),
    ({'people': '3'}, 'people is not a count'),
    ({'people': True}, 'people is not a count'),
    ({'owners': 'a key'}, 'owners is not a key'),
    ({'owners': {'pk': f'WS#{WS}#CONVERSANTS'}}, 'owners is not a key'),
    ({'owners': {**OWNERS_KEY, 'gsi1pk': 'x'}}, 'owners is not a key'),
    ({'owners': {**OWNERS_KEY, 'sk': 7}}, 'owners is not a key'),
    ({'owners': {'pk': f'WS#{OTHER}#CONVERSANTS', 'sk': FERN}}, "owners is not this workspace's owner list"),
    ({'owners': {'pk': f'WS#{WS}#USER#{FERN}', 'sk': 'CONV#a'}}, "owners is not this workspace's owner list"),
    ({'done': 'yes'}, 'done is not a flag'),
    ({'owners_done': 'no'}, 'owners_done is not a flag'),
    ({'cursor': None}, 'conversation_count is not a count state'),
], ids=lambda case: json.dumps(case)[:40])
def test_a_malformed_carried_count_fails_the_job(world, broken, message):
    """Each field of a carried count is checked (conversations.py ``carried_state``): a wrong shape is a malformed
    run state, so the job fails cleanly (handler.py ``_fail_malformed``) instead of counting from it."""
    with pytest.raises(ValueError, match=message):
        conversations.carried_state({**conversations.fresh_state(), **broken}, SCOPE)
    seed(world)
    event = {**queue(world), 'run': {'generation': 0, 'phase': handler.CONVERSATION_COUNTS,
                                     'conversation_count': {**conversations.fresh_state(), **broken}}}
    assert handler.handle_event(event, Budget())['status'] == 'failed'
    assert _row(world)['error'] == handler.MALFORMED_RUN


def test_an_absent_carried_count_is_the_fresh_state():
    assert conversations.carried_state(None, SCOPE) == conversations.fresh_state()
    assert conversations.carried_state({}, SCOPE) == conversations.fresh_state()
    carried = conversations.carried_state({'subs': [FERN], 'owners': OWNERS_KEY, 'people': 2}, SCOPE)
    assert (carried['subs'], carried['owners'], carried['people']) == ([FERN], OWNERS_KEY, 2)


@pytest.mark.parametrize(('carried', 'counted'), [
    ({'phase': handler.COMPLETING}, False),  # an earlier release's completion: past the count
    ({'phase': 10}, False),  # 4b's completion
    ({'phase': handler.MEMORY_COUNTS}, True),  # an earlier release's memory counts: the count still comes
    ({'phase': handler.COMPLETING, 'conversations_counted': True,
      'conversation_count': {'people': 2, 'done': True}}, True),  # this release's own completion
])
def test_an_export_resumed_from_an_earlier_release_past_the_count_says_they_were_not_counted(world, carried, counted):
    seed(world)
    seed_conversations(world)
    event = {**queue(world), 'run': {'generation': 0, **carried}}
    assert handler.handle_event(event, Budget())['status'] == 'completed'
    section = _counted(_unzip(world))
    if counted:
        assert section == {'counted': True, 'people': 2, 'note': entities.CONVERSATIONS_NOTE}
    else:
        assert section == {'counted': False, 'people': None, 'note': entities.CONVERSATIONS_NOT_COUNTED}


def test_a_run_past_the_count_keeps_saying_so_across_hand_overs(world):
    seed(world)
    event = {**queue(world), 'run': {'generation': 0, 'phase': handler.COMPLETING}}
    assert handler.handle_event(event, Budget(0))['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    assert following['run']['conversations_counted'] is False
    assert handler.RunState.from_event(following, SCOPE).conversations_counted is False


def test_the_count_follows_the_memory_counts():
    assert handler.PHASES[-3:] == (handler.MEMORY_COUNTS, handler.CONVERSATION_COUNTS, handler.COMPLETING)
    assert handler.phase_of(10) == handler.COMPLETING


def test_the_owner_list_and_the_owners_partitions_are_the_workspaces_own():
    assert conversant_key(SCOPE, FERN) == {'pk': f'WS#{WS}#CONVERSANTS', 'sk': FERN}
    assert conversation_partition(FERN, SCOPE) == f'WS#{WS}#USER#{FERN}'
    assert not WorkspaceScope(OTHER).owns(conversation_partition(FERN, SCOPE))
