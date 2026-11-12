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
 * agent role, narrowed by the session's tags (connection, run_id, agent_id). No MicroVM holds a host token (the
 * connector's broker does). The supervisor's role: the session rows, the checkpoints it reads, its own rule, the
 * MicroVM operations and the launcher's AssumeRole; no IAM write: a stop cuts a run's sessions by not renewing them.
 *
 * Deployed only with `-c engineeringAgents=true`: the default synth has none of it, so no fixed cost and nothing for
 * fixed-cost-guard.test.ts to see. Pay per use with the flag on too: the rule runs only while a run is active,
 * and its failed invocations go to a queue. The alarms are a fixed monthly cost, so they are a second opt-in
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
import { grantClaudeModels } from '../utils/claude-model-grant';
import { booleanContextFlag } from '../utils/context-flag';
import { acknowledgeNag, acknowledgeNagOnResource, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';

const ENGINEERING_AGENTS_FLAG = 'engineeringAgents';
const SUPERVISOR_ALARM_FLAG = 'engineeringSupervisorAlarm';
/** lambda/engineering/runtime: checkout.py (the cache), checkpoints.py (the runs), sessions.py (the rows). */
const CACHE_PREFIX = 'engineering/cache';
const RUNS_PREFIX = 'engineering/runs';
const SESSION_KEYS = ['ENGRUN#*', 'ENG_SESSIONS_ACTIVE'];
/** Every MicroVM operation lambda/engineering/runtime/aws.py calls. */
const MICROVM_ACTIONS = [
  'lambda:RunMicrovm', 'lambda:SuspendMicrovm', 'lambda:ResumeMicrovm', 'lambda:TerminateMicrovm',
  'lambda:CreateMicrovmAuthToken',
];
/**
 * The agent roles of lambda/engineering/runtime/interface.py ROLES (one execution role each); a Python test keeps
 * the two lists equal.
 */
const AGENT_ROLES = [
  'builder', 'coach', 'commit_reviewer', 'committer', 'coordinator', 'final_go', 'fixer', 'gate_runner', 'hunter',
  'pr_author', 'pr_reviewer', 'understander',
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

/** The only bus source an agent's session may put events with (the bus's schema names it). */
const EVENT_SOURCE = `voc.engineering.\${aws:PrincipalTag/run_id}.\${aws:PrincipalTag/agent_id}`;


interface EngineeringRuntimeProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  /** voc-agents: the session rows (`ENGRUN#…` partitions and the `ENG_SESSIONS_ACTIVE` index key only). */
  agentsTable: dynamodb.ITable;
  /** The raw data lake: the cache (`engineering/cache/`) and the runs' workspaces (`engineering/runs/`). */
  rawDataBucket: s3.IBucket;
}

/** A boolean context flag, strictly parsed (a typo fails the synth instead of deploying the opposite). */
function flag(scope: Construct, name: string): boolean {
  return booleanContextFlag(scope.node.tryGetContext(name), name, false, `Use -c ${name}=true or false.`);
}

class EngineeringRuntime extends Construct {
  constructor(scope: Construct, id: string, props: EngineeringRuntimeProps) {
    super(scope, id);
    const ruleName = props.uniqueName('voc-engineering-supervisor');
    const supervisorRole = workerRole(this, 'EngineeringSupervisorRole');
    const agentRoles = new Map(AGENT_ROLES.map((agentRole) => [agentRole, this.createAgentRole(props, agentRole,
      supervisorRole)]));
    const fn = this.createSupervisor(props, supervisorRole, agentRoles, ruleName);
    const deadLetters = this.createRule(props, fn, ruleName);
    if (flag(this, SUPERVISOR_ALARM_FLAG)) this.createAlarms(fn, deadLetters);
  }

  /**
   * ONE fixed execution role per agent role (never per run), narrowed per session by the tags only the launcher
   * sets (connection, run_id, agent_id): read its connection's cache and its run's workspace, write only its own
   * keys, read only its own inbox and its run's queue for its role, call the allowlisted models. It can assume no
   * role and put no event on the bus with any source but its own.
   */
  private createAgentRole(props: EngineeringRuntimeProps, agentRole: string, launcher: iam.IRole): iam.Role {
    const { rawDataBucket, kmsKey, uniqueName } = props;
    const stack = cdk.Stack.of(this);
    const role = new iam.Role(this, `EngineeringAgent${capitalize(agentRole)}Role`, {
      roleName: uniqueName(`voc-eng-${agentRole.replace(/_/g, '-')}`),
      // Only the launcher may assume it, and only the launcher may tag the session.
      assumedBy: new iam.SessionTagsPrincipal(new iam.ArnPrincipal(launcher.roleArn)),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const cacheKeys = `${CACHE_PREFIX}/\${aws:PrincipalTag/connection}/*`;
    const runKeys = `${RUNS_PREFIX}/\${aws:PrincipalTag/run_id}/*`;
    const cacheObjects = rawDataBucket.arnForObjects(`${CACHE_PREFIX}/\${aws:PrincipalTag/connection}/*`);
    const runObjects = rawDataBucket.arnForObjects(`${RUNS_PREFIX}/\${aws:PrincipalTag/run_id}/*`);
    // The agent comes right after the run in every workspace key, so this cannot match another agent's keys.
    const ownObjects = rawDataBucket.arnForObjects(`${RUNS_PREFIX}/\${aws:PrincipalTag/run_id}/\${aws:PrincipalTag/agent_id}/*`);
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
      conditions: { StringLike: { 's3:prefix': [cacheKeys, runKeys] } },
    }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteOwnKeys', actions: ['s3:PutObject'], resources: [ownObjects] }));
    // Its own inbox and its run's queue for its role (queue names agreed with the bus: see the doc).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'OwnQueues',
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
      // Ids hold no "_" (interface.py check_id), so "_" separates them: no two (run, agent) pairs share a name.
      resources: [`voc-eng_\${aws:PrincipalTag/run_id}_\${aws:PrincipalTag/agent_id}`,
        `voc-eng_\${aws:PrincipalTag/run_id}_role_${agentRole}`].map((queue) => stack.formatArn({
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
      conditions: { StringNotEquals: { 'events:source': EVENT_SOURCE } },
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
    const checkpoints = rawDataBucket.arnForObjects(`${RUNS_PREFIX}/*/*/checkpoints/*`);
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [checkpoints] }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${RUNS_PREFIX}/*`] } },
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
        // Image ARN per language, set when the images are built (docs/autonomous-engineering.md → Images).
        ENGINEERING_IMAGE_ARNS: '{}',
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
  private createRule(props: EngineeringRuntimeProps, fn: lambda.Function, ruleName: string): sqs.Queue {
    // SQS-managed encryption: EventBridge can deliver to it without a key-policy grant on the stack's key.
    const deadLetters = new sqs.Queue(this, 'SupervisorDeadLetters', {
      queueName: props.uniqueName('voc-engineering-supervisor-failures'),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    acknowledgeNagOnResource(deadLetters, [{
      id: 'AwsSolutions-SQS3',
      reason: 'This queue IS the terminal failure record of the supervisor rule; nothing consumes it, so it has no DLQ of its own',
    }]);
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
    return deadLetters;
  }

  private createAlarms(fn: lambda.Function, deadLetters: sqs.Queue): void {
    new cloudwatch.Alarm(this, 'SupervisorErrorsAlarm', {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The engineering supervisor failed 3 times in 5 minutes: agents may not be watched.',
    });
    new cloudwatch.Alarm(this, 'SupervisorDeadLettersAlarm', {
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A supervisor tick could not be delivered.',
    });
  }
}

/**
 * The engineering runtime when the stack's context says `engineeringAgents=true`, else nothing at all
 * (the default: no function, no rule, no role, no grant).
 */
export function addEngineeringRuntime(scope: Construct, props: EngineeringRuntimeProps): boolean {
  if (!flag(scope, ENGINEERING_AGENTS_FLAG)) return false;
  new EngineeringRuntime(scope, 'EngineeringRuntime', props);
  return true;
}
