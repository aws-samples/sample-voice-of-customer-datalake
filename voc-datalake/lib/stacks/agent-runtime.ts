/**
 * Autonomous-agent runtime (VocProcessingStack) — docs/autonomous-agents.md.
 *
 *   EventBridge 15 min → agent-heartbeat ──StartExecution──▶ voc-agent-run
 *   agents API "Run now" ─────────────────StartExecution──▶ voc-agent-run
 *
 * voc-agent-run is a CONDUCTOR LOOP, not a static pipeline: the workflow
 * definition is data (voc-agents `WORKFLOW#…`), interpreted by the conductor
 * Lambda one directive at a time, the KiroCrew way — the conductor decides and
 * verifies, crewmates do the work.
 *
 *   Init(conductor) ─▶ Route
 *     execute + persona_review ─▶ PersonaPanel(panel Lambda) ─▶ Advance
 *     execute                  ─▶ ExecuteNode(nodes Lambda)  ─▶ Advance
 *     wait  ─▶ WaitForJob ─▶ PollNode(nodes Lambda)          ─▶ Advance
 *     finish (anything else)   ─▶ Done
 *   Advance(conductor) ─▶ Route;  any task error ─▶ RecordFailure ─▶ Failed
 *
 * THE CONTRACT is lambda/agents/state_machine.py (rendered to
 * state_machine.asl.json, which this construct loads verbatim): conductor
 * actions init / advance / fail, crewmate actions start / poll.
 *
 * Node executors call the EXISTING Projects/Metrics/Memory API Lambdas
 * (synthetic API Gateway events as `agent:{agent_id}`), never their tables — so
 * no runtime role holds a projects- or feedback-table grant at all.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

import {
  MEMORY_API_FUNCTION_BASE_NAME, METRICS_API_FUNCTION_BASE_NAME, PROJECTS_API_FUNCTION_BASE_NAME,
} from '../utils/function-names';
import { stackModelArns } from '../utils/model-allowlist';
import { createWorkerFunction, grantInvokeByName, scheduleWorker, workerRole } from '../utils/worker-lambda';

/**
 * The rendered voc-agent-run definition. Its `TimeoutSeconds` (24 h, the
 * brief's ceiling on one run) and its retries live in the Python builder.
 */
const AGENT_RUN_ASL_PATH = path.join(__dirname, '../../lambda/agents/state_machine.asl.json');

/** The three Lambdas voc-agent-run invokes. */
interface AgentRunFunctions {
  conductor: lambda.IFunction;
  nodes: lambda.IFunction;
  personaPanel: lambda.IFunction;
}

/** What differs between the runtime Lambdas (see AgentRuntime.crewmate). */
interface CrewmateSpec {
  /** Base physical name, also the Powertools service name. */
  serviceName: string;
  handler: string;
  timeout: cdk.Duration;
  aggregatesActions: string[];
  /** Env var → base name of each domain API Lambda it invokes as the agent. */
  invokes: Record<string, string>;
  invokeSid: string;
  /** Extra grants beyond the shared ones. */
  grant?: (role: iam.IRole) => void;
  environment?: Record<string, string>;
}

export interface AgentRuntimeProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  agentsTable: dynamodb.ITable;
  /** Read only by the heartbeat (new-review trigger counts). */
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
  /** Agent runs are a memory source (`agent_run`). */
  memoryExtractQueue: sqs.IQueue;
}

