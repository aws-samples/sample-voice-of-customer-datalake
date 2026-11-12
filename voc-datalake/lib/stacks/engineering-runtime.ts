/**
 * The engineering agents' runtime (VocProcessingStack, off by default): docs/autonomous-engineering.md → Runtime.
 *
 *   EventBridge rule, rate(1 minute), created DISABLED ───▶ voc-engineering-runtime {action: tick}  (the supervisor)
 *   the run coordinator ───────────────────────────────────▶ voc-engineering-runtime {action: launch}
 *   the run monitor ───────────────────────────────────────▶ voc-engineering-runtime {action: signal}
 *   the inbox router (async) ──────────────────────────────▶ voc-engineering-delivery {message, seq}
 *   a run's start / its end ──────────────▶ voc-engineering-runtime {action: start_run / end_run} (and the rule)
 *
 * One MicroVM per agent. Its agent user gets a 15-minute session of its agent role from the launcher (this function's
 * role, the only principal the agent roles trust and the only one that may tag their sessions): ONE fixed role per
 * agent role, narrowed by the session's tags (ws, run, agent, connection). It calls the board's and the broker's
 * function URLs and puts events on the bus only with its own source (its policy and the bus's both deny any other);
 * it reads no queue (the role queues serve every run; voc-engineering-delivery records its run's messages in the
 * run's inbox and wakes it, once the router invokes it). No MicroVM holds a host token (the connector's broker does). The supervisor's role: the session rows, the checkpoints it reads, its own rule, the
 * MicroVM operations and the launcher's AssumeRole; no IAM write: a stop cuts a run's sessions by not renewing them.
 *
 * Deployed only with `-c engineeringAgents=true`: the default synth has none of it, so no fixed cost and nothing for
 * fixed-cost-guard.test.ts to see. Pay per use with the flag on too: the rule runs only while a run is active,
 * and a tick it could not deliver goes to the bus's voc-engineering-dlq (the stack's key; alerting watches it). The
 * supervisor's errors alarm is a fixed monthly cost, so it is a second opt-in
 * (`-c engineeringSupervisorAlarm=true`). The MicroVM IAM actions and ARN shapes follow the service's description and
 * are not yet checked against its reference (see the doc).
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { capitalize } from '../plugin-loader';
import { ENGINEERING_CACHE_PREFIX } from './core-buckets';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { booleanContextFlag } from '../utils/context-flag';
import { engineeringAgentsEnabled } from './engineering-broker';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';

/** A fixed monthly cost, so an opt-in of its own (lib/test-support/fixed-cost-rules.ts OPT_IN_FIXED_COSTS). */
export const SUPERVISOR_ALARM_FLAG = 'engineeringSupervisorAlarm';
/** `-c engineeringImageArns='{"python":"arn:…",…}'`: the MicroVM image per language; `{}` (no launch) by default. */
const IMAGE_ARNS_CONTEXT = 'engineeringImageArns';
/**
 * The languages with an image (engineering-images/, lambda/engineering/runtime/egress.py REGISTRY_HOSTS; a Python
 * test keeps the two equal).
 */
const IMAGE_LANGUAGES = ['java', 'node', 'python', 'rust'];
const ARN_RE = /^arn:aws(?:-[a-z]+)*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:\S+$/;
/**
 * The session's own S3 keys, one template each: its connection's cache in the raw bucket (checkout.py), its run's
 * keys in the workspace bucket (voc-eng-workspace, lambda/engineering/workspace/layout.py; checkpoints.py).
 */
const CACHE_KEYS = `${ENGINEERING_CACHE_PREFIX}\${aws:PrincipalTag/connection}/*`;
const RUN_KEYS = 'ws/${aws:PrincipalTag/ws}/runs/${aws:PrincipalTag/run}/*';
// The agent comes right after the run in every workspace key, so this cannot match another agent's keys.
const OWN_KEYS = 'ws/${aws:PrincipalTag/ws}/runs/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}/*';
/** Every agent's checkpoints of every run (the supervisor picks the one a continuation restores from). */
const CHECKPOINT_KEYS = 'ws/*/runs/*/*/commits/*/_checkpoints/*';
/** The session tags only the launcher sets (launcher.py); an AssumeRole without every one of them is refused. */
const SESSION_TAGS = ['ws', 'run', 'agent', 'connection'];
/**
 * The supervisor's keys in voc-engineering (lambda/engineering/runtime/runs.py, sessions.py): the runs' partitions
 * (`WS#<ws>#RUN#<run>`: their META and their agents' rows) and the workspace's registry of active runs.
 */
