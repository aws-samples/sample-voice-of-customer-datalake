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
 * voc-retention, lib/stacks/retention-worker.ts); the listing is pinned to the same prefixes by `s3:prefix`.
 * Who holds it is pinned by lib/customer-data-deletes.test.ts.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { RAW_LAYER_PREFIX } from '../stacks/core-buckets';

/** The prefix no workspace grant may name: the bronze layer (TENETS.md D1). */
const BRONZE_PREFIX = RAW_LAYER_PREFIX;

/**
 * Let `grantee` delete every version of the objects under `objectGlobs` (key globs, e.g. `avatars/*`,
 * `projects/*\/product_docs/*`) and list their versions. `sid` names the pair (unique per role).
 */
export function grantWorkspaceVersionDeletes(
  bucket: s3.IBucket, grantee: iam.IGrantable, objectGlobs: readonly string[], sid: string,
): void {
  if (objectGlobs.length === 0) throw new Error('grantWorkspaceVersionDeletes: name at least one prefix');
  const bronze = objectGlobs.filter((glob) => glob === '*' || glob.startsWith(BRONZE_PREFIX));
  if (bronze.length > 0) throw new Error(`grantWorkspaceVersionDeletes: not a workspace prefix: ${bronze.join(', ')}`);
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: `${sid}Versions`,
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: objectGlobs.map((glob) => bucket.arnForObjects(glob)),
  }));
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: `${sid}ListVersions`,
    actions: ['s3:ListBucketVersions'],
    resources: [bucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [...objectGlobs] } },
  }));
}
