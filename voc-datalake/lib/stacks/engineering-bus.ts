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
 *   denies `events:PutEvents` to every principal but the publishers, whatever an identity policy grants: the board
 *   API's role, the runtime's supervisor and delivery roles, the agent roles with a voice and (7.51.02) the Agents
 *   API's role, by its fixed name; and it denies each of those every `source` but its own (`addPublisher`: the board
 *   `voc.engineering/board`, the runtime's two roles `voc.engineering/supervisor`, each agent role its own,
 *   engineering-runtime.ts, the Agents API `voc.engineering/api`: `admitTheAgentsApi`). The policy is near EventBridge's
 *   10,240-character limit for a bus's policy: a new publisher's two entries must fit.
 * - One fixed rule sends every event of this account on the bus to the inbox router (`engineering/bus/router.py`),
 *   never a rule per run. The router checks voc-msg/1 and the sender, writes the run's conversation and pushes a
 *   posted task, and a message for an agent or the conductor, to the delivery function with its conversation seq
 *   (`{message, seq}`). There are no queues per role or per agent: a held session cannot poll, so every message
 *   is pushed per run; the delivery function records each notice as an `INBOX#` row and wakes the addressee, and an
 *   agent reads its notices through the board API's `inbox` op.
 * - The board API (`engineering/board/api.py`) behind a function URL with IAM authentication and no resource-based
 *   policy, like the broker: for an agent it takes the caller from its assumed-role identity and publishes each change
 *   as the board. The Agents API (VocApiStack) also invokes it directly, by name, for a person's board actions
 *   (`person_request`): the board writes them with its own role and hands the events back for the API to publish as
 *   the person. The agent roles may invoke it only through the URL, so a direct invoke is the API's.
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
 * (its inbox op reads the caller's INBOX# rows and its tasks op the run's tasks), `lambda:InvokeFunction` on the
 * runtime's function by its name (the coordinator's `launch`, which sends only the `launch` action) and GetObject on
 * the knowledge packs' objects (`ws/default/knowledge/*`, its `knowledge` op); the report builder GetItem, Query (a run's rows of a kind) and UpdateItem (the version counter and pointer), GetObject
 * on the runs' objects and PutObject on the reports in the workspace bucket (no ListBucket: a missing object answers
 * 403, which it reads as missing and logs); the board `events:PutEvents` on the bus; the router `lambda:InvokeFunction` on
 * the delivery function, by its name (the runtime's voc-engineering-delivery, deployed with it on the same flag), and
 * `sqs:SendMessage` on the DLQ as its failure destination; `kms:Decrypt` and `kms:GenerateDataKey` on the stack's
 * key, only through DynamoDB (and SQS for the router's and the report builder's failure records, S3 for the report
 * builder and the board's knowledge reads).
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

import { ENGINEERING_BOARD_FUNCTION_BASE_NAME } from '../utils/function-names';
import { acknowledgeNag, acknowledgeNagOnResource, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';
import {
  ENGINEERING_BUDGET_ALERT_PARTITIONS, ENGINEERING_CHECKPOINT_KEYS, ENGINEERING_FINDING_KEYS, ENGINEERING_GATE_RECORD_KEYS,
  ENGINEERING_PATCH_KEYS, ENGINEERING_REVIEW_KEYS, ENGINEERING_SPEND_PARTITIONS, ENGINEERING_TENETS_KEYS,
  ENGINEERING_TRANSCRIPT_KEYS,
  ENGINEERING_TRIAGE_KEYS, ENGINEERING_WORKSPACE_KNOWLEDGE_KEYS, ENGINEERING_WORKSPACE_REPORTS_KEYS,
  ENGINEERING_WORKSPACE_RUNS_KEYS,
} from './core-buckets';
import { ENGINEERING_DLQ_BASE_NAME } from './dlq-alarms';
import { runtimeLanguages } from './engineering-agentcore';

/** The report builder's base name: its future callers (the broker, the supervisor) address it by this name. */
export const ENGINEERING_REPORTS_FUNCTION_BASE_NAME = 'voc-engineering-reports';

/** The delivery function's base name (the runtime's): the router pushes every message to it. */
const ENGINEERING_DELIVERY_FUNCTION_BASE_NAME = 'voc-engineering-delivery';
/** The runtime's function (engineering-runtime.ts): the board invokes its `launch` action for the run's coordinator. */
const ENGINEERING_RUNTIME_FUNCTION_BASE_NAME = 'voc-engineering-runtime';
/**
 * The board function's timeout (seconds): above its wait for the runtime's launch (100 s, board/api.py
 * LAUNCH_READ_TIMEOUT_SECONDS), so the board answers the coordinator before it is cut off.
 */
const BOARD_TIMEOUT_SECONDS = 120;

/** Sid of the Core key-policy statement that lets EventBridge write the inbox rule's undelivered events to the DLQ. */
export const ENGINEERING_DLQ_KEY_SID = 'AllowEventBridgeToEngineeringDeadLetter';

/** The table's item actions both functions call (the stores' get_item, update_item and transactions' Put). */
const TABLE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'] as const;

/** The bus's base name: VocApiStack names it for the Agents API too (api-engineering-voice.ts), which it cannot import. */
export const ENGINEERING_BUS_BASE_NAME = 'voc-engineering';
/**
 * The Agents API's source on the bus and the only detail types it puts there (7.51.02): a person's steering of a run's
 * orchestrator and their answer to an agent or the conductor (lambda/engineering/bus/senders.py API_TYPES, the router's
 * allowlist for that source; engineering/monitor.py publishes them). Its role's grant is held to these
 * (api-engineering-voice.ts); the bus's policy holds it to its source (`admitTheAgentsApi`).
 */
export const ENGINEERING_API_SOURCE = 'voc.engineering/api';
export const ENGINEERING_API_DETAIL_TYPES = ['msg.answer', 'msg.steer'] as const;
/**
 * The Agents API's role name (VocApiStack), before the stack's `uniqueName`: fixed with the engineering agents on, so
 * this bus's policy (VocProcessingStack, which VocApiStack depends on and cannot reference) names it by ARN, as
 * VocCoreStack's raw bucket names the cache writer (core-buckets.ts).
 */
export const AGENTS_API_ROLE_BASE_NAME = 'voc-agents-api';

/** That role's ARN in `scope`'s account, by the deployment's prefix-aware `uniqueName` (the one source of its name). */
function agentsApiRoleArn(scope: Construct, uniqueName: (baseName: string) => string): string {
  return cdk.Arn.format({ service: 'iam', region: '', resource: 'role', resourceName: uniqueName(AGENTS_API_ROLE_BASE_NAME) },
    cdk.Stack.of(scope));
}

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
  /** The board's function URL (IAM-authenticated): the agents' harness calls it, signed as their session. */
  public readonly boardUrl: string;
  private readonly publishers: iam.IRole[] = [];
  /** The last of the bus's policy resources: each waits for the one before (one read-modify-write at a time). */
  private lastPolicy: Construct | undefined;

  constructor(scope: Construct, id: string, props: EngineeringBusProps) {
    super(scope, id);
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: props.uniqueName(ENGINEERING_BUS_BASE_NAME) });
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
    const board = this.createBoardApi(props);
    this.board = board.fn;
    this.boardUrl = board.url;
    this.admitTheAgentsApi(props.uniqueName);
    this.pinPublishers();
    this.createReports(props);
  }

  /**
   * The Agents API's role (VocApiStack, by its fixed name: 7.51.02) as a publisher of a person's steering and answers,
   * only with its own source (`addPublisher`, as every publisher). Its detail types are held by its own grant
   * (api-engineering-voice.ts) and by the router, which admits that source for those two types alone and drops an
   * event whose detail type is not its message's own. No detail-type statement here: the bus's policy is near
   * EventBridge's 10,240-character limit for a bus policy (each publisher costs two of its statements' worth).
   */
  private admitTheAgentsApi(uniqueName: (baseName: string) => string): void {
    this.addPublisher('AgentsApi', iam.Role.fromRoleArn(this, 'AgentsApiRole', agentsApiRoleArn(this, uniqueName),
      { mutable: false }), ENGINEERING_API_SOURCE);
  }

  /**
   * Let `role` put events on the bus, only with `source` (lambda/engineering/bus/senders.py: an agent role's own, from
   * its session tags; a service's, `voc.engineering/<service>`): the bus policy denies it every other source,
   * whatever its own policy says.
   */
  public addPublisher(statementId: string, role: iam.IRole, source: string): void {
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
    denyCostRows(role, props.engineeringTable);
    const bucket = props.workspaceBucket;
    const runObjects = bucket.arnForObjects(ENGINEERING_WORKSPACE_RUNS_KEYS);
    const reportObjects = bucket.arnForObjects(ENGINEERING_WORKSPACE_REPORTS_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadRunObjects', actions: ['s3:GetObject'], resources: [runObjects],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'WriteReports', actions: ['s3:PutObject'], resources: [reportObjects],
    }));
    // No ListBucket: a key the board recorded may name an object its agent never wrote (a failed attempt), which S3
    // then answers 403, not 404; the builder may read every runs' key, so it reads that denial as missing and logs it
    // (reports/handler.py). A ListBucket scoped by an s3:prefix condition would not help: a GetObject carries no
    // prefix, so the condition never matches it.
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
   * The bus policy: an explicit deny of `events:PutEvents` for every principal but the publishers (each role added
   * with `addPublisher`), whatever an identity policy grants.
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
    denyCostRows(role, props.engineeringTable);
    const delivery = props.uniqueName(ENGINEERING_DELIVERY_FUNCTION_BASE_NAME);
    // By name: the delivery function is the runtime's and is deployed with it, so no construct to grant on.
    this.grantInvokeByName(role, 'EngineeringDelivery', delivery);
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

  /** `lambda:InvokeFunction` on a function of this deployment by its name (one deployed with another stack). */
  private grantInvokeByName(role: iam.IRole, sid: string, functionName: string): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid, actions: ['lambda:InvokeFunction'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'lambda', resource: 'function', resourceName: functionName,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })],
    }));
  }

  /**
   * The board API (its role is a publisher, as the board only). Its role also invokes the runtime's function, for the coordinator's
   * `launch` op (the board sends only the `launch` action; the coordinator role holds no invoke itself), and reads
   * the knowledge packs' objects (`ws/<ws>/knowledge/*`) for the `knowledge` op and the quality gate's records for a
   * flow's gate step (the GO ledger); no ListBucket, so a missing object reads as denied, which the board reads as
   * missing.
   */
  private createBoardApi(props: EngineeringBusProps): { fn: lambda.Function; url: string } {
    const role = workerRole(this, 'BoardRole');
    this.addPublisher('Board', role, 'voc.engineering/board');
    // Query: the inbox op reads the caller's INBOX# rows (board/inbox.py).
    // ConditionCheckItem: a flow step's checks in the board's own transactions (a post, a launch or a board's close
    // held to the step not being closed and to its post count: lambda/engineering/board/store.py, flow/record.py).
    props.engineeringTable.grant(role, ...TABLE_ACTIONS, 'dynamodb:Query', 'dynamodb:ConditionCheckItem');
    denyCostRows(role, props.engineeringTable);
    // 7.50.00: the `skill` and `memory` ops read the skills' and the agent memory's rows; it writes none of them.
    denyLearningWrites(role, props.engineeringTable);
    const runtime = props.uniqueName(ENGINEERING_RUNTIME_FUNCTION_BASE_NAME);
    this.grantInvokeByName(role, 'EngineeringRuntimeLaunch', runtime);
    const knowledge = props.workspaceBucket.arnForObjects(ENGINEERING_WORKSPACE_KNOWLEDGE_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadKnowledgePacks', actions: ['s3:GetObject'], resources: [knowledge],
    }));
    // A flow's quality gate step takes its pass arrow only on a GO the GO ledger reads in the gate record itself
    // (lambda/engineering/flow/ledger.py): the records only, never another run object.
    const gateRecords = props.workspaceBucket.arnForObjects(ENGINEERING_GATE_RECORD_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadGateRecords', actions: ['s3:GetObject'], resources: [gateRecords],
    }));
    // A done step's assertions (7.51.00, lambda/engineering/flow/assertion_record.py) read what its tasks recorded:
    // their findings' and notes' lines, their submitted patches, a triage, (7.52.00, tenets.recorded) a tenets draft
    // and (7.54.00, review.no_blocking) a reviewer's verdict, by the keys the board recorded on them; never a
    // transcript or a checkpoint (denied, whatever the patterns above match).
    const outputs = [ENGINEERING_FINDING_KEYS, ENGINEERING_PATCH_KEYS, ENGINEERING_TRIAGE_KEYS, ENGINEERING_TENETS_KEYS,
      ENGINEERING_REVIEW_KEYS].map((keys) => props.workspaceBucket.arnForObjects(keys));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadRecordedOutputs', actions: ['s3:GetObject'], resources: outputs,
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'NoTranscriptsOrCheckpoints', effect: iam.Effect.DENY, actions: ['s3:GetObject'],
      resources: [ENGINEERING_TRANSCRIPT_KEYS, ENGINEERING_CHECKPOINT_KEYS]
        .map((keys) => props.workspaceBucket.arnForObjects(keys)),
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'The knowledge packs\' objects in the workspace bucket (one prefix: their keys name the connection, package and version, known only at run time), the quality gate\'s record objects (the GO ledger reads only the key a run\'s final-go task recorded) and the outputs a done step\'s tasks recorded (its assertions read their keys only; never a transcript or a checkpoint), read only',
      findings: [resourceFinding(knowledge), resourceFinding(gateRecords), ...outputs.map(resourceFinding)],
    }]);
    // The key through DynamoDB for the table's reads and writes; through S3 only to decrypt (the board only reads
    // the knowledge packs' objects, it writes none).
    grantKeyThrough(role, props.kmsKey, ['dynamodb']);
    grantKeyThrough(role, props.kmsKey, ['s3'], ['kms:Decrypt']);
    this.bus.grantPutEventsTo(role);
    const board = createWorkerFunction(this, 'Board', {
      tree: 'engineering',
      functionName: props.uniqueName(ENGINEERING_BOARD_FUNCTION_BASE_NAME),
      handler: 'engineering/board/api.handler',
      role,
      layer: props.layer,
      // The board waits for the runtime's launch (its session's start and the session row) without retrying it.
      timeout: cdk.Duration.seconds(BOARD_TIMEOUT_SECONDS),
      memorySize: 256,
      environment: {
        AGENT_ROLE_NAME_PATTERN: props.roleNamePattern,
        ENGINEERING_TABLE: props.engineeringTable.tableName,
        ENGINEERING_BUS_NAME: this.bus.eventBusName,
        ENGINEERING_RUNTIME_FUNCTION: runtime,
        ENGINEERING_WORKSPACE_BUCKET: props.workspaceBucket.bucketName,
        // The languages this deployment has an agent runtime for (-c engineeringImages, with a network): the board
        // refuses a launch in another before it numbers an agent.
        ENGINEERING_IMAGE_LANGUAGES: runtimeLanguages(this).join(','),
      },
      serviceName: 'voc-engineering-board',
    });
    // No resource-based policy: only identities an IAM policy grants lambda:InvokeFunctionUrl on it can call it.
    const url = board.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }).url;
    return { fn: board, url };
  }
}

