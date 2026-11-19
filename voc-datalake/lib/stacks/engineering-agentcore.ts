/**
 * The engineering agents' sessions on Amazon Bedrock AgentCore Runtime, platform version V2 (VocProcessingStack, with
 * `-c engineeringAgents=true` only): docs/autonomous-engineering.md → Runtime.
 *
 * - One ECR repository per language image (templates/orchestration/images/), made with the flag: nothing runs from
 *   them until a deployment names a pushed image (`-c engineeringImages`). They bill only for the images stored in
 *   them. Each repository's URI is a stack output (`EngineeringImageRepository<Language>`, 7.56.00), which
 *   `npm run images:build -- <language> <tag> --push` reads.
 * - Per language with an image, an AgentCore runtime of every agent's size (AgentCore's default: 2 vCPU and 8 GB,
 *   billed per second for the CPU used and the memory), and, with `-c engineeringBuildMemoryMiB=8192`, a build runtime
 *   for the roles that build and test (`-c engineeringBuildRoles`, the gate runner by default) whose resource
 *   configuration (`ResourceConfigurations`, `MinimumMemoryInMiB` 8192) commits 2 vCPU and 8 GB and bursts to 8 vCPU
 *   and 32 GB (32 GB disk). Opt-in since 7.40.00 (0, no build runtime, by default): CloudFormation is rolling the
 *   property out region by region (on 2026-11-15 us-east-2's `AWS::BedrockAgentCore::Runtime` schema had it,
 *   us-east-1, us-west-2, eu-west-1, eu-central-1 and ap-northeast-1 did not), and where it has not arrived the
 *   deploy fails CloudFormation's early validation ("Unsupported property [ResourceConfigurations]") before any
 *   change. Check a region with `aws cloudformation describe-type --type RESOURCE --type-name
 *   AWS::BedrockAgentCore::Runtime` (the schema's `properties`).
 *   Every runtime ends a session after an hour with no work (`IdleRuntimeSessionTimeout`, above the supervisor's
 *   45-minute hold of a waiting agent; an agent waiting on the model is busy) and at 8 hours (`MaxLifetime`; the
 *   supervisor continues an agent before then). Nothing is always on: no session runs between runs, and a committed
 *   baseline is billed only while its session lives.
 * - Network mode VPC, in the deployment's own subnets (`-c engineeringAgentNetwork`), behind a security group of the
 *   stack's that lets nothing in and only TCP 443 out; inside each session the runner's egress proxy holds the agent
 *   to its own allowlist (lambda/engineering/runtime/unit_runner.py). No runtime without a network.
 * - One execution role for every runtime: it pulls the images from these repositories and writes the runtimes' logs,
 *   nothing else. A session has no other AWS right of its own; the run's inputs are read with the agent role's
 *   15-minute session the launcher hands its agent user (engineering-runtime.ts).
 *
 * The runtime resource is the L1 `CfnRuntime` of the pinned aws-cdk-lib (2.275.0), which has no property for the
 * resource configuration, so `ResourceConfigurations` is a property override, in CloudFormation's own name and shape
 * (`[{ MinimumMemoryInMiB }]`, us-east-2's registry schema, 2026-11-15). aws-cdk-lib 2.277.0 has it typed
 * (`resourceConfigurations`) but also knows Python 3.15, which the dependency rule (docs/dependencies.md) would move
 * every Lambda to: a separate upgrade. The standard runtimes ran on a real deployment (us-west-2, 2026-11-15); a build
 * runtime has not yet.
 */
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { capitalize } from '../plugin-loader';
import { agentCoreTrust } from '../utils/agentcore-trust';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { agentCoreName } from '../utils/naming';

/** The languages with an image (templates/orchestration/images/; runtime/egress.py REGISTRY_HOSTS: a Python test keeps
 *  them equal). */
