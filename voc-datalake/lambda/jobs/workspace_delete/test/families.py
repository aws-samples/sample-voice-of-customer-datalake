"""Every key family of a workspace the code builds (shared/ws_repo.py's builders, and each ``scope.key(<part>, …)``
outside it, by its first part), and the sweep of jobs/workspace_delete/sweeps.py that deletes it, or why it stays
(``KEPT``) or expires (``TTL``). test_registry.py holds it to the code both ways; test_families.py seeds one row of each
and checks the delete removes it, or keeps it."""
from typing import Final

from jobs.workspace_delete.sweeps import WORK_PARTITION
from shared.import_runs import LIST_PK
from shared.onboarding import FEEDBACK_FORM_PK
from shared.ws_repo import WATERMARK_DIRECTORY

FAMILIES: Final = {
    'feedback_key': 'feedback', 'SOURCE': 'feedback',
    'date_pk': 'feedback', 'category_pk': 'feedback', 'urgency_pk': 'feedback', 'feedback_id_pk': 'feedback',
    'channel_pk': 'feedback',  # index partitions of the feedback items: they go with the items
    'metric_pk': 'counters', 'metric_type': 'counters',
    'source_run_pk': 'source_runs', 'scraper_run_pk': 'scraper_runs',
    'FAILURES': 'failures', 'CIRCUIT': 'circuits', 'LOGS': 'logs',
    'erasure_job_pk': 'erasure_jobs', 'export_job_pk': 'exports',
    'memory_company_pk': 'memory', 'memory_status_pk': 'memory', 'memory_cursor_pk': 'memory',
    'memory_import_pk': 'memory', 'memory_event_pk': 'memory',
    'plugin_config_pk': 'plugin_configs', 'plugin_config_key': 'plugin_configs',
    'plugin_config_history_pk': 'plugin_configs', 'plugin_config_history_key': 'plugin_configs',
    FEEDBACK_FORM_PK: 'feedback_forms', LIST_PK: 'import_runs',
    'watermark_key': 'watermarks', 'watermark_directory_key': 'watermarks', WATERMARK_DIRECTORY: 'watermarks',
    'delete_work_pk': WORK_PARTITION,
    's3_key': 'objects', 's3_prefix': 'objects', 'exports_prefix': 'objects',
    'control_partition': 'control_rows',
    'workspace_tombstone_key': 'KEPT: a tombstone of each deleted item and memory, for good (TENETS.md D4, D5)',
    'message_idempotency_key': ('TTL: voc-idempotency WS#{ws}#{source}:{id} claims hold no content and expire within '
                                'two days; not listable without a Scan'),
}
