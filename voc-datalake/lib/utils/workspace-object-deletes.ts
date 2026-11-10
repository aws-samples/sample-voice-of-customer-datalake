/**
 * Workspace deletes remove every S3 version (wave C owner decision 2: a workspace artifact is really deleted when
 * its owner deletes it, every S3 version too, and the deletion is recorded).
 *
 * The raw data bucket is versioned, so a plain DeleteObject only adds a delete marker and the object's data stays
 * as a noncurrent version. Until 6.00 a 90-day lifecycle rule per workspace prefix expired those versions; now the
 * deleting code removes them itself (lambda/shared/s3_versions.py: list the key's versions, delete each by
 * VersionId), which needs `s3:ListBucketVersions` on the bucket and `s3:DeleteObjectVersion` on the objects.
 *
 * Granted on exactly the workspace prefixes a role deletes under, never `raw/*` (the bronze layer is deleted only by
 * voc-retention, lib/stacks/retention-worker.ts). Each helper writes ONE statement in the shape of CDK's own bucket
 * grants (the bucket ARN for the bucket-level actions, the prefix ARNs for the object-level ones): one statement for
 * all of a role's prefixes instead of one per prefix and per grant keeps the projects API's inline policy under 70%
 * of IAM's quota (api-stack-mcp.test.ts) and CDK from splitting it into an overflow managed policy (a resource the
 * VocApiStack ceiling has no room for). So the version listing is not pinned by `s3:prefix`: it shows what the
 * `s3:ListBucket` every CDK prefix grant puts on the whole bucket already shows (key names), plus version ids.
 * Who holds a delete is pinned by lib/customer-data-deletes.test.ts.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { RAW_BUCKET_WORKSPACE_PREFIXES } from '../stacks/core-buckets';

/** What a role needs to delete every version of an object. */
export const VERSION_DELETE_ACTIONS = ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:ListBucketVersions'] as const;
/**
 * Read (GetObject / HeadObject / a copy source, ListObjectsV2) and write (PutObject, CopyObject, a presigned PUT):
 * what the exact-grants rewrite of CDK's `grantReadWrite` keeps, without the object-lock and tagging writes no
 * code makes (lib/utils/exact-grants.ts).
 */
const READ_WRITE_ACTIONS = ['s3:GetObject', 's3:ListBucket', 's3:PutObject'] as const;

function objectStatement(bucket: s3.IBucket, actions: readonly string[], objectGlobs: readonly string[]): iam.PolicyStatement {
  if (objectGlobs.length === 0) throw new Error('workspace object grant: name at least one prefix');
  // Only under a known workspace prefix: never raw/ (the bronze layer), never the whole bucket.
  const outside = objectGlobs.filter((glob) => !RAW_BUCKET_WORKSPACE_PREFIXES.some((prefix) => glob.startsWith(prefix)));
  if (outside.length > 0) throw new Error(`workspace object grant: not a workspace prefix: ${outside.join(', ')}`);
  return new iam.PolicyStatement({
    actions: [...actions],
    resources: [bucket.bucketArn, ...objectGlobs.map((glob) => bucket.arnForObjects(glob))],
  });
}

/** Let `grantee` delete every version of the objects under `objectGlobs` (key globs, e.g. `avatars/*`). */
export function grantWorkspaceVersionDeletes(bucket: s3.IBucket, grantee: iam.IGrantable, objectGlobs: readonly string[]): void {
  grantee.grantPrincipal.addToPrincipalPolicy(objectStatement(bucket, VERSION_DELETE_ACTIONS, objectGlobs));
}

/**
 * Read, write and delete (every version) the objects under `objectGlobs`, in one statement, with the bucket key's
 * encrypt / decrypt: a workspace owner's full access to its own prefixes.
 */
export function grantWorkspaceObjects(bucket: s3.IBucket, grantee: iam.IGrantable, objectGlobs: readonly string[]): void {
  grantee.grantPrincipal.addToPrincipalPolicy(
    objectStatement(bucket, [...READ_WRITE_ACTIONS, ...VERSION_DELETE_ACTIONS], objectGlobs));
  bucket.encryptionKey?.grantEncryptDecrypt(grantee);
}
