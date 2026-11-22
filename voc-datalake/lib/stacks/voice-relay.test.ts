/**
 * The voice personas (7.69.00, -c voicePersonas=true; lib/stacks/voice-relay.ts, lib/utils/voice-personas.ts):
 * off by default (nothing in any stack, the SPA's headers unchanged), and with the flag one AgentCore Runtime of
 * direct code in PUBLIC mode whose role is pinned EXACTLY, statement by statement, with its negative pins; the
 * projects role's presign and stop grants on that runtime alone, with no new VocApiStack resource; the CSP and the
 * Permissions-Policy; and every synth refusal (Region, model id, minutes, a companion setting without the flag).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { pkSkTable } from '../test-support/api-stack-fixture';
import { synthApiTemplate } from '../test-support/api-stack-template';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { fixtureBucket } from '../test-support/fixture-resources';
import { itemAt } from '../test-support/guards';
import { IamPolicySchema } from '../test-support/iam-statements';
import type { IamStatement } from '../test-support/iam-statements';
import { attachedStatements } from '../test-support/worker-function';
import { VOICE_REGIONS, voiceSettings } from '../utils/voice-personas';
import { addVoiceRelay } from './voice-relay';

const ON = { voicePersonas: 'true' };
const RUNTIME_TYPE = 'AWS::BedrockAgentCore::Runtime';

const RuntimeSchema = z.object({ Properties: z.object({
  AgentRuntimeName: z.string(),
  AgentRuntimeArtifact: z.object({ CodeConfiguration: z.object({ EntryPoint: z.array(z.string()), Runtime: z.string() }) }),
  NetworkConfiguration: z.object({ NetworkMode: z.string() }),
  LifecycleConfiguration: z.object({ IdleRuntimeSessionTimeout: z.number(), MaxLifetime: z.number() }),
  RequestHeaderConfiguration: z.object({ RequestHeaderAllowlist: z.array(z.string()) }),
  EnvironmentVariables: z.record(z.string(), z.unknown()),
  RoleArn: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }),
}) });
type Statement = IamStatement;

function voiceRuntimes(template: Template): z.infer<typeof RuntimeSchema>[] {
  return Object.values(template.findResources(RUNTIME_TYPE)).map((resource) => RuntimeSchema.parse(resource))
    .filter((runtime) => runtime.Properties.AgentRuntimeName.includes('persona_voice'));
}

/** The role's statements as written, without the audit-row guard's Denies. */
const roleStatements = (template: Template, roleId: string): Statement[] => attachedStatements(template, roleId);

const text = (value: unknown): string => JSON.stringify(value);

/** The relay as bin/voc-datalake.ts adds it to VocProcessingStack, on a stack of its own with VocCoreStack's kinds of
 *  table, bucket and key; its ARN (or undefined) and the stack's template. */
function synthRelay(context: Record<string, unknown>): { arn: string | undefined; template: Template } {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new cdk.Stack(app, 'Relay', { env: { account: '111111111111', region: 'us-east-1' } });
  const kmsKey = new kms.Key(stack, 'Key');
  const arn = addVoiceRelay(stack, {
    projectsTable: pkSkTable(stack, 'Projects'), aggregatesTable: pkSkTable(stack, 'Aggregates'),
    rawDataBucket: fixtureBucket(stack, 'Raw'), kmsKey,
  });
  return { arn, template: Template.fromStack(stack) };
}

