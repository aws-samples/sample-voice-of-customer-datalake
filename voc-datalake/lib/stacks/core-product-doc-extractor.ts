/**
 * The product-doc extractor's reach (VocCoreStack; lambda/product_doc_extractor/handler.py; docs/multi-workspace.md,
 * the project plan, 3f): its notification rules on the raw data bucket and its grants by key.
 *
 * - S3: GetObject of the uploads, PutObject of the text, and a delete of the text alone, to take back the text of a
 *   record deleted while it was being put; the deployment's `projects/…` and one workspace's `ws/{one id}/projects/…`.
 * - voc-projects: a document row's GetItem (a workspace's held to the attributes the handler projects) and its one
 *   conditional UpdateItem, held to the attributes it names; a project id's claim, its key and workspace id only.
 * - voc-workspaces: a workspace's `META` status. voc-aggregates: the two model rows.
 *
 * core-product-doc-extractor.test.ts pins all of it; voc-datalake/schemas/project-keys-cases.json holds the lists the
 * handler's tests hold the handler to.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { MODEL_DEFAULT_PARTITION } from '../utils/model-allowlist';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { grantWorkspaceAttributeRead, grantWorkspaceStatusRead } from '../utils/workspace-resolution-grants';
import { WORKSPACE_DATA_PREFIX, WORKSPACE_ID_PATTERN } from './core-buckets';
import { MODEL_SETTINGS_PARTITION } from './design-capture';
import { PROJECT_CLAIM_PARTITIONS } from './workspace-delete-worker';

/**
 * The extensions a product document's upload key ends in (lambda/api/product_context.py ALLOWED_CONTENT_TYPES, the
 * extractor's UPLOAD_EXTENSIONS): each is the suffix of one `ws/` notification rule.
 */
export const PRODUCT_DOC_UPLOAD_EXTENSIONS = ['gif', 'jpg', 'md', 'png', 'txt', 'webp'] as const;
/** One workspace's objects, `ws/{one id}/` (a workspace's product documents sit under it). */
const PRODUCT_DOC_WORKSPACE_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/`;
/** The uploads it reads and the text it writes, the deployment's and one workspace's: one id segment, never `*`. */
const READ_KEYS = ['projects/*/product_docs/raw/*', `${PRODUCT_DOC_WORKSPACE_PREFIX}projects/*/product_docs/raw/*`];
const WRITE_KEYS = [
  'projects/*/product_docs/extracted/*', `${PRODUCT_DOC_WORKSPACE_PREFIX}projects/*/product_docs/extracted/*`];
/** The project partitions the extractor reads and updates a document row in: the deployment's `PROJECT#{id}` and one
 *  workspace's `WS#{ws}#PROJECT#{id}` (lambda/shared/project_keys.py `project_pk`). */
export const PRODUCT_DOC_PARTITIONS = ['PROJECT#*', `WS#${WORKSPACE_ID_PATTERN}#PROJECT#*`] as const;
/** What the extractor may read of a project id's claim: its key and the workspace it names, never its `claimed_at`
 *  (the code projects `workspace_id` alone: handler.py `_claimed_workspace`). */
export const PROJECT_CLAIM_READ_ATTRIBUTES = ['pk', 'sk', 'workspace_id'] as const;
/** What the extractor reads of a workspace's document record (handler.py DOC_READ_ATTRIBUTES, its projection). */
export const PRODUCT_DOC_READ_ATTRIBUTES = ['content_type', 'pk', 's3_raw_key', 'sk', 'status'] as const;
/** Every attribute the extractor's UpdateItem of a document row names (`dynamodb:Attributes`): its key, its
 *  condition's and its writes'. */
export const PRODUCT_DOC_ROW_ATTRIBUTES = ['error', 'extracted_chars', 'pk', 's3_extracted_key', 'sk', 'status'] as const;
/** The voc-aggregates rows the extractor reads: the model picks and the deployment's default. */
export const PRODUCT_DOC_MODEL_PARTITIONS = [MODEL_SETTINGS_PARTITION, MODEL_DEFAULT_PARTITION] as const;

