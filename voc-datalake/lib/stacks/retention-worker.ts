/**
 * The per-source retention / erasure worker, `voc-retention` (VocProcessingStack,
 * docs/source-policies.md). The ONE role in the app that may delete customer data,
 * and only in the two opt-in ways the handler (lambda/jobs/retention/handler.py)
 * implements, each under a stated legal basis (TENETS.md D5):
 *
 *   - `{"mode": "retention"}`, daily: items of sources whose profile sets
 *     `retention_days`, older than the cutoff;
 *   - `{"mode": "erase", "job_id", "value"}`, async invoke by the settings API
 *     (POST /settings/erasure): items matching one field value; with the job's
 *     `field: 'source'`, every item of one source and then everything left under
 *     `raw/<source>/` (the grants below already cover it).
 *
 * Each deleted item gets a tombstone first; its `s3_raw_uri` object goes with it,
 * every version; Radar reviews go the same way, and so do a feedback form's test
 * responses (kept with the form in voc-aggregates); artifacts in voc-projects that
 * cited a deleted item are marked. Least privilege, pinned exactly by
 * processing-stack-retention.test.ts:
 *   - feedback: GetItem / Query / Scan / DeleteItem — no Put, no Update; on the table only, no index (7.72.00);
 *   - (7.72.00) the erasure walks' grants below (voc-projects, the product documents' reads, the participants' reads),
 *     none a delete or a put, are in a customer-managed policy of their own, `RetentionWalksPolicy`: the role's inline
 *     policy keeps every delete and every audit put, and would otherwise pass its size quota;
 *   - raw bucket: DeleteObject + DeleteObjectVersion on `raw/*`, `silver/*` and each workspace's
 *     `ws/{ws}/raw/*` and `ws/{ws}/silver/*` (an erasure by email or a retention window reaches a workspace's copies; the workspace
 *     segment is one id, `WORKSPACE_ID_PATTERN`), and ListBucketVersions restricted to those prefixes — no read there
 *     (the reads are a workspace's text product documents and the deployment's extracted text, below), no put, no ListBucket. Also each workspace's `ws/{ws}/exports/*` (its export zips and work objects, a derived copy that an
 *     erasure reaching the workspace deletes with every version), with AbortMultipartUpload there and
 *     ListBucketMultipartUploads on the bucket (that action takes no prefix condition: upload keys and ids only, no
 *     data; the code lists one workspace's exports) so its open export upload is aborted too. The
 *     whole-file uploads (`raw/csv_upload/`, `raw/json_upload/`) are under it: a
 *     whole-source erasure deletes the source's own uploaded files (every row of one
 *     is filed under the one source its upload named, shared/retention.py);
 *   - aggregates: GetItem / PutItem / UpdateItem / Query (source profiles, the
 *     erasure job row, the AUDIT#retention rows, one PutItem per tombstone: no BatchWriteItem, which
 *     would also allow deletes) and BatchGetItem (the lineage pass's tombstone lookups); DeleteItem in the test
 *     responses' partitions only (`dynamodb:LeadingKeys` `FEEDBACK_FORM_TEST` and one workspace id's
 *     `WS#{ws}#FEEDBACK_FORM_TEST`): the forms' TEST responses (never feedback items) that the feedback_form source's
 *     retention window or an erasure reaches (lambda/jobs/retention/form_tests.py). They have those partitions to
 *     themselves so this delete reaches nothing else: never a form's definition, revision or funnel row (the forms
 *     partitions, `FEEDBACK_FORM` / `WS#{ws}#FEEDBACK_FORM`, which the `_TEST` suffix keeps out of the pattern), a
 *     job, lock, setting or audit row;
 *   - radar: Scan / DeleteItem (a review and its dedupe marker) and the cache-version
 *     bump (UpdateItem on `SETTINGS#radar` only) — no Put, no Query;
 *   - projects: Scan (since 7.48.00 only the deployment walks' way of finding its review links, comment partitions and
 *     projects until the backfill of their registries has run; on the table only, of `SCAN_ATTRIBUTES` only),
 *     and UpdateItem in two statements (since
 *     7.43.00): of `LINEAGE_UPDATE_ATTRIBUTES` only (the lineage marks' id lists and `erased_evidence`) on the
 *     deployment's and one workspace id's `PROJECT#*` partitions, and of `PEOPLE_UPDATE_ATTRIBUTES` only (the
 *     addresses and names an erasure by email rewrites) on the deployment's and one workspace id's `PROJECT#*`,
 *     `DCOMMENTS#*` and `DOCSHARE#*` partitions (the deployment's since 7.48.00) — no delete, no put; and Query of one
 *     workspace id's `PROJECT_IDS`, `PROJECT#*`, `DCOMMENTS#*`, `DOCSHARE_IDS` and `DOCSHARE#*` partitions
 *     (`RETENTION_PROJECT_PARTITIONS`, 7.43.00; its `LIBRARY` since 7.62.00) and of the deployment's `PROJECT#*`,
 *     `DCOMMENTS#*`, `DOCSHARE#*`, `PROJECT_IDS`, `DOCSHARE_IDS`, `COMMENT_SERIES_IDS` and (7.62.00) `LIBRARY`
 *     (`RETENTION_DEPLOYMENT_PARTITIONS`, 7.48.00, of
 *     `DEPLOYMENT_QUERY_ATTRIBUTES` only), no index: the lineage marks and an erasure by email's addresses
 *     (lambda/jobs/retention/lineage.py, project_people.py). IAM holds neither the Query nor the update to one
 *     workspace (the pattern is any one workspace id), only the workspace layer does;
 *   - raw bucket, read: GetObject of a workspace's text product documents only (`WORKSPACE_PRODUCT_DOC_READS`:
 *     `ws/{one id}/projects/*\/product_docs/raw/*.md`, `…/raw/*.txt` and `…/extracted/*`, 7.43.00: an erasure by
 *     email reads a text upload or its extracted text for the address) and of the deployment's extracted text only
 *     (`DEPLOYMENT_PRODUCT_DOC_READS`, `projects/*\/product_docs/extracted/*`, 7.48.00), and the Documents Library's
 *     extracted text (`LIBRARY_TEXT_READS`, 7.62.00: `library/*\/extracted`, `ws/{one id}/library/*\/extracted`, listed
 *     for review when it holds the address). With no ListBucket a missing
 *     key answers 403, which the code takes for "cannot be judged", never a failure;
 *   - feature requests: Scan / GetItem / Query / UpdateItem (an erasure by email de-identifies the person's board
 *     requests: REMOVE their email and name) and PutItem / DeleteItem pinned to `FR#*` (a +1's id derives from the
 *     email, so it is RE-KEYED: put under a new random id, the old row deleted, totals recomputed); their raw
 *     copies under `raw/feature_requests/` go with the raw grant above;
 *   - workspaces: Scan (an erasure by email finds the membership rows that hold the email: the table has no email
 *     index; a paged, time-budgeted Scan once per job, never on a request path, lambda/jobs/retention/members.py) and
 *     UpdateItem pinned to `WS#*` and to the attributes `email` and `name` (REMOVEd from a `MEMBER#` row; IAM cannot
 *     pin the sort key, so `META` is in reach of IAM and kept out by the code) — no Put, no Delete, no other
 *     attribute; the audit-row guard denies it any write of an `AUDIT#` row there; GetItem of a `META`'s status
 *     only (`grantWorkspaceStatusRead`: an erasure creates no export lock for a workspace that is not active); and
 *     (7.43.00) Query of the `WORKSPACES` listing partition only (an erasure by email walks every listed workspace);
 *   - participants (7.72.00, projects 3g2): an erasure by email without a source looks the address up in the
 *     deployment's and each listed workspace's address guard and people index, and erases each person found
 *     (lambda/jobs/retention/participants.py, which runs lambda/shared/participants_erasure.py `erase_person`), so
 *     exactly that erasure's calls, each pinned by `dynamodb:LeadingKeys` to the deployment's and one workspace id's
 *     partitions of its rows (`PARTICIPANT_ACCESS`): the guard's and the person's reads, the person's partition by
 *     Query, a put of the participant's tombstone and delete record only, the membership and ask-recipient updates of
 *     their own attributes only, the deletes of the guard, the person, its memberships and (in a workspace) the
 *     guard's index row, the batch deletes of its tokens, project links and own rows (BatchWriteItem also allows
 *     puts in those partitions: IAM cannot tell a batch's deletes from its puts; the code sends deletes only), and (in
 *     a workspace) the guard's condition check that unlists it; and the people index's Query of the `PEOPLE`
 *     partitions only, for the key alone. No Scan, no other partition or index. What IAM cannot pin: a DeleteItem on
 *     `WS#{one id}#PARTICIPANTS` reaches every row of that workspace's index, one on `LIST#*` a list's `META` as well
 *     as its members, and the PutItem on the two `AUDIT#` partitions could overwrite a row there: each is held to the
 *     erasure's own rows only by the code's keys and conditions (TENETS.md tenet 6's gaps);
 *   - lambda:InvokeFunction on its own unqualified name (time-budget hand-over).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from '../utils/log-retention';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { grantCacheVersionBump, RADAR_VERSION_PARTITION } from '../utils/cache-version-grants';
import {
  RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, WORKSPACE_EXPORTS_PREFIX, WORKSPACE_ID_PATTERN, WORKSPACE_RAW_LAYER_PREFIX,
  WORKSPACE_SILVER_HISTORY_PREFIX,
} from './core-buckets';
import { RETENTION_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites, keyScopedWriteStatement, type TableWrite } from '../utils/table-write-grants';
import { grantInvokeByName, scheduleWorker, workerRole } from '../utils/worker-lambda';
import { grantWorkspaceStatusRead } from '../utils/workspace-resolution-grants';

/** The request partitions of voc-feature-requests (`FR#{id}`: META + its +1s), the only rows the worker re-keys. */
const FEATURE_REQUEST_PARTITIONS = 'FR#*';
/** The workspace partitions of voc-workspaces (`WS#{ws}`: META and the MEMBER# rows), the only rows it updates. */
const WORKSPACE_PARTITIONS = 'WS#*';
/** What an erasure by email removes from a membership row, and the key the update names. */
const MEMBER_PERSON_ATTRIBUTES = ['email', 'name', 'pk', 'sk'];
/** The test responses' partitions of voc-aggregates (lambda/shared/form_test_responses.py TEST_RESPONSES_PK): the
 *  deployment's and one workspace id's, the only aggregates rows the worker deletes (form_tests.py). */