const RUN_PARTITIONS = 'WS#*#RUN#*';
const RUN_REGISTRY = 'WS#*#RUNS';
/** Every MicroVM operation lambda/engineering/runtime/aws.py calls. */
const MICROVM_ACTIONS = [
  'lambda:RunMicrovm', 'lambda:SuspendMicrovm', 'lambda:ResumeMicrovm', 'lambda:TerminateMicrovm',
  'lambda:CreateMicrovmAuthToken',
];
/**
 * The agent roles of lambda/engineering/runtime/interface.py ROLES, which is the broker's connectors/identity.py
 * AGENT_ROLES (one execution role each); a Python test keeps this list and ROLES equal.
 */
const AGENT_ROLES = [
  'builder', 'coach', 'commit-reviewer', 'committer', 'coordinator', 'final-go', 'fixer', 'gate-runner', 'hunter',
  'mapper', 'pr-author', 'pr-reviewer', 'understander',
];
/** `actions` on `key`, only when one of `services` (in this region) calls KMS for the role. */
function viaServices(key: kms.IKey, actions: string[], services: string[]): iam.PolicyStatement {
  const region = cdk.Stack.of(key).region;
  return new iam.PolicyStatement({
    actions,
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  });
}

/**
 * The only bus source a session of `agentRole` may put events with (lambda/engineering/bus/senders.py): an agent's
 * own, from the tags only the launcher sets; the run coordinator speaks as its run's conductor. (The gate runner's is
 * one senders.py does not know yet: docs/autonomous-engineering.md → Runtime.)
 */
function eventSource(agentRole: string): string {
  const run = '${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}';
  if (agentRole === 'coordinator') return `voc.engineering/conductor/${run}`;
  return `voc.engineering/agent/${agentRole}/${run}/\${aws:PrincipalTag/agent}`;
}

/**
 * Agent roles that may not put events on the bus yet. The coach: senders.py knows it only as the service source
 * `voc.engineering/coach`, which names no workspace or run, so a coach session could speak, as the system, in any
 * run; it gets a voice once the bus has a run-scoped coach source.
 */
const NO_VOICE = new Set(['coach']);

/** What the runtime takes from the bus (engineering-bus.ts) and the connector broker (engineering-broker.ts). */
export interface EngineeringPeers {
  /**
   * voc-engineering-dlq: the supervisor rule's undelivered ticks. It is on the stack's key, whose EventBridge grant
   * VocCoreStack scopes to that queue, and alerting watches it (dlq-alarms.ts).
   */
  deadLetterQueue: sqs.IQueue;
  bus: events.IEventBus;
  /** The bus policy's pin of an agent role to its one source (EngineeringBus.addAgentPublisher). */
  addAgentPublisher: (statementId: string, role: iam.IRole, source: string) => void;
  board: lambda.IFunction;
  broker: lambda.IFunction;
}


interface EngineeringRuntimeProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  /**
   * voc-engineering (VocCoreStack): the runs' META rows, their agents' session rows and the registry of active runs.
   * Required with the flag on; it is deployed with the same flag.
   */
  engineeringTable: dynamodb.ITable | undefined;
  /** The raw data lake: the connections' caches (`engineering/cache/`). */
  rawDataBucket: s3.IBucket;
  /**
   * voc-eng-workspace (VocCoreStack): the runs' checkpoints, patches and findings. Create-only (it refuses a put
   * without If-None-Match) and nothing in it expires. Required with the flag on; it is deployed with the same flag.
   */
  workspaceBucket: s3.IBucket | undefined;
  /** The bus and the broker. Required with the flag on; they are deployed with the same flag. */
  peers: EngineeringPeers | undefined;
}

type WiredProps = EngineeringRuntimeProps & {
  peers: EngineeringPeers, engineeringTable: dynamodb.ITable, workspaceBucket: s3.IBucket,
};

/**
 * `-c engineeringImageArns`: a JSON object (or its text, from the CLI) from languages of IMAGE_LANGUAGES to ARNs,
 * `{}` when absent. Anything else fails the synth, so a typo never deploys a runtime that launches the wrong image.
 */
