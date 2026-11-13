/**
 * The one grant a writer of the Silver history needs (lambda/shared/silver_provenance.py `keep_silver_version`):
 * `s3:PutObject` on `silver/*` of the raw data bucket, nothing else. No read, no delete, no tagging or retention
 * actions (`grantPut` would add `s3:PutObject{LegalHold,Retention,Tagging,VersionTagging}`). Each put sends
 * `If-None-Match: *`, which the bucket policy requires under `silver/` (core-buckets.ts `APPEND_ONLY_PREFIXES`),
 * so the grant can only create a new version, never overwrite one. The bucket is SSE-KMS: the role also needs
 * `kms:GenerateDataKey` on the data key, which every writer already holds (`kmsKey.grantEncryptDecrypt`).
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { SILVER_HISTORY_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX } from '../stacks/core-buckets';

export function grantSilverHistoryPut(rawDataBucket: s3.IBucket, grantee: iam.IGrantable): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'KeepSilverVersions',
    actions: ['s3:PutObject'],
    resources: [rawDataBucket.arnForObjects(`${SILVER_HISTORY_PREFIX}*`)],
  }));
}

/**
 * The same for a workspace's item (docs/multi-workspace.md): `s3:PutObject` under one workspace's
 * `ws/{ws}/silver/` (`WORKSPACE_SILVER_HISTORY_PREFIX`: the workspace segment is exactly one id, IAM's `*` would
 * also match `/`), which the bucket policy holds write-once like `silver/`.
 */
export function grantWorkspaceSilverHistoryPut(rawDataBucket: s3.IBucket, grantee: iam.IGrantable): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'KeepWorkspaceSilverVersions',
    actions: ['s3:PutObject'],
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_SILVER_HISTORY_PREFIX}*`)],
  }));
}