const FORM_TEST_RESPONSES_PARTITIONS = ['FEEDBACK_FORM_TEST', `WS#${WORKSPACE_ID_PATTERN}#FEEDBACK_FORM_TEST`];
/**
 * One workspace's project partitions in voc-projects the worker Queries (7.43.00, projects 3g-b:
 * lambda/jobs/retention/project_people.py and lineage.py): its registry of project ids, each project's own partition
 * (its company persona library's too), its series' comment partitions, its registry of review links and each link's
 * own row. Never its document versions, a reviewer's `DCRATE#` counters, an index or a deployment-wide row.
 */
const RETENTION_PROJECT_PARTITIONS = [`WS#${WORKSPACE_ID_PATTERN}#PROJECT_IDS`,
  `WS#${WORKSPACE_ID_PATTERN}#PROJECT#*`, `WS#${WORKSPACE_ID_PATTERN}#DCOMMENTS#*`,
  `WS#${WORKSPACE_ID_PATTERN}#DOCSHARE_IDS`, `WS#${WORKSPACE_ID_PATTERN}#DOCSHARE#*`,
  `WS#${WORKSPACE_ID_PATTERN}#LIBRARY`];
/**
 * The deployment's own project partitions in voc-projects the worker Queries (7.48.00, projects 3g-d:
 * lambda/jobs/retention/project_people.py and lineage.py): each project's own partition (its persona library's too),
 * each series' comment partition, each link's own row, and the deployment's registries of its projects, of its links
 * and of its commented series (`PROJECT_IDS`, `DOCSHARE_IDS`, which also holds the backfill's marker, and
 * `COMMENT_SERIES_IDS`). Never an index, a document version, a `DCRATE#` counter or a workspace's row (the workspace
 * statement above is those).
 */
