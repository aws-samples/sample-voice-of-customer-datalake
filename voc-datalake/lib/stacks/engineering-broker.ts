/**
 * The engineering agents' connector broker (VocProcessingStack, only with `-c engineeringAgents=true`;
 * docs/autonomous-engineering.md, "Repository connectors").
 *
 *   agent session (assumed agent role) ──SigV4──▶ function URL (AWS_IAM) ──▶ voc-engineering-broker
 *
 * The only code that will hold a repository host's credential. It takes the caller's role, run and agent from the
 * request's assumed-role identity (lambda/engineering/connectors/identity.py), never from the body.
 *
 * What exists: the caller identity, the operations per role, the write rules and the GitHub client
 * (lambda/engineering/connectors/github.py), which reads a connection's GitHub App credential from the SSM
 * SecureString `/[<prefix>-]voc/engineering/{connection_id}` (credentials.py); the run's record, the board's GO
 * ledger and a person's go (records.py), the committer's submitted patch (patches.py) and the dial (dial.py), all
 * read, never written. Beyond writing its own log group (lib/utils/lambda-log-grants.ts), the role holds exactly:
 * - `ssm:GetParameter` on the connections' parameters (no other parameter, no put or delete) and `kms:Decrypt` on
 *   the stack's key through SSM (`kms:ViaService`) only for those parameters (the `PARAMETER_ARN` context);
 * - `dynamodb:GetItem` and `dynamodb:Query` on voc-engineering, only in the runs' partitions (`WS#*#RUN#*`, as a
 *   `dynamodb:LeadingKeys` condition): the run's META and its `GO#person` row by key, its `TASK#` rows by one Query
 *   (IAM cannot narrow a GetItem by sort key; the code reads those rows only);
 * - `dynamodb:GetItem` on the aggregates table, only in the people's flag partitions (`USERFLAGS#*`): the way of
 *   working of the person who started a run (shared/ai_mode.py), and of that row only `mode` (with its key: a
 *   `dynamodb:Attributes` condition, the read a projection);
 * - `s3:GetObject` on voc-eng-workspace's agents' patches and final-go and gate-runner agents' gate records only
 *   (`ws/default/runs/*\/commits/*\/_patches/*`, `ws/default/runs/*\/final-go-*\/commits/*\/_gate/*`,
 *   `ws/default/runs/*\/gate-runner-*\/commits/*\/_gate/*`; no ListBucket, so a key never written answers 403,
 *   read as missing);
 * - `dynamodb:GetItem`, `dynamodb:PutItem` and `dynamodb:UpdateItem` on voc-engineering, only in the runs' writes'
 *   partitions (`WS#*#WRITES#*`, never a run's own) and of a row only a write claim's attributes (6.30.00: each write
 *   made once per caller, attempt, operation and what it writes, records.py WriteClaims), with
 *   `kms:GenerateDataKey` on the stack's key through DynamoDB only, for it;
 * - `kms:Decrypt` on the stack's key through DynamoDB and S3 only.
 * No other write to any table or bucket. The function URL has no
 * resource-based policy, so only identities of this account that an IAM policy grants `lambda:InvokeFunctionUrl`
 * on it can call it: the agent roles (engineering-runtime.ts). Idle, it costs nothing (tenet 7): standard
 * SSM parameters have no monthly charge.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { booleanContextFlag } from '../utils/context-flag';
import { SIGNING_LAYER_DIR, dependencyLayer } from '../utils/dependency-layers';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';
import { ENGINEERING_WORKSPACE } from './core-buckets';

/** The CDK context key that deploys the engineering agents (default off). */
const ENGINEERING_AGENTS_CONTEXT_KEY = 'engineeringAgents';

/**
 * The agent roles' IAM role names before the stack's naming (`[prefix-]voc-eng-{role}-<account>-<region>`), `{role}`
 * being an agent role of lambda/engineering/connectors/identity.py AGENT_ROLES.
 */
export const ENGINEERING_ROLE_NAME_TEMPLATE = 'voc-eng-{role}';

/** The connections' credentials, one SecureString each under this path (lambda/engineering/connectors/credentials.py). */
const ENGINEERING_PARAMETER_PATH = 'voc/engineering/';

/**
 * `/voc/engineering/`, or `/<prefix>-voc/engineering/` on a prefixed deployment (the prefix on the `voc` segment, as
 * `DeploymentNaming.prefixed` places it; lib/utils/radar-exa-parameter.ts does the same): the broker's
 * `ENGINEERING_PARAMETER_PREFIX`.
 */
export function engineeringParameterPrefix(deploymentPrefix: string | undefined): string {
  return deploymentPrefix ? `/${deploymentPrefix}-${ENGINEERING_PARAMETER_PATH}` : `/${ENGINEERING_PARAMETER_PATH}`;
}