const IMAGE_LANGUAGES = ['java', 'node', 'python', 'rust'];
/** `-c engineeringImages='{"python":"<tag or sha256:digest>",…}'`: the pushed image per language; `{}` by default. */
const IMAGES_CONTEXT = 'engineeringImages';
/** `-c engineeringAgentNetwork='{"vpcId":"vpc-…","subnetIds":["subnet-…",…]}'`: where the sessions run. */
const NETWORK_CONTEXT = 'engineeringAgentNetwork';
/** `-c engineeringBuildMemoryMiB=0|8192`: the build runtimes' resource configuration (0, the default: none). */
const BUILD_MEMORY_CONTEXT = 'engineeringBuildMemoryMiB';
/** `-c engineeringBuildRoles='["gate-runner"]'`: the roles that run on the build runtimes. */
const BUILD_ROLES_CONTEXT = 'engineeringBuildRoles';
/** `-c engineeringSessionRates='{"vcpuHour":…,"gbHour":…,"baselineVcpuHour":…,"baselineGbHour":…}'` (USD). */
const RATES_CONTEXT = 'engineeringSessionRates';
/** `-c engineeringMaxSessions=<101-5000>`: the agent sessions this deployment runs at once. */
const MAX_SESSIONS_CONTEXT = 'engineeringMaxSessions';
/** `-c engineeringModelPrices`: the model tokens' prices (modelPrices). */
const MODEL_PRICES_CONTEXT = 'engineeringModelPrices';
/** runtime/caps.py MAX_USD_PER_MILLION_TOKENS, TOKEN_PRICE_PARTS and its model id's shape. */
const MAX_USD_PER_MILLION_TOKENS = 1000;
const PRICE_PARTS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** AgentCore Runtime V2's rates, checked 2026-11-13 (runtime/caps.py DEFAULT_RATES: a test keeps them equal). */
export const DEFAULT_RATES: Readonly<Record<string, string>> = {
  vcpuHour: '0.1276', gbHour: '0.0169', baselineVcpuHour: '0.0997', baselineGbHour: '0.0132',
};
/** runtime/caps.py MAX_USD_PER_HOUR and PRICE_DIGITS: a rate a few orders of magnitude off fails the synth. */
const MAX_USD_PER_HOUR = 10;
/** The build runtimes' one resource configuration: 4096 (1 vCPU and 4 GB committed) is below the 2 vCPU and 8 GB
 *  floor. Opt-in (the module comment: CloudFormation's regional rollout of the property). */
const BUILD_MEMORY_MIB = 8192;
/** The account's active sessions per region (the service's quota in us-east-1 and us-west-2). */
const SESSION_QUOTA = 5000;
/**
 * The lowest `engineeringMaxSessions` (runtime/caps.py MIN_MAX_SESSIONS): one run the Agents API starts must fit, its
 * task cap of 100 (lambda/api/agents_handler.py RUN_TASK_CAP) and its coordinator, else every start is refused.
 */
const MIN_MAX_SESSIONS = 101;
/** runtime/caps.py IDLE_TIMEOUT_SECONDS, and an AgentCore session's longest life. */
export const IDLE_TIMEOUT_SECONDS = 3600;
export const MAX_LIFETIME_SECONDS = 8 * 3600;
/** How many untagged images each repository keeps (older untagged ones expire; no tagged one ever does). */
const KEPT_IMAGES = 10;

const IMAGE_REF_RE = /^(?:sha256:[0-9a-f]{64}|\w[\w.-]{0,127})$/;
const VPC_RE = /^vpc-[0-9a-f]{8,17}$/;
const SUBNET_RE = /^subnet-[0-9a-f]{8,17}$/;
const RATE_RE = /^\d+(\.\d{1,12})?$/;