function imageArns(scope: Construct): Record<string, string> {
  const raw: unknown = scope.node.tryGetContext(IMAGE_ARNS_CONTEXT);
  if (raw === undefined || raw === null) return {};
  const usage = `Use -c ${IMAGE_ARNS_CONTEXT}='{"python":"arn:aws:…"}' (languages: ${IMAGE_LANGUAGES.join(', ')}).`;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${IMAGE_ARNS_CONTEXT} is not JSON. ${usage}`);
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${IMAGE_ARNS_CONTEXT} must be a JSON object. ${usage}`);
  }
  const entries = Object.entries(value);
  const bad = entries.filter(([language, arn]) => !IMAGE_LANGUAGES.includes(language)
    || typeof arn !== 'string' || !ARN_RE.test(arn));
  if (bad.length > 0) {
    throw new Error(`${IMAGE_ARNS_CONTEXT}: not a language with an image, or not an ARN: ${bad.map(([language]) => language).join(', ')}. ${usage}`);
  }
  return Object.fromEntries(entries.map(([language, arn]) => [language, String(arn)]));
}

/** A boolean context flag of the runtime's own, strictly parsed (a typo fails the synth, not the opposite). */
function flag(scope: Construct, name: string): boolean {
  return booleanContextFlag(scope.node.tryGetContext(name), name, false, `Use -c ${name}=true or false.`);
}

class EngineeringRuntime extends Construct {
  constructor(scope: Construct, id: string, props: WiredProps) {
    super(scope, id);
    const ruleName = props.uniqueName('voc-engineering-supervisor');
    const supervisorRole = workerRole(this, 'EngineeringSupervisorRole');
    const agentRoles = new Map(AGENT_ROLES.map((agentRole) => [agentRole, this.createAgentRole(props, agentRole,
      supervisorRole)]));
    const environment = this.environment(props, agentRoles, ruleName);
    const fn = this.createSupervisor(props, supervisorRole, agentRoles, ruleName, environment);
    this.createRule(props.peers.deadLetterQueue, fn, ruleName);
    this.createDelivery(props, supervisorRole, environment);
    if (flag(this, SUPERVISOR_ALARM_FLAG)) this.createAlarms(fn);
  }

  /** The supervisor's and the delivery function's environment (one code, one role). */
  private environment(props: WiredProps, agentRoles: Map<string, iam.Role>, ruleName: string): Record<string, string> {
    const stack = cdk.Stack.of(this);
    return {
      ENGINEERING_TABLE: props.engineeringTable.tableName,
      RAW_DATA_BUCKET: props.rawDataBucket.bucketName,
      ENGINEERING_WORKSPACE_BUCKET: props.workspaceBucket.bucketName,
      SUPERVISOR_RULE_NAME: ruleName,
      ENGINEERING_AGENT_ROLE_ARNS: stack.toJsonString(Object.fromEntries(
        [...agentRoles.entries()].map(([agentRole, agentIam]) => [agentRole, agentIam.roleArn]))),
      // Image ARN per language, from `-c engineeringImageArns` once the images are built (docs/deployment.md);
      // a language without one is refused at launch (aws.py AwsMicroVmRuntime.run).
      ENGINEERING_IMAGE_ARNS: JSON.stringify(imageArns(this)),
      ENGINEERING_EXTRA_EGRESS: '[]',
      // The supervisor's settable clocks (lambda/engineering/runtime/caps.py SETTABLE); {} keeps the defaults.
      ENGINEERING_TIMINGS: '{}',
    };
  }

