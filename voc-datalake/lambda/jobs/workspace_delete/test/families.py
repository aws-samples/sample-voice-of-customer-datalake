"""Every key family of a workspace the code builds (shared/ws_repo.py's builders; each ``scope.key(<part>, …)`` outside
it, by its first part; each workspace settings kind; each function that calls shared/scoped_keys.py ``scoped_pk``),
and the sweep of jobs/workspace_delete/sweeps.py that deletes it, or why it stays (``KEPT: ``), expires (``TTL: ``),
waits for a reserved entry of sweeps.py (``RESERVED: ``) or is not reached yet (``GAP: ``, a gap written
down, TENETS.md D5's, whose count only shrinks). test_registry.py holds it to the code both ways; test_families.py
seeds one row of each family a sweep or KEPT names and checks the delete removes it, or keeps it."""
from typing import Final

from jobs.workspace_delete.sweeps import WORK_PARTITION, WORKSPACE_SETTINGS_KINDS
from shared.form_test_responses import TEST_RESPONSES_PK
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
    'erasure_job_pk': 'erasure_jobs', 'reprocess_job_pk': 'reprocess_jobs', 'export_job_pk': 'exports',
    # What the workspace's web_reviews runs learned of each site (WS#{ws}#WEB_REVIEWS#METHODS, 7.44.00).
    'WEB_REVIEWS': 'web_review_methods',
    'memory_company_pk': 'memory', 'memory_status_pk': 'memory', 'memory_cursor_pk': 'memory',
    'memory_import_pk': 'memory', 'memory_event_pk': 'memory',
    # shared/memory_store.py's own spellings of the same partitions (through scoped_pk).
    'company_pk': 'memory', 'scope_pk': 'memory', 'status_partition': 'memory', 'append_event': 'memory',
    'cursor_key': 'memory', 'import_key': 'memory',
    'plugin_config_pk': 'plugin_configs', 'plugin_config_key': 'plugin_configs',
    'plugin_config_history_pk': 'plugin_configs', 'plugin_config_history_key': 'plugin_configs',
    FEEDBACK_FORM_PK: 'feedback_forms', TEST_RESPONSES_PK: 'feedback_forms', 'pin_forms_pk': 'feedback_forms',
    'pins_pk': 'prototype_pins', LIST_PK: 'import_runs',
    'watermark_key': 'watermarks', 'watermark_directory_key': 'watermarks', WATERMARK_DIRECTORY: 'watermarks',
    'delete_work_pk': WORK_PARTITION,
    's3_key': 'objects', 's3_prefix': 'objects', 'exports_prefix': 'objects',
    'control_partition': 'control_rows',
    # voc-radar: the workspace's Radar settings (shared/radar_keys.py, config, brands and version).
    'SETTINGS#radar': 'radar',
    # A workspace's settings rows (WS#{ws}#SETTINGS#{kind}, shared/workspace_settings.py), by kind: test_registry.py
    # finds each kind from the settings builders' call sites, and sweeps.py lists the same kinds.
    **{f'SETTINGS#{kind}': 'settings' for kind in WORKSPACE_SETTINGS_KINDS},
    # The workspace's daily cost rows (WS#{ws}#COST, shared/platform_costs.py), swept with its settings.
    'COST': 'settings',
    # The workspace's leadership view rollup items (WS#{ws}#ADOPTION#ROLLUP, shared/adoption.py, 7.70.00), the same.
    'ADOPTION': 'settings',
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
    # A project's series' comment partitions (7.37.00, shared/project_keys.py comments_pk: its threads and its review
    # link's pointer), each listed in the project's own partition (comment_series_key), which the projects entry's
    # comments child reads first.
    'comments_pk': 'projects',
    # A workspace's review links (7.37.00): the registry WS#{ws}#DOCSHARE_IDS and each link's own row
    # (review_link_key); their deployment-wide routing rows are the layer's (shared/ws_repo.py route_share_id).
    'DOCSHARE_IDS': 'docshares', 'review_link_key': 'docshares',
    'reviewer_rate_pk': ("TTL: voc-projects WS#{ws}#DCRATE#{share}#{digest} counters hold a count only and expire two "
                         "days after their day; no reviewer route writes one in a workspace yet"),
    # A product proposal accept's audit row in a workspace (7.106.00, shared/product_proposals.py audit_pk), written in
    # the accept's own transaction: ids only, kept as the deployment's AUDIT#product_context rows are.
    'audit_pk': ('KEPT: voc-projects WS#{ws}#AUDIT#product_context audit rows of accepted product fields hold ids only '
                 '(the project, the proposal, the field names, the actor, the model id), for good, as the '
                 "deployment's do"),
    # The Product tab's counters in voc-aggregates (7.106.00, 3h-S3b, shared/product_sources.py and
    # shared/product_proposals.py): a count only each, kept two days (shared/aws.py count_once's ttl).
    'link_reads_key': ('TTL: voc-aggregates WS#{ws}#PRODUCTURL#PROJECT#{id}#{day} counters hold a count only and '
                       'expire two days after their day'),
    'link_read_counters': ('TTL: voc-aggregates WS#{ws}#PRODUCTURL#USER#{sub}#{day} counters hold a count only and '
                           'expire two days after their day'),
    'file_read_counters': ('TTL: voc-aggregates WS#{ws}#PRODUCTFILE#USER#{sub}#{day} counters hold a count only and '
                           'expire two days after their day'),
    'extract_counter_keys': ('TTL: voc-aggregates WS#{ws}#PRODUCTX#… counters hold a count only and expire two days '
                             'after their day; no extract counts one in a workspace yet (3h-S8)'),
    # A workspace's people and lists in voc-participants (7.31.00, shared/participants_keys.py): every LIST#, PERSON#
    # and EMAIL# partition and the gsi1 LISTS and PEOPLE partitions (participants_partition), found through the
    # workspace's index WS#{ws}#PARTICIPANTS. A project's links to them are in its own partition (projects, above).
    'participants_partition': 'participants', 'PARTICIPANTS': 'participants',
    # The workspace's Documents Library (7.62.00, shared/library_keys.py): its items, slug guards and count, and each
    # item's passages (listed by its item row).
    'library_pk': 'library', 'chunks_pk': 'library',
    # The workspace's agents and workflows in voc-agents (7.80.00, shared/ws_repo.py): each agent's partition (its
    # META, history and runs), each workflow's (its CURRENT row and revisions) and a run's journal, every one listed in
    # the registry WS#{ws}#AGENT_REGISTRY, the registry last. The listing index's partitions (agents_index_pk, the
    # agents, workflows and active runs listings) are no rows of their own: they go with their base rows (an agent's
    # META, a workflow's CURRENT, an active run), as a project's by-type index goes with its META.
    'agent_pk': 'agents', 'workflow_pk': 'agents', 'agent_run_pk': 'agents', 'agents_index_pk': 'agents',
    'agent_registry_pk': 'agents',
    # A member's assists outside a project in voc-jobs (7.29.00, shared/assist_jobs.py owner_pk; no route writes one
    # yet): their rows hold the assist's input and answer for a day.
    'owner_pk': ('TTL: voc-jobs WS#{ws}#ASSIST#{sub} assist rows expire a day after they start (ASSIST_JOB_TTL); '
                 'no route writes one yet'),
    # voc-radar's rows in a workspace (shared/radar_keys.py, shared/radar_store.py, shared/radar_releases.py): its
    # settings and scan rows, and every per-brand partition its owner list WS#{ws}#RADAR_OWNED names (each writer
    # names its partitions there first), deleted by the radar sweep, the list last.
    'scoped_key': 'radar', 'daily_rows': 'radar', 'item_partitions': 'radar', 'RADAR_OWNED': 'radar',
    'brand_state_key': 'radar', 'release_pk': 'radar', 'scan_key': 'radar',
}
#: The most ``GAP: `` entries there may be: lower it when a gap closes, never raise it.
MAX_GAPS: Final = 0
