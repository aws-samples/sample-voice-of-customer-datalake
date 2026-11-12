/**
 * The engineering agents' bus, inbox router and task board (VocProcessingStack, only with
 * `-c engineeringAgents=true`; docs/autonomous-engineering.md, "How the agents work together").
 *
 *   agent (assumed agent role) ──SigV4──▶ board API (function URL, AWS_IAM) ──▶ voc-engineering table (the board)
 *   board API ──PutEvents──▶ voc-engineering bus ──one rule──▶ inbox router ──▶ voc-engineering table (the conversation)
 *                                                                           └──▶ the posted task's role queue
 *
 * - The bus: one EventBridge custom bus, no archive and no schema registry (nothing billed while idle). Its policy
 *   denies `events:PutEvents` to every principal but the board API's role, whatever an identity policy grants (the
 *   agents' roles, each pinned to its own `source`, come with the runtime).
 * - One fixed rule sends every event of this account on the bus to the inbox router (`engineering/bus/router.py`),
 *   never a rule per run. The router checks voc-msg/1 and the sender, writes the run's conversation and fans out:
 *   a posted task to its role's queue, a message for an agent or the conductor to the delivery function.
 * - The board API (`engineering/board/api.py`) behind a function URL with IAM authentication and no resource-based
 *   policy, like the broker: it takes the caller from its assumed-role identity and publishes each change as the
 *   board.
 * - One task queue per role of lambda/engineering/bus/schema.py ROLES (pinned by the test). Nothing consumes them
 *   until the runtime's agents land.
 * - One dead-letter queue, voc-engineering-dlq: the role queues' redrives, the events the rule could not hand the
 *   router, the router's invocations that failed every retry, and the runtime's supervisor ticks EventBridge could
 *   not deliver (engineering-runtime.ts). Alerting watches it like the platform's other
 *   failure queues (dlq-alarms.ts): its alarm exists only once an administrator turns alerting on, so no fixed cost.
 *
 * Grants, exactly what the code calls: both functions GetItem, PutItem and UpdateItem on the voc-engineering table
 * (the transactions are Put and Update items; no delete, no query yet); the board `events:PutEvents` on the bus; the
 * router `sqs:SendMessage` on the role queues (and on the DLQ, as its failure destination); `kms:Decrypt` and
 * `kms:GenerateDataKey` on the stack's key, only through DynamoDB (and SQS for the router). The router names the
 * delivery function (the runtime's, not deployed yet) and holds no invoke on it: until it lands, a message for an
 * agent or a conductor is written to the conversation and its delivery fails into the DLQ (no producer sends one
 * yet: only the board publishes, to a role or the run).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { createWorkerFunction, workerRole } from '../utils/worker-lambda';
import { ENGINEERING_DLQ_BASE_NAME } from './dlq-alarms';

/**
 * The roles with a task queue: lambda/engineering/bus/schema.py ROLES, in its order (engineering-bus.test.ts keeps
 * the two in lockstep).
 */
export const ENGINEERING_QUEUE_ROLES = [
  'understander', 'hunter', 'fixer', 'committer', 'commit-reviewer', 'pr-author', 'pr-reviewer', 'builder',
  'final-go', 'mapper',
] as const;

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
}

export class EngineeringBus extends Construct {
  private readonly bus: events.EventBus;
  /** voc-engineering-dlq: also the dead-letter queue of the runtime's supervisor rule (engineering-runtime.ts). */
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: EngineeringBusProps) {
    super(scope, id);
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: props.uniqueName('voc-engineering') });
    // Its EventBridge grant on the Core key: VocCoreStack, from this name (allowEventBridgeToScheduleDlq).
    this.dlq = new sqs.Queue(this, 'DLQ', {
      queueName: props.uniqueName(ENGINEERING_DLQ_BASE_NAME), ...queueEncryption(props.kmsKey),
      retentionPeriod: cdk.Duration.days(14), removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const queues = this.roleQueues(props);
    this.createRouter(props, queues);
    this.pinPublishers([this.createBoardApi(props)]);
  }

  /** One queue per role, encrypted with the stack's key, TLS only, redriving to the bus's dead-letter queue. */
  private roleQueues(props: EngineeringBusProps): Map<string, sqs.Queue> {
    return new Map(ENGINEERING_QUEUE_ROLES.map((role) => [role, new sqs.Queue(this, `TasksQueue-${role}`, {
      queueName: props.uniqueName(`voc-eng-tasks-${role}`), ...queueEncryption(props.kmsKey),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 }, removalPolicy: cdk.RemovalPolicy.DESTROY,
    })]));
  }

  /**
   * The bus policy: an explicit deny of `events:PutEvents` for every principal but `publishers`, whatever an identity
   * policy grants. Today the board's role alone; the agents' roles, each pinned to its own `source`, come later.
   */
  private pinPublishers(publishers: iam.IRole[]): void {
    this.bus.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheEngineeringPublishers',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['events:PutEvents'],
      resources: [this.bus.eventBusArn],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': publishers.map((role) => role.roleArn) } },
    }));
  }

  private createRouter(props: EngineeringBusProps, queues: Map<string, sqs.Queue>): void {
    const role = workerRole(this, 'RouterRole');
    props.engineeringTable.grant(role, ...TABLE_ACTIONS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringRoleQueues', actions: ['sqs:SendMessage'], resources: [...queues.values()].map((q) => q.queueArn),
    }));
    // The table's key and the queues' (a send to a queue on a customer-managed key needs GenerateDataKey).
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
        ENGINEERING_ROLE_QUEUE_URLS: cdk.Stack.of(this).toJsonString(
          Object.fromEntries([...queues].map(([name, queue]) => [name, queue.queueUrl]))),
        ENGINEERING_DELIVERY_FUNCTION: props.uniqueName('voc-engineering-delivery'),
      },
      serviceName: 'voc-engineering-router',
      // A redelivery is safe (the EVT# marker; the receivers dedupe by event id) and the router calls no model, so a
      // failed fan-out (a throttled queue) is retried rather than lost; one that fails every retry is kept in the DLQ.
      retryAttempts: 2,
      // Not destinations.SqsDestination, whose grant adds GetQueueAttributes, GetQueueUrl and every key action: the
      // send below and the key statement above are all a failure record needs.
      onFailure: { bind: () => ({ destination: this.dlq.queueArn }) },
    });
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringFailureRecords', actions: ['sqs:SendMessage'], resources: [this.dlq.queueArn],
    }));
    new events.Rule(this, 'InboxRule', {
      eventBus: this.bus,
      description: 'Every event on the engineering bus to the inbox router (one fixed rule, never one per run)',
      // Every event a principal of this account puts on the bus: the router judges the sender itself.
      eventPattern: { account: [cdk.Stack.of(this).account] },
      // An event EventBridge could not hand the router goes to the DLQ.
      targets: [new targets.LambdaFunction(router, { retryAttempts: 2, deadLetterQueue: this.dlq })],
    });
  }

  /** The board API; returns its role (the bus's one publisher). */
  private createBoardApi(props: EngineeringBusProps): iam.Role {
    const role = workerRole(this, 'BoardRole');
    props.engineeringTable.grant(role, ...TABLE_ACTIONS);
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
    return role;
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
