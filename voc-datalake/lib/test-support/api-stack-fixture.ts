/**
 * Test support: the cross-stack dependencies `VocApiStack` takes, built on a
 * throwaway `deps` stack.
 *
 * The api-stack specs (`api-stack.test.ts`, `api-stack-webhook-env.test.ts`)
 * each construct the whole dependency graph — tables, KMS key, buckets, Cognito,
 * CloudFront, the research state machine — before the one or two props their
 * cases are about. This is that graph, once. What a suite varies stays its own:
 * the table factory (one suite needs GSIs for its IAM wildcard assertions),
 * `enabledSources`, `deploymentPrefix` and `brandName`.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { VocApiStackProps } from '../stacks/api-stack';
import { fixtureBucket } from './fixture-resources';

export interface ApiStackEnv {
  account: string;
  region: string;
}

/** The shared plugin secret the API Lambdas read; a spec pins which roles may reach it. */
export function sharedSecretArn(env: ApiStackEnv): string {
  return `arn:aws:secretsmanager:${env.region}:${env.account}:secret:voc`;
}

/** The CDN signing key secret — a different secret, so a grant on one never covers the other. */
function cdnSigningSecretArn(env: ApiStackEnv): string {
  return `arn:aws:secretsmanager:${env.region}:${env.account}:secret:cdn-signing`;
}

/** A table keyed `pk`/`sk` (both strings) — the shape every VoC table shares. */
export function pkSkTable(scope: cdk.Stack, id: string): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
}

/** Every VocApiStack prop except the env, prefix and config a suite sets itself. */
export type ApiStackDependencyProps = Omit<VocApiStackProps, 'env' | 'deploymentPrefix' | 'brandName' | 'enabledSources'>;

/** Adds the `gsi1` (gsi1pk/gsi1sk) index every indexed fixture table carries. */
export function addGsi1(table: dynamodb.Table): void {
  table.addGlobalSecondaryIndex({
    indexName: 'gsi1',
    partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
  });
}

/**
 * A pk/sk table factory whose tables carry a `gsi1` index. Load-bearing for IAM
 * assertions: `Table.grant()` expands to `<table>/index/*` only when an index
 * exists, so without one a table-only and an index-reaching grant synthesize
 * identically and every wildcard assertion is vacuous.
 */
export function indexedTableFactory(deps: cdk.Stack): (id: string) => dynamodb.Table {
  return (id) => {
    const created = pkSkTable(deps, id);
    addGsi1(created);
    return created;
  };
}

export function apiStackDependencyProps(
  deps: cdk.Stack,
  env: ApiStackEnv,
  table: (id: string) => dynamodb.Table,
): ApiStackDependencyProps {
  const userPool = new cognito.UserPool(deps, 'UserPool');
  const websiteBucket = fixtureBucket(deps, 'Website');
  return {
    feedbackTable: table('Feedback'),
    aggregatesTable: table('Aggregates'),
    projectsTable: table('Projects'),
    jobsTable: table('Jobs'),
    conversationsTable: table('Conversations'),
    memoryTable: table('Memory'),
    agentsTable: table('Agents'),
    designIntegrationsSecretArn: `arn:aws:secretsmanager:${env.region}:${env.account}:secret:design-integrations`,
    kmsKey: new kms.Key(deps, 'Key'),
    rawDataBucket: fixtureBucket(deps, 'RawData'),
    avatarsCdnUrl: 'https://cdn.example.invalid/avatars',
    prototypesCdnUrl: 'https://cdn.example.invalid/prototypes',
    cdnSigningSecretArn: cdnSigningSecretArn(env),
    cdnSigningKeyPairId: 'KEXAMPLE0000',
    websiteBucket,
    frontendDistribution: new cloudfront.Distribution(deps, 'Dist', {
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket) },
    }),
    frontendDomainName: 'app.example.invalid',
    userPool,
    userPoolClient: userPool.addClient('Client'),
    identityPool: new cognito.CfnIdentityPool(deps, 'IdentityPool', { allowUnauthenticatedIdentities: false }),
    authenticatedRole: new iam.Role(deps, 'AuthRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
    processingQueueUrl: `https://sqs.${env.region}.amazonaws.com/${env.account}/processing`,
    processingQueueArn: `arn:aws:sqs:${env.region}:${env.account}:processing`,
    secretsArn: sharedSecretArn(env),
    s3ImportBucket: fixtureBucket(deps, 'S3Import'),
    researchStateMachine: new sfn.StateMachine(deps, 'Research', {
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, 'Noop')),
    }),
    agentRunStateMachine: new sfn.StateMachine(deps, 'AgentRun', {
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, 'AgentRunNoop')),
    }),
    memoryExtractQueueUrl: `https://sqs.${env.region}.amazonaws.com/${env.account}/memory-extract`,
    memoryExtractQueueArn: `arn:aws:sqs:${env.region}:${env.account}:memory-extract`,
  };
}
