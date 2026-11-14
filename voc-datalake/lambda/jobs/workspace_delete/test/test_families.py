"""Every entry of families.py, seeded: one row (or object) of each key family the code builds, written with that
family's own builder, then the whole delete run; each is gone, or kept when its entry says ``KEPT``. A ``TTL`` entry
lives in a table the job never reaches (voc-idempotency), so it is not seeded: its reason says why. A family added to
families.py without a seed here fails, so the seeds follow the registry (test_registry.py holds the registry to the
code)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

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
from shared.import_runs import LIST_PK
from shared.onboarding import FEEDBACK_FORM_PK
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
    s3_key,
    s3_prefix,
    scraper_run_pk,
    source_run_pk,
    urgency_pk,
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
}


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
    not_seeded = sorted(name for name, seed in SEEDS.items() if seed is None)
    assert [(name, FAMILIES[name].split(':')[0]) for name in not_seeded] == [('message_idempotency_key', 'TTL')]