/**
 * Every connection's parameter (`/[<prefix>-]voc/engineering/*`) in `stack`'s account and region: the broker reads them,
 * the Agents API writes and deletes them (api-assistant-lambdas.ts).
 */
export function engineeringParameterArns(stack: cdk.Stack, deploymentPrefix: string | undefined): string {
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', resourceName: `${engineeringParameterPrefix(deploymentPrefix).slice(1)}*`,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/** `lambda/engineering/connectors/handler.py`, path-style inside the worker bundle. */
const BROKER_HANDLER = 'engineering/connectors/handler.lambda_handler';

/** The runs' partitions in voc-engineering (`WS#<ws>#RUN#<run>`: META, TASK#, GO#person), a LeadingKeys pattern. */
const BROKER_RUN_PARTITIONS = 'WS#*#RUN#*';
/** The people's flag partitions in the aggregates table (shared/user_flags.py USERFLAGS_PREFIX; ai_mode's row). */
const BROKER_PEOPLE_PARTITIONS = 'USERFLAGS#*';
/**
 * The workspace keys the broker reads: an agent's submitted patches and the gate records (workspace/layout.py:
 * `ws/<ws>/runs/<run>/<agent>/commits/<sha>/_<kind>/attempt-<n>/<name>`). The workspace is spelled out, as in
 * every grant on the bucket (core-buckets.ts).
 */
const BROKER_WORKSPACE_KEYS = [
  `ws/${ENGINEERING_WORKSPACE}/runs/*/commits/*/_patches/*`,
  // Only a final-go agent's and a gate runner's gate records (`<agent>` is `final-go-<n>`, `gate-runner-<n>`): the
  // GO ledger reads the final go's GO and the gate runner's GO on the same tree (flow/ledger.py go_tree), no other's.
  `ws/${ENGINEERING_WORKSPACE}/runs/*/final-go-*/commits/*/_gate/*`,
  `ws/${ENGINEERING_WORKSPACE}/runs/*/gate-runner-*/commits/*/_gate/*`,
];
/** The way-of-working row's attributes the broker may read (its key, and `mode`: connectors/dial.py MODE_ATTRIBUTE). */
const BROKER_PEOPLE_ATTRIBUTES = ['pk', 'sk', 'mode'];
/** A write's claim row's attributes, all the broker may write (connectors/records.py WriteClaims). */
const BROKER_CLAIM_ATTRIBUTES = ['pk', 'sk', 'state', 'op', 'at', 'result', 'closed_at'];
/** The runs' writes' partitions (`WS#<ws>#WRITES#<run>`, records.py writes_pk): the claim rows', and nothing else. */
const BROKER_WRITE_PARTITIONS = 'WS#*#WRITES#*';

/**
 * Whether `-c engineeringAgents=true` asked for the engineering agents (CLI context arrives as a string), strictly
 * parsed: a typo fails the synth instead of deploying the opposite. The one parser of the flag (core, processing,
 * runtime).
 */
export function engineeringAgentsEnabled(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(ENGINEERING_AGENTS_CONTEXT_KEY), ENGINEERING_AGENTS_CONTEXT_KEY,
    false, `Use -c ${ENGINEERING_AGENTS_CONTEXT_KEY}=true or false.`);
}

export interface EngineeringBrokerProps {
  uniqueName: (baseName: string) => string;
  /** The agent roles' IAM role names, `{role}` standing for the role (identity.py ROLE_PLACEHOLDER). */
  roleNamePattern: string;
  layer: lambda.ILayerVersion;
  /** The stack's customer-managed key, which encrypts the connections' SecureString parameters. */
  kmsKey: kms.IKey;
  deploymentPrefix: string | undefined;
  /** voc-engineering (VocCoreStack): the runs' META, tasks and a person's go, read only. */
  engineeringTable: dynamodb.ITable;
  /** voc-eng-workspace (VocCoreStack): the agents' submitted patches and the gate records, read only. */
  workspaceBucket: s3.IBucket;
  /** The aggregates table: the people's way of working (shared/ai_mode.py), read only. */
  aggregatesTable: dynamodb.ITable;
}