const RETENTION_DEPLOYMENT_PARTITIONS = ['PROJECT#*', 'DCOMMENTS#*', 'DOCSHARE#*', 'PROJECT_IDS', 'DOCSHARE_IDS',
  'COMMENT_SERIES_IDS', 'LIBRARY'];
/**
 * What the worker's Queries of those partitions may read (`dynamodb:Attributes`, 7.48.00): the keys, what the erasure
 * by email judges of each kind of row (a thread's authors, replies and resolver; a link's audience, names, revocation
 * and project; a META's owner, members and delete state; a persona's research notes; a product document's upload, type, status,
 * extracted text and filename; a library item's title, source, tags and who made and changed it), a registry row's
 * `deleted_at`, the backfill marker's time, release and counts, and the lineage marks' id lists and mark. The statement also requires `dynamodb:Select` `SPECIFIC_ATTRIBUTES`, so a Query
 * that names no attribute (which `ForAllValues` alone would let through, reading whole rows) is refused; every
 * deployment Query of the code names its attributes and says so (lambda/shared/project_walk.py `query_page`;
 * lambda/jobs/retention/test/test_deployment_project_erasure.py records each one against this list). The workspace
 * Query statement has no attribute limit: a workspace's walk reads its rows through the workspace layer.
 */
const DEPLOYMENT_QUERY_ATTRIBUTES = ['pk', 'sk', 'author', 'replies', 'status_by', 'audience', 'created_by_name',
  'revoked_by', 'revoked', 'project_id', 'owner_email', 'members', 'research_notes', 's3_raw_key', 'content_type',
  'status', 's3_extracted_key', 'filename', 'deleted_at', 'deletion_started_at', 'completed_at', 'release',
  'links_found', 'series_found', 'projects_found', 'input_feedback_ids', 'evidence_feedback_ids',
  'input_feature_request_ids', 'evidence_updates', 'erased_evidence', 'title', 'source', 'tags', 'created_by', 'updated_by'];