/** The tables and the bucket the extractor reaches. */
export interface ProductDocExtractorResources {
  rawDataBucket: s3.IBucket;
  projectsTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
}

/** Grants the extractor its S3 and DynamoDB reach (above); returns the S3 key patterns, for its IAM5 acknowledgement. */
export function grantProductDocExtractor(fn: lambda.Function, resources: ProductDocExtractorResources): string[] {
  const { rawDataBucket, projectsTable, workspacesTable, aggregatesTable } = resources;
  const role = fn.role;
  if (!role) throw new Error('the product-doc extractor must have a role of its own');
  // GetObject only (no List, no bucket-level read): the handler reads the one object its event names.
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'], resources: READ_KEYS.map((keys) => rawDataBucket.arnForObjects(keys)) }));
  // Its own output only: PutObject (no tagging, retention or legal hold), and a delete only to take that text back
  // when the record was deleted while it was being put (handler.py `_delete_own_output`, the exact version it put).
  // Never the raw upload, which would let it overwrite or remove its own input; a document delete is the projects API's.
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: WRITE_KEYS.map((keys) => rawDataBucket.arnForObjects(keys)),
  }));
  // A workspace's record is read for PRODUCT_DOC_READ_ATTRIBUTES only (the handler projects them); the deployment's
  // read stays the unprojected request it always was, so its GetItem is not held to attributes.
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'], resources: [projectsTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [PRODUCT_DOC_PARTITIONS[0]] } },
  }));
  grantWorkspaceAttributeRead(role, projectsTable, PRODUCT_DOC_READ_ATTRIBUTES, [PRODUCT_DOC_PARTITIONS[1]]);
  grantKeyScopedWrites(projectsTable, fn, ['UpdateItem'], PRODUCT_DOC_PARTITIONS, PRODUCT_DOC_ROW_ATTRIBUTES);
  // A project id's claim (`PROJECT_ID#{id}` / `CLAIM`, deployment-wide by design), read for its workspace id only.
  grantWorkspaceAttributeRead(role, projectsTable, PROJECT_CLAIM_READ_ATTRIBUTES, PROJECT_CLAIM_PARTITIONS);
  // A workspace's `META` status before a workspace upload is written (shared/ws_repo.py `workspace_is_active`).
  grantWorkspaceStatusRead(role, workspacesTable);
  // voc-aggregates: the two model rows only (handler.py `_model_row`: the picks and the deployment's default).
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'], resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [...PRODUCT_DOC_MODEL_PARTITIONS] } },
  }));
  return [...READ_KEYS, ...WRITE_KEYS];
}

/**
 * The extractor's notification rules on the raw data bucket. The deployment's uploads: ONE rule on the broad
 * `projects/` prefix (S3 allows one prefix per rule and rejects overlapping rules on the same event type, and the
 * project ids are runtime values); the handler's RAW_KEY_PATTERN drops every other object, its own
 * `product_docs/extracted/` output included, which would otherwise re-trigger it in a loop. A workspace's uploads
 * (`ws/{ws}/projects/{id}/product_docs/raw/{doc}.{ext}`, 3f): no prefix names every workspace's `product_docs/raw/`,
 * and the whole of `ws/` would invoke it for every object any workspace writes, so one rule per upload extension,
 * `ws/` with that suffix: the suffixes overlap neither one another nor `projects/`, so S3 accepts them side by side,
 * and the handler's WORKSPACE_RAW_KEY_PATTERN drops every other match.
 */
export function notifyProductDocExtractor(rawDataBucket: s3.Bucket, fn: lambda.Function): void {
  rawDataBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(fn), { prefix: 'projects/' });
  for (const extension of PRODUCT_DOC_UPLOAD_EXTENSIONS) {
    rawDataBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(fn),
      { prefix: WORKSPACE_DATA_PREFIX, suffix: `.${extension}` });
  }
}
