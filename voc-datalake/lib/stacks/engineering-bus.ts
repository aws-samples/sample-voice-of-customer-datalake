/**
 * The engineering agents' bus, inbox router and task board (VocProcessingStack, only with
 * `-c engineeringAgents=true`; docs/autonomous-engineering.md, "How the agents work together").
 *
 *   agent (assumed agent role) ──SigV4──▶ board API (function URL, AWS_IAM) ──▶ voc-engineering table (the board)
 *   board API ──PutEvents──▶ voc-engineering bus ──one rule──▶ inbox router ──▶ voc-engineering table (the conversation)
 *                                                                           └──▶ the delivery function (invoke, async)
 *   delivery function ──▶ voc-engineering table (INBOX# rows) ◀── the board API's inbox op ◀── agent
 *
 * - The bus: one EventBridge custom bus, no archive and no schema registry (nothing billed while idle). Its policy
 *   denies `events:PutEvents` to every principal but the board API's role and the agent roles with a voice, whatever
 *   an identity policy grants, and denies each of those every `source` but its own (`addAgentPublisher`,
 *   engineering-runtime.ts).
 * - One fixed rule sends every event of this account on the bus to the inbox router (`engineering/bus/router.py`),
 *   never a rule per run. The router checks voc-msg/1 and the sender, writes the run's conversation and pushes a
 *   posted task, and a message for an agent or the conductor, to the delivery function with its conversation seq
 *   (`{message, seq}`). There are no queues per role or per agent: a suspended MicroVM cannot poll, so every message
 *   is pushed per run; the delivery function records each notice as an `INBOX#` row and wakes the addressee, and an
 *   agent reads its notices through the board API's `inbox` op.
 * - The board API (`engineering/board/api.py`) behind a function URL with IAM authentication and no resource-based
 *   policy, like the broker: it takes the caller from its assumed-role identity and publishes each change as the
 *   board.
 * - One dead-letter queue, voc-engineering-dlq: the events the rule could not hand the router, the router's and the
 *   delivery function's invocations that failed every retry, the report builder's failed builds, and the runtime's
 *   supervisor ticks EventBridge could not deliver (engineering-runtime.ts). Alerting watches it like the platform's other
 *   failure queues (dlq-alarms.ts): its alarm exists only once an administrator turns alerting on, so no fixed cost.
 *
 * - The report builder (`engineering/reports/handler.py`): `{run_id, level, subject[, head]}` in, a new version of
 *   that commit, PR or goal report written to the workspace bucket (`ws/<ws>/reports/…`, create-only). Its callers
 *   (the run coordinator, the supervisor, the write broker before it opens a PR) are not wired yet, so nothing
 *   invokes it and no role holds an invoke on it; an asynchronous invocation that fails is kept in the DLQ.
 *
 * Grants, exactly what the code calls: the router and the board GetItem, PutItem and UpdateItem on the voc-engineering
 * table (the transactions are Put and Update items, the board's history rows included; no delete), and the board Query
 * (its inbox op reads the caller's INBOX# rows); the
 * report builder GetItem, Query (a run's rows of a kind) and UpdateItem (the version counter and pointer), GetObject
 * on the runs' objects and PutObject on the reports in the workspace bucket, and ListBucket on it so a missing object
 * reads as missing rather than denied; the board `events:PutEvents` on the bus; the router `lambda:InvokeFunction` on
 * the delivery function, by its name (the runtime's voc-engineering-delivery, deployed with it on the same flag), and
 * `sqs:SendMessage` on the DLQ as its failure destination; `kms:Decrypt` and `kms:GenerateDataKey` on the stack's
 * key, only through DynamoDB (and SQS for the router's and the report builder's failure records, S3 for the report
 * builder).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { acknowledgeNag, acknowledgeNagOnResource, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';
import { ENGINEERING_WORKSPACE_REPORTS_KEYS, ENGINEERING_WORKSPACE_RUNS_KEYS } from './core-buckets';
import { ENGINEERING_DLQ_BASE_NAME } from './dlq-alarms';

/** The report builder's base name: its future callers (the broker, the supervisor) address it by this name. */
export const ENGINEERING_REPORTS_FUNCTION_BASE_NAME = 'voc-engineering-reports';

/** The delivery function's base name (the runtime's): the router pushes every message to it. */
const ENGINEERING_DELIVERY_FUNCTION_BASE_NAME = 'voc-engineering-delivery';

/** Sid of the Core key-policy statement that lets EventBridge write the inbox rule's undelivered events to the DLQ. */
export const ENGINEERING_DLQ_KEY_SID = 'AllowEventBridgeToEngineeringDeadLetter';

/** The table's item actions both functions call (the stores' get_item, update_item and transactions' Put). */
const TABLE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'] as const;

