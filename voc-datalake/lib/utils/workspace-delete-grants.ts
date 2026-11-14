/**
 * What each sweep of a workspace's hard delete may do (lambda/jobs/workspace_delete/sweeps.py `SWEEPS`, the same
 * names in the same order; lambda/jobs/workspace_delete/test/test_registry.py keeps the two lists equal), and the
 * statements of each grant (lib/stacks/workspace-delete-worker.ts adds the union, each statement once).
 *
 * Every delete and every read of data is held to keys of the shape of ONE workspace id segment (`WS#ws_<26 ?>#…`,
 * `ws/ws_<26 ?>/…`: IAM's `*` also matches `#` and `/`, so the id is `?`s): the code names the workspace from its
 * event and the job row only (shared/ws_repo.py refuses any key of another before a call), and IAM cannot pin it to
 * that one id (decision 1's soft isolation). Call by call (the PutItem, the settings' GetItem and the uploads' list
 * are the ones that reach past such keys, none of them to content):
 *   - BatchWriteItem only on `WS#{id}#*` partitions (voc-feedback's `#SOURCE#*` alone), the table's own key: no
 *     audit row is ever in reach of a batch (the audit-row guard denies it on `AUDIT#*` besides);
 *   - PutItem only on the audit partitions it writes, keyed by partition and not by workspace: `AUDIT#tombstone#*`
 *     (one tombstone per deleted item and memory, its sort key `{ws}#{id}`) in voc-aggregates, and
 *     `AUDIT#workspace-deletes` (the completed row) in voc-workspaces;
 *   - GetItem of the deployment's `SETTINGS#categories` and `SETTINGS#dimensions` (`deploymentSettings`: the closed
 *     counter families' names);
 *   - S3: versions listed only with the `s3:prefix` `ws/{id}/*`, deleted by version id and uploads aborted under
 *     `ws/{id}/*` only; ListBucketMultipartUploads is bucket-wide (it takes no `s3:prefix` condition: upload keys and
 *     ids only, no data);
 *   - SSM: the workspace's credentials path listed and its parameters deleted; kms:Decrypt through SSM is denied
 *     outright (lib/stacks/workspace-delete-worker.ts), so no value is ever read.
 * Reserved for voc-lead: `conversations` (voc-conversations: Query `WS#{id}#CONVERSANTS`, Query and BatchWriteItem
 * on `WS#{id}#USER#*`) and `projects` (the `WS#{id}#PROJECT_IDS` registry and each project's partitions), each added
 * here and in SWEEPS together; MCP tokens, once phase 3 pins one to a workspace (sweeps.py says so).
 */
export type DeleteGrant =
  | 'aggregates' | 'metricTypeIndex' | 'deploymentSettings' | 'tombstones' | 'exportJobs' | 'feedback'
  | 'watermarks' | 'memory' | 'objects' | 'credentials' | 'controlRows';

/** Each sweep (SWEEPS' names, in order) and the grants it needs. */
export const WORKSPACE_DELETE_GRANTS: Readonly<Record<string, readonly DeleteGrant[]>> = {
  credentials: ['credentials', 'aggregates'],
  feedback: ['feedback', 'aggregates', 'tombstones'],
  counters: ['aggregates', 'metricTypeIndex', 'deploymentSettings'],
  source_runs: ['aggregates'],
  failures: ['aggregates'],
  circuits: ['aggregates'],
  logs: ['aggregates'],
  scraper_runs: ['aggregates'],
  plugin_configs: ['aggregates'],
  feedback_forms: ['aggregates'],
  import_runs: ['aggregates'],
  erasure_jobs: ['aggregates'],
  watermarks: ['aggregates', 'watermarks'],
  memory: ['memory', 'tombstones'],
  exports: ['aggregates', 'exportJobs', 'objects'],
  objects: ['objects'],
  control_rows: ['controlRows', 'aggregates'],
};

/** The grants the sweeps need together, each once, in a stable order. */
export function deleteGrants(): DeleteGrant[] {
  return [...new Set(Object.values(WORKSPACE_DELETE_GRANTS).flat())];
}
