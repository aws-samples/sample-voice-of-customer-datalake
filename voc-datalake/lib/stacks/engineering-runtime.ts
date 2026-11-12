/**
 * The engineering agents' runtime (VocProcessingStack, off by default): docs/autonomous-engineering.md → Runtime.
 *
 *   EventBridge rule, rate(1 minute), created DISABLED ───▶ voc-engineering-runtime {action: tick}  (the supervisor)
 *   the run coordinator ───────────────────────────────────▶ voc-engineering-runtime {action: launch}
 *   the run monitor ───────────────────────────────────────▶ voc-engineering-runtime {action: signal}
 *   a run's start / the last active run's end ─────────────▶ voc-engineering-runtime {action: switch} (the rule)
 *
 * One MicroVM per agent. Its agent user gets a 15-minute session of its agent role from the launcher (this function's
 * role, the only principal the agent roles trust and the only one that may tag their sessions): ONE fixed role per
 * agent role, narrowed by the session's tags (ws, run, agent, connection). No MicroVM holds a host token (the
 * connector's broker does). The supervisor's role: the session rows, the checkpoints it reads, its own rule, the
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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { capitalize } from '../plugin-loader';
import { ENGINEERING_CACHE_PREFIX, ENGINEERING_RUNS_PREFIX } from './core-buckets';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { booleanContextFlag } from '../utils/context-flag';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';

const ENGINEERING_AGENTS_FLAG = 'engineeringAgents';
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
/** The session's own S3 keys (checkout.py: the cache; checkpoints.py: the runs), one template each. */
const CACHE_KEYS = `${ENGINEERING_CACHE_PREFIX}\${aws:PrincipalTag/connection}/*`;
const RUN_KEYS = `${ENGINEERING_RUNS_PREFIX}\${aws:PrincipalTag/run}/*`;
// The agent comes right after the run in every workspace key, so this cannot match another agent's keys.
const OWN_KEYS = `${ENGINEERING_RUNS_PREFIX}\${aws:PrincipalTag/run}/\${aws:PrincipalTag/agent}/*`;
/** The session tags only the launcher sets (launcher.py); an AssumeRole without every one of them is refused. */
const SESSION_TAGS = ['ws', 'run', 'agent', 'connection'];
const SESSION_KEYS = ['ENGRUN#*', 'ENG_SESSIONS_ACTIVE'];
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
 * own, from the tags only the launcher sets; the run coordinator speaks as its run's conductor. (The coach's and the
 * gate runner's are sources senders.py drops: docs/autonomous-engineering.md → Runtime.)
 */
function eventSource(agentRole: string): string {
  const run = '${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}';
  return agentRole === 'coordinator'
    ? `voc.engineering/conductor/${run}`
    : `voc.engineering/agent/${agentRole}/${run}/\${aws:PrincipalTag/agent}`;
}


interface EngineeringRuntimeProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  /** voc-agents: the session rows (`ENGRUN#…` partitions and the `ENG_SESSIONS_ACTIVE` index key only). */
  agentsTable: dynamodb.ITable;
  /** The raw data lake: the cache (`engineering/cache/`) and the runs' workspaces (`engineering/runs/`). */
  rawDataBucket: s3.IBucket;
  /**
   * voc-engineering-dlq (engineering-bus.ts): the supervisor rule's undelivered ticks. It is on the stack's key, whose
   * EventBridge grant VocCoreStack scopes to that queue, and alerting watches it (dlq-alarms.ts). Required with the
   * flag on; the bus is deployed with the same flag.
   */
  deadLetterQueue: sqs.IQueue | undefined;
}

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

/** A boolean context flag, strictly parsed (a typo fails the synth instead of deploying the opposite). */
function flag(scope: Construct, name: string): boolean {
  return booleanContextFlag(scope.node.tryGetContext(name), name, false, `Use -c ${name}=true or false.`);
}

class EngineeringRuntime extends Construct {
  constructor(scope: Construct, id: string, props: EngineeringRuntimeProps & { deadLetterQueue: sqs.IQueue }) {
    super(scope, id);
    const ruleName = props.uniqueName('voc-engineering-supervisor');
    const supervisorRole = workerRole(this, 'EngineeringSupervisorRole');
    const agentRoles = new Map(AGENT_ROLES.map((agentRole) => [agentRole, this.createAgentRole(props, agentRole,
      supervisorRole)]));
    const fn = this.createSupervisor(props, supervisorRole, agentRoles, ruleName);
    this.createRule(props.deadLetterQueue, fn, ruleName);
    if (flag(this, SUPERVISOR_ALARM_FLAG)) this.createAlarms(fn);
  }

