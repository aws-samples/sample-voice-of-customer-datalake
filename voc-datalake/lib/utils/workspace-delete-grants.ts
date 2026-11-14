/**
 * What each sweep of a workspace's hard delete may do (lambda/jobs/workspace_delete/sweeps.py `SWEEPS`, the same
 * names in the same order; lambda/jobs/workspace_delete/test/test_registry.py keeps the two lists equal), and the
 * statements of each grant (lib/stacks/workspace-delete-worker.ts adds the union, each statement once).
 *
 * Every delete and every read of data is held to keys of the shape of ONE workspace id segment (`WS#ws_<26 ?>#…`,
 * `ws/ws_<26 ?>/…`: IAM's `*` also matches `#` and `/`, so the id is `?`s): the code names the workspace from its
 * event and the job row only (shared/ws_repo.py refuses any key of another before a call), and IAM cannot pin it to
 * that one id (decision 1's soft isolation). Call by call (the PutItem, the settings' GetItem, the uploads' list and
 * the project claims' GetItem and DeleteItem are the ones that reach past such keys, none of them to content):
 *   - BatchWriteItem only on `WS#{id}#*` partitions (voc-feedback's `#SOURCE#*` alone), the table's own key: no
 *     audit row is ever in reach of a batch (the audit-row guard denies it on `AUDIT#*` besides). IAM has no condition
 *     that tells a BatchWriteItem's DeleteRequest from its PutRequest, and limiting `dynamodb:Attributes` to `pk` and
 *     `sk` would still let a put of a key-only item through (and the inventory's puts need it), so it is not set: the
 *     code alone keeps these batches to deletes (shared/ws_repo.py `WorkspaceTable.batch_delete` sends DeleteRequest
 *     entries of keys only), but for the inventory's key-only puts in voc-aggregates (sweeps.py `note`,
 *     `WS#{id}#DELETE#PARTITIONS`, through the layer's checked batch writer);
 *   - PutItem only on the audit partitions it writes, keyed by partition and not by workspace: `AUDIT#tombstone#*`
 *     (one tombstone per deleted item and memory, its sort key `{ws}#{id}`) in voc-aggregates, and
 *     `AUDIT#workspace-deletes` (the completed row) in voc-workspaces;
 *   - the closed counter families' names read from the workspace's own `WS#{id}#SETTINGS#categories` and
 *     `#dimensions` rows (the `aggregates` grant's GetItem on `WS#{id}#*`), never the deployment's settings;
 *   - S3: versions listed only with the `s3:prefix` `ws/{id}/*`, deleted by version id and uploads aborted under
 *     `ws/{id}/*` only; ListBucketMultipartUploads is bucket-wide (it takes no `s3:prefix` condition), so the role
 *     could list every open upload's key and upload id in the bucket, other workspaces' and the deployment's too, but
 *     no object's data; the code asks for `ws/{id}/` only. Accepted (docs/multi-workspace.md, step 4's IAM);
 *   - SSM: the workspace's credentials path listed and its parameters deleted; kms:Decrypt through SSM is denied
 *     outright (lib/stacks/workspace-delete-worker.ts), so no value is ever read;
 *   - `projects`: Query of the registry `WS#{id}#PROJECT_IDS` and of each project's partitions (`WS#{id}#PROJECT#*`
 *     and `WS#{id}#DOCUMENT_VERSIONS#PROJECT#*` in voc-projects, `WS#{id}#PROJECT#*` in voc-jobs and
 *     voc-participants), BatchWriteItem on those; GetItem and DeleteItem of the ids' claims, `PROJECT_ID#*`, which
 *     name no workspace in their key, so IAM cannot tie a claim to the workspace being deleted: the code does
 *     (shared/ws_repo.py release_project_claim's condition that the claim names this workspace, and the ids come only
 *     from that workspace's own registry);
 *   - `conversations`: in voc-conversations, Query and BatchWriteItem of the owner list `WS#{id}#CONVERSANTS` and of
 *     each owner's `WS#{id}#USER#*` only, never the deployment's `USER#{sub}`; every Query for the keys alone
 *     (`dynamodb:Attributes` `pk` and `sk`, named, and `dynamodb:Select` `SPECIFIC_ATTRIBUTES`: no message, title or
 *     `first_at` is read; sweeps.py `KEYS_ONLY`).
 * Reserved: MCP tokens, once phase 3 pins one to a workspace (sweeps.py says so).
 */
export type DeleteGrant =
  | 'aggregates' | 'metricTypeIndex' | 'tombstones' | 'exportJobs' | 'feedback'
  | 'watermarks' | 'memory' | 'objects' | 'credentials' | 'controlRows' | 'radar' | 'projects' | 'conversations';

/** Each sweep (SWEEPS' names, in order) and the grants it needs. */
export const WORKSPACE_DELETE_GRANTS: Readonly<Record<string, readonly DeleteGrant[]>> = {
  credentials: ['credentials', 'aggregates'],
  feedback: ['feedback', 'aggregates', 'tombstones'],
  counters: ['aggregates', 'metricTypeIndex'],
  source_runs: ['aggregates'],
  failures: ['aggregates'],
  circuits: ['aggregates'],
  logs: ['aggregates'],
  scraper_runs: ['aggregates'],
  plugin_configs: ['aggregates'],
  feedback_forms: ['aggregates'],
  import_runs: ['aggregates'],
  erasure_jobs: ['aggregates'],
  reprocess_jobs: ['aggregates'],
  watermarks: ['aggregates', 'watermarks'],
  memory: ['memory', 'tombstones'],
  exports: ['aggregates', 'exportJobs', 'objects'],
  objects: ['objects'],
  radar: ['radar', 'aggregates'],
  settings: ['aggregates'],
  user_contexts: ['aggregates'],
  projects: ['projects'],
  conversations: ['conversations'],
  control_rows: ['controlRows', 'aggregates'],
};

/**
 * Every sweep docs/multi-workspace.md ("Export and delete", step 4) says a delete runs, in its order: a build of the
 * job fails while the registry lacks any (`requireDeleteSweeps`), so it is never built without, say, its
 * conversations entry. lambda/jobs/workspace_delete/test/test_registry.py parses this list and holds the Python
 * registry's `SWEEPS` names to it.
 */
export const REQUIRED_DELETE_SWEEPS: readonly string[] = [
  'credentials', 'feedback', 'counters', 'source_runs', 'failures', 'circuits', 'logs', 'scraper_runs',
  'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'reprocess_jobs', 'watermarks', 'memory',
  'exports', 'objects', 'radar', 'settings', 'user_contexts', 'projects', 'conversations', 'control_rows',
];

/** Throws, naming them, when `registry` lacks any of `REQUIRED_DELETE_SWEEPS`. */
export function requireDeleteSweeps(registry: Readonly<Record<string, readonly DeleteGrant[]>>): void {
  const missing = REQUIRED_DELETE_SWEEPS.filter((name) => !(name in registry));
  if (missing.length > 0) {
    throw new Error(`the hard delete needs the delete sweeps ${missing.join(', ')} (lib/utils/workspace-delete-grants.ts)`);
  }
}

/** The grants the sweeps need together, each once, in a stable order. */
export function deleteGrants(): DeleteGrant[] {
  requireDeleteSweeps(WORKSPACE_DELETE_GRANTS);
  return [...new Set(Object.values(WORKSPACE_DELETE_GRANTS).flat())];
}
