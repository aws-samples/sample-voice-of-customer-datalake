"""Every key family of a workspace the code builds (shared/ws_repo.py's builders; each ``scope.key(<part>, …)`` outside
it, by its first part; each workspace settings kind; each function that calls shared/scoped_keys.py ``scoped_pk``),
and the sweep of jobs/workspace_delete/sweeps.py that deletes it, or why it stays (``KEPT: ``), expires (``TTL: ``),
waits for a reserved entry of sweeps.py (``RESERVED: ``) or is not reached yet (``GAP: ``, a gap written
down, TENETS.md D5's, whose count only shrinks). test_registry.py holds it to the code both ways; test_families.py
seeds one row of each family a sweep or KEPT names and checks the delete removes it, or keeps it."""
from typing import Final

from jobs.workspace_delete.sweeps import WORK_PARTITION, WORKSPACE_SETTINGS_KINDS
from shared.import_runs import LIST_PK
from shared.onboarding import FEEDBACK_FORM_PK
from shared.ws_repo import WATERMARK_DIRECTORY

#: Why Radar's data rows in a workspace are not swept: none is written yet.
_RADAR_DATA_GAP: Final = ("GAP: voc-radar data rows in a workspace (items, review markers, counters, releases): read "
                          "with a workspace, written by nothing yet; the change that writes them lists their "
                          "partitions for the radar sweep")

FAMILIES: Final = {
    'feedback_key': 'feedback', 'SOURCE': 'feedback',
    'date_pk': 'feedback', 'category_pk': 'feedback', 'urgency_pk': 'feedback', 'feedback_id_pk': 'feedback',
    'channel_pk': 'feedback',  # index partitions of the feedback items: they go with the items
    'metric_pk': 'counters', 'metric_type': 'counters',
    'source_run_pk': 'source_runs', 'scraper_run_pk': 'scraper_runs',
    'FAILURES': 'failures', 'CIRCUIT': 'circuits', 'LOGS': 'logs',
    'erasure_job_pk': 'erasure_jobs', 'reprocess_job_pk': 'reprocess_jobs', 'export_job_pk': 'exports',
    'memory_company_pk': 'memory', 'memory_status_pk': 'memory', 'memory_cursor_pk': 'memory',
    'memory_import_pk': 'memory', 'memory_event_pk': 'memory',
    # shared/memory_store.py's own spellings of the same partitions (through scoped_pk).
    'company_pk': 'memory', 'scope_pk': 'memory', 'status_partition': 'memory', 'append_event': 'memory',
    'cursor_key': 'memory', 'import_key': 'memory',
    'plugin_config_pk': 'plugin_configs', 'plugin_config_key': 'plugin_configs',
    'plugin_config_history_pk': 'plugin_configs', 'plugin_config_history_key': 'plugin_configs',
    FEEDBACK_FORM_PK: 'feedback_forms', LIST_PK: 'import_runs',
    'watermark_key': 'watermarks', 'watermark_directory_key': 'watermarks', WATERMARK_DIRECTORY: 'watermarks',
    'delete_work_pk': WORK_PARTITION,
    's3_key': 'objects', 's3_prefix': 'objects', 'exports_prefix': 'objects',
    'control_partition': 'control_rows',
    # voc-radar: the workspace's Radar settings (shared/radar_keys.py, config and brands).
    'SETTINGS#radar': 'radar',
    # A workspace's settings rows (WS#{ws}#SETTINGS#{kind}, shared/workspace_settings.py), by kind: test_registry.py
    # finds each kind from the settings builders' call sites, and sweeps.py lists the same kinds.
    **{f'SETTINGS#{kind}': 'settings' for kind in WORKSPACE_SETTINGS_KINDS},
    # A member's own objectives in the workspace (WS#{ws}#USERCTX#{sub}) and the list of who saved some.
    'my_context_key': 'user_contexts', 'user_context_owners_pk': 'user_contexts',
    'workspace_tombstone_key': 'KEPT: a tombstone of each deleted item and memory, for good (TENETS.md D4, D5)',
    'message_idempotency_key': ('TTL: voc-idempotency WS#{ws}#{source}:{id} claims hold no content and expire within '
                                'two days; not listable without a Scan'),
    # voc-conversations' WS#{ws}#CONVERSANTS (7.19.00) and each owner's WS#{ws}#USER#{sub} there (an owner list).
    'conversants_pk': 'conversations', 'USER': 'conversations',
    # A workspace's projects (7.26.00, 7.27.00, shared/project_keys.py): the registry WS#{ws}#PROJECT_IDS, each
    # project's partition and its document versions, and the index partitions of its rows (its META's by-type, its
    # jobs' by-status), which go with the rows.
    'PROJECT_IDS': 'projects', 'project_pk': 'projects', 'version_partition_key': 'projects',
    'project_type_pk': 'projects', 'job_status_pk': 'projects',
    # A member's assists outside a project in voc-jobs (7.29.00, shared/assist_jobs.py owner_pk; no route writes one
    # yet): their rows hold the assist's input and answer for a day.
    'owner_pk': ('TTL: voc-jobs WS#{ws}#ASSIST#{sub} assist rows expire a day after they start (ASSIST_JOB_TTL); '
                 'no route writes one yet'),
    'scoped_key': _RADAR_DATA_GAP, '_releases_since': _RADAR_DATA_GAP, 'daily_rows': _RADAR_DATA_GAP,
    'item_partitions': _RADAR_DATA_GAP,
}
#: The most ``GAP: `` entries there may be: lower it when a gap closes, never raise it.
MAX_GAPS: Final = 4
