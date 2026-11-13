/**
 * The engineering agents' runtime (VocProcessingStack, off by default): docs/autonomous-engineering.md → Runtime.
 *
 *   EventBridge rule, rate(1 minute), created DISABLED ───▶ voc-engineering-runtime {action: tick}  (the supervisor)
 *   the run coordinator ───────────────────────────────────▶ voc-engineering-runtime {action: launch}
 *   the run monitor ───────────────────────────────────────▶ voc-engineering-runtime {action: signal}
 *   the inbox router (async) ──────────────────────────────▶ voc-engineering-delivery {message, seq}
 *   a run's start / its end ──────────────▶ voc-engineering-runtime {action: start_run / end_run} (and the rule)
 *
 * One MicroVM per agent. Its agent user gets a 15-minute session of its agent role from a launcher (the supervisor's
 * role, or the delivery function's, whose wake renews a session: the only principals the agent roles trust and the
 * only ones that may tag their sessions): ONE fixed role per agent role, narrowed by the session's tags (ws, run,
 * agent, connection). It calls the board's and the broker's function URLs and puts events on the bus only with its
 * own source (its policy and the bus's both deny any other); it reads no queue (there are none: the router invokes
 * voc-engineering-delivery, which records its run's messages in the run's inbox and wakes it).
 * No MicroVM holds a host token (the connector's broker does). The supervisor's role: the run and session rows and
 * the registry, the checkpoints it reads, its own rule, the MicroVM operations and the launcher's AssumeRole. The
 * delivery's role: the runs' rows only (no registry, no delete), the checkpoints, resuming, continuing and ending a
 * MicroVM, the launcher's AssumeRole and its failure records; no rule. No IAM write: a stop cuts a run's sessions by
 * not renewing them.
 *
 * Deployed only with `-c engineeringAgents=true`: the default synth has none of it, so no fixed cost and nothing for
 * fixed-cost-guard.test.ts to see. Pay per use with the flag on too: the rule runs only while a run is active,
 * and a tick it could not deliver goes to the bus's voc-engineering-dlq (the stack's key; alerting watches it). The
 * supervisor's errors alarm is a fixed monthly cost, so it is a second opt-in
 * (`-c engineeringSupervisorAlarm=true`). The MicroVM IAM actions and ARN shapes follow the service's description and
 * are not yet checked against its reference (see the doc).
 */
import * as fs from 'fs';
import * as path from 'path';

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
import { createWorkerFunction, grantInvokeByName, workerRole } from '../utils/worker-lambda';

/** A fixed monthly cost, so an opt-in of its own (lib/test-support/fixed-cost-rules.ts OPT_IN_FIXED_COSTS). */
export const SUPERVISOR_ALARM_FLAG = 'engineeringSupervisorAlarm';
/** `-c engineeringImageArns='{"python":"arn:…",…}'`: the MicroVM image per language; `{}` (no launch) by default. */
const IMAGE_ARNS_CONTEXT = 'engineeringImageArns';
/**
 * `-c engineeringMicrovmUsdPerSecond=<decimal>`: the price of a MicroVM second, priced into each agent's `cost_usd` and
 * so into a run's cost cap (lambda/engineering/runtime/caps.py microvm_price); unset: `0`, MicroVM time not priced.
 */
const MICROVM_PRICE_CONTEXT = 'engineeringMicrovmUsdPerSecond';
/** caps.py MAX_USD_PER_SECOND: a price a few orders of magnitude off fails the synth. */
const MAX_USD_PER_SECOND = 0.01;
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
/**
 * The learning loop's keys (lambda/engineering/learning/): the skills' partitions, which the coach reads and proposes
 * a version in (skills/store.py: `WS#<ws>#SKILL#<connection>#<role>`), the roles' lessons in agent memory, where it
 * drafts one (agent_memory/model.py: `WS#<ws>#AMEM#ROLE#<connection>#<role>`), and the scorecards, one create-only
 * row per version per run (learning/scorecard.py: `WS#<ws>#SCORE#<connection>#<role>#<version>`).
 */
