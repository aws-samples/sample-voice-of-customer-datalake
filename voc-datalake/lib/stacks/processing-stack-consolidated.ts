import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from '../utils/log-retention';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { acknowledgeNagOnResource } from '../utils/nag-ack';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { dependencyLayer } from '../utils/dependency-layers';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import { MemoryWorkers } from './memory-workers';
import { AGGREGATOR_FUNCTION_BASE_NAME, AGGREGATOR_STREAM_FAILURES_BASE_NAME, FEEDBACK_PROCESSOR_FUNCTION_BASE_NAME } from './dlq-alarms';
import { AgentRuntime } from './agent-runtime';
import { createBriefingWorker } from './briefing-worker';
import { ENGINEERING_ROLE_NAME_TEMPLATE, EngineeringBroker, engineeringAgentsEnabled } from './engineering-broker';
import { EngineeringBus } from './engineering-bus';
import { type EngineeringPeers, addEngineeringRuntime } from './engineering-runtime';
import { createRadarScanWorker } from './radar-scan-worker';
import { createRetentionWorker } from './retention-worker';
import { createResearchStateMachine } from './processing-research-workflow';
import { grantSharedMemoryRecall } from '../utils/memory-recall-grant';
import { PROCESSOR_BATCHING_WINDOW, PROCESSOR_MAX_CONCURRENCY, PROCESSOR_TIMEOUT } from './processor-timing';
import { appVersion } from '../utils/connector-version';
import { grantSilverHistoryPut } from '../utils/silver-history-grants';
import { grantReadAndWrites } from '../utils/table-write-grants';
import { grantRealtimePublish, type RealtimePublishing } from '../utils/realtime';
import { FEATURE_REQUESTS_TABLE_ENV, grantFeatureRequestEvidenceRead } from '../utils/feature-request-evidence-grant';
import { createAggregatorRole, createProcessorRole, grantTextAnalysis } from './processing-roles';
import { loadPlugins, pluginIdsWithCapability } from '../plugin-loader';

/**
 * The processor env var naming the sources whose records are refreshed in place
 * (lambda/shared/source_updates.py): the plugins whose manifest declares
 * `capabilities.updatesItems`. Every loaded plugin counts, enabled or not, as the
 * hard-coded github_issues check did before 6.04.00: records already queued by a
 * plugin that was since disabled are still handled as updates.
 */
const UPDATE_CAPABLE_SOURCES_ENV = 'UPDATE_CAPABLE_SOURCES';

export interface VocProcessingStackProps extends VocStackProps {
  /** VocCoreStack's Event API (core-realtime.ts): job workers publish on `jobs`, the conductor on `runs`. */
  realtime: RealtimePublishing;
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  idempotencyTable: dynamodb.Table;
  /** voc-memory — memory items, events, session cursors, imports. */
  memoryTable: dynamodb.Table;
  /** voc-agents — agents, workflows, runs, run events, crewmate transcripts. */
  agentsTable: dynamodb.Table;
  /** voc-engineering — the engineering bus's board and conversations; VocCoreStack makes it only with -c engineeringAgents=true. */
  engineeringTable?: dynamodb.ITable;
  /** voc-eng-workspace — the engineering runs' findings and reports; VocCoreStack makes it only with -c engineeringAgents=true. */
  engineeringWorkspaceBucket?: s3.IBucket;
  /** voc-radar — the processor routes Radar sources' reviews here; the release scan writes here (docs/radar.md). */
  radarTable: dynamodb.Table;
  /** voc-feature-requests: research reads board requests as a separate evidence source (Query only); the
   *  retention worker de-identifies board rows on an erasure by email. */
  featureRequestsTable: dynamodb.Table;
  /** The memory scanner reads assistant sessions; the extractor reads one. */
  conversationsTable: dynamodb.Table;
  /** The agent conductor re-checks a plan's approver in Cognito (docs/assistant-plan-mode.md). */
  userPool: cognito.IUserPool;
  processingQueue: sqs.Queue;
  kmsKey: kms.Key;
  /** Raw data lake — the category reprocess worker re-reads `raw/*` in raw mode; research keeps its per-job scratch under `scratch/research_jobs/`. */
  rawDataBucket: s3.IBucket;
  // Web search (AgentCore Gateway, deployed in us-east-1 by VocWebSearchStack)
  // — absent when the feature isn't enabled.
  webSearchGatewayUrl?: string;
  webSearchGatewayArn?: string;
  webSearchToolName?: string;
  config: {
    brandName: string;
    primaryLanguage: string;
    enabledSources: string[];
  };
}

