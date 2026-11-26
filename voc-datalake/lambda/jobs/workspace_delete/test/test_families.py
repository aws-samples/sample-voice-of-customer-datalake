"""Every entry of families.py, seeded: one row (or object) of each key family the code builds, written with that
family's own builder, then the whole delete run; each is gone, or kept when its entry says ``KEPT``. A ``TTL`` entry
lives in a table the job never reaches (voc-idempotency), so it is not seeded: its reason says why. A family added to
families.py without a seed here fails, so the seeds follow the registry (test_registry.py holds the registry to the
code)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

from jobs.workspace_delete.sweeps import WORKSPACE_SETTINGS_KINDS
from jobs.workspace_delete.test.conftest import (
    OTHER,
    WS,
    World,
    day,
    request_job,
    run_to_the_end,
    seed_deployment,
    seed_workspace,
)
from jobs.workspace_delete.test.families import FAMILIES
from shared.adoption import rollup_partition
from shared.company_context import my_context_key, put_my_context
from shared.conversations import conversant_key, conversation_partition
from shared.document_comments import put_thread, thread_item, user_author
from shared.document_share import create_share
from shared.form_test_responses import TEST_RESPONSES_PK
from shared.import_runs import LIST_PK
from shared.library_keys import chunks_pk as library_chunks_pk
from shared.library_keys import item_key as library_item_key
from shared.memory_store import append_event, company_pk, cursor_key, import_key, scope_pk, status_partition
from shared.onboarding import FEEDBACK_FORM_PK
from shared.participants_keys import list_partition, participants_index_key, person_key
from shared.participants_store import create_person
from shared.platform_costs import cost_partition
from shared.project_keys import (
    job_status_pk,
    project_pk,
    project_registry_key,
    project_type_pk,
    review_link_registry_key,
    version_partition_key,
)
from shared.radar_keys import owned_row, radar_settings_key, scan_key
from shared.scoped_keys import scoped_pk
from shared.web_review_methods import methods_partition
from shared.workspace_settings import settings_key
from shared.ws_repo import (
    WATERMARK_DIRECTORY,
    WorkspaceScope,
    category_pk,
    channel_pk,
    control_partition,
    date_pk,
    delete_work_pk,
    erasure_job_pk,
    export_job_pk,
    exports_prefix,
    feedback_id_pk,
    feedback_key,
    memory_company_pk,
    memory_cursor_pk,
    memory_event_pk,
    memory_import_pk,
    memory_status_pk,
    metric_pk,
    metric_type,
    plugin_config_history_key,
    plugin_config_history_pk,
    plugin_config_key,
    plugin_config_pk,
    reprocess_job_pk,
    s3_key,
    s3_prefix,
    scraper_run_pk,
    source_run_pk,
    urgency_pk,
    user_context_owners_pk,
    watermark_directory_key,
    watermark_key,
    workspace_tombstone_key,
)

SCOPE = WorkspaceScope(WS)


@dataclass(frozen=True)
class Probe:
    """Where a seeded row is (a table of ``World`` and its key), or an object's key (``table`` ``'objects'``)."""

    table: str
    key: Any


def _put(world: World, table: str, item: dict[str, Any], key: tuple[str, ...] = ('pk', 'sk')) -> Probe:
    getattr(world, table).put_item(Item=item)
    return Probe(table, {name: item[name] for name in key})


def _item(world: World, n: str, partition: str = 'webscraper', **index: str) -> Probe:
    """A feedback item of the workspace (in a partition the feedback sweep finds), with ``index`` attributes."""
    return _put(world, 'feedback', {**feedback_key(SCOPE, partition, f'fam-{n}'), 'feedback_id': f'fam-{n}',
                                    'source_platform': 'webscraper', **index})


def _aggregate(world: World, pk: str, sk: str = 'fam', **fields: Any) -> Probe:
    return _put(world, 'aggregates', {'pk': pk, 'sk': sk, **fields})


