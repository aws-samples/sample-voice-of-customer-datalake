/**
 * The review registries' backfill marker is dropped whenever a release that keeps the registries is installed or
 * removed (7.48.00, projects 3g-d; voc-datalake/scripts/projects/backfill_review_registries.py).
 *
 * The marker (`DOCSHARE_IDS` / `MIGRATION#review-registries` in voc-projects) tells an erasure by email that the
 * deployment's links, series and projects are all in their registries, so it walks them by Query and no longer by
 * Scan. Only the operator's backfill writes it, and only while every writer runs 7.48.0 or later. A release older than
 * 7.48.00 writes no registry row, so a marker left behind by a rollback would make the next upgrade's erasures trust
 * registries that miss what the older release made meanwhile. So a custom resource deletes the marker:
 *   - on Create: the upgrade to 7.48.00 adds the resource (and so does every later upgrade after a rollback below it),
 *     so a marker that predates this release's writers never counts;
 *   - on Delete: a rollback to a release without the resource (or the stack's removal) removes it, so no marker
 *     outlives the writers that keep the registries.
 * It lives in VocCoreStack, beside voc-projects and its key, not in VocApiStack beside the writers. 7.93.00 (3g-d2)
 * measured the move: the reset is five resources (the custom resource, its policy, and CDK's singleton provider
 * function, its role and that role's policy), and VocApiStack's largest shape (`-c performanceTier=true`, every
 * plugin) synthesizes 425 resources, the 425 gate itself (api-engagement-budget.test.ts, api-stack-snapstart.test.ts):
 * the move would take it to 430, so it waits until that stack gives five back (docs/multi-workspace.md, 3g-d3). So it
 * fires when the whole release is deployed or rolled back (`npm run deploy:all` from a checkout), not when VocApiStack
 * alone is: deploying one stack is routine (docs/deployment.md, "Deploy Individual Stacks"), and an older VocApiStack
 * deployed alone, or a project bundle imported from an older checkout, leaves the marker standing while a writer keeps
 * no registry. That case needs the backfill's `--unmark`, which docs/deployment.md says where it describes
 * single-stack deploys; since 7.93.00 the retention worker's registries check also notices a live project such a
 * writer made and left unlisted (lambda/jobs/retention/registries.py `step`; it cannot see an unlisted review link,
 * an unlisted series or an unlisted deleted project). The worker also refuses a marker that names no release of 7.48.0
 * or later (lambda/shared/review_registries.py `marker_complete`); since 7.93.00, without a complete marker, an erasure
 * by email fails by name and every other run of the deployment owes its lineage marks.
 *
 * The reset deletes the marker only, never the backfill's progress row (`MIGRATION#review-registries#progress`): a
 * stopped walk resumed after any later deploy is voided by the backfill itself, since its writers are judged against
 * when the walk began (`started_at`), and a writer updated since then voids it; so a progress row can never earn a
 * marker across the deploy that reset it.
 *
 * The seed (7.93.00, 3g-d2, review round 2: fp-2; lambda/custom_resources/review_registries_marker.py): since 7.93.00
 * an erasure by email fails by name without the marker, so a new deployment, which has nothing to backfill, gets a
 * complete one on its own. A second resource, created after the reset (it depends on it, so the delete always comes
 * first), runs a Python handler behind its own provider: on Create it reads one row of `gsi1-by-type`'s
 * `TYPE#PROJECT` (`Limit` 1, the keys only) and, finding no project, puts a complete marker (each count 0, this
 * release), never over one already there; finding one (an upgrade, or the release added again after a rollback
 * below 7.48.00) it writes nothing, and the operator's backfill writes it. Update and Delete do nothing. It is a
 * resource of its own, not a new handler for the reset, because a custom resource's provider cannot change in
 * place: a new reset would have deleted every upgraded deployment's marker (the old one's Delete). Its role may run
 * exactly that Query (`dynamodb:LeadingKeys` `TYPE#PROJECT`, `dynamodb:Attributes` the table's and the index's keys,
 * `dynamodb:Select` `SPECIFIC_ATTRIBUTES`: the retention worker's own index grant) and PutItem in `DOCSHARE_IDS`
 * only. Its blind spot: a project made before 7.48.00 and since deleted, on a deployment with no live project (off
 * the index and never listed, its threads are not), so docs/deployment.md says to run the backfill on every upgrade
 * from below 7.48.00, and to take the dry run before the deploy on one from 7.48.00 or later.
 *
 * The reset's policy may DeleteItem in voc-projects' `DOCSHARE_IDS` partition only (`dynamodb:LeadingKeys`); IAM has no
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
import { appVersion } from '../utils/connector-version';
import { acknowledgeNag } from '../utils/nag-ack';
import { cdkCustomResourceSuppressions, suppressAwsCustomResourceProvider } from '../utils/nag-suppressions';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { createInlineCustomResourceHandler, lambdaLogGroup } from './core-auth';
import { DEPLOYMENT_PROJECTS_PARTITION, PROJECTS_INDEX, projectIndexKeysQuery } from './retention-worker';

/** Its own custom-resource type, so it is never counted as another `Custom::AWS` call. */
export const REVIEW_REGISTRIES_MARKER_RESET_TYPE = 'Custom::ReviewRegistriesMarkerReset';
/** The marker's key (lambda/shared/project_keys.py `DEPLOYMENT_LINK_REGISTRY_PK`, `REVIEW_REGISTRIES_MARKER_SK`). */
export const REVIEW_REGISTRIES_MARKER_PK = 'DOCSHARE_IDS';
export const REVIEW_REGISTRIES_MARKER_SK = 'MIGRATION#review-registries';
/** The seed's type (7.93.00): a new deployment's complete marker. */
export const REVIEW_REGISTRIES_MARKER_SEED_TYPE = 'Custom::ReviewRegistriesMarkerSeed';