/**
 * Base physical name of the category reprocess worker. The settings API (in
 * VocApiStack) builds the same deterministic name for its env var and invoke
 * grant instead of importing the function: no cross-stack export to pin, and
 * the API stack already deploys after this one.
 */
export const CATEGORY_REPROCESS_FUNCTION_BASE_NAME = 'voc-category-reprocess';

// Feedback processor event source (the timeout and batching window live in processor-timing.ts). Pinned by
// processing-stack-consolidated.test.ts.
const PROCESSOR_ENRICHMENT_CONCURRENCY = 5;

/**
 * VocProcessingStack - Consolidated processing and research
 * 
 * Merges: VocProcessingStack + VocResearchStack
 * 
 * Contains:
 * - Feedback processor Lambda (SQS triggered)
 * - Aggregation Lambda (DynamoDB Streams triggered)
 * - Research Step Functions workflow
 * - Research step Lambda
 * - Category reprocess worker (async job started by POST /settings/categories/reprocess)
 * - Retention / erasure worker, voc-retention (daily + POST /settings/erasure; retention-worker.ts)
 * - Memory workers: scanner, memory-extract queue + extractor, retention (memory-workers.ts)
 * - Autonomous-agent runtime: heartbeat, conductor, persona panel, voc-agent-run (agent-runtime.ts)
 * - Only with -c engineeringAgents=true: the engineering agents' connector broker (engineering-broker.ts), and their
 *   bus, inbox router, board API and report builder (engineering-bus.ts), and their AgentCore runtime: the supervisor,
 *   its rule and the agent roles (engineering-runtime.ts)
 */
