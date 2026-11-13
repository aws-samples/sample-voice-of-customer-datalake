import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { count, functionEnv, policyText, runtimeStack, supervisorEnv } from '../test-support/engineering-runtime-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { DEFAULT_RATES, IDLE_TIMEOUT_SECONDS, MAX_LIFETIME_SECONDS } from './engineering-agentcore';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const byName = (a: string, b: string): number => a.localeCompare(b, 'en');
const NETWORK = { vpcId: 'vpc-0abc1234def567890', subnetIds: ['subnet-0abc1234def567890', 'subnet-0123456789abcdef0'] };
/** Two languages with an image, in a network: their runtimes, the build ones included. */
const WITH_RUNTIMES = {
  engineeringAgents: 'true', engineeringImages: { python: DIGEST, rust: 'v7' }, engineeringAgentNetwork: NETWORK,
};

const RuntimeSchema = z.object({
  Properties: z.looseObject({
    AgentRuntimeName: z.string(),
    AgentRuntimeArtifact: z.object({ ContainerConfiguration: z.object({ ContainerUri: z.unknown() }) }),
    ResourceConfigurations: z.array(z.object({ MinimumMemoryInMiB: z.number() })).optional(),
  }),
});

/** The template's AgentCore runtimes, by name. */
function runtimes(template: Template): Map<string, z.infer<typeof RuntimeSchema>['Properties']> {
  return new Map(Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))
    .map((resource) => RuntimeSchema.parse(resource).Properties)
    .map((properties) => [properties.AgentRuntimeName, properties]));
}

/** The actions of the statement `sid` in the policies of the role whose logical id contains `roleId`. */
function actionsOf(template: Template, roleId: string, sid: string): unknown {
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) },
  });
  return Object.values(policies)
    .flatMap((policy) => z.array(z.looseObject({ Sid: z.string().optional(), Action: z.unknown() }))
      .parse(policy.Properties?.PolicyDocument?.Statement))
    .find((statement) => statement.Sid === sid)?.Action;
}