/** A context value that is JSON (or its text, from the CLI); `fallback` when absent. */
function jsonContext(scope: Construct, key: string, fallback: unknown, usage: string): unknown {
  const raw: unknown = scope.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${key} is not JSON. ${usage}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `-c engineeringImages`: languages of IMAGE_LANGUAGES to a tag or a digest. Anything else fails the synth. */
function images(scope: Construct): Record<string, string> {
  const usage = `Use -c ${IMAGES_CONTEXT}='{"python":"sha256:…"}' (languages: ${IMAGE_LANGUAGES.join(', ')}; a tag or a digest of the image pushed to its repository).`;
  const value = jsonContext(scope, IMAGES_CONTEXT, {}, usage);
  if (!isRecord(value)) throw new Error(`${IMAGES_CONTEXT} must be a JSON object. ${usage}`);
  const bad = Object.entries(value).filter(([language, ref]) => !IMAGE_LANGUAGES.includes(language)
    || typeof ref !== 'string' || !IMAGE_REF_RE.test(ref));
  if (bad.length > 0) {
    throw new Error(`${IMAGES_CONTEXT}: not a language with an image, or not a tag or digest: ${bad.map(([language]) => language).join(', ')}. ${usage}`);
  }
  return Object.fromEntries(Object.entries(value).map(([language, ref]) => [language, String(ref)]));
}

interface AgentNetwork { vpcId: string; subnetIds: string[] }

/** `-c engineeringAgentNetwork`: the VPC and its subnets (1 to 16), or undefined when absent. */
function agentNetwork(scope: Construct): AgentNetwork | undefined {
  const usage = `Use -c ${NETWORK_CONTEXT}='{"vpcId":"vpc-…","subnetIds":["subnet-…"]}' (private subnets whose way out reaches the hosts the agents need: docs/deployment.md).`;
  const value = jsonContext(scope, NETWORK_CONTEXT, undefined, usage);
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.vpcId !== 'string' || !VPC_RE.test(value.vpcId)
    || !Array.isArray(value.subnetIds) || value.subnetIds.length < 1 || value.subnetIds.length > 16
    || !value.subnetIds.every((subnet) => typeof subnet === 'string' && SUBNET_RE.test(subnet))
    || Object.keys(value).some((key) => !['vpcId', 'subnetIds'].includes(key))) {
    throw new Error(`${NETWORK_CONTEXT} must name a VPC and 1 to 16 of its subnets. ${usage}`);
  }
  return { vpcId: value.vpcId, subnetIds: value.subnetIds.map(String) };
}

/** `-c engineeringBuildMemoryMiB`: 0 by default (no build runtime: every role at the standard size), or 8192 (the
 *  build runtimes, where CloudFormation has the property: the module comment). */
export function buildMemoryMiB(scope: Construct): number {
  const raw: unknown = scope.node.tryGetContext(BUILD_MEMORY_CONTEXT);
  if (raw === undefined || raw === null || raw === '') return 0;
  const text = String(raw).trim();
  if (text !== '0' && text !== String(BUILD_MEMORY_MIB)) {
    throw new Error(`${BUILD_MEMORY_CONTEXT} is ${BUILD_MEMORY_MIB} or 0 (4096 is below the 2 vCPU and 8 GB floor).`);
  }
  return Number(text);
}

/** `-c engineeringBuildRoles`: agent roles of `roles` (the gate runner by default). */
export function buildRoles(scope: Construct, roles: readonly string[]): string[] {
  const usage = `Use -c ${BUILD_ROLES_CONTEXT}='["gate-runner"]' (roles: ${roles.join(', ')}).`;
  const value = jsonContext(scope, BUILD_ROLES_CONTEXT, ['gate-runner'], usage);
  if (!Array.isArray(value) || !value.every((role) => typeof role === 'string' && roles.includes(role))) {
    throw new Error(`${BUILD_ROLES_CONTEXT} must be a JSON list of agent roles. ${usage}`);
  }
  return [...new Set(value.map(String))].sort((a, b) => a.localeCompare(b, 'en'));
}

/** `-c engineeringSessionRates`: the four rates as decimal text, AgentCore's published ones by default. */
function sessionRates(scope: Construct): Record<string, string> {
  const usage = `Use -c ${RATES_CONTEXT}='${JSON.stringify(DEFAULT_RATES)}' (USD per hour, 0 to ${MAX_USD_PER_HOUR}, at most 12 digits after the point; 0 leaves that part unpriced).`;
  const value = jsonContext(scope, RATES_CONTEXT, DEFAULT_RATES, usage);
  const names = Object.keys(DEFAULT_RATES);
  const byName = (a: string, b: string): number => a.localeCompare(b, 'en');
  if (!isRecord(value) || Object.keys(value).sort(byName).join() !== [...names].sort(byName).join()) {
    throw new Error(`${RATES_CONTEXT} names exactly ${names.join(', ')}. ${usage}`);
  }
  return Object.fromEntries(names.map((name) => {
    const text = String(value[name]).trim();
    if (typeof value[name] === 'boolean' || !RATE_RE.test(text) || Number(text) > MAX_USD_PER_HOUR) {
      throw new Error(`${RATES_CONTEXT}.${name} is not a rate. ${usage}`);
    }
    return [name, text];
  }));
}