def _memory(world: World, pk: str, sk: str, **fields: Any) -> Probe:
    return _put(world, 'memory', {'pk': pk, 'sk': sk, **fields})


def _object(world: World, key: str) -> Probe:
    world.s3.put_object(Bucket='test-raw-data-bucket', Key=key, Body=b'fam')
    return Probe('objects', key)


def _watermark(world: World) -> Probe:
    """A watermark and its directory row (set_watermark writes the row first: the sweep finds it by it)."""
    _put(world, 'aggregates', watermark_directory_key(SCOPE, 'webscraper', 'fam'))
    return _put(world, 'watermarks', {'source': watermark_key(SCOPE, 'webscraper', 'fam'), 'value': '1'},
                ('source',))


def _personal_memory(world: World) -> Probe:
    """A personal memory, found only through its status partition of the memory index."""
    return _memory(world, f'WS#{WS}#MEM#user#sub-fam', 'MEM#mem_fam_p', memory_id='mem_fam_p', scope='personal',
                   status='active', gsi1pk=memory_status_pk(SCOPE, 'personal', 'active'),
                   gsi1sk='2026-11-02T00:00:00#mem_fam_p')


def _my_context(world: World) -> Probe:
    put_my_context(world.aggregates, 'sub-fam', {'objectives': []}, updated_at='2026-11-02T00:00:00+00:00',
                   workspace=SCOPE)
    return Probe('aggregates', my_context_key('sub-fam', SCOPE))


#: A library item of the workspace (shared/library_keys.py ``lib_`` + stamp + 8 hex).
_FAM_ITEM = 'lib_20261102000000_0000fa11'


def _library_passage(world: World) -> Probe:
    """A passage of a library item, listed by the item's row (as the extraction writes them)."""
    world.projects.put_item(Item={**library_item_key(_FAM_ITEM, workspace=SCOPE), 'item_id': _FAM_ITEM})
    return _put(world, 'projects', {'pk': library_chunks_pk(_FAM_ITEM, workspace=SCOPE), 'sk': 'C#00001', 'text': 'x'})


#: A project of the workspace the family seeds sit in: registered (its registry row and claim), as a create writes.
_FAM_PROJECT = 'proj_fam'


def _registered(world: World, project_id: str = _FAM_PROJECT) -> Probe:
    world.projects.put_item(Item={'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM', 'workspace_id': WS,
                                  'claimed_at': '2026-11-02T00:00:00+00:00'})
    return _put(world, 'projects', {**project_registry_key(project_id, workspace=SCOPE),
                                    'created_at': '2026-11-02T00:00:00+00:00'})


def _project_row(world: World, table: str, pk: str, sk: str, **fields: Any) -> Probe:
    """A row of the registered family project (registered first, so the projects sweep finds it)."""
    _registered(world)
    return _put(world, table, {'pk': pk, 'sk': sk, **fields})


#: The family project's series (shared/document_series.py's shape).
_FAM_SERIES = 'ser_' + 'f' * 24


def _comment(world: World) -> Probe:
    """A thread of the family project's series (shared/document_comments.py: its series listed first)."""
    _registered(world)
    item = thread_item(project_id=_FAM_PROJECT, series_id=_FAM_SERIES, document={'document_id': 'doc_fam', 'version': 1},
                       author=user_author('sub-fam', 'Fam'), text='Fam', anchor=None, workspace=SCOPE)
    put_thread(world.projects, item, workspace=SCOPE)
    return Probe('projects', {'pk': item['pk'], 'sk': item['sk']})