describe('voice personas off (the default)', () => {
  it('builds no relay, no voice grant and no voice output', () => {
    const relay = synthRelay({});
    expect([relay.arn, Object.keys(relay.template.findResources(RUNTIME_TYPE))]).toStrictEqual([undefined, []]);
    const api = synthApiTemplate();
    expect(text(api.toJSON())).not.toContain('bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream');
    expect(Object.keys(api.toJSON().Outputs ?? {})).not.toContain('VoiceAvailable');
  });

  it('leaves the SPA without the microphone and without the AgentCore host', () => {
    const core = text(synthCoreTemplate().findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(core).not.toContain('bedrock-agentcore');
    expect(core).not.toContain('microphone=(self)');
  });
});

describe('voice personas on: the relay', () => {
  let template: Template;
  let statements: Statement[];
  beforeAll(() => {
    ({ template } = synthRelay(ON));
    const runtime = itemAt(voiceRuntimes(template), 0);
    statements = roleStatements(template, runtime.Properties.RoleArn['Fn::GetAtt'][0]);
  });

  it('is one runtime of direct Node code in PUBLIC mode with a short lifecycle', () => {
    const runtimes = voiceRuntimes(template);
    expect(runtimes).toHaveLength(1);
    const { Properties: props } = itemAt(runtimes, 0);
    expect([props.AgentRuntimeArtifact.CodeConfiguration, props.NetworkConfiguration, props.LifecycleConfiguration])
      .toStrictEqual([{ EntryPoint: ['relay.js'], Runtime: 'NODE_22' }, { NetworkMode: 'PUBLIC' },
        { IdleRuntimeSessionTimeout: 120, MaxLifetime: 1200 }]);
    expect(props.RequestHeaderConfiguration.RequestHeaderAllowlist)
      .toStrictEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Voc-Scope']);
  });

  it('runs no container: no ECR repository, image or VPC', () => {
    expect(Object.keys(template.findResources('AWS::ECR::Repository'))).toStrictEqual([]);
    expect(text(voiceRuntimes(template))).not.toMatch(/ContainerConfiguration|NetworkModeConfig/);
  });

  it('names the model, Region, tables and bucket in its environment', () => {
    const env = itemAt(voiceRuntimes(template), 0).Properties.EnvironmentVariables;
    expect(Object.keys(env).sort((a, b) => a.localeCompare(b, 'en'))).toStrictEqual(
      ['AGGREGATES_TABLE', 'PROJECTS_TABLE', 'RAW_DATA_BUCKET', 'VOICE_MODEL_ID', 'VOICE_REGION']);
    expect([env.VOICE_MODEL_ID, env.VOICE_REGION]).toStrictEqual(['amazon.nova-2-5-sonic', 'us-east-1']);
  });

  it('holds exactly its seven statements', () => {
    expect(statements.map((statement) => [statement.Sid ?? '', [statement.Action].flat()])).toStrictEqual([
      ['SpeakWithNovaSonic', ['bedrock:InvokeModel']],
      ['TheSessionRow', ['dynamodb:UpdateItem']],
      ['TheVoiceUsage', ['dynamodb:UpdateItem']],
      ['ReadTheEvidence', ['s3:GetObject']],
      ['WriteTheTranscript', ['s3:PutObject']],
      ['', ['kms:Decrypt', 'kms:GenerateDataKey']],
      ['RuntimeLogs', ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']],
    ]);
  });

  it('invokes the one Nova Sonic model in its own Region, nothing else', () => {
    const bedrock = statements.filter((statement) => text(statement.Action).includes('bedrock'));
    expect(bedrock.map((statement) => statement.Resource))
      .toStrictEqual([{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:us-east-1::foundation-model/amazon.nova-2-5-sonic']] }]);
    expect(text(statements)).not.toMatch(/InvokeModelWithResponseStream|inference-profile|bedrock-agentcore:/);
  });

  it('updates only a session partition and the voice usage rows, only their listed attributes', () => {
    const [session, usage] = ['TheSessionRow', 'TheVoiceUsage'].map((sid) => statements.find((s) => s.Sid === sid)?.Condition);
    expect(session).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['VOICE#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'status', 'connected_at', 'ended_at',
        'end_reason', 'seconds', 'tokens', 'cost_microusd', 'transcript_parts', 'streams', 'connect_by'] },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_NEW'] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    });
    expect(text(usage)).toContain('"dynamodb:LeadingKeys":["VOICEUSE#*"]');
    expect(text(usage)).toContain('"dynamodb:Attributes":["pk","sk","seconds","cost_microusd","live","updated_at"]');
  });

  it('reads only a session\'s evidence and writes only its transcript parts in scratch/', () => {
    const s3 = statements.filter((statement) => text(statement.Action).includes('s3:'));
    expect(s3.map((statement) => text(statement.Resource))).toStrictEqual([
      expect.stringContaining('/scratch/voice/*/evidence.json"'), expect.stringContaining('/scratch/voice/*/transcript/*"')]);
    expect(text(statements)).not.toMatch(/s3:(DeleteObject|ListBucket)|dynamodb:(GetItem|PutItem|Query|Scan|DeleteItem|BatchWriteItem)/);
  });

  it('never reaches the feedback table, SSM, secrets, Lambda, ECR or another project\'s rows', () => {
    const all = text(statements);
    expect(all).not.toMatch(/Feedback|ssm:|secretsmanager:|lambda:|ecr:|PROJECT#/);
    expect(all).not.toContain('"Resource":"*"');
  });
});

describe('voice personas on: the projects API and the SPA', () => {
  let api: Template;
  beforeAll(() => { api = synthApiTemplate(ON); });

  it('presigns and stops sessions of the relay runtime alone', () => {
    const voice = Object.values(api.findResources('AWS::IAM::Policy')).map((resource) => IamPolicySchema.parse(resource))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement).filter((statement) => statement.Sid === 'VoiceSessions');
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/voc_persona_voice-Fixture000';
    expect(voice.map((statement) => [statement.Action, statement.Resource])).toStrictEqual([[
      ['bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream', 'bedrock-agentcore:StopRuntimeSession'],
      [arn, `${arn}/runtime-endpoint/DEFAULT`]]]);
  });

  it('hands the projects API and its assist twin the voice settings in one variable', () => {
    const settings = Object.values(api.findResources('AWS::Lambda::Function'))
      .filter((fn) => text(fn).includes('projects_handler.lambda_handler'))
      .map((fn) => text(z.object({ Properties: z.object({ Environment: z.object({
        Variables: z.record(z.string(), z.unknown()) }) }) }).parse(fn).Properties.Environment.Variables.VOICE_PERSONAS));
    expect(settings).toHaveLength(2);
    expect(new Set(settings).size).toBe(1);
    expect(itemAt(settings, 0)).toMatch(/runtime_arn.*voc_persona_voice-Fixture000.*model_id.*amazon\.nova-2-5-sonic.*monthly_minutes.*300.*session_minutes.*15.*max_concurrent.*8/);
  });

  it('adds no VocApiStack resource (the 425 ceiling) and outputs VoiceAvailable', () => {
    expect(Object.keys(api.toJSON().Resources)).toHaveLength(Object.keys(synthApiTemplate().toJSON().Resources).length);
    expect(api.toJSON().Outputs?.VoiceAvailable?.Value).toBe('true');
  });

  it('allows the microphone on the SPA\'s own origin and connects to the AgentCore host, the widget unchanged', () => {
    const policies = synthCoreTemplate(ON).findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const spa = text(Object.entries(policies).find(([id]) => id.startsWith('SecurityHeadersPolicy'))?.[1]);
    const widget = text(Object.entries(policies).find(([id]) => id.startsWith('WidgetHeadersPolicy'))?.[1]);
    expect(spa).toContain('microphone=(self)');
    expect(spa).toMatch(/connect-src [^;]*wss:\/\/bedrock-agentcore\.us-east-1\.amazonaws\.com;/);
    expect(widget).toContain('microphone=()');
  });
});

describe('the synth refuses what the relay could not honour', () => {
  const settingsIn = (region: string, context: Record<string, unknown> = {}) => () => voiceSettings(
    new cdk.Stack(new cdk.App({ context: { ...ON, ...context } }), 'S', { env: { account: '111111111111', region } }));

  it('takes the four Regions with the model and refuses an EU deployment\'s', () => {
    for (const region of VOICE_REGIONS) expect(settingsIn(region)()?.modelId).toBe('amazon.nova-2-5-sonic');
    expect(settingsIn('eu-central-1')).toThrow(/us-east-1, us-west-2, eu-north-1, ap-northeast-1/);
    expect(settingsIn('eu-west-1')).toThrow(/eu-west-1/);
  });

  it('takes Nova 2 Sonic as a pin and refuses any other id or a profile', () => {
    expect(settingsIn('us-west-2', { voiceModelId: 'amazon.nova-2-sonic-v1:0' })()?.modelId).toBe('amazon.nova-2-sonic-v1:0');
    expect(settingsIn('us-west-2', { voiceModelId: 'us.amazon.nova-2-5-sonic' })).toThrow(/voiceModelId/);
    expect(settingsIn('us-west-2', { voiceModelId: 'amazon.nova-sonic-v1:0' })).toThrow(/voiceModelId/);
  });

  it('keeps the approved defaults and bounds the minutes', () => {
    expect(settingsIn('us-west-2')()).toStrictEqual(
      { modelId: 'amazon.nova-2-5-sonic', monthlyMinutes: 300, sessionMinutes: 15, maxConcurrent: 8 });
    expect(settingsIn('us-west-2', { voiceSessionMinutes: '16' })).toThrow(/voiceSessionMinutes must be from 1 to 15/);
    expect(settingsIn('us-west-2', { voiceMaxConcurrent: '21' })).toThrow(/voiceMaxConcurrent/);
    expect(settingsIn('us-west-2', { voiceMonthlyMinutes: '0' })).toThrow(/voiceMonthlyMinutes/);
  });

  it('refuses a companion setting without the flag', () => {
    const stack = new cdk.Stack(new cdk.App({ context: { voiceMonthlyMinutes: '60' } }), 'S', { env: { region: 'us-west-2' } });
    expect(() => voiceSettings(stack)).toThrow(/voiceMonthlyMinutes need -c voicePersonas=true/);
  });
});