/**
 * `-c engineeringModelPrices='{"<model id>":{"input":…,"output":…,"cacheRead"?:…,"cacheWrite"?:…},…}'` (USD per million
 * tokens, 7.50.00): each model's price over runtime/caps.py DEFAULT_TOKEN_PRICES (the Price List API's, read
 * 2026-11-16), so a run's cost cap and its flow's budget bound model spend. `{}` by default: the defaults. A model
 * with no price is priced at the dearest listed (caps.py TokenPrices), never left out.
 */
export function modelPrices(scope: Construct): Record<string, Record<string, string>> {
  const usage = `Use -c ${MODEL_PRICES_CONTEXT}='{"global.anthropic.claude-sonnet-5-5":{"input":"2","output":"10"}}' (USD per million tokens, 0 to ${MAX_USD_PER_MILLION_TOKENS}, at most 12 digits after the point; input and output, optionally cacheRead and cacheWrite).`;
  const value = jsonContext(scope, MODEL_PRICES_CONTEXT, {}, usage);
  if (!isRecord(value)) throw new Error(`${MODEL_PRICES_CONTEXT} must be a JSON object. ${usage}`);
  return Object.fromEntries(Object.entries(value).map(([model, parts]) => {
    if (!MODEL_ID_RE.test(model) || !isRecord(parts) || !('input' in parts) || !('output' in parts)
      || !Object.keys(parts).every((part) => PRICE_PARTS.includes(part))) {
      throw new Error(`${MODEL_PRICES_CONTEXT} maps a model id to its input and output prices. ${usage}`);
    }
    return [model, Object.fromEntries(Object.entries(parts).map(([part, price]) => {
      const text = String(price).trim();
      if (typeof price === 'boolean' || !RATE_RE.test(text) || Number(text) > MAX_USD_PER_MILLION_TOKENS) {
        throw new Error(`${MODEL_PRICES_CONTEXT}.${model}.${part} is not a price. ${usage}`);
      }
      return [part, text];
    }))];
  }));
}

/**
 * The runtime's pricing settings, as its environment names them: AgentCore's rates for each session's CPU and memory
 * (`-c engineeringSessionRates`) and each model's token price over the runtime's defaults (`-c engineeringModelPrices`,
 * 7.50.00; `{}` keeps them), so a run's cost cap and its flow's budget bound both.
 */
export function pricingEnvironment(scope: Construct): Record<string, string> {
  return {
    ENGINEERING_SESSION_RATES: JSON.stringify(sessionRates(scope)),
    ENGINEERING_MODEL_PRICES: JSON.stringify(modelPrices(scope)),
  };
}

/** `-c engineeringMaxSessions`: 101 to 5,000 (the account's quota), 5,000 by default. */
export function maxSessions(scope: Construct): number {
  const raw: unknown = scope.node.tryGetContext(MAX_SESSIONS_CONTEXT);
  if (raw === undefined || raw === null || raw === '') return SESSION_QUOTA;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text) || Number(text) < MIN_MAX_SESSIONS || Number(text) > SESSION_QUOTA) {
    throw new Error(`${MAX_SESSIONS_CONTEXT} is a whole number from ${MIN_MAX_SESSIONS} (a run the Agents API starts: `
      + `100 tasks and its coordinator) to ${SESSION_QUOTA} (the account's quota).`);
  }
  return Number(text);
}

/** The context keys 6.26.00 removed (the Lambda MicroVM runtime's), each with what replaced it. */
const REMOVED_SETTINGS: Readonly<Record<string, string>> = {
  engineeringImageArns: `${IMAGES_CONTEXT} (a tag or sha256 digest per language, of an image pushed to its voc-eng-<language> repository) and ${NETWORK_CONTEXT}`,
  engineeringMicrovmUsdPerSecond: `${RATES_CONTEXT} (AgentCore's rates per vCPU-hour and GB-hour; every rate 0 leaves sessions unpriced)`,
};