  /**
   * voc-engineering-delivery, the name the inbox router invokes (engineering-bus.ts ENGINEERING_DELIVERY_FUNCTION):
   * a message for an agent, the conductor or a role of a run goes into that run's inbox (its rows in voc-engineering)
   * and its addressees are woken (lambda/engineering/runtime/delivery.py). The supervisor's code and role: a wake
   * renews an agent's role session, and the agent roles trust the launcher's role alone, so a role of its own would
   * have to be the launcher too (the supervisor's rule switch and registry delete come with it, unused here). An
   * invocation fails while an addressee is busy or its wake failed: Lambda retries it twice, then records it in
   * voc-engineering-dlq.
   */
  private createDelivery(props: WiredProps, role: iam.Role, environment: Record<string, string>): void {
    const dlq = props.peers.deadLetterQueue;
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DeliveryFailureRecords', actions: ['sqs:SendMessage'], resources: [dlq.queueArn],
    }));
    createWorkerFunction(this, 'EngineeringDelivery', {
      tree: 'engineering',
      functionName: props.uniqueName('voc-engineering-delivery'),
      handler: 'engineering/runtime/handler.delivery_handler',
      role,
      layer: props.layer,
      // A wake can start a MicroVM (a continuation); no model call.
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      serviceName: 'voc-engineering-delivery',
      // Its code launches nothing and switches no rule: neither the extra egress nor the rule's name.
      environment: Object.fromEntries(Object.entries(environment)
        .filter(([name]) => !['ENGINEERING_EXTRA_EGRESS', 'SUPERVISOR_RULE_NAME'].includes(name))),
      // The inbox row is written once (a conditional put), so a retry only wakes again.
      retryAttempts: 2,
      // Not destinations.SqsDestination, whose grant adds every key action: the send above and the key's use
      // through SQS below are all a failure record needs.
      onFailure: { bind: () => ({ destination: dlq.queueArn }) },
    });
  }

  /**
   * ONE fixed execution role per agent role (never per run), narrowed per session by the tags only the launcher
   * sets (ws, run, agent, connection): read its connection's cache and its run's workspace, write only its own
   * keys, call the board's and the broker's function URLs and the allowlisted models, and put events on the bus with
   * its own source. It can assume no role and use no other source.
   */
  private createAgentRole(props: WiredProps, agentRole: string, launcher: iam.IRole): iam.Role {
    const { rawDataBucket, workspaceBucket, kmsKey, uniqueName, peers } = props;
    const id = capitalize(agentRole.replace(/-/g, '_'));
    const role = new iam.Role(this, `EngineeringAgent${id}Role`, {
      // The broker's AGENT_ROLE_NAME_PATTERN reads the role back from this name (`voc-eng-{role}` + the naming).
      roleName: uniqueName(`voc-eng-${agentRole}`),
      // Only the launcher may assume it and tag the session, and only with every session tag the conditions read
      // (an untagged session would match no key, but it is refused outright rather than relied on).
      assumedBy: new iam.SessionTagsPrincipal(new iam.ArnPrincipal(launcher.roleArn)).withConditions({
        Null: Object.fromEntries(SESSION_TAGS.map((tag) => [`aws:RequestTag/${tag}`, 'false'])),
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const cacheObjects = rawDataBucket.arnForObjects(CACHE_KEYS);
    const runObjects = workspaceBucket.arnForObjects(RUN_KEYS);
    const ownObjects = workspaceBucket.arnForObjects(OWN_KEYS);
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Object keys under ONE session-tagged prefix (the connection\'s cache, the run\'s workspace, the agent\'s own keys); the trailing wildcard is the object key, never another connection, run or agent',
      findings: [cacheObjects, runObjects, ownObjects].map(resourceFinding),
    }]);
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCacheAndRun', actions: ['s3:GetObject'], resources: [cacheObjects, runObjects],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListCache', actions: ['s3:ListBucket'], resources: [rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [CACHE_KEYS] } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListRun', actions: ['s3:ListBucket'], resources: [workspaceBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [RUN_KEYS] } },
    }));
    // Create-only: the bucket refuses a put without If-None-Match, so no object is ever written over.
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteOwnKeys', actions: ['s3:PutObject'], resources: [ownObjects] }));
    // No queue: the role queues (voc-eng-tasks-<role>) serve every run, so no agent reads them; its run's messages,
    // posted tasks included, are pushed to it by the delivery function, and the board (its run's only) is the record.
    // The board's and the broker's function URLs (IAM-authenticated, no resource policy): the URL call, and the
    // invoke behind it only through a function URL.
    const urls = [peers.board.functionArn, peers.broker.functionArn];
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BoardAndBrokerUrls', actions: ['lambda:InvokeFunctionUrl'], resources: urls,
      conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BoardAndBrokerThroughUrls', actions: ['lambda:InvokeFunction'], resources: urls,
      conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
    }));
    // The bus, with its own source only: denied here for any other, and by the bus's policy too (which denies a
    // role without a voice everything).
    if (!NO_VOICE.has(agentRole)) {
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'PutOnTheBus', actions: ['events:PutEvents'], resources: [peers.bus.eventBusArn],
      }));
      peers.addAgentPublisher(id, role, eventSource(agentRole));
    }
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'NoRoleChaining',
      effect: iam.Effect.DENY,
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'OwnEventSourceOnly',
      effect: iam.Effect.DENY,
      actions: ['events:PutEvents'],
      resources: ['*'],
      conditions: { StringNotEquals: { 'events:source': eventSource(agentRole) } },
    }));
    // The bucket's key, only through S3 (its reads and its own puts): never a direct KMS call.
    role.addToPolicy(viaServices(kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['s3']));
    grantClaudeModels(role, 'invoke');
    return role;
  }

  private createSupervisor(
    props: WiredProps, role: iam.Role, agentRoles: Map<string, iam.Role>, ruleName: string,
    environment: Record<string, string>,
  ): lambda.Function {
    const { uniqueName, kmsKey, engineeringTable, workspaceBucket } = props;
    const stack = cdk.Stack.of(this);
    // A run's start and end (its META, its registry row) and its agents' session rows, in those partitions only
    // (a session is created with a check that its run's META is still active).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem',
        'dynamodb:Query'],
      resources: [engineeringTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_PARTITIONS, RUN_REGISTRY] } },
    }));
    // Its one delete: an ended run's row in the registry of active runs; never a run's own rows.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:DeleteItem'],
      resources: [engineeringTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_REGISTRY] } },
    }));
    // The agents' checkpoints, to pick the one a continuation restores from: read only.
    const checkpoints = workspaceBucket.arnForObjects(CHECKPOINT_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [checkpoints] }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [workspaceBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [CHECKPOINT_KEYS] } },
    }));
    // The key, only through S3 (checkpoint reads), DynamoDB (the session and inbox rows) and SQS (the delivery's
    // failure records): never a direct KMS call.
    role.addToPrincipalPolicy(viaServices(kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['s3', 'dynamodb', 'sqs']));
    const microvms = ['microvm', 'microvm-image'].map((resource) => stack.formatArn({
      service: 'lambda', resource, resourceName: '*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: MICROVM_ACTIONS, resources: microvms }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Read-only on the agents\' checkpoint objects of every run (it picks the one a continuation restores from), and the MicroVMs of this account and region, which are created per agent session and have no name known at deploy time',
      findings: [checkpoints, ...microvms].map(resourceFinding),
    }]);
    // The launcher: a 15-minute session of an agent role, with its tags (launcher.py). No IAM write anywhere: a
    // stop cuts a run's sessions by not renewing them.
    const agentRoleArns = [...agentRoles.values()].map((agentRole) => agentRole.roleArn);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: agentRoleArns,
    }));
    // Its own rule only, by name (a reference to the rule would be a cycle: the rule targets this function).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule'],
      resources: [stack.formatArn({ service: 'events', resource: 'rule', resourceName: ruleName })],
    }));
    return createWorkerFunction(this, 'EngineeringSupervisor', {
      tree: 'engineering',
      functionName: uniqueName('voc-engineering-runtime'),
      handler: 'engineering/runtime/handler.lambda_handler',
      role,
      layer: props.layer,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      serviceName: 'voc-engineering-runtime',
      environment,
    });
  }

  /**
   * The supervisor's EventBridge rule (TENETS.md tenet 7: schedules run on EventBridge rules): every minute,
   * created DISABLED; a run's start turns it on, and it goes off once no run is listed (handler.start_run, and its
   * settling after an end_run or a tick).
   */
  private createRule(deadLetters: sqs.IQueue, fn: lambda.Function, ruleName: string): void {
    new events.Rule(this, 'SupervisorRule', {
      ruleName,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      enabled: false,
      targets: [new targets.LambdaFunction(fn, {
        event: events.RuleTargetInput.fromObject({ action: 'tick' }),
        // The next tick is a minute away: no retry, a failure is recorded instead.
        retryAttempts: 0,
        deadLetterQueue: deadLetters,
      })],
    });
  }

  /** The supervisor's own errors; its undelivered ticks are the engineering DLQ's, which alerting already watches. */
  private createAlarms(fn: lambda.Function): void {
    new cloudwatch.Alarm(this, 'SupervisorErrorsAlarm', {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The engineering supervisor failed 3 times in 5 minutes: agents may not be watched.',
    });
  }
}

/**
 * The engineering runtime when the stack's context says `engineeringAgents=true`, else nothing at all
 * (the default: no function, no rule, no role, no grant).
 */
export function addEngineeringRuntime(scope: Construct, props: EngineeringRuntimeProps): boolean {
  if (!engineeringAgentsEnabled(scope)) return false;
  const { peers, engineeringTable, workspaceBucket } = props;
  if (!peers) throw new Error('engineeringAgents needs the engineering bus (its dead-letter queue) and broker');
  if (!engineeringTable) throw new Error('engineeringAgents needs VocCoreStack\'s voc-engineering table');
  if (!workspaceBucket) throw new Error('engineeringAgents needs VocCoreStack\'s voc-eng-workspace bucket');
  new EngineeringRuntime(scope, 'EngineeringRuntime', { ...props, peers, engineeringTable, workspaceBucket });
  return true;
}