/**
 * What the worker's Scan of voc-projects may read (7.48.00; lambda/shared/review_registries.py `SCAN_ATTRIBUTES`, which
 * a test holds to this list): a row's key, a routing row's workspace, a link's project and series, and a link's or a
 * project's creation time. The Scan finds the deployment's links, comment partitions and projects until the backfill
 * of their registries has run; it reads every row of the table, but answers only these attributes of each.
 */
const SCAN_ATTRIBUTES = ['pk', 'sk', 'workspace_id', 'project_id', 'series_id', 'created_at'];
/**
 * The attributes the worker's UpdateItems name on voc-projects, the key included (`dynamodb:Attributes`), as two
 * statements: the lineage marks' three id lists, a persona's `evidence_updates` (7.64.00) and `erased_evidence`, on
 * the deployment's and one workspace id's project partitions only (`LINEAGE_UPDATE_PARTITIONS`; since 7.48.00 neither
 * lineage pass Scans, so no other row is marked); and what an erasure by email rewrites (a META's owner and member addresses; a thread's authors, replies and
 * resolver; a link's audience, creator and revoker names and its revocation; a persona's research notes), on the
 * deployment's and one workspace id's `PROJECT#*`, `DCOMMENTS#*` and `DOCSHARE#*` partitions only (the deployment's
 * since 7.48.00). lambda/jobs/retention/test/test_project_erasure.py holds each list to project_people.py's
 * `LINEAGE_UPDATE_ATTRIBUTES` and `PEOPLE_UPDATE_ATTRIBUTES` and to every update the job sends.
 */
const LINEAGE_UPDATE_ATTRIBUTES = ['pk', 'sk', 'input_feedback_ids', 'evidence_feedback_ids',
  'input_feature_request_ids', 'evidence_updates', 'erased_evidence'];
const PEOPLE_UPDATE_ATTRIBUTES = ['pk', 'sk', 'author', 'replies', 'status_by', 'audience', 'created_by_name',
  'revoked_by', 'revoked', 'owner_email', 'members', 'research_notes'];
/** The partitions the lineage marks write: the deployment's and one workspace id's projects (their libraries too). */
const LINEAGE_UPDATE_PARTITIONS = ['PROJECT#*', `WS#${WORKSPACE_ID_PATTERN}#PROJECT#*`];
/** The partitions the de-identification writes: the deployment's and one workspace id's projects, comment threads and
 * review links. */
const PEOPLE_UPDATE_PARTITIONS = ['PROJECT#*', 'DCOMMENTS#*', 'DOCSHARE#*', `WS#${WORKSPACE_ID_PATTERN}#PROJECT#*`,
  `WS#${WORKSPACE_ID_PATTERN}#DCOMMENTS#*`, `WS#${WORKSPACE_ID_PATTERN}#DOCSHARE#*`];
/**
 * The deployment's product documents' extracted text the worker reads (7.48.00): the extractor writes text for every
 * kind there (a PDF's, an image's description), so only that text is read, never an upload.
 */
export const DEPLOYMENT_PRODUCT_DOC_READS = ['projects/*/product_docs/extracted/*'];
/**
 * The Documents Library's extracted text the worker reads (7.62.00, lambda/jobs/retention/project_people.py
 * `_library_item`): the deployment's and one workspace id's, never an original (lambda/shared/library_keys.py).
 */
export const LIBRARY_TEXT_READS = ['library/*/extracted', `ws/${WORKSPACE_ID_PATTERN}/library/*/extracted`];
/**
 * A workspace's product documents the worker reads (7.43.00): its text uploads (`.md`, `.txt`) and the extracted
 * text, under one workspace id, never an image or another upload (lambda/jobs/retention/project_people.py; the keys
 * api/product_context.py builds).
 */
export const WORKSPACE_PRODUCT_DOC_READS = [`ws/${WORKSPACE_ID_PATTERN}/projects/*/product_docs/raw/*.md`,
  `ws/${WORKSPACE_ID_PATTERN}/projects/*/product_docs/raw/*.txt`,
  `ws/${WORKSPACE_ID_PATTERN}/projects/*/product_docs/extracted/*`];
/** The platform's listing of every workspace in voc-workspaces (lambda/shared/platform_workspaces.py `LISTING_PK`). */
const WORKSPACE_LISTING_PARTITION = 'WORKSPACES';

/** One statement of the participant erasure on voc-participants: its actions, and the partitions they may name: the
 * deployment's, and the same parts inside one workspace id (`WS#{one id}#…`). */