/** Fail the synth on a removed context key, naming its replacement: it would otherwise do nothing, silently. */
export function refuseRemovedSettings(scope: Construct): void {
  const passed = Object.keys(REMOVED_SETTINGS).filter((key) => scope.node.tryGetContext(key) !== undefined);
  if (passed.length > 0) {
    throw new Error(passed.map((key) => `-c ${key} was removed in 6.26.00: use ${REMOVED_SETTINGS[key]}.`).join(' '));
  }
}

/** The languages this deployment runs agents in: those with an image, once there is a network for them. */
export function runtimeLanguages(scope: Construct): string[] {
  const named = Object.keys(images(scope));
  if (named.length > 0 && agentNetwork(scope) === undefined) {
    throw new Error(`${IMAGES_CONTEXT} needs ${NETWORK_CONTEXT}: the agents' sessions run in a VPC with locked egress.`);
  }
  return named.sort((a, b) => a.localeCompare(b, 'en'));
}

/** Whether the sessions have a network (`-c engineeringAgentNetwork`): the readiness check's (7.50.00). */
export function agentNetworkConfigured(scope: Construct): boolean {
  return agentNetwork(scope) !== undefined;
}

/** The sizes of a language's runtimes, and their ARNs. */
type RuntimeArns = Record<string, Record<string, string>>;

interface AgentCoreProps {
  uniqueName: (baseName: string) => string;
}

export class EngineeringAgentCore extends Construct {
  /** `{language: {standard: arn, build?: arn}}`, for the runtime's environment (ENGINEERING_AGENT_RUNTIMES). */
  readonly runtimes: RuntimeArns = {};
  /** Every runtime's ARN (the supervisor's and the delivery's grants). */
  readonly runtimeArns: string[] = [];
  readonly repositories = new Map<string, ecr.Repository>();

