"""Properties of the workspace keys, ids and message routing (shared/ws_repo.py, shared/workspace_ids.py).

A key one workspace builds that another workspace's prefix also matches is a cross-team read or write; a message
routed to the wrong workspace, or run deployment-wide, is the same. Each property says its rule in words above it.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from shared.test.ws_properties import (
    KEY_PARTS,
    PARAMETER_PREFIXES,
    PLUGIN_IDS,
    PROPERTY,
    exactly,
    two_workspace_ids,
    workspace_ids,
)
from shared.workspace_ids import credentials_parameter_name, credentials_path, is_workspace_id, ws_key
from shared.ws_repo import (
    OutOfScopeError,
    WorkspaceScope,
    category_pk,
    channel_pk,
    control_partition,
    control_query,
    conversants_pk,
    date_pk,
    erasure_job_pk,
    export_job_pk,
    exports_prefix,
    feedback_id_pk,
    feedback_key,
    is_workspace_key,
    memory_company_pk,
    memory_cursor_pk,
    memory_event_pk,
    memory_import_pk,
    memory_status_pk,
    message_scope,
    metric_pk,
    metric_type,
    partition_scope,
    plugin_config_history_key,
    plugin_config_history_pk,
    plugin_config_key,
    plugin_config_pk,
    reprocess_job_pk,
    s3_key,
    s3_prefix,
    scope_from_key,
    scope_from_lookup,
    scope_from_message,
    scraper_run_pk,
    source_run_pk,
    urgency_pk,
    watermark_key,
)

#: Every partition key builder of the layer, each given the scope and one part where it takes one.
PARTITION_BUILDERS = (
    lambda scope, part: feedback_key(scope, part, part)['pk'],
    date_pk, category_pk, urgency_pk, feedback_id_pk, channel_pk, source_run_pk, scraper_run_pk, memory_event_pk,
    lambda scope, part: metric_pk(scope, part, part),
    metric_type,
    lambda scope, part: memory_status_pk(scope, part, part),
    lambda scope, part: watermark_key(scope, part, part),
    lambda scope, part: plugin_config_key(scope, part)['pk'],
    lambda scope, part: plugin_config_history_key(scope, part, part, part)['pk'],
    lambda scope, _part: erasure_job_pk(scope),
    lambda scope, _part: reprocess_job_pk(scope),
    lambda scope, _part: export_job_pk(scope),
    lambda scope, _part: conversants_pk(scope),
    lambda scope, _part: memory_company_pk(scope),
    lambda scope, _part: memory_cursor_pk(scope),
    lambda scope, _part: memory_import_pk(scope),
    lambda scope, _part: plugin_config_pk(scope),
    lambda scope, _part: plugin_config_history_pk(scope),
)

#: A character that is never in a workspace id: lower case, the four letters Crockford leaves out, punctuation.
NOT_IN_AN_ID = st.sampled_from('ILOUilou_-#/ .abz\n\x00é')


# A workspace id is exactly ``ws_`` and a ULID: every generated one is accepted, and so is each one's shape only.
@PROPERTY
@given(workspace_ids())
def test_every_ulid_with_the_prefix_is_a_workspace_id(ws):
    assert is_workspace_id(ws)
    assert WorkspaceScope(ws).ws == ws


# One character changed to one outside the id's alphabet, one character more or less, a first character past 7,
# or the prefix in another case: none of these is a workspace id, so none of them reaches a key or a parameter.
@PROPERTY
@given(workspace_ids(), st.integers(min_value=0, max_value=28), NOT_IN_AN_ID, st.sampled_from('89ABCDEFGHJKMNPQRSTVWXYZ'))
@example('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 28, 'I', '8')
def test_a_near_miss_is_not_a_workspace_id(ws, position, char, high):
    near_misses = [
        ws[:position] + (char if char != ws[position] else 'I') + ws[position + 1:],
        ws[:position] + ws[position + 1:],
        ws[:position] + ws[position] + ws[position:],
        f'ws_{high}{ws[4:]}',
        'WS' + ws[2:],
        f' {ws}', f'{ws}\n',
    ]
    for value in near_misses:
        assert not is_workspace_id(value), value
        with pytest.raises(ValueError, match=exactly('not a workspace id')):
            ws_key(value, 'SOURCE')
        with pytest.raises(ValueError, match=exactly('not a workspace id')):
            WorkspaceScope(value)


# ``ws_key`` joins the id and the parts with ``#`` after ``WS``, and nothing else.
@PROPERTY
@given(workspace_ids(), st.lists(KEY_PARTS, max_size=4))
def test_a_key_is_the_id_and_its_parts(ws, parts):
    assert ws_key(ws, *parts) == '#'.join(['WS', ws, *parts])


# Every partition key a workspace builds is its own (``owns``, ``scope_from_key`` and ``partition_scope`` all say
# so), and no other workspace owns it, even one whose id differs in a single character.
@PROPERTY
@given(two_workspace_ids(), KEY_PARTS)
def test_a_workspace_key_is_owned_by_that_workspace_only(pair, part):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    for build in PARTITION_BUILDERS:
        key = build(mine, part)
        assert key.startswith(mine.prefix)
        assert mine.owns(key)
        assert not theirs.owns(key)
        assert is_workspace_key(key)
        assert scope_from_key(key) == mine
        assert partition_scope(key) == mine


# Each key is exactly the one the layout (the module docstring) gives, so two kinds of row never share a partition
# and every reader finds the rows a writer put: the parts after ``WS#{ws}#``, in order.
@PROPERTY
@given(workspace_ids(), KEY_PARTS, KEY_PARTS, KEY_PARTS)
def test_each_key_is_the_documented_layout(ws, a, b, c):
    scope = WorkspaceScope(ws)
    p = f'WS#{ws}#'
    assert feedback_key(scope, a, b) == {'pk': f'{p}SOURCE#{a}', 'sk': f'FEEDBACK#{b}'}
    assert date_pk(scope, a) == f'{p}DATE#{a}'
    assert category_pk(scope, a) == f'{p}CATEGORY#{a}'
    assert urgency_pk(scope, a) == f'{p}URGENCY#{a}'
    assert feedback_id_pk(scope, a) == f'{p}FEEDBACK#{a}'
    assert channel_pk(scope, a) == f'{p}CHANNEL#{a}'
    assert metric_pk(scope, a) == f'{p}METRIC#{a}'
    assert metric_pk(scope, a, b, c) == f'{p}METRIC#{a}#{b}#{c}'
    assert metric_type(scope, a) == f'{p}{a}'
    assert source_run_pk(scope, a) == f'{p}SOURCE_RUN#{a}'
    assert scraper_run_pk(scope, a) == f'{p}SCRAPER_RUN#{a}'
    assert erasure_job_pk(scope) == f'{p}JOB#erasure'
    assert reprocess_job_pk(scope) == f'{p}JOB#category_reprocess'
    assert export_job_pk(scope) == f'{p}JOB#export'
    assert conversants_pk(scope) == f'{p}CONVERSANTS'
    assert memory_company_pk(scope) == f'{p}MEM#company'
    assert memory_status_pk(scope, a, b) == f'{p}MEMSTATUS#{a}#{b}'
    assert memory_cursor_pk(scope) == f'{p}MEMCURSOR'
    assert memory_import_pk(scope) == f'{p}MEMIMPORT'
    assert memory_event_pk(scope, a) == f'{p}MEMEVT#{a}'
    assert plugin_config_pk(scope) == f'{p}PLUGIN_CONFIG'
    assert plugin_config_key(scope, a) == {'pk': f'{p}PLUGIN_CONFIG', 'sk': a}
    assert plugin_config_history_pk(scope) == f'{p}PLUGIN_CONFIG#HISTORY'
    assert plugin_config_history_key(scope, a, b, c) == {'pk': f'{p}PLUGIN_CONFIG#HISTORY', 'sk': f'{a}#{b}#{c}'}
    assert watermark_key(scope, a, b) == f'{p}{a}#{b}'


# A key that names an item needs every part it names it by: an empty feedback id, plugin id, time or token builds
# no key (and so never one that a second item with another empty part would share).
@PROPERTY
@given(workspace_ids(), KEY_PARTS, KEY_PARTS, st.integers(min_value=0, max_value=2))
def test_an_item_key_with_an_empty_part_is_refused(ws, a, b, empty):
    scope = WorkspaceScope(ws)
    with pytest.raises(ValueError, match=exactly('a feedback item needs an id')):
        feedback_key(scope, a, '')
    with pytest.raises(ValueError, match=exactly('a plugin config key needs a plugin id')):
        plugin_config_key(scope, '')
    parts = [a, b, b]
    parts[empty] = ''
    with pytest.raises(ValueError, match=exactly('a plugin config history key needs a plugin id, a time and a token')):
        plugin_config_history_key(scope, *parts)
    with pytest.raises(ValueError, match=exactly('a key needs non-empty parts')):
        feedback_key(scope, '', a)


# A key needs at least one part, and no empty one: the bare prefix belongs to no row.
@PROPERTY
@given(workspace_ids(), st.lists(KEY_PARTS, max_size=3), st.lists(KEY_PARTS, max_size=3))
def test_a_key_with_no_part_or_an_empty_one_is_refused(ws, before, after):
    scope = WorkspaceScope(ws)
    with pytest.raises(ValueError, match=exactly('a key needs non-empty parts')):
        scope.key(*before, '', *after)
    with pytest.raises(ValueError, match=exactly('a key needs non-empty parts')):
        scope.key()
    assert not scope.owns(scope.prefix)
    assert not scope.owns(scope.prefix[:-1])


# ``owns`` is exactly "a string that starts with the scope's prefix and has more after it".
@PROPERTY
@given(workspace_ids(), st.one_of(st.text(max_size=40), st.none(), st.integers(), st.binary(max_size=8)))
def test_owns_is_the_prefix_and_something_after_it(ws, suffix):
    scope = WorkspaceScope(ws)
    candidate = scope.prefix + suffix if isinstance(suffix, str) else suffix
    expected = isinstance(candidate, str) and candidate.startswith(scope.prefix) and candidate != scope.prefix
    assert scope.owns(candidate) is expected


# A stored key names its workspace only as ``WS#{ws}#{something}``: the scope it gives is that id's, and a key that
# stops after the id, names a malformed id or starts otherwise belongs to no workspace (ValueError, never a guess).
@PROPERTY
@given(workspace_ids(), st.text(min_size=1, max_size=30), st.text(max_size=30))
@example('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'SOURCE', '')
def test_a_stored_key_names_one_workspace_or_none(ws, rest, noise):
    assert scope_from_key(f'WS#{ws}#{rest}') == WorkspaceScope(ws)
    for not_a_key in (f'WS#{ws}', f'WS#{ws}#', f'ws#{ws}#{rest}', f'AUDIT#WS#{ws}#{rest}', f'X{noise}#{ws}#{rest}'):
        with pytest.raises(ValueError, match=exactly('not a workspace key')):
            scope_from_key(not_a_key)
    if not noise.startswith('WS#'):
        assert partition_scope(noise) is None
        assert not is_workspace_key(noise)


# A row whose partition starts ``WS#`` but names no workspace is never taken as deployment-wide: the erasure worker
# that reads every copy of a row would otherwise skip it.
@PROPERTY
@given(st.text(max_size=30).filter(lambda rest: not is_workspace_id(rest.partition('#')[0]) or '#' not in rest
                                   or not rest.partition('#')[2]))
def test_a_ws_row_that_names_no_workspace_is_refused_not_skipped(rest):
    key = f'WS#{rest}'
    assert is_workspace_key(key)
    with pytest.raises(ValueError, match=r'^not a workspace (key|id)$'):
        partition_scope(key)


# An object key stays in its workspace's folder: it starts ``ws/{ws}/``, no other workspace's folder, and has no
# empty, ``.`` or ``..`` segment after it; a part that would add one is refused, whatever the other parts are.
@PROPERTY
@given(two_workspace_ids(), st.lists(KEY_PARTS, min_size=1, max_size=4),
       st.sampled_from(['', '.', '..', 'a//b', '../x', 'x/..', '/x', 'x/', './x']), st.integers(min_value=0, max_value=4))
def test_an_object_key_stays_in_its_workspace_folder(pair, parts, bad, position):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    clean = [part for part in parts if all(segment not in ('', '.', '..') for segment in part.split('/'))] or ['raw']
    key = s3_key(mine, *clean)
    assert key == '/'.join(['ws', mine.ws, *clean])
    assert key.startswith(s3_prefix(mine))
    assert not key.startswith(s3_prefix(theirs))
    assert all(segment not in ('', '.', '..') for segment in key[len(s3_prefix(mine)):].split('/'))
    assert exports_prefix(mine) == f'{s3_prefix(mine)}exports/'
    poisoned = [*clean[:position], bad, *clean[position:]]
    with pytest.raises(ValueError, match=exactly('an object key needs non-empty segments')):
        s3_key(mine, *poisoned)
    with pytest.raises(ValueError, match=exactly('an object key needs non-empty segments')):
        s3_key(mine)


# The control-plane partitions are the workspace's own ``WS#{ws}`` and ``AUDIT#WS#{ws}``, which no data-path scope
# owns (so the table guard refuses them), and nothing else.
@PROPERTY
@given(two_workspace_ids(), st.text(max_size=8).filter(lambda which: which not in ('meta', 'audit')))
def test_the_control_partitions_are_the_workspace_own(pair, other):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    assert control_partition(mine, 'meta') == f'WS#{mine.ws}'
    assert control_partition(mine, 'audit') == f'AUDIT#WS#{mine.ws}'
    for which in ('meta', 'audit'):
        assert not mine.owns(control_partition(mine, which))
        assert control_partition(mine, which) != control_partition(theirs, which)
    with pytest.raises(ValueError, match=exactly('a control partition is one of meta, audit')):
        control_partition(mine, other)


# A control-plane read is one Query of the workspace's own control partition, its key condition built by the layer:
# a caller's index, key condition or table is refused, and so is a cursor into any other partition, before any call.
@PROPERTY
@given(two_workspace_ids(), st.sampled_from(['meta', 'audit']),
       st.lists(st.sampled_from(['IndexName', 'KeyConditionExpression', 'TableName', 'RequestItems']), min_size=1,
                max_size=4, unique=True),
       st.one_of(st.none(), st.just('begins_with(sk, :m)')))
def test_a_control_query_reads_the_workspace_own_partition(pair, which, refused, sort_condition):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    partition = control_partition(mine, which)
    table = MagicMock()
    table.query.return_value = {'Items': []}
    values = {':m': 'MEMBER#'} if sort_condition else {}
    answer = control_query(mine, table, which, sort_condition=sort_condition, Limit=5,
                           ExclusiveStartKey={'pk': partition, 'sk': 'META'}, ExpressionAttributeValues=values)
    assert answer == {'Items': []}
    assert table.query.call_args.kwargs == {
        'KeyConditionExpression': '#p = :p' + (f' AND {sort_condition}' if sort_condition else ''),
        'ExpressionAttributeNames': {'#p': 'pk'}, 'ExpressionAttributeValues': {**values, ':p': partition},
        'Limit': 5, 'ExclusiveStartKey': {'pk': partition, 'sk': 'META'}}
    table = MagicMock()
    expected = [field for field in ('IndexName', 'KeyConditionExpression', 'TableName', 'RequestItems')
                if field in refused]
    with pytest.raises(OutOfScopeError, match=exactly(f'a control-plane query does not take {", ".join(expected)}')):
        control_query(mine, table, which, **dict.fromkeys(refused, 'x'))
    for cursor in ({'pk': control_partition(theirs, which), 'sk': 'META'}, {'sk': 'META'}, [('pk', partition)],
                   {'pk': control_partition(mine, 'audit' if which == 'meta' else 'meta')}):
        with pytest.raises(OutOfScopeError, match=exactly('a cursor outside the workspace')):
            control_query(mine, table, which, ExclusiveStartKey=cursor)
    assert not table.query.called


# An asynchronous message runs in the workspace its ``workspace_id`` names; with no such field it runs
# deployment-wide; with a field that is not a workspace id (None included) it is refused, never run deployment-wide.
@PROPERTY
@given(workspace_ids(), st.dictionaries(st.text(max_size=8).filter(lambda name: name != 'workspace_id'),
                                        st.text(max_size=8), max_size=3),
       st.one_of(st.none(), st.integers(), st.text(max_size=30), workspace_ids().map(str.lower)))
def test_a_message_runs_where_it_says_or_is_refused(ws, others, malformed):
    assert message_scope({**others, 'workspace_id': ws}) == (False, WorkspaceScope(ws))
    assert scope_from_message({**others, 'workspace_id': ws}) == WorkspaceScope(ws)
    assert message_scope(others) == (False, None)
    assert message_scope([('workspace_id', ws)]) == (False, None)
    if not is_workspace_id(malformed):
        assert message_scope({**others, 'workspace_id': malformed}) == (True, None)
        expected = 'not a workspace id' if isinstance(malformed, str) else 'the message names no workspace'
        with pytest.raises(ValueError, match=exactly(expected)):
            scope_from_message({**others, 'workspace_id': malformed})


# A public route reaches a workspace only through a stored routing row: a form's ``FORM#{id}`` / ``META`` row routes
# to the workspace it names, a workspace's own ``WS#{ws}`` / ``META`` row to that one; any other row shape routes to
# none (ValueError), so no caller-sent value picks the workspace.
@PROPERTY
@given(two_workspace_ids(), st.text(min_size=1, max_size=20), st.text(max_size=10).filter(lambda sk: sk != 'META'))
def test_a_public_route_follows_its_stored_row_only(pair, form_id, other_sk):
    mine, theirs = pair
    assert scope_from_lookup({'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': mine}) == WorkspaceScope(mine)
    # A form id is the whole rest of the key, ``#`` included (one ending in ``#`` too).
    assert scope_from_lookup({'pk': f'FORM#{form_id}#', 'sk': 'META', 'workspace_id': mine}) == WorkspaceScope(mine)
    assert scope_from_lookup({'pk': f'WS#{mine}', 'sk': 'META', 'workspace_id': theirs}) == WorkspaceScope(mine)
    refused = [
        {'pk': f'FORM#{form_id}', 'sk': other_sk, 'workspace_id': mine},
        {'pk': 'FORM#', 'sk': 'META', 'workspace_id': mine},
        {'pk': f'WS#{mine}#{form_id}', 'sk': 'META'},
        {'pk': f'OTHER#{form_id}', 'sk': 'META', 'workspace_id': mine},
        {'pk': None, 'sk': 'META', 'workspace_id': mine},
        {'sk': 'META', 'workspace_id': mine},
        [('pk', f'WS#{mine}'), ('sk', 'META')],
    ]
    for row in refused:
        with pytest.raises(ValueError, match=exactly('not a lookup row')):
            scope_from_lookup(row)
    # Shaped like a workspace's own row, but the id in it is not one: refused by the id rule.
    with pytest.raises(ValueError, match=exactly('not a workspace id')):
        scope_from_lookup({'pk': f'WS#{mine.replace("ws_", "WS_")}', 'sk': 'META'})
    # A form row whose workspace field is not an id routes nowhere either.
    with pytest.raises(ValueError, match=exactly('the message names no workspace')):
        scope_from_lookup({'pk': f'FORM#{form_id}', 'sk': 'META'})


# A credentials parameter is ``{prefix}/{ws}/credentials/{plugin}``: two different (workspace, plugin) pairs never
# name the same parameter, and neither name is inside the other's path, so a role scoped to one never reads another.
@PROPERTY
@given(PARAMETER_PREFIXES, two_workspace_ids(), PLUGIN_IDS, PLUGIN_IDS)
def test_a_credentials_parameter_names_one_workspace_and_plugin(prefix, pair, plugin, other_plugin):
    mine, theirs = pair
    name = credentials_parameter_name(prefix, mine, plugin)
    assert name == f'{credentials_path(prefix, mine)}/{plugin}' == f'{prefix}/{mine}/credentials/{plugin}'
    for other in {credentials_parameter_name(prefix, theirs, plugin), credentials_parameter_name(prefix, theirs,
                                                                                                 other_plugin)}:
        assert other != name
        assert not other.startswith(f'{name}/')
        assert not name.startswith(f'{other}/')
        assert not other.startswith(f'{credentials_path(prefix, mine)}/')
    if other_plugin != plugin:
        assert credentials_parameter_name(prefix, mine, other_plugin) != name


# A plugin id outside the rule (a ``/``, ``.``, ``-``, upper case, an edge ``_``, empty), a malformed workspace id
# or a prefix that is not ``/a/b`` builds no parameter name at all.
@PROPERTY
@given(PARAMETER_PREFIXES, workspace_ids(), PLUGIN_IDS,
       st.sampled_from(['', '/', '.', '..', '-', '_', 'a/b', 'a.b', 'a-b', 'A', '_a', 'a_', ' a', 'a\n', 'x' * 65]),
       st.sampled_from(['', 'voc/ws', '/voc/ws/', '/voc//ws', '/voc/../ws', '/voc/ws ', '/', '/voc.ws']),
       NOT_IN_AN_ID)
def test_a_malformed_part_builds_no_parameter_name(prefix, ws, plugin, bad_plugin, bad_prefix, char):
    with pytest.raises(ValueError, match=exactly('not a plugin id')):
        credentials_parameter_name(prefix, ws, bad_plugin)
    with pytest.raises(ValueError, match=exactly('no parameter prefix')):
        credentials_parameter_name(bad_prefix, ws, plugin)
    with pytest.raises(ValueError, match=exactly('no parameter prefix')):
        credentials_path(bad_prefix, ws)
    malformed = ws[:5] + char + ws[6:]
    with pytest.raises(ValueError, match=exactly('not a workspace id')):
        credentials_parameter_name(prefix, malformed, plugin)
    with pytest.raises(ValueError, match=exactly('not a workspace id')):
        credentials_path(prefix, malformed)