interface ParticipantAccess {
  readonly actions: readonly ('GetItem' | 'Query' | 'ConditionCheckItem' | TableWrite)[];
  readonly deployment: readonly string[];
  readonly workspace: readonly string[];
}
/**
 * Every call an erasure by email makes on voc-participants (7.72.00, projects 3g2: lambda/jobs/retention/participants.py
 * and lambda/shared/participants_erasure.py `erase_person`, with the stores it calls): the address guard's read
 * (`EMAIL#`), the person's (`PERSON#` / `META`) and its partition's Query; the participant's tombstone and delete
 * record (`AUDIT#tombstone#participant`, `AUDIT#delete`, a workspace's tombstone in the same partition under its own
 * sort key), put only if new; a person's `list_ids`, a list's `member_count` and (the deployment's) an ask
 * recipient's token hash and error; the deletes of the guard, the person's rows and its memberships (`LIST#` /
 * `MEMBER#`), and in a workspace the guard's row in its index (`PARTICIPANTS`), after a condition check of the guard;
 * and the batch deletes of its tokens (`TOKEN#`, the deployment's only: a workspace person has none), its project links
 * (`PROJECT#` / `PERSON#`) and its own rows. The reads share one statement (a Query of a guard's partition, or a
 * condition check of a person's, reaches only what the GetItem already reads), so the role's inline policy stays under
 * its size quota. lambda/jobs/retention/test/test_participant_erasure.py records every call the job sends against this
 * list.
 */
const PARTICIPANT_ACCESS: readonly ParticipantAccess[] = [
  { actions: ['GetItem', 'Query', 'ConditionCheckItem'], deployment: ['EMAIL#*', 'PERSON#*'], workspace: ['EMAIL#*', 'PERSON#*'] },
  { actions: ['PutItem'], deployment: ['AUDIT#tombstone#participant', 'AUDIT#delete'], workspace: [] },
  { actions: ['UpdateItem'], deployment: ['PERSON#*', 'LIST#*', 'ASK#*'], workspace: ['PERSON#*', 'LIST#*'] },
  { actions: ['DeleteItem'], deployment: ['EMAIL#*', 'PERSON#*', 'LIST#*'], workspace: ['EMAIL#*', 'PERSON#*', 'LIST#*', 'PARTICIPANTS'] },
  { actions: ['BatchWriteItem'], deployment: ['TOKEN#*', 'PROJECT#*', 'PERSON#*'], workspace: ['PROJECT#*', 'PERSON#*'] },
];
/** What the participant erasure's UpdateItems name (`dynamodb:Attributes`, the key included): a person's lists, a
 * list's count, an ask recipient's token hash and error code. */
const PARTICIPANT_UPDATE_ATTRIBUTES = ['pk', 'sk', 'list_ids', 'member_count', 'response_token_hash', 'error'];
/** The participants' people index (core-stack.ts `gsi1`, lambda/shared/indexes.py `PARTICIPANTS_LISTING_INDEX`) and its
 * partitions the erasure reads in each scope (`PEOPLE`, `WS#{one id}#PEOPLE`, the lower-cased address the sort key): a
 * person whose erasure was cut after its guard went is still found. */
const PARTICIPANT_PEOPLE_INDEX = 'gsi1';
const PARTICIPANT_PEOPLE_INDEX_PARTITIONS = ['PEOPLE', `WS#${WORKSPACE_ID_PATTERN}#PEOPLE`];
const PARTICIPANT_PEOPLE_INDEX_ATTRIBUTES = ['pk', 'gsi1pk', 'gsi1sk'];

/** Path-style handler: the bundle keeps `jobs/retention/` with `shared/` beside `jobs/`. */
const RETENTION_HANDLER = 'jobs/retention/handler.lambda_handler';

/**
 * The prefixes the worker may delete under (and list versions of): the deployment's raw archive and kept Silver
 * versions (lambda/shared/silver_provenance.py), and each workspace's (`ws/{ws}/raw/`, `ws/{ws}/silver/`, one
 * workspace id per pattern: `WORKSPACE_ID_PATTERN`), which an erasure by email and a retention window reach too
 * (TENETS.md D5, legal obligations; lambda/shared/retention.py `reaches_workspaces`). A whole-source erasure, a
 * request about the deployment's own source, never deletes there (in code).
 */
const DELETE_PREFIXES = [RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, WORKSPACE_RAW_LAYER_PREFIX,
  WORKSPACE_SILVER_HISTORY_PREFIX, WORKSPACE_EXPORTS_PREFIX] as const;
export interface RetentionWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  /** voc-radar: other brands' reviews, erased like our own (docs/radar.md). */
  radarTable: dynamodb.ITable;
  /** voc-projects: artifacts whose lineage names an erased item are marked. */
  projectsTable: dynamodb.ITable;
  /** voc-feature-requests: an erasure by email de-identifies the person's board requests and +1s. */
  featureRequestsTable: dynamodb.ITable;
  /** voc-workspaces: an erasure by email removes the email and name from the person's membership rows. */
  workspacesTable: dynamodb.ITable;
  /** voc-participants: an erasure by email erases the participants its address names (7.72.00). */
  participantsTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
}