const SKILL_PARTITIONS = 'WS#*#SKILL#*';
const ROLE_MEMORY_PARTITIONS = 'WS#*#AMEM#ROLE#*';
const SCORECARD_PARTITIONS = 'WS#*#SCORE#*';
/** The quality gate's records, which a retrospective reads only where a final-go task named them (records.py). */
const GATE_RECORD_KEYS = 'ws/*/runs/*/*/commits/*/_gate/attempt-*/record.json';
/**
 * The benchmark's case directories (voc-datalake/engineering-benchmark/cases, lambda/engineering/benchmark/cases.py),
 * read at synth: the coach names one of them as the case its version should gain on.
 */
const BENCHMARK_CASES_DIR = path.join(__dirname, '../../engineering-benchmark/cases');

/** The benchmark's case ids (its case directories' names), sorted. */
export function benchmarkCaseIds(dir: string = BENCHMARK_CASES_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}
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
 * own, from the tags only the launcher sets; the run coordinator speaks as its run's conductor, the coach as its run's
 * coach (a run-scoped source: senders.py checks the run and the refs as for an agent).
 */
function eventSource(agentRole: string): string {
  const run = '${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}';
  if (agentRole === 'coordinator') return `voc.engineering/conductor/${run}`;
  if (agentRole === 'coach') return `voc.engineering/coach/${run}`;
  return `voc.engineering/agent/${agentRole}/${run}/\${aws:PrincipalTag/agent}`;
}