export function resetReviewRegistriesMarker(
  stack: cdk.Stack, projectsTable: dynamodb.ITable, kmsKey: kms.IKey, uniqueName: (baseName: string) => string,
): void {
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
  seedReviewRegistriesMarker(stack, projectsTable, kmsKey, uniqueName).node.addDependency(reset);
}

/** The seed (the header): its handler, exactly its two grants, its provider and the resource. */
function seedReviewRegistriesMarker(
  stack: cdk.Stack, projectsTable: dynamodb.ITable, kmsKey: kms.IKey, uniqueName: (baseName: string) => string,
): cdk.CustomResource {
  const seed = createInlineCustomResourceHandler({ stack, uniqueName }, 'ReviewRegistriesMarkerSeedLambda', {
    baseName: 'voc-review-registries-seed',
    sourceFile: 'review_registries_marker.py',
    description: "Writes a new deployment's review registries marker (no project yet: nothing to backfill)",
    // Named, so the System logs reach it through their existing `/aws/lambda/voc-*` grant (the logs API's policy is
    // near its quota: a CloudFormation-named group would add a statement there).
    namedLogGroup: true,
  });
  // The retention worker's own index grant (retention-worker.ts): the deployment's project keys only.
  seed.addToRolePolicy(projectIndexKeysQuery(projectsTable, 'QueryOneDeploymentProjectKey'));
  kmsKey.grant(seed, 'kms:Decrypt');
  grantKeyScopedWrites(projectsTable, seed, ['PutItem'], [REVIEW_REGISTRIES_MARKER_PK]);
  const provider = new cr.Provider(stack, 'ReviewRegistriesMarkerSeedProvider', {
    onEventHandler: seed,
    logGroup: lambdaLogGroup(stack, 'ReviewRegistriesMarkerSeedProviderLogs'),
  });
  acknowledgeNag(provider.node.findChild('framework-onEvent'), cdkCustomResourceSuppressions);
  return new cdk.CustomResource(stack, 'ReviewRegistriesMarkerSeed', {
    serviceToken: provider.serviceToken,
    resourceType: REVIEW_REGISTRIES_MARKER_SEED_TYPE,
    // The index and partition its policy allows (projectIndexKeysQuery), so the handler names no index of its own.
    properties: {
      TableName: projectsTable.tableName, IndexName: PROJECTS_INDEX, Partition: DEPLOYMENT_PROJECTS_PARTITION,
      Release: appVersion(),
    },
  });
}