describe('the agents\' sessions on AgentCore Runtime (-c engineeringAgents=true)', () => {
  let bare: Template;
  let wired: Template;
  beforeAll(() => {
    bare = runtimeStack({ engineeringAgents: 'true' }).template;
    wired = runtimeStack(WITH_RUNTIMES).template;
  }, SYNTH_TIMEOUT_MS);

  it('makes one image repository per language, scanned, immutable, expiring only untagged images; and no runtime yet', () => {
    expect(count(bare, 'AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true }, ImageTagMutability: 'IMMUTABLE',
    })).toBe(4);
    expect(count(bare, 'AWS::ECR::Repository', { RepositoryName: 'voc-eng-rust' })).toBe(1);
    // Only untagged images expire: a runtime's pinned tag (or a tagged image's digest) is never deleted under it.
    const rules = JSON.stringify(bare.findResources('AWS::ECR::Repository'));
    expect([rules.includes('\\"tagStatus\\":\\"untagged\\"'), rules.includes('\\"tagStatus\\":\\"any\\"')]).toStrictEqual([true, false]);
    expect([count(bare, 'AWS::BedrockAgentCore::Runtime'), count(bare, 'AWS::EC2::SecurityGroup')]).toStrictEqual([0, 0]);
  });

  it('runs every agent at the default size and the roles that build and test on a runtime that bursts to 32 GB', () => {
    const made = runtimes(wired);
    expect([...made.keys()].sort(byName)).toStrictEqual(
      ['voc_eng_python', 'voc_eng_python_build', 'voc_eng_rust', 'voc_eng_rust_build']);
    expect(made.get('voc_eng_python')?.ResourceConfigurations).toBeUndefined();
    expect(made.get('voc_eng_rust_build')?.ResourceConfigurations).toStrictEqual([{ MinimumMemoryInMiB: 8192 }]);
    expect(JSON.parse(String(supervisorEnv(wired).ENGINEERING_BUILD_ROLES))).toStrictEqual(['gate-runner']);
  });

  it('runs platform version V2 over HTTP, ends an idle session after an hour and every session at 8 hours', () => {
    expect(count(wired, 'AWS::BedrockAgentCore::Runtime', {
      PlatformVersion: 'V2', ProtocolConfiguration: 'HTTP',
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 3600, MaxLifetime: 28800 },
    })).toBe(4);
    expect([IDLE_TIMEOUT_SECONDS, MAX_LIFETIME_SECONDS]).toStrictEqual([3600, 8 * 3600]);
  });

  it('runs the image named for its language, by digest or by tag, from its own repository', () => {
    const uri = (name: string) => JSON.stringify(runtimes(wired).get(name)?.AgentRuntimeArtifact);
    expect(uri('voc_eng_python')).toMatch(new RegExp(`PythonImages.*@${DIGEST}`));
    expect(uri('voc_eng_rust_build')).toMatch(/RustImages.*:v7/);
  });

  it('runs every session in the deployment\'s subnets, behind a group that lets nothing in and only 443 out', () => {
    expect(count(wired, 'AWS::BedrockAgentCore::Runtime', {
      NetworkConfiguration: { NetworkMode: 'VPC', NetworkModeConfig: {
        SecurityGroups: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('SessionsSecurityGroup'), 'GroupId'] }],
        Subnets: NETWORK.subnetIds,
      } },
    })).toBe(4);
    const [group] = Object.values(wired.findResources('AWS::EC2::SecurityGroup'));
    expect(group?.Properties?.SecurityGroupIngress).toBeUndefined();
    expect(group?.Properties?.SecurityGroupEgress).toStrictEqual([
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS only' },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv6: '::/0', Description: 'HTTPS only' }]);
  });

  it('gives the sessions one execution role: pull their images and write their logs, nothing else', () => {
    const role = policyText(wired, 'AgentCoreSessionRole');
    const actions = new Set(role.match(/"(\w+(-\w+)*):[A-Za-z]+"/g)?.filter((name) => !/Source/.test(name)));
    expect([...actions].sort(byName)).toStrictEqual(['"ecr:BatchGetImage"', '"ecr:GetAuthorizationToken"',
      '"ecr:GetDownloadUrlForLayer"', '"logs:CreateLogGroup"', '"logs:CreateLogStream"', '"logs:PutLogEvents"']);
    expect(role).not.toMatch(/s3:|dynamodb:|bedrock:|sts:|events:|lambda:|kms:/);
    wired.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: Match.objectLike({ Statement: [
      Match.objectLike({ Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': '111111111111' } }) })] }) });
  });

  it('lets the supervisor invoke, command and stop sessions on these runtimes only, and the delivery no command', () => {
    expect(actionsOf(wired, 'EngineeringSupervisorRole', 'AgentSessions')).toStrictEqual([
      'bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeCommand',
      'bedrock-agentcore:StopRuntimeSession']);
    expect(actionsOf(wired, 'EngineeringDeliveryRole', 'AgentSessions')).toStrictEqual([
      'bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession']);
    expect(policyText(wired, 'EngineeringSupervisorRole')).toMatch(/PythonStandardRuntime\w*","AgentRuntimeArn"\]\},"\/runtime-endpoint\/DEFAULT"/);
    expect(policyText(wired, 'EngineeringStartRole')).not.toMatch(/bedrock-agentcore/);
  });

  it('hands the runtime its runtimes, sizes, rates and session ceiling; the board the languages it may launch', () => {
    const env = supervisorEnv(wired);
    expect(JSON.stringify(env.ENGINEERING_AGENT_RUNTIMES)).toMatch(/python.*standard.*build.*rust/);
    expect([env.ENGINEERING_BUILD_MEMORY_MIB, env.ENGINEERING_MAX_SESSIONS]).toStrictEqual(['8192', '5000']);
    expect(JSON.parse(String(env.ENGINEERING_SESSION_RATES))).toStrictEqual(DEFAULT_RATES);
    expect(functionEnv(wired, 'voc-engineering-delivery').ENGINEERING_AGENT_RUNTIMES).toStrictEqual(env.ENGINEERING_AGENT_RUNTIMES);
  });
});

describe('the sessions\' deployment settings', () => {
  it('takes its own sizes, rates and ceiling: no build runtime with 0, the roles named, lower rates', () => {
    const template = runtimeStack({
      ...WITH_RUNTIMES, engineeringBuildMemoryMiB: '0', engineeringMaxSessions: '200',
      engineeringSessionRates: JSON.stringify({ ...DEFAULT_RATES, vcpuHour: '0.05' }),
    }).template;
    expect([...runtimes(template).keys()].sort(byName)).toStrictEqual(['voc_eng_python', 'voc_eng_rust']);
    expect(supervisorEnv(template).ENGINEERING_MAX_SESSIONS).toBe('200');
    expect(JSON.parse(String(supervisorEnv(template).ENGINEERING_SESSION_RATES)).vcpuHour).toBe('0.05');
    const roles = runtimeStack({ ...WITH_RUNTIMES, engineeringBuildRoles: '["fixer","gate-runner"]' }).template;
    expect(supervisorEnv(roles).ENGINEERING_BUILD_ROLES).toBe('["fixer","gate-runner"]');
  });

  it.each([
    ['an image without a network', { engineeringImages: { python: 'v1' } }, /engineeringAgentNetwork/],
    ['an unknown language', { engineeringImages: { go: 'v1' } }, /engineeringImages/],
    ['an image that is not a tag or digest', { engineeringImages: { python: 'v1 latest' } }, /engineeringImages/],
    ['images that are not JSON', { engineeringImages: '{python:' }, /engineeringImages/],
    ['a network without a subnet', { engineeringAgentNetwork: { vpcId: NETWORK.vpcId, subnetIds: [] } }, /engineeringAgentNetwork/],
    ['a network that is not a VPC', { engineeringAgentNetwork: { vpcId: 'my-vpc', subnetIds: NETWORK.subnetIds } }, /engineeringAgentNetwork/],
    ['the 4096 configuration (below the floor)', { engineeringBuildMemoryMiB: '4096' }, /floor/],
    ['an unknown build role', { engineeringBuildRoles: '["admin"]' }, /engineeringBuildRoles/],
    ['a missing rate', { engineeringSessionRates: { vcpuHour: '0.1' } }, /engineeringSessionRates/],
    ['a rate that is not one', { engineeringSessionRates: { ...DEFAULT_RATES, gbHour: '1e-3' } }, /engineeringSessionRates/],
    ['more sessions than the quota', { engineeringMaxSessions: '5001' }, /engineeringMaxSessions/],
    ['no session', { engineeringMaxSessions: '0' }, /engineeringMaxSessions/],
    ['too few sessions for one run the Agents API starts', { engineeringMaxSessions: '100' }, /engineeringMaxSessions/],
  ])('refuses %s at synth', (_case, context, message) => {
    expect(() => runtimeStack({ engineeringAgents: 'true', ...context })).toThrow(message);
  });
});