export class VocProcessingStack extends VocStack {
  public readonly processingLambda: lambda.Function;
  public readonly aggregationLambda: lambda.Function;
  public readonly researchStateMachine: sfn.StateMachine;
  /** Memory extraction queue — the memory API (imports) sends to it from VocApiStack. */
  public readonly memoryExtractQueue: sqs.Queue;
  /** voc-agent-run — the agents API starts/stops executions from VocApiStack. */
  public readonly agentRunStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: VocProcessingStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, projectsTable, jobsTable, idempotencyTable, processingQueue, kmsKey, rawDataBucket, config } = props;


    // Shared Lambda Layer
    const processingLayer = dependencyLayer(this, 'ProcessingDepsLayer', 'lambda/layers/processing-deps',
      'Dependencies for processing lambdas (ARM64/Graviton)');

    // ============================================
    // PROCESSOR + AGGREGATOR ROLES (one each, lib/stacks/processing-roles.ts)
    // ============================================
    const processingRole = createProcessorRole(this, {
      feedbackTable, aggregatesTable, idempotencyTable, radarTable: props.radarTable, processingQueue, kmsKey, rawDataBucket,
    });
    const aggregatorRole = createAggregatorRole(this, { aggregatesTable, idempotencyTable, kmsKey });

    // ============================================
    // FEEDBACK PROCESSOR LAMBDA
    // ============================================
    const processorCode = pythonLambdaAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/aggregator/', '/api/', '/jobs/', '/research/'],
      copy: ['mkdir -p /asset-output', 'cp -r /asset-input/processor/* /asset-output/', 'cp -r /asset-input/shared /asset-output/'],
    });

    this.processingLambda = new lambda.Function(this, 'FeedbackProcessor', {
      functionName: this.uniqueName(FEEDBACK_PROCESSOR_FUNCTION_BASE_NAME),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: processorCode,
      role: processingRole,
      timeout: PROCESSOR_TIMEOUT, // the processing queue's visibility timeout derives from it (processor-timing.ts)
      memorySize: 1769, // CPU: 90.9 % p95 at 1024 MB, projected 60.6 % at 1536 → one vCPU, 2026-10-18 (lib/sizing/policy.ts)
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        PRIMARY_LANGUAGE: config.primaryLanguage,
        ENRICHMENT_CONCURRENCY: String(PROCESSOR_ENRICHMENT_CONCURRENCY),
        // No BEDROCK_MODEL_ID env: the enrichment model resolves through the
        // per-surface AI-model picker (lambda/shared/model_config.py — the
        // 'enrichment' surface defaults to Haiku, admins can override it).
        // Radar sources' reviews (another brand) go here, never to FEEDBACK_TABLE.
        RADAR_TABLE: props.radarTable.tableName,
        // The inline raw_data fallback's bucket and connector-version (lambda/shared/raw_fallback.py).
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        APP_VERSION: appVersion(),
        // Sources refreshed in place (`capabilities.updatesItems` in their manifest; tenet 5).
        [UPDATE_CAPABLE_SOURCES_ENV]: JSON.stringify(
          pluginIdsWithCapability(loadPlugins(path.join(__dirname, '../../plugins')), 'updatesItems')),
        POWERTOOLS_SERVICE_NAME: 'voc-processor',
        POWERTOOLS_IDEMPOTENCY_DISABLED: '0',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ProcessorLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-feedback-processor'),
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Latency to "visible" is batching window + the batch's enrichment time. The
    // window used to be 30 s, which was most of a Manual Import's ~50 s wait (QA
    // 2.13.00); 5 s still gathers a burst into one invocation. Records of a batch
    // are enriched ENRICHMENT_CONCURRENCY at a time (lambda/processor/handler.py).
    this.processingLambda.addEventSource(new lambdaEventSources.SqsEventSource(processingQueue, {
      batchSize: 10,
      maxBatchingWindow: PROCESSOR_BATCHING_WINDOW,
      reportBatchItemFailures: true,
      maxConcurrency: PROCESSOR_MAX_CONCURRENCY,
    }));


    // ============================================
    // AGGREGATION LAMBDA
    // ============================================
    const aggregatorCode = pythonLambdaAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/api/', '/jobs/', '/processor/', '/research/'],
      copy: ['mkdir -p /asset-output', 'cp -r /asset-input/aggregator/* /asset-output/', 'cp -r /asset-input/shared /asset-output/'],
    });

    this.aggregationLambda = new lambda.Function(this, 'AggregationProcessor', {
      functionName: this.uniqueName(AGGREGATOR_FUNCTION_BASE_NAME),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: aggregatorCode,
      role: aggregatorRole,
      timeout: cdk.Duration.minutes(1),
      memorySize: 1536, // CPU: 88.7 % p95 at 512 MB → 1024 2026-10-18; 68.8 % at 1024 MB → 1536 2026-10-23 (lib/sizing/policy.ts)
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // The dedupe marker for one stream record (issue #264). Streams deliver
        // at-least-once and this event source sets `retryAttempts: 3` with
        // `reportBatchItemFailures: true`, so a batch that partially fails
        // re-presents records whose counter updates (one per dimension, plus the
        // running average) already landed — permanently, since nothing recomputes a
        // counter from source. The aggregator claims each record's `eventID` in this
        // table INSIDE the same TransactWriteItems as the counters, so the claim and
        // the counters commit together or not at all.
        //
        // The aggregator's own role holds exactly the PutItem that claim needs
        // (lib/stacks/processing-roles.ts). Absent, the handler logs a
        // warning and applies counters non-transactionally, which is the
        // pre-#264 behaviour rather than an outage.
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-aggregator',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'AggregatorLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-aggregation-processor'),
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Records the stream source gives up on (#253): after `retryAttempts` the
    // batch's failed range is otherwise DROPPED, and a feedback item's counters
    // then never reach the aggregates table. The on-failure destination keeps a
    // pointer to each discarded shard range (shard id + sequence numbers, not the
    // record bodies) so the gap is visible and can be replayed from the stream
    // within its 24 h retention. CMK-encrypted, TLS-only, 14 days like the app's
    // other terminal-failure queues; nothing consumes it, hence no DLQ of its own.
    const aggregatorFailureQueueName = this.uniqueName(AGGREGATOR_STREAM_FAILURES_BASE_NAME);
    const aggregatorFailureQueue = new sqs.Queue(this, 'AggregatorStreamFailures', {
      queueName: aggregatorFailureQueueName,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    acknowledgeNagOnResource(aggregatorFailureQueue, [{
      id: 'AwsSolutions-SQS3',
      reason: 'This queue IS the terminal failure record (a DynamoDB stream event source on-failure destination); nothing consumes it, so it has no DLQ of its own',
    }]);

    this.aggregationLambda.addEventSource(new lambdaEventSources.DynamoEventSource(feedbackTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(30),
      retryAttempts: 3,
      reportBatchItemFailures: true,
      // A FUNCTION error (timeout, crash, or Powertools raising because every
      // record failed) has no partial response to checkpoint on, so without
      // bisection one poison record retries — and finally discards — its whole
      // batch of up to 100 valid records. Bisecting halves the batch on each
      // error until the poison record is isolated; only its range reaches the
      // failure queue. Partial responses still checkpoint as before (#253).
      bisectBatchOnError: true,
      onFailure: new lambdaEventSources.SqsDlq(aggregatorFailureQueue),
    }));

    // ============================================
    // CATEGORY REPROCESS WORKER
    // ============================================
    const reprocessWorker = this.createCategoryReprocessLambda({
      feedbackTable, aggregatesTable, kmsKey, rawDataBucket, processingLayer, primaryLanguage: config.primaryLanguage,
    });
    // A reprocess job's end reaches its starter (shared/reprocess_jobs.py finish_job, docs/realtime.md).
    grantRealtimePublish(props.realtime, 'jobs', [reprocessWorker]);

    // ============================================
    // RETENTION / ERASURE WORKER (docs/source-policies.md)
    // ============================================
    const retentionWorker = createRetentionWorker(this, 'RetentionWorker', {
      uniqueName: (baseName) => this.uniqueName(baseName),
      layer: processingLayer,
      kmsKey,
      feedbackTable,
      aggregatesTable,
      radarTable: props.radarTable,
      projectsTable,
      featureRequestsTable: props.featureRequestsTable,
      rawDataBucket,
    });
    // An erasure job's end reaches the admin who started it (jobs/retention/runs.py, docs/realtime.md): a publish
    // grant (the `jobs` managed policy) and the host only; nothing else on the only customer-data delete role changes (D5).
    grantRealtimePublish(props.realtime, 'jobs', [retentionWorker]);

    // ============================================
    // MEMORY + AUTONOMOUS AGENTS
    // ============================================
    const uniqueName = (baseName: string) => this.uniqueName(baseName);
    const memoryWorkers = new MemoryWorkers(this, 'MemoryWorkers', {
      uniqueName,
      layer: processingLayer,
      kmsKey,
      memoryTable: props.memoryTable,
      conversationsTable: props.conversationsTable,
      aggregatesTable,
      rawDataBucket,
    });
    this.memoryExtractQueue = memoryWorkers.extractQueue;
    grantRealtimePublish(props.realtime, 'jobs', [memoryWorkers.extractor]);
    const agentRuntime = new AgentRuntime(this, 'AgentRuntime', {
      uniqueName,
      layer: processingLayer,
      kmsKey,
      agentsTable: props.agentsTable,
      feedbackTable,
      aggregatesTable,
      rawDataBucket,
      memoryExtractQueue: this.memoryExtractQueue,
      jobsTable,
      userPool: props.userPool,
      realtime: props.realtime,
      webSearchGatewayUrl: props.webSearchGatewayUrl,
      webSearchGatewayArn: props.webSearchGatewayArn,
      webSearchToolName: props.webSearchToolName,
    });
    this.agentRunStateMachine = agentRuntime.stateMachine;
    // The per-user morning brief (docs/briefing.md): idle until someone subscribes or presses Refresh.
    const briefingWorker = createBriefingWorker(this, 'BriefingWorker', {
      uniqueName, layer: processingLayer, kmsKey, feedbackTable, aggregatesTable, memoryTable: props.memoryTable,
      agentsTable: props.agentsTable, projectsTable, radarTable: props.radarTable, userPool: props.userPool,
    });
    // A built brief tells its reader, so Home shows it at once (docs/realtime.md).
    grantRealtimePublish(props.realtime, 'jobs', [briefingWorker]);
    createRadarScanWorker(this, 'RadarScanWorker', {
      uniqueName, layer: processingLayer, kmsKey, radarTable: props.radarTable, aggregatesTable,
      deploymentPrefix: this.deploymentPrefix,
      webSearch: props.webSearchGatewayUrl && props.webSearchGatewayArn && props.webSearchToolName
        ? { url: props.webSearchGatewayUrl, arn: props.webSearchGatewayArn, toolName: props.webSearchToolName }
        : undefined,
    });
    // The engineering agents' connector broker (docs/autonomous-engineering.md): only with -c engineeringAgents=true.
    let peers: EngineeringPeers | undefined;
    if (engineeringAgentsEnabled(this)) {
      const roleNamePattern = this.uniqueNamePattern(ENGINEERING_ROLE_NAME_TEMPLATE);
      if (!props.engineeringTable) throw new Error('engineeringAgents needs VocCoreStack\'s voc-engineering table');
      if (!props.engineeringWorkspaceBucket) {
        throw new Error('engineeringAgents needs VocCoreStack\'s voc-eng-workspace bucket');
      }
      const broker = new EngineeringBroker(this, 'EngineeringBroker', {
        uniqueName, layer: processingLayer, roleNamePattern, kmsKey, deploymentPrefix: this.deploymentPrefix,
        engineeringTable: props.engineeringTable, workspaceBucket: props.engineeringWorkspaceBucket, aggregatesTable,
        agentsTable: props.agentsTable,
      });
      const bus = new EngineeringBus(this, 'EngineeringBus', {
        uniqueName, layer: processingLayer, roleNamePattern, kmsKey, engineeringTable: props.engineeringTable,
        workspaceBucket: props.engineeringWorkspaceBucket,
      });
      peers = {
        deadLetterQueue: bus.dlq, bus: bus.bus, board: bus.board, boardUrl: bus.boardUrl, broker: broker.function,
        brokerUrl: broker.url,
        addPublisher: (statementId, role, source) => bus.addPublisher(statementId, role, source),
      };
    }
    // The engineering agents' runtime (one AgentCore session per agent): only with `-c engineeringAgents=true`
    // (engineering-runtime.ts, engineering-agentcore.ts): its
    // agent roles call the board and the broker and publish on the bus; its supervisor rule's undelivered ticks go to
    // the bus's dead-letter queue.
    addEngineeringRuntime(this, {
      uniqueName, layer: processingLayer, kmsKey, engineeringTable: props.engineeringTable, agentsTable: props.agentsTable,
      rawDataBucket, peers,
      workspaceBucket: props.engineeringWorkspaceBucket,
    });

    // ============================================
    // RESEARCH WORKFLOW (Step Functions)
    // ============================================
    const researchRole = new iam.Role(this, 'ResearchLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    feedbackTable.grantReadData(researchRole);
    // The research document and its job row (Put + Update); the research workflow deletes nothing in DynamoDB.
    grantReadAndWrites(projectsTable, researchRole, ['PutItem', 'UpdateItem']);
    grantReadAndWrites(jobsTable, researchRole, ['PutItem', 'UpdateItem']);
    aggregatesTable.grantReadData(researchRole);
    kmsKey.grantEncryptDecrypt(researchRole);
    // Board requests as a separate evidence source (opt-in per research job, read-only).
    grantFeatureRequestEvidenceRead(props.featureRequestsTable, researchRole);
    // The per-job feedback block (claim-check: too large for Step Functions state).
    rawDataBucket.grantReadWrite(researchRole, 'scratch/research_jobs/*');

    // Research is a 'documents' surface (defaults to Sonnet 5) and is
    // repointable via the picker, so grant every allowlisted model (issue #96).
    grantClaudeModels(researchRole, 'invoke');

    // Same lambda/-rooted staging as processor/aggregator: root-based staging
    // hashed the entire CDK project (scripts/, schemas/, coverage output...)
    // into this asset, redeploying it on every unrelated edit.
    const researchCode = pythonLambdaAsset('lambda', {
      // research_step_handler reads api/prompts/research-analysis.json at RUNTIME,
      // so the prompts must be BOTH copied into the bundle (the cp below) and kept
      // in the asset FINGERPRINT (this per-entry exclude) — otherwise editing the
      // config would not change the hash and the Lambda would keep the old budgets.
      // Only prompts are re-included, so api/*.py edits can't churn this hash.
      exclude: [
        ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
        '/aggregator/',
        '/api/*',
        '!/api/prompts',
        '/jobs/',
        '/processor/',
      ],
      copy: [
        'mkdir -p /asset-output',
        'cp -r /asset-input/research/* /asset-output/',
        'cp -r /asset-input/shared /asset-output/',
        // INVARIANT: prompts land at the bundle ROOT (/var/task/prompts) —
        // shared/prompts.py::get_prompts_dir resolves that path first. Same
        // staging contract as the api-stack bundles.
        'cp -r /asset-input/api/prompts /asset-output/prompts',
      ],
    });

    const researchStepLambda = new lambda.Function(this, 'ResearchStepLambda', {
      functionName: this.uniqueName('voc-research-step'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'research_step_handler.lambda_handler',
      code: researchCode,
      role: researchRole,
      timeout: cdk.Duration.minutes(15),
      // Raised for CPU (lib/sizing/policy.ts RAISED_FOR_CPU): 66.2 % p95 at 1536 MB, 2026-10-18 → one vCPU.
      memorySize: 1769,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        // Needed so the per-surface AI-model picker ('documents') can resolve
        // an admin override for research generation (issue #96).
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // Scratch home of the per-job feedback block (research_step_handler).
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        [FEATURE_REQUESTS_TABLE_ENV]: props.featureRequestsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-research-step',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ResearchStepLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-research-step'),
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // The research job's end reaches its starter (docs/realtime.md).
    grantRealtimePublish(props.realtime, 'jobs', [researchStepLambda]);

    grantSharedMemoryRecall(researchStepLambda, researchRole, { memoryTable: props.memoryTable, kmsKey, region: this.region });

    // Step Functions workflow
    this.researchStateMachine = createResearchStateMachine(this, (baseName) => this.uniqueName(baseName), researchStepLambda);

    // ============================================
    // WEB SEARCH (AgentCore Gateway — see VocWebSearchStack)
    // ============================================
    // Opt-in per research request; without the gateway the env vars stay
    // unset and step_initialize skips web grounding.
    const { webSearchGatewayUrl, webSearchGatewayArn, webSearchToolName } = props;
    if (webSearchGatewayUrl && webSearchGatewayArn && webSearchToolName) {
      researchStepLambda.addEnvironment('WEB_SEARCH_GATEWAY_URL', webSearchGatewayUrl);
      researchStepLambda.addEnvironment('WEB_SEARCH_TOOL_NAME', webSearchToolName);
      researchStepLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [webSearchGatewayArn],
      }));
    }

    // ============================================
    // OUTPUTS
    // ============================================
    new cdk.CfnOutput(this, 'ProcessorFunctionArn', { value: this.processingLambda.functionArn });
    new cdk.CfnOutput(this, 'AggregatorFunctionArn', { value: this.aggregationLambda.functionArn });
    new cdk.CfnOutput(this, 'ResearchStateMachineArn', { value: this.researchStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'ResearchStepLambdaArn', { value: researchStepLambda.functionArn });
    new cdk.CfnOutput(this, 'AgentRunStateMachineArn', { value: this.agentRunStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'MemoryExtractQueueUrl', { value: this.memoryExtractQueue.queueUrl });
  }

  /**
   * The category reprocess worker: re-categorises stored feedback in place after
   * the category configuration changes (lambda/jobs/category_reprocess). Scans
   * voc-feedback page by page, checkpoints the job row in aggregates, and hands
   * over to a fresh async invocation of ITSELF before its 15-minute ceiling.
   *
   * Least privilege — no DeleteItem/PutItem on feedback (items are only ever
   * UPDATEd in place), raw bucket read limited to `raw/*`.
   */
  private createCategoryReprocessLambda(deps: {
    feedbackTable: dynamodb.Table;
    aggregatesTable: dynamodb.Table;
    kmsKey: kms.Key;
    rawDataBucket: s3.IBucket;
    processingLayer: lambda.ILayerVersion;
    primaryLanguage: string;
  }): lambda.Function {
    const functionName = this.uniqueName(CATEGORY_REPROCESS_FUNCTION_BASE_NAME);
    const role = new iam.Role(this, 'CategoryReprocessRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // A slice by source is a Scan filtered on source_platform (shared/reprocess_slices.py): no Query.
    deps.feedbackTable.grant(role, 'dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    // Category config + model-picker override (GetItem); the job row and its
    // lock are only ever UPDATEd by the worker (claim, checkpoint, finish,
    // release). Creating jobs (PutItem) and the latest-job lookup (Query) are
    // the settings API's, not the worker's.
    deps.aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    deps.rawDataBucket.grantRead(role, 'raw/*');
    // The item as it was before each reprocess update (lambda/shared/silver_provenance.py): write-once Put only.
    grantSilverHistoryPut(deps.rawDataBucket, role);
    deps.kmsKey.grantEncryptDecrypt(role);
    // 'enrichment'/'utilities' surfaces are repointable via the picker (issue #96).
    grantClaudeModels(role, 'invoke');
    grantTextAnalysis(role, ['comprehend:DetectSentiment', 'comprehend:DetectDominantLanguage']);
    // Self hand-over: a deterministic ARN, not `fn.grantInvoke(role)` — the
    // function depends on its role, so a role policy GetAtt-ing the function
    // would be a CloudFormation cycle (same pattern as the api-stack job Lambdas).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SelfInvoke',
      actions: ['lambda:InvokeFunction'],
      resources: [this.formatArn({ service: 'lambda', resource: 'function', resourceName: functionName, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
    }));

    const code = pythonLambdaAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/aggregator/', '/api/', '/processor/', '/research/', '/jobs/retention/'],
      copy: ['mkdir -p /asset-output', 'cp /asset-input/jobs/category_reprocess/handler.py /asset-output/', 'cp -r /asset-input/shared /asset-output/'],
    });

    return new lambda.Function(this, 'CategoryReprocessWorker', {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code,
      role,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      // Async-invoked; a hidden re-drive would re-pay a page of model calls and
      // race the checkpoint. The job row records failures for the UI instead.
      retryAttempts: 0,
      environment: {
        FEEDBACK_TABLE: deps.feedbackTable.tableName,
        AGGREGATES_TABLE: deps.aggregatesTable.tableName,
        RAW_DATA_BUCKET: deps.rawDataBucket.bucketName,
        // The Silver contract's pipeline_version (lambda/shared/silver_provenance.py).
        APP_VERSION: appVersion(),
        PRIMARY_LANGUAGE: deps.primaryLanguage,
        POWERTOOLS_SERVICE_NAME: CATEGORY_REPROCESS_FUNCTION_BASE_NAME,
        LOG_LEVEL: 'INFO',
      },
      layers: [deps.processingLayer],
      logGroup: new logs.LogGroup(this, 'CategoryReprocessLogs', {
        logGroupName: this.uniqueName(`/aws/lambda/${CATEGORY_REPROCESS_FUNCTION_BASE_NAME}`),
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  }
}