export interface EngineeringBusProps {
  uniqueName: (baseName: string) => string;
  /** The agent roles' IAM role names, `{role}` standing for the role (identity.py ROLE_PLACEHOLDER). */
  roleNamePattern: string;
  layer: lambda.ILayerVersion;
  /** The stack's customer-managed key: the table's and the queues'. */
  kmsKey: kms.IKey;
  /** voc-engineering (VocCoreStack): the board's tasks and the runs' conversations. */
  engineeringTable: dynamodb.ITable;
  /** voc-eng-workspace (VocCoreStack): the runs' findings and gate records, and the reports. */
  workspaceBucket: s3.IBucket;
}

export class EngineeringBus extends Construct {
  /** The bus the agents put their messages on. */
  public readonly bus: events.EventBus;
  /** voc-engineering-dlq: also the dead-letter queue of the runtime's supervisor rule (engineering-runtime.ts). */
  public readonly dlq: sqs.Queue;
  /** The board API: the agent roles may call its function URL (engineering-runtime.ts). */
  public readonly board: lambda.IFunction;
  private readonly publishers: iam.IRole[] = [];
  /** The last of the bus's policy resources: each waits for the one before (one read-modify-write at a time). */
  private lastPolicy: Construct | undefined;

  constructor(scope: Construct, id: string, props: EngineeringBusProps) {
    super(scope, id);
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: props.uniqueName('voc-engineering') });
    // Its EventBridge grant on the Core key: VocCoreStack, from this name (allowEventBridgeToScheduleDlq).
    this.dlq = new sqs.Queue(this, 'DLQ', {
      queueName: props.uniqueName(ENGINEERING_DLQ_BASE_NAME), ...queueEncryption(props.kmsKey),
      retentionPeriod: cdk.Duration.days(14), removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    acknowledgeNagOnResource(this.dlq, [{
      id: 'AwsSolutions-SQS3',
      reason: 'This queue IS the terminal failure record (the inbox rule\'s and the supervisor rule\'s dead-letter queue, the router\'s, the delivery function\'s and the report builder\'s async on-failure destination); nothing consumes it, so it has no DLQ of its own',
    }]);
    this.createRouter(props);
    this.board = this.createBoardApi(props);
    this.pinPublishers();
    this.createReports(props);
  }

  /**
   * Let `role` (an agent role) put events on the bus, only with `source` (its own, from its session tags:
   * lambda/engineering/bus/senders.py): the bus policy denies it every other source, whatever its own policy says.
   */
  public addAgentPublisher(statementId: string, role: iam.IRole, source: string): void {
    this.publishers.push(role);
    this.addPolicy(new iam.PolicyStatement({
      sid: `OwnSourceOnly${statementId}`,
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['events:PutEvents'],
      resources: [this.bus.eventBusArn],
      conditions: { ArnEquals: { 'aws:PrincipalArn': role.roleArn }, StringNotEquals: { 'events:source': source } },
    }));
  }

  /** One statement of the bus policy, written after the one before it (CloudFormation would write them at once). */
  private addPolicy(statement: iam.PolicyStatement): void {
    const { policyDependable } = this.bus.addToResourcePolicy(statement);
    if (!Construct.isConstruct(policyDependable)) throw new Error('the bus policy is not a construct');
    if (this.lastPolicy) policyDependable.node.addDependency(this.lastPolicy);
    this.lastPolicy = policyDependable;
  }

  /**
   * The report builder. Reads a run's rows and the workspace objects its tasks recorded, writes each report version
   * once; puts no event and holds no invoke.
   */
  private createReports(props: EngineeringBusProps): void {
    const role = workerRole(this, 'ReportsRole');
    props.engineeringTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem');
    const bucket = props.workspaceBucket;
    const runObjects = bucket.arnForObjects(ENGINEERING_WORKSPACE_RUNS_KEYS);
    const reportObjects = bucket.arnForObjects(ENGINEERING_WORKSPACE_REPORTS_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadRunObjects', actions: ['s3:GetObject'], resources: [runObjects],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'WriteReports', actions: ['s3:PutObject'], resources: [reportObjects],
    }));
    // A key the board recorded may name an object its agent never wrote (a failed attempt): with ListBucket S3 answers
    // 404, which reads as missing, rather than 403.
    // Scoped to the runs' keys (the only ones it reads): never a listing of the reports or anything else.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'MissingReadsAsMissing', actions: ['s3:ListBucket'], resources: [bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [ENGINEERING_WORKSPACE_RUNS_KEYS] } },
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'The workspace bucket\'s object keys: reads of the runs\' objects the board recorded (their keys are known only at run time) and create-only writes of the reports; never another bucket',
      findings: [runObjects, reportObjects].map(resourceFinding),
    }]);
    // The table's, the bucket's and the DLQ's key (a failure record sent to it needs GenerateDataKey).
    grantKeyThrough(role, props.kmsKey, ['dynamodb', 's3', 'sqs']);
    createWorkerFunction(this, 'Reports', {
      tree: 'engineering',
      functionName: props.uniqueName(ENGINEERING_REPORTS_FUNCTION_BASE_NAME),
      handler: 'engineering/reports/handler.handler',
      role,
      layer: props.layer,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ENGINEERING_TABLE: props.engineeringTable.tableName,
        ENGINEERING_WORKSPACE_BUCKET: bucket.bucketName,
      },
      serviceName: ENGINEERING_REPORTS_FUNCTION_BASE_NAME,
      // An asynchronous build that failed (its callers never read the answer) is kept, like the router's.
      onFailure: this.failureRecords(role),
    });
  }

  /**
   * The DLQ as an async failure destination, and `role`'s send to it. Not destinations.SqsDestination, whose grant
   * adds GetQueueAttributes, GetQueueUrl and every key action: the send and the role's key statement are all a failure
   * record needs.
   */
  private failureRecords(role: iam.Role): lambda.IDestination {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringFailureRecords', actions: ['sqs:SendMessage'], resources: [this.dlq.queueArn],
    }));
    return { bind: () => ({ destination: this.dlq.queueArn }) };
  }

  /**
   * The bus policy: an explicit deny of `events:PutEvents` for every principal but the publishers (the board's role,
   * and each agent role added with `addAgentPublisher`), whatever an identity policy grants.
   */
  private pinPublishers(): void {
    this.addPolicy(new iam.PolicyStatement({
      sid: 'OnlyTheEngineeringPublishers',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['events:PutEvents'],
      resources: [this.bus.eventBusArn],
      conditions: {
        ArnNotEquals: { 'aws:PrincipalArn': cdk.Lazy.list({ produce: () => this.publishers.map((role) => role.roleArn) }) },
      },
    }));
  }

  private createRouter(props: EngineeringBusProps): void {
    const role = workerRole(this, 'RouterRole');
    props.engineeringTable.grant(role, ...TABLE_ACTIONS);
    const delivery = props.uniqueName(ENGINEERING_DELIVERY_FUNCTION_BASE_NAME);
    // By name: the delivery function is the runtime's (engineering-runtime.ts), so no construct here to grant on.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringDelivery', actions: ['lambda:InvokeFunction'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'lambda', resource: 'function', resourceName: delivery, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })],
    }));
    // The table's key, and the DLQ's for its failure records (a send to a queue on a customer-managed key needs
    // GenerateDataKey).
    grantKeyThrough(role, props.kmsKey, ['dynamodb', 'sqs']);
    const router = createWorkerFunction(this, 'Router', {
      tree: 'engineering',
      functionName: props.uniqueName('voc-engineering-router'),
      handler: 'engineering/bus/router.handler',
      role,
      layer: props.layer,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ENGINEERING_TABLE: props.engineeringTable.tableName,
        ENGINEERING_DELIVERY_FUNCTION: delivery,
      },
      serviceName: 'voc-engineering-router',
      // A redelivery is safe (the EVT# marker; the delivery function's put is conditional) and the router calls no
      // model, so a failed push is retried rather than lost; one that fails every retry is kept in the DLQ.
      retryAttempts: 2,
      onFailure: this.failureRecords(role),
    });
    new events.Rule(this, 'InboxRule', {
      eventBus: this.bus,
      description: 'Every event on the engineering bus to the inbox router (one fixed rule, never one per run)',
      // Every event a principal of this account puts on the bus: the router judges the sender itself.
      eventPattern: { account: [cdk.Stack.of(this).account] },
      // An event EventBridge could not hand the router goes to the DLQ.
      targets: [new targets.LambdaFunction(router, { retryAttempts: 2, deadLetterQueue: this.dlq })],
    });
  }

  /** The board API (its role is a publisher). */
  private createBoardApi(props: EngineeringBusProps): lambda.Function {
    const role = workerRole(this, 'BoardRole');
    this.publishers.push(role);
    // Query: the inbox op reads the caller's INBOX# rows (board/inbox.py).
    props.engineeringTable.grant(role, ...TABLE_ACTIONS, 'dynamodb:Query');
    grantKeyThrough(role, props.kmsKey, ['dynamodb']);
    this.bus.grantPutEventsTo(role);
    const board = createWorkerFunction(this, 'Board', {
      tree: 'engineering',
      functionName: props.uniqueName('voc-engineering-board'),
      handler: 'engineering/board/api.handler',
      role,
      layer: props.layer,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        AGENT_ROLE_NAME_PATTERN: props.roleNamePattern,
        ENGINEERING_TABLE: props.engineeringTable.tableName,
        ENGINEERING_BUS_NAME: this.bus.eventBusName,
      },
      serviceName: 'voc-engineering-board',
    });
    // No resource-based policy: only identities an IAM policy grants lambda:InvokeFunctionUrl on it can call it.
    board.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    return board;
  }
}

function queueEncryption(key: kms.IKey): Pick<sqs.QueueProps, 'encryption' | 'encryptionMasterKey' | 'enforceSSL'> {
  return { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: key, enforceSSL: true };
}

/** kms:Decrypt and kms:GenerateDataKey on the stack's key, only through `services` (the table's, the queues'). */
function grantKeyThrough(role: iam.Role, key: kms.IKey, services: readonly string[]): void {
  const { region } = cdk.Stack.of(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  }));
}