  constructor(scope: Construct, id: string, props: AgentCoreProps) {
    super(scope, id);
    for (const language of IMAGE_LANGUAGES) {
      const repository = new ecr.Repository(this, `${capitalize(language)}Images`, {
        repositoryName: props.uniqueName(`voc-eng-${language}`),
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        // Tags are immutable and never expire: a runtime pinned to a tag, or to the digest of a tagged image, keeps its
        // image. Only untagged images (a re-push's leftovers) expire, the newest kept.
        lifecycleRules: [{
          tagStatus: ecr.TagStatus.UNTAGGED, maxImageCount: KEPT_IMAGES,
          description: `Expire untagged images past the newest ${KEPT_IMAGES}; tagged ones are kept`,
        }],
      });
      this.repositories.set(language, repository);
      // (7.56.00: where `npm run images:build -- <language> <tag> --push` pushes; on the stack, so its key is this name)
      new cdk.CfnOutput(cdk.Stack.of(this), `EngineeringImageRepository${capitalize(language)}`, {
        value: repository.repositoryUri,
        description: `The ${language} engineering agent image's repository (npm run images:build -- ${language} <tag> --push)`,
      });
    }
    const languages = runtimeLanguages(this);
    const network = agentNetwork(this);
    if (languages.length === 0 || network === undefined) return;
    const role = this.executionRole(languages);
    const group = new ec2.CfnSecurityGroup(this, 'SessionsSecurityGroup', {
      groupDescription: 'Engineering agent sessions: nothing in, TCP 443 out only',
      vpcId: network.vpcId,
      securityGroupEgress: [
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0', description: 'HTTPS only' },
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIpv6: '::/0', description: 'HTTPS only' },
      ],
    });
    const build = buildMemoryMiB(this);
    const refs = images(this);
    for (const language of languages) {
      const sizes: [string, number][] = build > 0 ? [['standard', 0], ['build', build]] : [['standard', 0]];
      this.runtimes[language] = Object.fromEntries(sizes.map(([size, memory]) => {
        const runtime = this.runtime(props, role, group, network, language, refs[language] ?? '', size, memory);
        this.runtimeArns.push(runtime.attrAgentRuntimeArn);
        return [size, runtime.attrAgentRuntimeArn];
      }));
    }
  }

  /** The runtimes' one execution role: pull these images, write the runtimes' logs; nothing else. */
  private executionRole(languages: string[]): iam.Role {
    const stack = cdk.Stack.of(this);
    const role = new iam.Role(this, 'SessionRole', {
      assumedBy: agentCoreTrust(stack),
      description: 'Engineering agent sessions: pull their image and write their logs, nothing else',
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PullImages', actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resources: languages.map((language) => this.repositories.get(language)?.repositoryArn ?? ''),
    }));
    // The registry's token call names no repository.
    role.addToPolicy(new iam.PolicyStatement({ sid: 'RegistryToken', actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    const logs = stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: '/aws/bedrock-agentcore/runtimes/*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RuntimeLogs', actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logs, `${logs}:log-stream:*`],
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'ecr:GetAuthorizationToken names no resource; the logs are the AgentCore runtimes\' own log groups, which the service names per runtime',
      findings: ['Resource::*', resourceFinding(logs), resourceFinding(`${logs}:log-stream:*`)],
    }]);
    return role;
  }

  private runtime(
    props: AgentCoreProps, role: iam.Role, group: ec2.CfnSecurityGroup, network: AgentNetwork, language: string,
    ref: string, size: string, memory: number,
  ): agentcore.CfnRuntime {
    const repository = this.repositories.get(language);
    if (repository === undefined) throw new Error(`no repository for ${language}`);
    const image = ref.startsWith('sha256:') ? `${repository.repositoryUri}@${ref}` : `${repository.repositoryUri}:${ref}`;
    const suffix = size === 'standard' ? '' : `_${size}`;
    const runtime = new agentcore.CfnRuntime(this, `${capitalize(language)}${capitalize(size)}Runtime`, {
      agentRuntimeName: agentCoreName(props.uniqueName(`voc_eng_${language}${suffix}`)),
      description: `Engineering agents (${language}, ${size} size): one session per agent`,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image } },
      roleArn: role.roleArn,
      networkConfiguration: {
        networkMode: 'VPC', networkModeConfig: { securityGroups: [group.attrGroupId], subnets: network.subnetIds },
      },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: IDLE_TIMEOUT_SECONDS, maxLifetime: MAX_LIFETIME_SECONDS },
      // MMDSv2 (required since 2026-06-30): neither this CfnRuntime nor CloudFormation's schema (us-west-2, 2026-11-17)
      // has `metadataConfiguration`; the service sets `requireMMDSV2: true` on these runtimes itself (read back on b-:
      // docs/autonomous-engineering.md, Runtime, "MMDSv2"). Set it here once both have the property.
      platformVersion: 'V2',
    });
    if (memory > 0) runtime.addPropertyOverride('ResourceConfigurations', [{ MinimumMemoryInMiB: memory }]);
    // The role's policy first: the service checks the image pull when the runtime is made.
    const policy = role.node.tryFindChild('DefaultPolicy');
    if (policy !== undefined) runtime.node.addDependency(policy);
    return runtime;
  }
}

/**
 * The AgentCore calls of the supervisor (start, hold, wake, status, the role session: InvokeAgentRuntime; commands:
 * InvokeAgentRuntimeCommand; the end: StopRuntimeSession) or of the delivery (a wake and a continuation: no command),
 * on this deployment's runtimes and their default endpoint only. Nothing without a runtime.
 */
export function grantSessions(role: iam.Role, runtimeArns: readonly string[], commands: boolean): void {
  if (runtimeArns.length === 0) return;
  const actions = ['bedrock-agentcore:InvokeAgentRuntime',
    ...(commands ? ['bedrock-agentcore:InvokeAgentRuntimeCommand'] : []), 'bedrock-agentcore:StopRuntimeSession'];
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'AgentSessions', actions,
    resources: runtimeArns.flatMap((arn) => [arn, `${arn}/runtime-endpoint/DEFAULT`]),
  }));
}