/**
 * Staged from `lambda/`, pruned to `jobs/retention`, `jobs/__init__.py` and
 * `shared/`, so no other job, API handler or worker tree moves this hash.
 */
function retentionCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/aggregator/', '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/retention/',
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/retention /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/**
 * voc-projects for the worker: the backfill fallback's Scan, the two UpdateItem statements and the Queries of a
 * workspace's and the deployment's project partitions (each pinned by processing-stack-retention.test.ts), in the
 * erasure walks' own customer-managed policy (`walk`, 7.72.00): none of them deletes anything, and the role's inline
 * policy, which keeps every delete and every audit put, would otherwise pass its size quota.
 */
function grantProjectsAccess(walk: iam.ManagedPolicy, projectsTable: dynamodb.ITable): void {
  // Scan (7.48.00): only the deployment's walks' way of finding its review links, comment partitions and projects
  // until the backfill's marker is there (lambda/shared/review_registries.py; voc-datalake/scripts/projects/
  // backfill_review_registries.py). A later release (3g-d2) drops it once every deployment ran the backfill. On the table only (no index), and only for SCAN_ATTRIBUTES (dynamodb:Select and
  // dynamodb:Attributes): a Scan that reads any other attribute, or the whole item, is refused.
  walk.addStatements(new iam.PolicyStatement({
    sid: 'ScanDeploymentReviewRows',
    actions: ['dynamodb:Scan'],
    resources: [projectsTable.tableArn],
    conditions: {
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': SCAN_ATTRIBUTES },
    },
  }));
  // UpdateItem in two statements (7.43.00; jobs/retention/project_people.py, which a test holds to both): the
  // lineage marks and the de-identification, each on the deployment's and one workspace id's partitions of its rows
  // only (7.48.00); no other attribute of a project row can be rewritten.
  // Neither asks for returned values (`dynamodb:ReturnValues` `NONE`), so neither reads a row back beyond its attributes.
  // The table key's actions are the role's own (kmsKey.grantEncryptDecrypt).
  walk.addStatements(keyScopedWriteStatement(projectsTable, ['UpdateItem'], LINEAGE_UPDATE_PARTITIONS,
    LINEAGE_UPDATE_ATTRIBUTES, { noReturnValues: true }));
  walk.addStatements(keyScopedWriteStatement(projectsTable, ['UpdateItem'], PEOPLE_UPDATE_PARTITIONS,
    PEOPLE_UPDATE_ATTRIBUTES, { noReturnValues: true }));
  // 7.43.00 (projects 3g-b): a workspace's projects are read by Query only, of that workspace's partitions on the
  // table (no index, no Scan): the lineage marks of its erased items and an erasure by email's addresses; the code
  // writes a workspace's rows through the workspace layer only.
  walk.addStatements(new iam.PolicyStatement({
    sid: 'QueryWorkspaceProjects',
    actions: ['dynamodb:Query'],
    resources: [projectsTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': RETENTION_PROJECT_PARTITIONS } },
  }));
  // 7.48.00 (projects 3g-d): the deployment's own projects by Query too, on the table only (no index: a deleted
  // project's META is off gsi1-by-type, so its registry, PROJECT_IDS, lists the projects), each project's, series' and
  // link's own partition and the deployment's project, link and series registries, of DEPLOYMENT_QUERY_ATTRIBUTES only.
  walk.addStatements(new iam.PolicyStatement({
    sid: 'QueryDeploymentProjects',
    actions: ['dynamodb:Query'],
    resources: [projectsTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': RETENTION_DEPLOYMENT_PARTITIONS },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': DEPLOYMENT_QUERY_ATTRIBUTES },
      // Without it a Query that names no attribute would pass the ForAllValues test above and read whole rows.
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  }));
}

/**
 * voc-participants for the worker (7.72.00): one statement per entry of `PARTICIPANT_ACCESS`, each on the table only
 * and pinned to its partitions; the UpdateItem also to `PARTICIPANT_UPDATE_ATTRIBUTES`, asking for no returned values;
 * the reads in the walks' policy, every write in the role's own; and the people index's Query, of the deployment's
 * and one workspace id's `PEOPLE` partitions only (`PARTICIPANT_PEOPLE_INDEX_PARTITIONS`), in the walks' policy (each
 * pinned by processing-stack-retention.test.ts and lib/customer-data-deletes.test.ts).
 */
function grantParticipantsAccess(role: iam.Role, walks: iam.ManagedPolicy, participantsTable: dynamodb.ITable): void {
  const writes = new Set<string>(['PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem']);
  walks.addStatements(new iam.PolicyStatement({
    sid: 'QueryParticipantPeopleIndex',
    actions: ['dynamodb:Query'],
    resources: [`${participantsTable.tableArn}/index/${PARTICIPANT_PEOPLE_INDEX}`],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': PARTICIPANT_PEOPLE_INDEX_PARTITIONS },
      // The key it reads and the index's keys it queries by, nothing else of a person (participants.py `_indexed`
      // names them, Select included): a Query naming no attribute would otherwise read whole rows.
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': PARTICIPANT_PEOPLE_INDEX_ATTRIBUTES },
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  }));
  // A workspace person's tombstone is put by the workspace layer (shared/ws_repo.py `put_new_tombstone`), which asks
  // for the row already there when the key is taken (`ReturnValuesOnConditionCheckFailure` `ALL_OLD`): that read of
  // the participant's own tombstone is granted, GetItem of `AUDIT#tombstone#participant` only.
  walks.addStatements(new iam.PolicyStatement({
    sid: 'GetParticipantTombstones',
    actions: ['dynamodb:GetItem'],
    resources: [participantsTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['AUDIT#tombstone#participant'] } },
  }));
  for (const { actions, deployment, workspace } of PARTICIPANT_ACCESS) {
    const partitions = [...deployment, ...workspace.map((part) => `WS#${WORKSPACE_ID_PATTERN}#${part}`)];
    const written = actions.filter((action): action is TableWrite => writes.has(action));
    if (written.length === 0) {
      walks.addStatements(new iam.PolicyStatement({
        actions: actions.map((action) => `dynamodb:${action}`),
        resources: [participantsTable.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } },
      }));
    } else if (written.includes('UpdateItem')) {
      grantKeyScopedWrites(participantsTable, role, written, partitions, PARTICIPANT_UPDATE_ATTRIBUTES,
        { noReturnValues: true });
    } else {
      grantKeyScopedWrites(participantsTable, role, written, partitions);
    }
  }
}

