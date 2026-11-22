/**
 * The voice personas' relay (7.69.00, VocProcessingStack, with `-c voicePersonas=true` only): one Amazon Bedrock
 * AgentCore Runtime, `voc_persona_voice`, that holds a browser's WebSocket and Nova Sonic's bidirectional stream for
 * one conversation (docs/voice-personas.md). Nothing of it exists without the flag (lib/utils/voice-personas.ts).
 *
 * - Direct code, not a container (the S-15 spike): a ZIP of the stream package's `src/voice/main.ts` bundled by
 *   esbuild into `relay.js`, run on AgentCore's `NODE_22` (arm64), from the CDK assets bucket. No ECR repository, no
 *   image to push, sessions created at AgentCore's 25 a second, the language runtime patched by AWS. The bundle holds
 *   its WebSocket server, `ws` (docs/dependencies.md), without the two native add-ons ws only tries to load
 *   (`bufferutil`, `utf-8-validate`: external and never installed, so ws runs its JavaScript fallbacks).
 * - Network mode PUBLIC: no VPC, no NAT gateway, no endpoint (tenet 7). The container is reachable only through
 *   AgentCore's own endpoint, which authenticates every request with SigV4: the browser's URL is presigned for 60 s by
 *   the projects API (lambda/shared/voice_sessions.py) for one session id and one project, both signed.
 * - One session (microVM) per conversation: it ends after 2 minutes without a frame (`IdleRuntimeSessionTimeout`)
 *   and at 20 minutes in any case (`MaxLifetime`, above the 15-minute session cap). Billed per second while a session
 *   lives, about $0.001 a minute; nothing between sessions, so no fixed cost.
 * - The custom header AgentCore forwards: only the signed project scope.
 *
 * The execution role (exact; lib/stacks/voice-relay.test.ts pins every statement and the negative pins):
 * - `bedrock:InvokeModel` on the one Nova Sonic model ARN in the deployment's Region (the action that authorizes
 *   `InvokeModelWithBidirectionalStream`; there is no other): no stream invoke, no profile, no other model;
 * - `dynamodb:UpdateItem` on voc-projects, held by `dynamodb:LeadingKeys` to `VOICE#*` (a session's own partition,
 *   never a project's) and by `dynamodb:Attributes` to the session row's status and meter: no read, put or delete;
 * - `dynamodb:UpdateItem` on voc-aggregates, held to `VOICEUSE#*` (the month's minutes and the live set);
 * - `s3:GetObject` on a session's `scratch/voice/<session>/evidence.json` and `s3:PutObject` on its
 *   `scratch/voice/<session>/transcript/` parts in the raw bucket
 *   (the scratch prefix expires after 2 days): no list, no delete, nothing outside them;
 * - the stack key's Decrypt and GenerateDataKey, only through DynamoDB and S3; its runtime's own log groups.
 * Nothing on the feedback table, SSM, Secrets Manager, Lambda, ECR or `bedrock-agentcore:*`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

import { agentCoreTrust, grantRuntimeLogs } from '../utils/agentcore-trust';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { agentCoreName, DeploymentNaming } from '../utils/naming';
import { VOICE_SCRATCH_PREFIX, type VoiceSettings, voiceModelArn, voiceSettings } from '../utils/voice-personas';
import { grantKeyThrough } from './engineering-bus';

/** The stream package, whose `src/voice/` the relay is (it shares the persona prompt and the citation rule). */
const STREAM_ROOT = path.join(__dirname, '../../lambda/stream');
const ENTRY = 'src/voice/main.ts';
const BUNDLE = 'relay.js';
const ESBUILD = path.join(__dirname, '../../node_modules/.bin/esbuild');
/** What the bundle is built with: one CommonJS file for Node 22, every dependency inside it but ws's optional add-ons. */
const ESBUILD_ARGS = [
  ENTRY, '--bundle', '--platform=node', '--target=node22', '--format=cjs', '--legal-comments=none',
  '--external:bufferutil', '--external:utf-8-validate',
];

/** The relay's session lifecycle (seconds): idle without a frame, and the longest life (the session cap is 15 min). */
const VOICE_IDLE_TIMEOUT_SECONDS = 120;
const VOICE_MAX_LIFETIME_SECONDS = 1200;
/** The only custom header AgentCore forwards to the container (the projects API signs it into the URL). */
const VOICE_SCOPE_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Voc-Scope';
/** The session row's attributes the relay may write (contract: status, meter, transcript count). */
const VOICE_SESSION_ATTRIBUTES = [
  'pk', 'sk', 'status', 'connected_at', 'ended_at', 'end_reason', 'seconds', 'tokens', 'cost_microusd',
  'transcript_parts', 'streams', 'connect_by',
] as const;
/** The month's usage row and the live set's attributes it may write. */
const VOICE_USAGE_ATTRIBUTES = ['pk', 'sk', 'seconds', 'cost_microusd', 'live', 'updated_at'] as const;

/** What the relay reads and writes (VocCoreStack's), and the deployment's prefix for its runtime's name. */
export interface VoiceRelayResources {
  readonly deploymentPrefix?: string;
  readonly projectsTable: dynamodb.ITable;
  readonly aggregatesTable: dynamodb.ITable;
  readonly rawDataBucket: s3.IBucket;
  readonly kmsKey: kms.IKey;
}

interface VoiceRelayProps extends VoiceRelayResources {
  readonly settings: VoiceSettings;
}