def _review_link(world: World, which: str) -> Probe:
    """A review link of the family project, as shared/document_share.py makes it in the workspace: its routing row,
    its own row, its series' pointer and listing, and its registry row, in one transaction."""
    _registered(world)
    # The layer writes a routing row in voc-projects only (the table PROJECTS_TABLE names).
    with patch.dict('os.environ', {'PROJECTS_TABLE': world.projects.name}):
        share, _created = create_share(
            world.projects, project_id=_FAM_PROJECT, document_id='doc_fam',
            series={'series_id': 'ser_' + 'e' * 24, 'document_type': 'prd', 'base_title': 'Fam'},
            creator={'sub': 'sub-fam', 'name': 'Fam'},
            values={'audience': {'mode': 'anyone', 'domains': [], 'emails': []}, 'expires_in_days': 30},
            workspace=SCOPE)
    if which == 'registry':
        return Probe('projects', review_link_registry_key(str(share['share_id']), workspace=SCOPE))
    return Probe('projects', {'pk': share['pk'], 'sk': share['sk']})


def _event(world: World) -> Probe:
    """An event of a company memory the seed holds, as the store appends it."""
    append_event(world.memory, 'mem_c1', 'reinforced', workspace=SCOPE)
    rows = world.memory.query(KeyConditionExpression='pk = :p',
                              ExpressionAttributeValues={':p': memory_event_pk(SCOPE, 'mem_c1')})['Items']
    newest = max(rows, key=lambda row: str(row['sk']))
    return Probe('memory', {'pk': newest['pk'], 'sk': newest['sk']})


def _participant(world: World) -> Probe:
    """A person of the workspace, as the store writes it (its partition and guard listed in the index first)."""
    person = create_person(world.participants, email='fam@example.com', email_lc='fam@example.com', fields={},
                           origin='manual', created_by='sub-fam', workspace=SCOPE)
    return Probe('participants', person_key(str(person['person_id']), workspace=SCOPE))


def _conversation(world: World) -> Probe:
    """A conversation of a listed owner (and its Stop marker), in ``WS#{ws}#USER#{sub}``."""
    _put(world, 'conversations', {**conversant_key(SCOPE, 'sub-fam2'), 'first_at': 'x'})
    _put(world, 'conversations', {'pk': conversation_partition('sub-fam2', SCOPE), 'sk': 'RUNCANCEL#fam'})
    return _put(world, 'conversations', {'pk': conversation_partition('sub-fam2', SCOPE), 'sk': 'CONV#fam',
                                         'kind': 'assistant'})


