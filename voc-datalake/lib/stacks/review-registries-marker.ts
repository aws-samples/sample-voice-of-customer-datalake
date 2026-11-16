/**
 * The review registries' backfill marker is dropped whenever a release that keeps the registries is installed or
 * removed (7.44.00, projects 3g-d; voc-datalake/scripts/projects/backfill_review_registries.py).
 *
 * The marker (`DOCSHARE_IDS` / `MIGRATION#review-registries` in voc-projects) tells an erasure by email that the
 * deployment's links, series and projects are all in their registries, so it walks them by Query and no longer by
 * Scan. Only the operator's backfill writes it, and only while every writer runs 7.44.0 or later. A release older than
 * 7.44.00 writes no registry row, so a marker left behind by a rollback would make the next upgrade's erasures trust
 * registries that miss what the older release made meanwhile. So a custom resource deletes the marker:
 *   - on Create: the upgrade to 7.44.00 adds the resource (and so does every later upgrade after a rollback below it),
 *     so a marker that predates this release's writers never counts;
 *   - on Delete: a rollback to a release without the resource (or the stack's removal) removes it, so no marker
 *     outlives the writers that keep the registries.
 * It lives in VocCoreStack, beside voc-projects and its key (CDK's AwsCustomResource provider, its role and its log
 * group come with it), not in VocApiStack beside the writers, whose resource count is at its release ceiling
 * (api-engagement-budget.test.ts: these would be six of its last ten under the 425 gate). So it fires when the whole
 * release is deployed or rolled back (`npm run deploy:all` from a checkout), not when VocApiStack alone is: deploying
 * one stack is routine (docs/deployment.md, "Deploy Individual Stacks"), and an older VocApiStack deployed alone, or
 * a project bundle imported from an older checkout, leaves the marker standing while a writer keeps no registry. That
 * case needs the backfill's `--unmark`, which docs/deployment.md says where it describes single-stack deploys; moving
 * the reset into VocApiStack once its budget allows, and a walk's check that the registries still hold every live
 * project, are 3g-d2's (docs/multi-workspace.md). The erasure also refuses a marker that names no release of 7.44.0
 * or later (lambda/shared/review_registries.py `marker_complete`).
 *
 * The reset deletes the marker only, never the backfill's progress row (`MIGRATION#review-registries#progress`): a
 * stopped walk resumed after any later deploy is voided by the backfill itself, since its writers are judged against
 * when the walk began (`started_at`), and a writer updated since then voids it; so a progress row can never earn a
 * marker across the deploy that reset it.
 *
 * Its policy may DeleteItem in voc-projects' `DOCSHARE_IDS` partition only (`dynamodb:LeadingKeys`); IAM has no
 * condition on the sort key, so the one row it deletes is pinned by the call, not by IAM (the rest of the partition is
 * the deployment's link registry, which the call never names). It decrypts with the table's key, as every caller of a
 * table with a customer-managed key must. The policy is attached to CDK's singleton AwsCustomResource role, which every
 * AwsCustomResource of the stack would share: this is the stack's only one (a test holds it so), so the role holds
 * exactly this policy.
 */
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';

import { AUDIT_DENY_WRITE_SID } from '../utils/audit-row-guard';
import { acknowledgeNag } from '../utils/nag-ack';
import { cdkCustomResourceSuppressions, suppressAwsCustomResourceProvider } from '../utils/nag-suppressions';

/** Its own custom-resource type, so it is never counted as another `Custom::AWS` call. */
export const REVIEW_REGISTRIES_MARKER_RESET_TYPE = 'Custom::ReviewRegistriesMarkerReset';
/** The marker's key (lambda/shared/project_keys.py `DEPLOYMENT_LINK_REGISTRY_PK`, `REVIEW_REGISTRIES_MARKER_SK`). */
export const REVIEW_REGISTRIES_MARKER_PK = 'DOCSHARE_IDS';
export const REVIEW_REGISTRIES_MARKER_SK = 'MIGRATION#review-registries';

export function resetReviewRegistriesMarker(stack: cdk.Stack, projectsTable: dynamodb.ITable, kmsKey: kms.IKey): void {
  const call: cr.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'deleteItem',
    parameters: {
      TableName: projectsTable.tableName,
      Key: { pk: { S: REVIEW_REGISTRIES_MARKER_PK }, sk: { S: REVIEW_REGISTRIES_MARKER_SK } },
    },
    physicalResourceId: cr.PhysicalResourceId.of('review-registries-marker-reset'),
  };
  const reset = new cr.AwsCustomResource(stack, 'ReviewRegistriesMarkerReset', {
    resourceType: REVIEW_REGISTRIES_MARKER_RESET_TYPE,
    onCreate: call,
    onDelete: call,
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem'],
        resources: [projectsTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [REVIEW_REGISTRIES_MARKER_PK] } },
      }),
      new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [kmsKey.keyArn] }),
      // The audit-row guard's Deny (lib/utils/audit-row-guard.ts), which guards roles' default and customer-managed
      // policies but not this construct's own: no audit row may be forged, changed or removed through it.
      new iam.PolicyStatement({
        sid: AUDIT_DENY_WRITE_SID,
        effect: iam.Effect.DENY,
        actions: ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem'],
        resources: [projectsTable.tableArn],
        conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#*'] } },
      }),
    ]),
    installLatestAwsSdk: false,
  });
  acknowledgeNag(reset, cdkCustomResourceSuppressions);
  suppressAwsCustomResourceProvider(stack);
}