  /**
   * ONE fixed execution role per agent role (never per run), narrowed per session by the tags only the launcher
   * sets (ws, run, agent, connection): read its connection's cache and its run's workspace, write only its own
   * keys, read only its own inbox and its run's queue for its role, call the allowlisted models. It can assume no
   * role and put no event on the bus with any source but its own.
   */
  private createAgentRole(props: EngineeringRuntimeProps, agentRole: string, launcher: iam.IRole): iam.Role {
    const { rawDataBucket, kmsKey, uniqueName } = props;
    const stack = cdk.Stack.of(this);
    const role = new iam.Role(this, `EngineeringAgent${capitalize(agentRole.replace(/-/g, '_'))}Role`, {
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
    const runObjects = rawDataBucket.arnForObjects(RUN_KEYS);
    const ownObjects = rawDataBucket.arnForObjects(OWN_KEYS);
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Object keys under ONE session-tagged prefix (the connection\'s cache, the run\'s workspace, the agent\'s own keys); the trailing wildcard is the object key, never another connection, run or agent',
      findings: [cacheObjects, runObjects, ownObjects].map(resourceFinding),
    }]);
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCacheAndRun', actions: ['s3:GetObject'], resources: [cacheObjects, runObjects],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListCacheAndRun',
      actions: ['s3:ListBucket'],
      resources: [rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [CACHE_KEYS, RUN_KEYS] } },
    }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteOwnKeys', actions: ['s3:PutObject'], resources: [ownObjects] }));
    // Its own inbox and its run's queue for its role (queue names agreed with the bus: see the doc).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'OwnQueues',
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
      // Ids hold no "_" (a ULID run, a `<role>-<index>` agent), so "_" separates them.
      resources: [`voc-eng_\${aws:PrincipalTag/run}_\${aws:PrincipalTag/agent}`,
        `voc-eng_\${aws:PrincipalTag/run}_role_${agentRole}`].map((queue) => stack.formatArn({
        service: 'sqs', resource: queue, arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
      })),
    }));
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
    props: EngineeringRuntimeProps, role: iam.Role, agentRoles: Map<string, iam.Role>, ruleName: string,
  ): lambda.Function {
    const { uniqueName, kmsKey, agentsTable, rawDataBucket } = props;
    const stack = cdk.Stack.of(this);
    // Session rows: read, write and list the live ones; in the ENGRUN# partitions and the index key only; never a delete.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
      resources: [agentsTable.tableArn, `${agentsTable.tableArn}/index/gsi1-by-agents-listing`],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': SESSION_KEYS } },
    }));
    // The agents' checkpoints, to pick the one a continuation restores from: read only.
    const checkpoints = rawDataBucket.arnForObjects(`${ENGINEERING_RUNS_PREFIX}*/*/checkpoints/*`);
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [checkpoints] }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${ENGINEERING_RUNS_PREFIX}*`] } },
    }));
    // The key, only through S3 (checkpoint reads) and DynamoDB (the session rows): never a direct KMS call.
    role.addToPrincipalPolicy(viaServices(kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['s3', 'dynamodb']));
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
      environment: {
        AGENTS_TABLE: agentsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        SUPERVISOR_RULE_NAME: ruleName,
        ENGINEERING_AGENT_ROLE_ARNS: stack.toJsonString(Object.fromEntries(
          [...agentRoles.entries()].map(([agentRole, agentIam]) => [agentRole, agentIam.roleArn]))),
        // Image ARN per language, from `-c engineeringImageArns` once the images are built (docs/deployment.md);
        // a language without one is refused at launch (aws.py AwsMicroVmRuntime.run).
        ENGINEERING_IMAGE_ARNS: JSON.stringify(imageArns(this)),
        ENGINEERING_EXTRA_EGRESS: '[]',
        // The supervisor's settable clocks (lambda/engineering/runtime/caps.py SETTABLE); {} keeps the defaults.
        ENGINEERING_TIMINGS: '{}',
      },
    });
  }

  /**
   * The supervisor's EventBridge rule (TENETS.md tenet 7: schedules run on EventBridge rules): every minute,
   * created DISABLED; a run's start turns it on, the end of the last active run turns it off (handler.switch).
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
  if (!flag(scope, ENGINEERING_AGENTS_FLAG)) return false;
  const { deadLetterQueue } = props;
  if (!deadLetterQueue) throw new Error('engineeringAgents needs the engineering bus\'s dead-letter queue');
  new EngineeringRuntime(scope, 'EngineeringRuntime', { ...props, deadLetterQueue });
  return true;
}