#: Each family's seed, by its families.py name (None: not seeded, its entry says why).
SEEDS: dict[str, Callable[[World], Probe] | None] = {
    'feedback_key': lambda w: _item(w, 'key'),
    'SOURCE': lambda w: _put(w, 'feedback', {'pk': SCOPE.key('SOURCE', 'webscraper'), 'sk': 'FEEDBACK#fam-source',
                                             'feedback_id': 'fam-source', 'source_platform': 'webscraper'}),
    # A brand partition no plugin names: found by its day on the date index alone.
    'date_pk': lambda w: _item(w, 'date', 'fam-brand', gsi1pk=date_pk(SCOPE, day(0)), gsi1sk=f'{day(0)}#fam-date',
                               date=day(0)),
    'category_pk': lambda w: _item(w, 'category', gsi2pk=category_pk(SCOPE, 'delivery')),
    'urgency_pk': lambda w: _item(w, 'urgency', gsi3pk=urgency_pk(SCOPE, 'high')),
    'feedback_id_pk': lambda w: _item(w, 'id', gsi4pk=feedback_id_pk(SCOPE, 'fam-id')),
    'channel_pk': lambda w: _item(w, 'channel', gsi5pk=channel_pk(SCOPE, 'email')),
    'metric_pk': lambda w: _aggregate(w, metric_pk(SCOPE, 'daily_total'), day(1), count=1),
    # A tag counter no stored item names: found through the metric-type index.
    'metric_type': lambda w: _aggregate(w, metric_pk(SCOPE, 'daily_tag', 'fam-tag'), day(1), count=1,
                                        metric_type=metric_type(SCOPE, 'tag')),
    'source_run_pk': lambda w: _aggregate(w, source_run_pk(SCOPE, 'webscraper')),
    'scraper_run_pk': lambda w: _aggregate(w, scraper_run_pk(SCOPE, 's1')),
    'FAILURES': lambda w: _aggregate(w, SCOPE.key('FAILURES', 'webscraper')),
    'CIRCUIT': lambda w: _aggregate(w, SCOPE.key('CIRCUIT', 'webscraper')),
    'LOGS': lambda w: _aggregate(w, SCOPE.key('LOGS', 'validation', 'webscraper')),
    'erasure_job_pk': lambda w: _aggregate(w, erasure_job_pk(SCOPE), 'er_fam', status='completed'),
    'reprocess_job_pk': lambda w: _aggregate(w, reprocess_job_pk(SCOPE), 'rp_fam', status='completed'),
    'WEB_REVIEWS': lambda w: _aggregate(w, methods_partition(SCOPE), 'g2.com', best_method='browser'),
    **{f'SETTINGS#{kind}': (lambda w, kind=kind: _aggregate(w, settings_key(WS, kind)['pk'], 'config', kind=kind))
       for kind in WORKSPACE_SETTINGS_KINDS},
    'COST': lambda w: _aggregate(w, cost_partition(SCOPE), '2026-11-01', schema=1, totals={'calls': 1}),
    'ADOPTION': lambda w: _aggregate(w, rollup_partition(SCOPE), '2026-11-21', schema=1,
                                     months={'2026-11': {'projects_started': 1}}),
    # A member's own objectives, saved as the settings API saves them (its owner row first), and a former
    # member's owner row whose objectives row is already gone.
    'my_context_key': _my_context,
    'user_context_owners_pk': lambda w: _aggregate(w, user_context_owners_pk(SCOPE), 'sub-former'),
    'SETTINGS#radar': lambda w: _put(w, 'radar', {**radar_settings_key('brands', SCOPE), 'brands': []}),
    # shared/memory_store.py's own spellings of the memory partitions.
    'company_pk': lambda w: _memory(w, company_pk(SCOPE), 'MEM#mem_fam_c2', memory_id='mem_fam_c2',
                                    scope='company', status='active'),
    'scope_pk': lambda w: _memory(w, scope_pk('company', None, SCOPE), 'MEM#mem_fam_c3', memory_id='mem_fam_c3',
                                  scope='company', status='active'),
    'status_partition': lambda w: _memory(w, f'WS#{WS}#MEM#user#sub-fam2', 'MEM#mem_fam_p2', memory_id='mem_fam_p2',
                                          scope='personal', status='active',
                                          gsi1pk=status_partition('personal', 'active', SCOPE),
                                          gsi1sk='2026-11-02T00:00:00#mem_fam_p2'),
    'append_event': _event,
    'cursor_key': lambda w: _put(w, 'memory', cursor_key('fam2', SCOPE)),
    'import_key': lambda w: _put(w, 'memory', import_key('imp_fam2', SCOPE)),
    'export_job_pk': lambda w: _aggregate(w, export_job_pk(SCOPE), 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7DA',
                                          export_id='ex_01JC3Q8ZK6V7W9X2Y4A5B6C7DA', status='failed'),
    'memory_company_pk': lambda w: _memory(w, memory_company_pk(SCOPE), 'MEM#mem_fam_c', memory_id='mem_fam_c',
                                           scope='company', status='active'),
    'memory_status_pk': _personal_memory,
    'memory_cursor_pk': lambda w: _memory(w, memory_cursor_pk(SCOPE), 'SESSION#fam'),
    'memory_import_pk': lambda w: _memory(w, memory_import_pk(SCOPE), 'imp_fam'),
    'memory_event_pk': lambda w: _memory(w, memory_event_pk(SCOPE, 'mem_c1'), '2026-11-09#fam'),
    'plugin_config_pk': lambda w: _aggregate(w, plugin_config_pk(SCOPE), 'app_reviews_ios', configs='[]'),
    'plugin_config_key': lambda w: _put(w, 'aggregates', {**plugin_config_key(SCOPE, 'feedback_form'), 'configs': '[]'}),
    'plugin_config_history_pk': lambda w: _aggregate(w, plugin_config_history_pk(SCOPE), 'webscraper#fam'),
    'plugin_config_history_key': lambda w: _put(w, 'aggregates', {
        **plugin_config_history_key(SCOPE, 'webscraper', '2026-09-01T00:00:00', 'b2'), 'configs': '[]'}),
    FEEDBACK_FORM_PK: lambda w: _aggregate(w, SCOPE.key(FEEDBACK_FORM_PK), 'FORM#ff_fam', form_id='ff_fam'),
    TEST_RESPONSES_PK: lambda w: _aggregate(w, SCOPE.key(TEST_RESPONSES_PK), 'ff_fam#t#r1', form_id='ff_fam'),
    LIST_PK: lambda w: _aggregate(w, SCOPE.key(LIST_PK), '2026-11-02T00:00:00+00:00#runfam', run_id='runfam'),
    'watermark_key': _watermark,
    'watermark_directory_key': lambda w: _put(w, 'aggregates', watermark_directory_key(SCOPE, 'app_reviews_ios', 'fam')),
    WATERMARK_DIRECTORY: lambda w: _aggregate(w, SCOPE.key(WATERMARK_DIRECTORY), 'feedback_form#fam'),
    # An inventory row of a kind the sweeps read (a source with nothing under it).
    'delete_work_pk': lambda w: _aggregate(w, delete_work_pk(SCOPE), 'source#fam-source'),
    's3_key': lambda w: _object(w, s3_key(SCOPE, 'raw', 'fam', 'item.json')),
    's3_prefix': lambda w: _object(w, f'{s3_prefix(SCOPE)}fam-folder/note.txt'),
    'exports_prefix': lambda w: _object(w, f'{exports_prefix(SCOPE)}ex_fam/workspace-export.zip'),
    'control_partition': lambda w: _put(w, 'workspaces', {'pk': control_partition(SCOPE, 'meta'),
                                                          'sk': 'INVITE#fam', 'ttl': 1}),
    'workspace_tombstone_key': lambda w: _put(w, 'aggregates', {
        **workspace_tombstone_key(SCOPE, 'webscraper', 'fam-stone'), 'mode': 'erase', 'run_id': 'r-fam'}),
    'message_idempotency_key': None,
    # A workspace's projects: the registry row, a row of the project's partition, its META on the by-type index, a
    # saved revision in its version partition, and a job on the by-status index in voc-jobs.
    'PROJECT_IDS': lambda w: _registered(w, 'proj_fam_r'),
    'project_pk': lambda w: _project_row(w, 'projects', project_pk(_FAM_PROJECT, workspace=SCOPE), 'DOC#fam'),
    'project_type_pk': lambda w: _project_row(w, 'projects', project_pk(_FAM_PROJECT, workspace=SCOPE), 'META',
                                              gsi1pk=project_type_pk(workspace=SCOPE), gsi1sk='2026-11-02'),
    'version_partition_key': lambda w: _project_row(
        w, 'projects', version_partition_key(_FAM_PROJECT, workspace=SCOPE), 'REVISION#doc_fam#000001'),
    'job_status_pk': lambda w: _project_row(w, 'jobs', project_pk(_FAM_PROJECT, workspace=SCOPE), 'JOB#fam',
                                            gsi1pk=job_status_pk('completed', workspace=SCOPE), gsi1sk='2026-11-02'),
    # A comment thread of the family project, as the store writes it (its series listed in the project first).
    'comments_pk': _comment,
    # A review link of the workspace, as the share store writes it (its route, its row and its registry row).
    'DOCSHARE_IDS': lambda w: _review_link(w, 'registry'),
    'review_link_key': lambda w: _review_link(w, 'link'),
    'reviewer_rate_pk': None,
    # A workspace's person (its META, guard and index rows), and an index row naming a list with no rows left.
    'participants_partition': _participant,
    'PARTICIPANTS': lambda w: _put(w, 'participants', participants_index_key(
        list_partition('lst_0123456789abcdef', workspace=SCOPE), workspace=SCOPE)),
    # A library item's row and one of its passages (7.62.00): the passages through the item, the item last.
    'library_pk': lambda w: _put(w, 'projects', {**library_item_key(_FAM_ITEM, workspace=SCOPE), 'item_id': _FAM_ITEM}),
    'chunks_pk': _library_passage,
    # A member's assist outside a project (7.29.00): its row expires a day after it starts (TTL).
    'owner_pk': None,
    # A conversation owner's row, and a conversation and its Stop marker in that owner's partition, as the writers
    # keep them (shared/conversations.py: the owner listed first).
    'conversants_pk': lambda w: _put(w, 'conversations', {**conversant_key(SCOPE, 'sub-fam'), 'first_at': 'x'}),
    'USER': _conversation,
    # voc-radar's rows in a workspace, each per-brand partition named in the owner list first, as the writers do.
    'scoped_key': lambda w: _radar(w, 'RADAR#fam#daily_total', '2026-11-20'),
    'daily_rows': lambda w: _radar(w, 'RADAR#fam#daily_sentiment#negative', '2026-11-20'),
    'item_partitions': lambda w: _radar(w, 'RADAR#fam#ITEMS#2026-11', '2026-11-20#fam-r1'),
    'release_pk': lambda w: _radar(w, 'RELEASE#fam', '2026-11-20#r1'),
    'brand_state_key': lambda w: _radar(w, 'RADARSCAN#fam', 'STATE'),
    'RADAR_OWNED': lambda w: _put(w, 'radar', owned_row(SCOPE, SCOPE.key('RELEASE#fam-gone'))),
    'scan_key': lambda w: _put(w, 'radar', {**scan_key('LAST', SCOPE), 'status': 'completed'}),
}