/** The worker; the caller wires its erasure-end notices (lib/utils/realtime.ts). */
export function createRetentionWorker(scope: Construct, id: string, props: RetentionWorkerProps): lambda.Function {
  // A plain construct with the same id keeps every logical id the class form had.
  const worker = new Construct(scope, id);
  const {
    uniqueName, kmsKey, feedbackTable, aggregatesTable, radarTable, projectsTable, featureRequestsTable, workspacesTable,
    participantsTable, rawDataBucket,
  } = props;
  const functionName = uniqueName(RETENTION_FUNCTION_BASE_NAME);

  const role = workerRole(worker, 'RetentionRole');
  // The table itself, never its indexes (7.72.00: the worker scans and reads items by key, and reads no index; the
  // index ARNs the grant named also weighed on the role's inline policy quota).
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem'],
    resources: [feedbackTable.tableArn],
  }));
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query',
    'dynamodb:BatchGetItem');
  // The forms' test responses are not feedback items (voc-aggregates, FEEDBACK_FORM_TEST / WS#{ws}#FEEDBACK_FORM_TEST,
  // {form_id}#…), and retention and erasure reach them too: the delete is pinned to their own partitions, which hold
  // nothing else (IAM pins a partition, never a sort-key prefix: in the forms partition it would reach every form's
  // definition). The Query above reads them.
  grantKeyScopedWrites(aggregatesTable, role, ['DeleteItem'], FORM_TEST_RESPONSES_PARTITIONS);
  radarTable.grant(role, 'dynamodb:Scan', 'dynamodb:DeleteItem');
  grantCacheVersionBump(radarTable, role, RADAR_VERSION_PARTITION);
  // The erasure walks' reads and updates (voc-projects, the product documents, the participants' reads), none a delete
  // or a put, in a policy of their own (7.72.00): with the participants' grants the role's inline policy, which keeps
  // every delete and audit put, would pass its size quota (CDK would then move its last statements, the raw bucket's
  // deletes among them, to an overflow policy of its own choosing).
  const walks = new iam.ManagedPolicy(worker, 'RetentionWalksPolicy', {
    description: 'The retention worker\'s erasure walks: reads, and updates that delete nothing',
    roles: [role],
  });
  grantProjectsAccess(walks, projectsTable);
  // Boards: read + de-identify a request; RE-KEY an erased +1 (one transaction: Put the de-identified row under a new
  // random id, Delete the email-derived one), so Put/Delete are pinned to the request partitions (FR#*), never boards.
  featureRequestsTable.grant(role, 'dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem');
  grantKeyScopedWrites(featureRequestsTable, role, ['PutItem', 'DeleteItem'], [FEATURE_REQUEST_PARTITIONS]);
  // Workspace memberships (lambda/jobs/retention/members.py): find the rows that hold the erased email (Scan: no
  // email index), then REMOVE email and name, on `WS#*` and those two attributes only, asking for no returned values.
  workspacesTable.grant(role, 'dynamodb:Scan');
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], [WORKSPACE_PARTITIONS], MEMBER_PERSON_ATTRIBUTES,
    { noReturnValues: true });
  // 7.43.00: an erasure by email walks every listed workspace's projects, read from the platform's listing (one paged
  // Query of `WORKSPACES`, and at its end a filtered one of the rows renamed or created meanwhile: the same partition,
  // no attribute condition, so no other grant; lambda/jobs/retention/workspaces.py).
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'QueryWorkspaceListing',
    actions: ['dynamodb:Query'],
    resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [WORKSPACE_LISTING_PARTITION] } },
  }));
  // A workspace's META status before its export lock is taken (lambda/jobs/retention/exports.py: no lock row is
  // created for a workspace that is deleting or deleted).
  grantWorkspaceStatusRead(role, workspacesTable);
  // 7.72.00 (projects 3g2): an erasure by email erases the participants its address names (participants.py).
  grantParticipantsAccess(role, walks, participantsTable);
  kmsKey.grantEncryptDecrypt(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DeleteRawArchiveObjects',
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: DELETE_PREFIXES.map((prefix) => rawDataBucket.arnForObjects(`${prefix}*`)),
  }));
  // 7.43.00: an erasure by email reads a workspace's product documents (a text upload, its extracted text) to list
  // for review those that hold the address (lambda/jobs/retention/project_people.py); read only, nothing written.
  // 7.48.00: and the deployment's product documents' extracted text (every kind has one there), never an upload.
  // In the erasure walks' policy (7.72.00).
  walks.addStatements(new iam.PolicyStatement({
    sid: 'ReadWorkspaceProductDocuments',
    actions: ['s3:GetObject'],
    resources: [...WORKSPACE_PRODUCT_DOC_READS, ...DEPLOYMENT_PRODUCT_DOC_READS, ...LIBRARY_TEXT_READS]
      .map((key) => rawDataBucket.arnForObjects(key)),
  }));
  // A workspace's S3 import originals (one file holds many people's rows; no row links an item to its file): no
  // code deletes them, a run lists their folder for review (lambda/shared/retention.py), so IAM refuses it too.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DenyWorkspaceImportOriginalDeletes',
    effect: iam.Effect.DENY,
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    // A workspace's S3 import originals (plugins/_shared/raw_original.py `S3_IMPORT_SOURCE`).
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}s3_import/*`)],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ListRawArchiveVersions',
    actions: ['s3:ListBucketVersions'],
    resources: [rawDataBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': DELETE_PREFIXES.map((prefix) => `${prefix}*`) } },
  }));
  // A workspace's export is a derived copy (TENETS.md D5): an erasure that reaches the workspace aborts its open
  // export upload too (lambda/jobs/retention/exports.py), listed under its exports and aborted there only.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'AbortWorkspaceExportUploads',
    actions: ['s3:AbortMultipartUpload'],
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`)],
  }));
  // ListBucketMultipartUploads takes no `s3:prefix` condition (the Service Authorization Reference lists that key for
  // ListBucket and ListBucketVersions only), so it is granted on the bucket unconditioned: it reaches the keys and
  // upload ids of the bucket's open uploads, no object data. The code lists one workspace's exports prefix only
  // (lambda/shared/ws_repo.py `ExportObjects.open_uploads`), and the abort is held to `ws/{one id}/exports/*` above.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ListWorkspaceExportUploads',
    actions: ['s3:ListBucketMultipartUploads'],
    resources: [rawDataBucket.bucketArn],
  }));
  // Self hand-over before the 15-minute ceiling, by name (a GetAtt on the
  // function from its own role's policy would be a CloudFormation cycle).
  grantInvokeByName(cdk.Stack.of(worker), role, [functionName], 'SelfInvoke');

  const fn = new lambda.Function(worker, 'Retention', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: RETENTION_HANDLER,
    code: retentionCode(),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: 512,
    // A hidden re-drive would race the job row's checkpoint; the job/audit
    // rows record failures, and the next daily tick catches up.
    retryAttempts: 0,
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      RADAR_TABLE: radarTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
      FEATURE_REQUESTS_TABLE: featureRequestsTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      PARTICIPANTS_TABLE: participantsTable.tableName,
      // No RETENTION_FUNCTION: the worker re-invokes itself via context.function_name.
      POWERTOOLS_SERVICE_NAME: RETENTION_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, 'RetentionLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
  // The function waits for the walks' policy as it waits for the role's own (an invocation before it is attached
  // would fail its first Query).
  fn.node.addDependency(walks);

  scheduleWorker(worker, 'RetentionSchedule', fn, uniqueName('voc-retention-schedule'),
    // 04:15 UTC — after the memory retention run (03:15), off the quarter-hour ticks.
    events.Schedule.cron({ hour: '4', minute: '15' }),
    events.RuleTargetInput.fromObject({ mode: 'retention' }));
  return fn;
}