export class EngineeringBroker extends Construct {
  /** The broker: the agent roles may call its function URL (engineering-runtime.ts). */
  public readonly function: lambda.IFunction;
  /** Its function URL (IAM authentication), handed to every agent's harness as `VOC_BROKER_URL`. */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: EngineeringBrokerProps) {
    super(scope, id);
    const functionName = props.uniqueName('voc-engineering-broker');
    const stack = cdk.Stack.of(this);
    const parameterPrefix = engineeringParameterPrefix(props.deploymentPrefix);
    const role = workerRole(this, 'Role');
    const broker = createWorkerFunction(this, 'Function', {
      tree: 'engineering',
      functionName,
      handler: BROKER_HANDLER,
      role,
      layer: props.layer,
      // A push rebuilds every commit with the Git Data API (a tree and a commit per commit, a blob per binary file, then
      // the ref once), one request after another: 30 s was shorter than a large bundle's chain. Idle cost is nil either way.
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        AGENT_ROLE_NAME_PATTERN: props.roleNamePattern,
        ENGINEERING_PARAMETER_PREFIX: parameterPrefix,
        ENGINEERING_TABLE: props.engineeringTable.tableName,
        ENGINEERING_WORKSPACE_BUCKET: props.workspaceBucket.bucketName,
        AGGREGATES_TABLE: props.aggregatesTable.tableName,
      },
      serviceName: 'voc-engineering-broker',
    });
    // cryptography signs the GitHub App's JWT (RS256): the signing layer, for this one function of the stack.
    broker.addLayers(dependencyLayer(this, 'SigningDepsLayer', SIGNING_LAYER_DIR,
      'RS256 signing for the engineering broker (GitHub App JWT; ARM64/Graviton)'));
    const parameters = engineeringParameterArns(stack, props.deploymentPrefix);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringConnectionCredentials', actions: ['ssm:GetParameter'], resources: [parameters],
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'One SecureString per repository connection, created by an administrator at run time, so the read '
        + 'is scoped to the connections\' path (/[<prefix>-]voc/engineering/*), read-only, and nothing else',
      findings: [resourceFinding(parameters)],
    }]);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringConnectionCredentialsKey',
      actions: ['kms:Decrypt'],
      resources: [props.kmsKey.keyArn],
      // Only through SSM, and only for the connections' parameters (SSM puts the parameter's ARN in the context).
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters },
      },
    }));
    grantRunRecordReads(role, props);
    this.url = broker.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }).url;
    this.function = broker;
  }
}

/**
 * The broker's reads of what a run recorded (records.py, patches.py, dial.py): the runs' partitions of voc-engineering
 * (GetItem, Query), the people's flags of the aggregates table (GetItem), the agents' patches and gate records in the
 * workspace (GetObject), and the stack's key to decrypt them through DynamoDB and S3. Nothing written.
 */
function grantRunRecordReads(role: iam.Role, props: EngineeringBrokerProps): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'EngineeringRunRecords',
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [BROKER_RUN_PARTITIONS] } },
  }));
  // The broker's one write: a write's claim row (records.py WriteClaims: create-only PutItem, then one UpdateItem that
  // closes it, and the GetItem a repeat reads), in a partition of the run's writes alone, so the grant reaches no row
  // of the run's own partition (META, TASK#, GO#person, RUNLOG#), and of a row only the claim's attributes.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'WriteClaims',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [props.engineeringTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [BROKER_WRITE_PARTITIONS] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': BROKER_CLAIM_ATTRIBUTES },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': 'NONE' },
    },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'WaysOfWorking',
    actions: ['dynamodb:GetItem'],
    resources: [props.aggregatesTable.tableArn],
    // Only the mode of the row, asked by a projection (dial.py): a GetItem asking for any other attribute, or for
    // the whole item, is denied.
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [BROKER_PEOPLE_PARTITIONS] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': BROKER_PEOPLE_ATTRIBUTES },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  }));
  const objects = BROKER_WORKSPACE_KEYS.map((keys) => props.workspaceBucket.arnForObjects(keys));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SubmittedPatchesAndGateRecords', actions: ['s3:GetObject'], resources: objects,
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'The workspace bucket\'s agents\' patches and gate records (their run, agent and commit are known only at '
      + 'run time), read only; the code reads the caller\'s own patch and the run\'s recorded gate record alone',
    findings: objects.map(resourceFinding),
  }]);
  const { region } = cdk.Stack.of(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'EngineeringRunRecordsKey',
    actions: ['kms:Decrypt'],
    resources: [props.kmsKey.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': ['dynamodb', 's3'].map((service) => `${service}.${region}.amazonaws.com`) } },
  }));
  // The claim rows' encryption: through DynamoDB alone (it encrypts nothing in S3), and for voc-engineering alone
  // (DynamoDB puts the table's name in the encryption context).
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'WriteClaimsKey',
    actions: ['kms:GenerateDataKey'],
    resources: [props.kmsKey.keyArn],
    conditions: {
      StringEquals: {
        'kms:ViaService': `dynamodb.${region}.amazonaws.com`,
        'kms:EncryptionContext:aws:dynamodb:tableName': props.engineeringTable.tableName,
      },
    },
  }));
}