def _radar(world: World, partition: str, sort_key: str) -> Probe:
    """A row of a workspace's per-brand Radar partition (``partition`` the deployment's spelling), named in the
    workspace's owner list first (shared/radar_keys.py ``owned_row``)."""
    pk = scoped_pk(SCOPE, partition)
    world.radar.put_item(Item=owned_row(SCOPE, pk))
    return _put(world, 'radar', {'pk': pk, 'sk': sort_key})


def _present(world: World, probe: Probe) -> bool:
    if probe.table == 'objects':
        listed = world.s3.list_object_versions(Bucket='test-raw-data-bucket', Prefix=probe.key)
        return bool(listed.get('Versions') or listed.get('DeleteMarkers'))
    return 'Item' in getattr(world, probe.table).get_item(Key=probe.key)


def test_every_family_has_a_seed():
    assert sorted(SEEDS) == sorted(FAMILIES)


def test_each_familys_row_is_gone_or_kept_as_its_entry_says(world):
    seed_workspace(world, WS, status='deleting')
    seed_workspace(world, OTHER, status='active')
    seed_deployment(world)
    event = request_job(world)
    probes = {name: seed(world) for name, seed in SEEDS.items() if seed is not None}
    assert all(_present(world, probe) for probe in probes.values())

    assert run_to_the_end(world, event)[-1]['status'] == 'completed'

    outcome = {name: ('kept' if _present(world, probe) else 'gone') for name, probe in probes.items()}
    expected = {name: ('kept' if FAMILIES[name].startswith('KEPT: ') else 'gone') for name in probes}
    assert outcome == expected
    # Not seeded: exactly the entries no sweep deletes yet or that expire (TTL, RESERVED, GAP).
    not_seeded = {name for name, seed in SEEDS.items() if seed is None}
    assert not_seeded == {name for name, entry in FAMILIES.items() if entry.startswith(('TTL: ', 'RESERVED: ', 'GAP: '))}