/**
 * The bus's roles write voc-engineering table-wide (a run's partition has no key IAM can name per run): an explicit
 * Deny keeps them off the cost rows, the spend ledger's month partitions and the budget alerts' (the runtime's to
 * write: spend.py), so no bug in the board, the router or the report builder can change a total or make, and so
 * mute, an alert. `ForAnyValue`, as audit-row-guard.ts: denied when ANY key a request names is one of them.
 */
function denyCostRows(role: iam.Role, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DenyCostRowWrites',
    effect: iam.Effect.DENY,
    actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    resources: [table.tableArn],
    conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS, ENGINEERING_BUDGET_ALERT_PARTITIONS] } },
  }));
}

/** The skills', the agent memory's and the scorecards' partitions (skills/store.py, agent_memory/model.py, scorecard.py). */
const LEARNING_PARTITIONS = ['WS#*#SKILL#*', 'WS#*#AMEM#*', 'WS#*#SCORE#*'];

/**
 * The board reads a session's skill and its task's approved lessons (its `skill` and `memory` ops, 7.50.00) on its
 * table-wide grant; an explicit Deny keeps it from writing any of those rows, so no board bug, nor an agent's request
 * through it, can propose, accept or change a skill version, a memory or a scorecard.
 */
function denyLearningWrites(role: iam.Role, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DenyLearningWrites',
    effect: iam.Effect.DENY,
    actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    resources: [table.tableArn],
    conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': LEARNING_PARTITIONS } },
  }));
}

function queueEncryption(key: kms.IKey): Pick<sqs.QueueProps, 'encryption' | 'encryptionMasterKey' | 'enforceSSL'> {
  return { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: key, enforceSSL: true };
}

/** kms:Decrypt and kms:GenerateDataKey on the stack's key, only through `services` (the table's, the queues'). */
function grantKeyThrough(role: iam.Role, key: kms.IKey, services: readonly string[],
  actions: readonly string[] = ['kms:Decrypt', 'kms:GenerateDataKey']): void {
  const { region } = cdk.Stack.of(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [...actions],
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  }));
}