/** What the runtime takes from the bus (engineering-bus.ts) and the connector broker (engineering-broker.ts). */
export interface EngineeringPeers {
  /**
   * voc-engineering-dlq: the supervisor rule's undelivered ticks. It is on the stack's key, whose EventBridge grant
   * VocCoreStack scopes to that queue, and alerting watches it (dlq-alarms.ts).
   */
  deadLetterQueue: sqs.IQueue;
  bus: events.IEventBus;
  /** The bus policy's pin of a role to its one source (EngineeringBus.addPublisher). */
  addPublisher: (statementId: string, role: iam.IRole, source: string) => void;
  board: lambda.IFunction;
  /** The board's function URL: handed to every agent's harness, its host on the agent's egress. */
  boardUrl: string;
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
export function imageArns(scope: Construct): Record<string, string> {
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

/** `-c engineeringMicrovmUsdPerSecond`, as the decimal text the runtime reads; `0` when absent. */
function microvmPrice(scope: Construct): string {
  const raw: unknown = scope.node.tryGetContext(MICROVM_PRICE_CONTEXT);
  if (raw === undefined || raw === null || raw === '') return '0';
  const text = String(raw).trim();
  const price = Number(text);
  // At most 12 digits after the point, as caps.py PRICE_DIGITS: the two parsers agree, and the runtime's sums stay exact.
  if (!/^\d+(\.\d{1,12})?$/.test(text) || !Number.isFinite(price) || price > MAX_USD_PER_SECOND) {
    throw new Error(`${MICROVM_PRICE_CONTEXT} is a decimal amount of 0 to ${MAX_USD_PER_SECOND} USD per MicroVM second, `
      + 'with at most 12 digits after the point.');
  }
  return text;
}

/** A boolean context flag of the runtime's own, strictly parsed (a typo fails the synth, not the opposite). */
function flag(scope: Construct, name: string): boolean {
  return booleanContextFlag(scope.node.tryGetContext(name), name, false, `Use -c ${name}=true or false.`);
}

/** The source the supervisor speaks with on the bus (lambda/engineering/runtime/board_bus.py SOURCE). */
const SUPERVISOR_SOURCE = 'voc.engineering/supervisor';

class EngineeringRuntime extends Construct {
  constructor(scope: Construct, id: string, props: WiredProps) {
    super(scope, id);
    const ruleName = props.uniqueName('voc-engineering-supervisor');
    const supervisorRole = workerRole(this, 'EngineeringSupervisorRole');
    // The delivery function's own role (least privilege): a wake renews agent sessions, so it is a launcher too.
    const deliveryRole = workerRole(this, 'EngineeringDeliveryRole');
    const agentRoles = new Map(AGENT_ROLES.map((agentRole) => [agentRole, this.createAgentRole(props, agentRole,
      [supervisorRole, deliveryRole])]));
    for (const [id, role] of [['Supervisor', supervisorRole], ['Delivery', deliveryRole]] as const) {
      this.grantSupervisorVoice(props, id, role);
    }
    const environment = this.environment(props, agentRoles, ruleName);
    const fn = this.createSupervisor(props, supervisorRole, agentRoles, ruleName, environment);
    this.createRule(props.peers.deadLetterQueue, fn, ruleName);
    this.createDelivery(props, deliveryRole, agentRoles, environment);
    if (flag(this, SUPERVISOR_ALARM_FLAG)) this.createAlarms(fn);
  }

  /** The MicroVMs of this account and region (created per agent session: no name is known at deploy time). */
  private microvmArns(): string[] {
    const stack = cdk.Stack.of(this);
    return ['microvm', 'microvm-image'].map((resource) => stack.formatArn({
      service: 'lambda', resource, resourceName: '*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    }));
  }

  /** Read only, the agents' checkpoints in the workspace bucket: a continuation restores from the latest one. */
  private grantCheckpointReads(role: iam.Role, workspaceBucket: s3.IBucket): string {
    const checkpoints = workspaceBucket.arnForObjects(CHECKPOINT_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [checkpoints] }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [workspaceBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [CHECKPOINT_KEYS] } },
    }));
    return checkpoints;
  }

  /**
   * The supervisor's voice on the bus, for both functions' role (a wake's continuation speaks too): PutEvents, only
   * with `voc.engineering/supervisor` (denied here for any other source, and by the bus's policy too).
   */
  private grantSupervisorVoice(props: WiredProps, id: string, role: iam.Role): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'SpeakAsTheSupervisor', actions: ['events:PutEvents'], resources: [props.peers.bus.eventBusArn],
      conditions: { StringEquals: { 'events:source': SUPERVISOR_SOURCE } },
    }));
    props.peers.addPublisher(id, role, SUPERVISOR_SOURCE);
  }

  /** The launcher's AssumeRole of the agent roles (their trust also requires all four session tags). */
  private grantLaunch(role: iam.Role, agentRoles: Map<string, iam.Role>): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [...agentRoles.values()].map((agentRole) => agentRole.roleArn),
    }));
  }

  /** The supervisor's and the delivery function's environment (one code; the delivery takes a subset). */
  private environment(props: WiredProps, agentRoles: Map<string, iam.Role>, ruleName: string): Record<string, string> {
    const stack = cdk.Stack.of(this);
    return {
      ENGINEERING_TABLE: props.engineeringTable.tableName,
      ENGINEERING_BUS_NAME: props.peers.bus.eventBusName,
      ENGINEERING_BOARD_URL: props.peers.boardUrl,
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
      // The price of a MicroVM second (`-c engineeringMicrovmUsdPerSecond`; 0: not priced).
      ENGINEERING_MICROVM_USD_PER_SECOND: microvmPrice(this),
      // The benchmark's case ids, for the coach the run's retrospective asks (learning/loop.py).
      ENGINEERING_BENCHMARK_CASES: JSON.stringify(benchmarkCaseIds()),
    };
  }

  /**
   * voc-engineering-delivery, the name the inbox router invokes (engineering-bus.ts ENGINEERING_DELIVERY_FUNCTION):
   * a message for an agent, the conductor or a role of a run goes into that run's inbox (its rows in voc-engineering)
   * and its addressees are woken (lambda/engineering/runtime/delivery.py, through Supervisor.wake). The supervisor's
   * code, but a role of its own with only what a wake needs: the runs' partitions (never the registry, no delete),
   * resuming a MicroVM and handing it a fresh agent session (the agent roles trust it as a launcher, with the same
   * four session tags), continuing a held agent in a new MicroVM from its checkpoint, and its failure records. No
   * rule switch. An invocation fails while an addressee is busy or its wake failed: Lambda retries it twice, then
   * records it in voc-engineering-dlq.
   */
  private createDelivery(
    props: WiredProps, role: iam.Role, agentRoles: Map<string, iam.Role>, environment: Record<string, string>,
  ): void {
    const { kmsKey, engineeringTable, workspaceBucket } = props;
    const dlq = props.peers.deadLetterQueue;
    // The run's inbox rows, META and its agents' session rows (claim, save, release), in the runs' partitions only.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'RunRows',
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      resources: [engineeringTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_PARTITIONS] } },
    }));
    const checkpoints = this.grantCheckpointReads(role, workspaceBucket);
    role.addToPrincipalPolicy(viaServices(kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['s3', 'dynamodb', 'sqs']));
    // Waking (resume, a fresh session over the MicroVM's auth token) and continuing (a new MicroVM, the old one ended).
    const microvms = this.microvmArns();
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'WakeMicrovms',
      actions: ['lambda:ResumeMicrovm', 'lambda:CreateMicrovmAuthToken', 'lambda:RunMicrovm', 'lambda:TerminateMicrovm'],
      resources: microvms,
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Read-only on the agents\' checkpoint objects of every run (a continuation restores from the latest), and the MicroVMs of this account and region, which are created per agent session and have no name known at deploy time',
      findings: [checkpoints, ...microvms].map(resourceFinding),
    }]);
    this.grantLaunch(role, agentRoles);
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
      // It never takes the launch action (a continuation reuses the session's stored egress), switches no rule and
      // runs no retrospective: neither the extra egress, the rule's name nor the benchmark's cases.
      environment: Object.fromEntries(Object.entries(environment)
        .filter(([name]) => !['ENGINEERING_EXTRA_EGRESS', 'SUPERVISOR_RULE_NAME', 'ENGINEERING_BENCHMARK_CASES']
          .includes(name))),
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
  private createAgentRole(props: WiredProps, agentRole: string, launchers: [iam.IRole, ...iam.IRole[]]): iam.Role {
    const { rawDataBucket, workspaceBucket, kmsKey, uniqueName, peers } = props;
    const id = capitalize(agentRole.replace(/-/g, '_'));
    // Only the launchers (the supervisor; the delivery function, whose wake renews a session) may assume it and tag
    // the session, and only with every session tag the conditions read (an untagged session would match no key, but
    // it is refused outright rather than relied on).
    const tagged = { Null: Object.fromEntries(SESSION_TAGS.map((tag) => [`aws:RequestTag/${tag}`, 'false'])) };
    const [first, ...others] = launchers;
    const role = new iam.Role(this, `EngineeringAgent${id}Role`, {
      // The broker's AGENT_ROLE_NAME_PATTERN reads the role back from this name (`voc-eng-{role}` + the naming).
      roleName: uniqueName(`voc-eng-${agentRole}`),
      assumedBy: new iam.SessionTagsPrincipal(new iam.ArnPrincipal(first.roleArn)).withConditions(tagged),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    for (const launcher of others) {
      role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        principals: [new iam.ArnPrincipal(launcher.roleArn)],
        conditions: tagged,
      }));
    }
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
    // No queue: its run's messages, posted tasks included, are pushed to it by the delivery function and read
    // through the board's inbox op (its run's only).
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
    // The bus, with its own source only: denied here for any other, and by the bus's policy too (which denies
    // every role it does not admit everything).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PutOnTheBus', actions: ['events:PutEvents'], resources: [peers.bus.eventBusArn],
    }));
    peers.addPublisher(id, role, eventSource(agentRole));
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
    const checkpoints = this.grantCheckpointReads(role, workspaceBucket);
    // The key, only through S3 (checkpoint reads) and DynamoDB (the run and session rows): never a direct KMS call.
    // (Its rule's undelivered ticks reach the DLQ through EventBridge, not this role.)
    role.addToPrincipalPolicy(viaServices(kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['s3', 'dynamodb']));
    const microvms = this.microvmArns();
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: MICROVM_ACTIONS, resources: microvms }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Read-only on the agents\' checkpoint objects of every run (it picks the one a continuation restores from), and the MicroVMs of this account and region, which are created per agent session and have no name known at deploy time',
      findings: [checkpoints, ...microvms].map(resourceFinding),
    }]);
    // The launcher: a 15-minute session of an agent role, with its tags (launcher.py). No IAM write anywhere: a
    // stop cuts a run's sessions by not renewing them.
    this.grantLaunch(role, agentRoles);
    // Its own rule only, by name (a reference to the rule would be a cycle: the rule targets this function).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule'],
      resources: [stack.formatArn({ service: 'events', resource: 'rule', resourceName: ruleName })],
    }));
    const functionName = uniqueName('voc-engineering-runtime');
    this.grantLearning(props, role, functionName);
    return createWorkerFunction(this, 'EngineeringSupervisor', {
      tree: 'engineering',
      functionName,
      handler: 'engineering/runtime/handler.lambda_handler',
      role,
      layer: props.layer,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      serviceName: 'voc-engineering-runtime',
      environment,
      // No asynchronous retry: its asynchronous callers are its own rule (the next tick is a minute away) and its
      // own hand-on of a retrospective, whose every step is claimed by a create-only row and never raises; a retry
      // of an invocation cut off at its limit would only repeat what the claim already stops.
      retryAttempts: 0,
    });
  }

  /**
   * The learning loop's grants on the runtime's role (lambda/engineering/learning/loop.py, the `retrospective`
   * action a run's end hands on): the run's own rows it already reads and writes (its board, agents and gate-record
   * keys; its `LEARN#` claims, create-only), plus only what the loop adds:
   * - the gate records the final-go tasks named, read only (`GetObject`, no listing);
   * - the skills' partitions: the coach's reads (`GetItem`) and its proposal (`UpdateItem` of the version counter,
   *   `PutItem` of the create-only version and its `RUN#` guard); never a delete;
   * - the roles' lessons in agent memory: the scope's bounded read (`Query`, `GetItem`) and the draft or its
   *   confirmation (`PutItem`, `UpdateItem` of the memory's count); never a person's memories, never a delete;
   * - the scorecards: `PutItem` only (each row is create-only; nothing here reads them back);
   * - Converse on the allowlisted Claude models (one call per failure, at most three per run);
   * - an asynchronous invoke of this function itself, by name (a reference to it would be a cycle), so the
   *   retrospective and each failure run in invocations of their own.
   */
  private grantLearning(props: WiredProps, role: iam.Role, functionName: string): void {
    const { engineeringTable, workspaceBucket } = props;
    const gateRecords = workspaceBucket.arnForObjects(GATE_RECORD_KEYS);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'LearningReadsGateRecords', actions: ['s3:GetObject'], resources: [gateRecords],
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Read-only on the quality gate\'s record objects of every run: a retrospective reads only the keys its run\'s final-go tasks recorded',
      findings: [resourceFinding(gateRecords)],
    }]);
    const keyed = (sid: string, actions: string[], partitions: string[]): iam.PolicyStatement => new iam.PolicyStatement({
      sid, actions, resources: [engineeringTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } },
    });
    role.addToPrincipalPolicy(keyed('LearningCoachSkills',
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], [SKILL_PARTITIONS]));
    role.addToPrincipalPolicy(keyed('LearningRoleLessons',
      ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], [ROLE_MEMORY_PARTITIONS]));
    role.addToPrincipalPolicy(keyed('LearningScorecards', ['dynamodb:PutItem'], [SCORECARD_PARTITIONS]));
    grantClaudeModels(role, 'invoke');
    grantInvokeByName(cdk.Stack.of(this), role, [functionName], 'LearningHandsOnToItself');
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