export class AgentRuntime extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, private readonly props: AgentRuntimeProps) {
    super(scope, id);
    this.stateMachine = this.createStateMachine({
      conductor: this.createConductor(),
      nodes: this.createNodes(),
      personaPanel: this.createPersonaPanel(),
    });
    this.createHeartbeat(this.stateMachine);
  }

  private bedrockStatement(): iam.PolicyStatement {
    // agent_* surfaces are picker surfaces (and per-agent overrides), so every
    // allowlisted model, like every other Bedrock caller here (issue #96).
    return new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel'],
      resources: stackModelArns(this),
    });
  }

  /**
   * One runtime Lambda: its role (voc-agents rows without DeleteItem, the
   * aggregates actions it reads, KMS, Bedrock on the allowlist, and invoke on
   * exactly the domain API Lambdas it calls AS THE AGENT), then the function
   * with each of those API names in its environment.
   */
  private crewmate(id: string, spec: CrewmateSpec): lambda.Function {
    const { uniqueName, kmsKey, agentsTable, aggregatesTable } = this.props;
    const role = workerRole(this, `${id}Role`);
    agentsTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    aggregatesTable.grant(role, ...spec.aggregatesActions);
    kmsKey.grantEncryptDecrypt(role);
    role.addToPolicy(this.bedrockStatement());
    spec.grant?.(role);
    const apis = Object.fromEntries(Object.entries(spec.invokes).map(([env, base]) => [env, uniqueName(base)]));
    grantInvokeByName(cdk.Stack.of(this), role, Object.values(apis), spec.invokeSid);
    return createWorkerFunction(this, id, {
      tree: 'agents',
      functionName: uniqueName(spec.serviceName),
      handler: spec.handler,
      role,
      layer: this.props.layer,
      timeout: spec.timeout,
      memorySize: 1024,
      serviceName: spec.serviceName,
      environment: {
        AGENTS_TABLE: agentsTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        ...spec.environment,
        ...apis,
      },
    });
  }

  private createConductor(): lambda.Function {
    const { memoryExtractQueue } = this.props;
    return this.crewmate('AgentConductor', {
      serviceName: 'voc-agent-conductor',
      handler: 'agents/conductor/handler.lambda_handler',
      timeout: cdk.Duration.minutes(5),
      // Model picker (orchestrator surface) — a GetItem. It builds no
      // design-system block, the only aggregates Query (company_context.list_references).
      aggregatesActions: ['dynamodb:GetItem'],
      // A finished run is a memory source (`agent_run`).
      grant: (role) => memoryExtractQueue.grantSendMessages(role),
      environment: { MEMORY_EXTRACT_QUEUE_URL: memoryExtractQueue.queueUrl },
      // Verification re-reads every claimed project/document AS THE AGENT through
      // the Projects API — the conductor never trusts a crewmate's claim.
      invokes: { PROJECTS_FUNCTION: PROJECTS_API_FUNCTION_BASE_NAME },
      invokeSid: 'InvokeProjectsApi',
    });
  }

  /** The crewmates: every node type except persona_review (agents/nodes). */
  private createNodes(): lambda.Function {
    const { rawDataBucket } = this.props;
    return this.crewmate('AgentNodes', {
      serviceName: 'voc-agent-nodes',
      handler: 'agents/nodes/handler.lambda_handler',
      timeout: cdk.Duration.minutes(15),
      // Model picker, company context, design system, category owners, fallback owner.
      aggregatesActions: ['dynamodb:GetItem', 'dynamodb:Query'],
      // final_review reads the built prototype it judges.
      grant: (role) => rawDataBucket.grantRead(role, 'prototypes/*'),
      environment: { RAW_DATA_BUCKET: rawDataBucket.bucketName },
      // Reviews, projects/documents/personas and memories — each through its own
      // API Lambda as the agent principal, so the API's access rules apply.
      invokes: {
        PROJECTS_FUNCTION: PROJECTS_API_FUNCTION_BASE_NAME,
        METRICS_FUNCTION: METRICS_API_FUNCTION_BASE_NAME,
        MEMORY_FUNCTION: MEMORY_API_FUNCTION_BASE_NAME,
      },
      invokeSid: 'InvokeDomainApis',
    });
  }

  private createPersonaPanel(): lambda.Function {
    const { rawDataBucket } = this.props;
    return this.crewmate('AgentPersonaPanel', {
      serviceName: 'voc-agent-persona-panel',
      handler: 'agents/persona_panel/handler.lambda_handler',
      timeout: cdk.Duration.minutes(5),
      aggregatesActions: ['dynamodb:GetItem'],
      // The prototype under review.
      grant: (role) => rawDataBucket.grantRead(role, 'prototypes/*'),
      environment: { RAW_DATA_BUCKET: rawDataBucket.bucketName },
      // Persona + document reads go through the Projects API (its access rules).
      invokes: { PROJECTS_FUNCTION: PROJECTS_API_FUNCTION_BASE_NAME },
      invokeSid: 'InvokeProjectsApi',
    });
  }

  /**
   * voc-agent-run from the runtime's OWN definition (lambda/agents/state_machine.py
   * renders state_machine.asl.json; a Python test keeps the two identical), so the
   * Lambdas and the state machine can never disagree about actions or shapes.
   */
  private createStateMachine(functions: AgentRunFunctions): sfn.StateMachine {
    const { uniqueName } = this.props;
    const machine = new sfn.StateMachine(this, 'AgentRunStateMachine', {
      stateMachineName: uniqueName('voc-agent-run'),
      definitionBody: sfn.DefinitionBody.fromString(fs.readFileSync(AGENT_RUN_ASL_PATH, 'utf8')),
      definitionSubstitutions: {
        ConductorFunctionArn: functions.conductor.functionArn,
        NodesFunctionArn: functions.nodes.functionArn,
        PersonaPanelFunctionArn: functions.personaPanel.functionArn,
      },
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'AgentRunStateMachineLogs', {
          logGroupName: uniqueName('/aws/stepfunctions/voc-agent-run'),
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        // Every transition, but never a payload: directives and node results
        // carry document/review content, which is never logged.
        includeExecutionData: false,
      },
    });
    // Exactly the three unqualified ARNs the definition invokes — not
    // grantInvoke(), which adds `<arn>:*` (every version and alias).
    const runtime = [functions.conductor, functions.nodes, functions.personaPanel];
    machine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: runtime.map((fn) => fn.functionArn),
    }));
    return machine;
  }

  private createHeartbeat(stateMachine: sfn.StateMachine): void {
    const { uniqueName, kmsKey, agentsTable, feedbackTable, aggregatesTable } = this.props;
    const role = workerRole(this, 'AgentHeartbeatRole');
    // Enabled agents (index), cursors, the queued RUN row it creates.
    agentsTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    // new_reviews trigger: in-scope reviews since the agent's cursor (date index).
    feedbackTable.grant(role, 'dynamodb:Query');
    // threshold trigger: METRIC#daily_category / daily_subcategory rows.
    aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query');
    kmsKey.grantEncryptDecrypt(role);
    stateMachine.grantStartExecution(role);

    const fn = createWorkerFunction(this, 'AgentHeartbeat', {
      tree: 'agents',
      functionName: uniqueName('voc-agent-heartbeat'),
      handler: 'agents/heartbeat/handler.lambda_handler',
      role,
      layer: this.props.layer,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // CPU: 101 % p95 at 512 MB (docs/lambda-sizing.md)
      serviceName: 'voc-agent-heartbeat',
      environment: {
        AGENTS_TABLE: agentsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        AGENT_RUN_STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });
    scheduleWorker(this, 'AgentHeartbeatSchedule', fn, uniqueName('voc-agent-heartbeat-schedule'),
      events.Schedule.rate(cdk.Duration.minutes(15)));
  }
}
