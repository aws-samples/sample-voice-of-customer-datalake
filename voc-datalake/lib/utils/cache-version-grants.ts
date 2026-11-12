/**
 * The cache-version bump grant (docs/caching.md, lambda/shared/data_version.py).
 *
 * A writer that publishes "the data / config / Radar changed" does ONE `UpdateItem`
 * (`ADD v 1`) on a version row. Roles that otherwise only read a table get exactly
 * that, pinned by `dynamodb:LeadingKeys` to the version rows' partition, so the grant
 * cannot write anything else in the table.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

import { WORKSPACE_ID_PATTERN } from '../stacks/core-buckets';

/** `voc-aggregates`: `METRIC#meta / data_version` and `METRIC#meta / config_version`. */
export const AGGREGATES_VERSION_PARTITION = 'METRIC#meta';
/** `voc-radar`: `SETTINGS#radar / version`. */
export const RADAR_VERSION_PARTITION = 'SETTINGS#radar';

/**
 * `voc-aggregates`: a workspace's own `WS#{ws}#METRIC#meta / data_version` (docs/multi-workspace.md; the workspace
 * segment is exactly one id, `WORKSPACE_ID_PATTERN`, so no other `WS#…` partition matches).
 */
const WORKSPACE_AGGREGATES_VERSION_PARTITION =`WS#${WORKSPACE_ID_PATTERN}#METRIC#meta`;

export function grantCacheVersionBump(table: dynamodb.ITable, grantee: iam.IGrantable, partition: string): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [partition] } },
  }));
}

/** The same bump on a workspace's version row (`StringLike` over {@link WORKSPACE_AGGREGATES_VERSION_PARTITION}). */
export function grantWorkspaceCacheVersionBump(table: dynamodb.ITable, grantee: iam.IGrantable): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [WORKSPACE_AGGREGATES_VERSION_PARTITION] } },
  }));
}