/** Bundle the relay with the CDK app's own esbuild; false (Docker's turn) when it is not installed. */
function bundleLocally(outputDir: string): boolean {
  if (!existsSync(ESBUILD)) return false;
  const result = spawnSync(ESBUILD, [...ESBUILD_ARGS, `--outfile=${path.join(outputDir, BUNDLE)}`],
    { cwd: STREAM_ROOT, stdio: 'inherit' });
  return result.status === 0;
}

function relayCode(scope: Construct): s3assets.Asset {
  return new s3assets.Asset(scope, 'RelayCode', {
    path: STREAM_ROOT,
    exclude: ['node_modules', 'coverage', 'reports', '.stryker-tmp', '**/*.test.ts'],
    bundling: {
      local: { tryBundle: bundleLocally },
      image: lambda.Runtime.NODEJS_22_X.bundlingImage,
      command: ['bash', '-c', `npm ci --ignore-scripts --no-audit --no-fund && npx esbuild ${ESBUILD_ARGS.join(' ')} --outfile=/asset-output/${BUNDLE}`],
    },
  });
}

class VoiceRelay extends Construct {
  /** The runtime's ARN: the projects API presigns its WebSocket URL and stops its sessions. */
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: VoiceRelayProps) {
    super(scope, id);
    const naming = new DeploymentNaming(cdk.Stack.of(this), props.deploymentPrefix);
    const name = agentCoreName(naming.uniqueName('voc_persona_voice'));
    const role = this.executionRole(props, name);
    const code = relayCode(this);
    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: name,
      description: 'Voice personas: relays one conversation between a browser and Amazon Nova Sonic (no audio stored)',
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          entryPoint: [BUNDLE],
          runtime: 'NODE_22',
        },
      },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: VOICE_IDLE_TIMEOUT_SECONDS, maxLifetime: VOICE_MAX_LIFETIME_SECONDS,
      },
      requestHeaderConfiguration: { requestHeaderAllowlist: [VOICE_SCOPE_HEADER] },
      environmentVariables: {
        VOICE_MODEL_ID: props.settings.modelId,
        VOICE_REGION: cdk.Stack.of(this).region,
        PROJECTS_TABLE: props.projectsTable.tableName,
        AGGREGATES_TABLE: props.aggregatesTable.tableName,
        RAW_DATA_BUCKET: props.rawDataBucket.bucketName,
      },
      platformVersion: 'V2',
    });
    // The role's policy first: the service may check the role when the runtime is made.
    const policy = role.node.tryFindChild('DefaultPolicy');
    if (policy !== undefined) runtime.node.addDependency(policy);
    this.runtimeArn = runtime.attrAgentRuntimeArn;
  }

  private executionRole(props: VoiceRelayProps, runtimeName: string): iam.Role {
    const stack = cdk.Stack.of(this);
    const role = new iam.Role(this, 'Role', {
      assumedBy: agentCoreTrust(stack),
      description: 'Voice personas relay: one Nova Sonic model, its session rows, its scratch files and its logs',
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SpeakWithNovaSonic', actions: ['bedrock:InvokeModel'],
      resources: [voiceModelArn(stack, props.settings.modelId)],
    }));
    role.addToPolicy(keyScopedUpdate('TheSessionRow', props.projectsTable, 'VOICE#*', VOICE_SESSION_ATTRIBUTES));
    role.addToPolicy(keyScopedUpdate('TheVoiceUsage', props.aggregatesTable, 'VOICEUSE#*', VOICE_USAGE_ATTRIBUTES));
    const evidence = props.rawDataBucket.arnForObjects(`${VOICE_SCRATCH_PREFIX}*/evidence.json`);
    const transcript = props.rawDataBucket.arnForObjects(`${VOICE_SCRATCH_PREFIX}*/transcript/*`);
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ReadTheEvidence', actions: ['s3:GetObject'], resources: [evidence] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteTheTranscript', actions: ['s3:PutObject'], resources: [transcript] }));
    grantKeyThrough(role, props.kmsKey, ['dynamodb', 's3']);
    const logs = grantRuntimeLogs(role, `${runtimeName}-*`);
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'Every session has its own id: the scratch keys and the session and usage partitions are named by it '
        + '(the DynamoDB statements are held by dynamodb:LeadingKeys and dynamodb:Attributes); the log groups are the '
        + 'one runtime\'s own, which the service names by its generated id',
      findings: [evidence, transcript, ...logs].map(resourceFinding),
    }]);
    return role;
  }
}

/**
 * The relay in VocProcessingStack with `-c voicePersonas=true` (its settings checked: lib/utils/voice-personas.ts),
 * and its runtime's ARN for VocApiStack; nothing and `undefined` without the flag. Called by bin/voc-datalake.ts on
 * the processing stack, after it is built.
 */
export function addVoiceRelay(stack: cdk.Stack, resources: VoiceRelayResources): string | undefined {
  const settings = voiceSettings(stack);
  if (settings === undefined) return undefined;
  return new VoiceRelay(stack, 'VoiceRelay', { ...resources, settings }).runtimeArn;
}

/** UpdateItem on `table`, only on partitions `leading` names and only for `attributes`, answering nothing back that
 *  the request did not set (`UPDATED_NEW` at most). */
function keyScopedUpdate(sid: string, table: dynamodb.ITable, leading: string,
  attributes: readonly string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid, actions: ['dynamodb:UpdateItem'], resources: [table.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [leading] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...attributes] },
      'StringEqualsIfExists': { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_NEW'] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    },
  });
}
