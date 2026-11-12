/**
 * Test support: the fixed-cost rules lib/fixed-cost-guard.test.ts holds every synthesized template to.
 *
 * TENETS.md, tenet 7: the platform runs fully serverless with NO fixed monthly cost by default. A
 * resource or setting that bills by the hour or month whether or not anyone uses the platform (a WAF
 * web ACL, SnapStart's snapshot cache, provisioned concurrency or capacity, a NAT gateway, a database
 * or cache cluster, a container service, an API Gateway cache, a CloudFront dedicated IP, a hosted
 * zone) may exist only behind an opt-in context flag.
 *
 * ALLOWED, because it costs nothing: Lambda RESERVED concurrency (`ReservedConcurrentExecutions`)
 * only caps a function's share of the account pool (the MCP endpoint keeps its 20,
 * `-c mcpReservedConcurrency`). Record sets in an EXISTING hosted zone (the inbound-email intake
 * imports its zone by id) are pay-per-query too.
 */
import { z } from 'zod';

import { PERFORMANCE_TIER_CONTEXT_KEY } from '../utils/performance-tier';
import { SNAPSTART_CONTEXT_KEY, SNAPSTART_FUNCTION_IDS } from '../utils/snapstart';
import { WAF_CONTEXT_KEY } from '../utils/waf';
import { isRecord } from './guards';
import { TemplateResourcesSchema } from './template-resources';

/** What every finding ends with: the tenet and the remedy. */
export const FIXED_COST_REMEDY = 'fixed monthly cost: off by default (TENETS.md, tenet 7); make it opt-in behind a context flag';

type Properties = Record<string, unknown>;

/** A rule: the reason a resource of this shape carries a fixed cost, or undefined when it does not. */
type Rule = (type: string, properties: Properties) => string | undefined;

/**
 * Resource types that are a fixed cost by existing: `[type or type prefix ending in '::', what it is]`.
 * A prefix (`AWS::RDS::`, `AWS::Redshift::`, `AWS::DocDB::`, `AWS::Neptune::`, `AWS::MSK::`, …) also flags the
 * service's free sub-resources (parameter and subnet groups). That is deliberate: they exist only beside a billed
 * cluster, so flagging them fails safe.
 */
const FIXED_COST_TYPES: readonly (readonly [string, string])[] = [
  ['AWS::WAF::', 'a WAF (classic) resource'],
  ['AWS::WAFRegional::', 'a WAF (regional classic) resource'],
  ['AWS::WAFv2::', 'a WAF web ACL / rule group'],
  ['AWS::EC2::NatGateway', 'a NAT gateway (hourly)'],
  ['AWS::EC2::Instance', 'an EC2 instance (hourly)'],
  ['AWS::ECS::Service', 'an ECS service (always-on tasks)'],
  ['AWS::RDS::', 'an RDS database resource (hourly)'],
  ['AWS::ElastiCache::', 'an ElastiCache cluster (hourly)'],
  ['AWS::OpenSearchService::Domain', 'an OpenSearch domain (hourly)'],
  ['AWS::Elasticsearch::Domain', 'an Elasticsearch domain (hourly)'],
  ['AWS::EC2::EIP', 'an Elastic IP (public IPv4, hourly)'],
  ['AWS::MSK::', 'an MSK (Kafka) cluster (hourly)'],
  ['AWS::Redshift::', 'a Redshift cluster resource (hourly)'],
  ['AWS::DocDB::', 'a DocumentDB cluster resource (hourly)'],
  ['AWS::Neptune::', 'a Neptune cluster resource (hourly)'],
  ['AWS::GlobalAccelerator::', 'a Global Accelerator (hourly)'],
  ['AWS::DAX::', 'a DynamoDB Accelerator (DAX) cluster (hourly)'],
  ['AWS::Route53::HostedZone', 'a hosted zone created by the app (monthly; import an existing zone by id instead)'],
];

const matchesType = (type: string, pattern: string): boolean => (
  pattern.endsWith('::') ? type.startsWith(pattern) : type === pattern
);

const recordAt = (properties: Properties, key: string): Properties => {
  const value = properties[key];
  return isRecord(value) ? value : {};
};

const byType: Rule = (type) => FIXED_COST_TYPES.find(([pattern]) => matchesType(type, pattern))?.[1];

// Interface and Gateway Load Balancer endpoints bill per hour per AZ; a Gateway endpoint (S3, DynamoDB, the
// CloudFormation default type) is free.
const BILLED_ENDPOINTS: ReadonlyMap<unknown, string> = new Map([
  ['Interface', 'an interface VPC endpoint (hourly per AZ)'],
  ['GatewayLoadBalancer', 'a Gateway Load Balancer VPC endpoint (hourly per AZ)'],
]);
const interfaceEndpoint: Rule = (type, properties) => (
  type === 'AWS::EC2::VPCEndpoint' ? BILLED_ENDPOINTS.get(properties.VpcEndpointType) : undefined
);

const snapStart: Rule = (type, properties) => (
  (type === 'AWS::Lambda::Function' || type === 'AWS::Lambda::Version')
    && recordAt(properties, 'SnapStart').ApplyOn === 'PublishedVersions'
    ? 'Lambda SnapStart (snapshot cache billed while the version is active)' : undefined
);

const provisionedConcurrency: Rule = (type, properties) => (
  (type === 'AWS::Lambda::Alias' || type === 'AWS::Lambda::Version')
    && properties.ProvisionedConcurrencyConfig !== undefined
    ? 'Lambda provisioned concurrency (billed per hour)' : undefined
);

/** GSIs carrying their own ProvisionedThroughput. */
const hasProvisionedIndex = (properties: Properties): boolean => {
  const indexes = properties.GlobalSecondaryIndexes;
  return Array.isArray(indexes) && indexes.some((index) => isRecord(index) && index.ProvisionedThroughput !== undefined);
};

// CloudFormation's default BillingMode is PROVISIONED, so an absent one is provisioned capacity too.
const dynamoProvisioned: Rule = (type, properties) => (
  (type === 'AWS::DynamoDB::Table' || type === 'AWS::DynamoDB::GlobalTable')
    && (properties.BillingMode !== 'PAY_PER_REQUEST' || properties.ProvisionedThroughput !== undefined
      || hasProvisionedIndex(properties))
    ? 'a DynamoDB table with PROVISIONED capacity (use PAY_PER_REQUEST)' : undefined
);

// A stream without StreamModeDetails is PROVISIONED (shard-hours).
const kinesisProvisioned: Rule = (type, properties) => (
  type === 'AWS::Kinesis::Stream' && recordAt(properties, 'StreamModeDetails').StreamMode !== 'ON_DEMAND'
    ? 'a Kinesis stream in PROVISIONED mode (shard-hours; use ON_DEMAND)' : undefined
);

/** A stage's CacheClusterEnabled, set on the Stage itself or on a Deployment's StageDescription. */
function cacheClusterEnabled(type: string, properties: Properties): unknown {
  if (type === 'AWS::ApiGateway::Stage') return properties.CacheClusterEnabled;
  if (type === 'AWS::ApiGateway::Deployment') return recordAt(properties, 'StageDescription').CacheClusterEnabled;
  return undefined;
}

const apiGatewayCache: Rule = (type, properties) => {
  const enabled = cacheClusterEnabled(type, properties);
  return enabled === true || enabled === 'true' ? 'an API Gateway cache cluster (hourly)' : undefined;
};

const cloudFrontDedicatedIp: Rule = (type, properties) => (
  type === 'AWS::CloudFront::Distribution'
    && recordAt(recordAt(properties, 'DistributionConfig'), 'ViewerCertificate').SslSupportMethod === 'vip'
    ? 'a CloudFront dedicated-IP SSL certificate (monthly)' : undefined
);

const RULES: readonly Rule[] = [
  byType, interfaceEndpoint, snapStart, provisionedConcurrency, dynamoProvisioned, kinesisProvisioned, apiGatewayCache, cloudFrontDedicatedIp,
];

/** One fixed-cost finding: where, and the message the gate prints. */
export interface FixedCostFinding {
  readonly stack: string;
  readonly logicalId: string;
  readonly type: string;
  readonly message: string;
}

/** Every fixed-cost resource or setting in one stack's template. */
export function fixedCostFindings(stack: string, template: Record<string, unknown>): FixedCostFinding[] {
  const resources = TemplateResourcesSchema.parse(template.Resources ?? {});
  return Object.entries(resources).flatMap(([logicalId, { Type, Properties }]) => RULES
    .map((rule) => rule(Type, Properties))
    .filter((reason): reason is string => reason !== undefined)
    .map((reason) => ({
      stack, logicalId, type: Type,
      message: `${stack}/${logicalId} (${Type}): ${reason} — ${FIXED_COST_REMEDY}`,
    })));
}

/** An opt-in flag allowed to add a fixed cost: its context, and the `<type> <logical id pattern>` findings it adds. */
export interface OptInFixedCost {
  readonly context: Readonly<Record<string, unknown>>;
  readonly expected: readonly RegExp[];
}

/** A resource type with a small monthly price per resource, held to a fixed count in every synthesized shape. */
export interface CountedFixedCost {
  readonly type: string;
  /** How many every counted synth shape (every stack together) holds today: the ceiling, and a ratchet. */
  readonly baseline: number;
  readonly what: string;
}

/**
 * Resource types billed per resource per month (TENETS.md, tenet 7), counted over every stack of the default synth
 * and of the all-features synth (lib/fixed-cost-guard.test.ts), against ONE baseline on purpose: no context-gated
 * feature may add a key or a secret either (reuse the Core key; put a credential in an existing secret, later in
 * SSM Parameter Store). A feature that truly needs one is an owner decision that changes this rule.
 * The count may never grow, and the gate also fails when it shrinks, so the number here is lowered in the same
 * change: the set can only get smaller.
 *
 * - `AWS::KMS::Key`: exactly ONE, the Core data key (about $1 a month), the accepted baseline. Every other
 *   encrypted resource uses it, with a narrow key-policy statement for a service principal (the alarm topic's
 *   CloudWatch grant, the schedule DLQ's EventBridge grant: lib/stacks/dlq-alarms.ts, ingestion-schedule-dlq.ts).
 * - `AWS::SecretsManager::Secret`: 3 today (about $0.40 a month each), a known baseline: the plugin-credentials
 *   secret (lib/stacks/ingestion-stack.ts) and the design-integrations and CDN signing-key secrets
 *   (lib/stacks/core-cdn.ts). A later release moves them to SSM Parameter Store (SecureString, no monthly fee) and
 *   brings this number to zero. These are the secrets CDK creates; the per-workspace credentials secrets the app
 *   creates at run time (one per workspace, decision 8) are not in any template, so {@link RUNTIME_FIXED_COSTS}
 *   names them instead, as the only runtime create of a counted type.
 *
 * The single-flag opt-in shapes (`snapStart`, `enableWaf`, `performanceTier`) are not counted: their registries above list
 * hourly-priced resources only. Every free context-gated feature is in the all-features synth, so a key or secret
 * one of those adds still fails here.
 */
export const COUNTED_FIXED_COSTS: readonly CountedFixedCost[] = [
  { type: 'AWS::KMS::Key', baseline: 1, what: 'customer-managed KMS keys' },
  { type: 'AWS::SecretsManager::Secret', baseline: 3, what: 'Secrets Manager secrets' },
];

/** One stack's synthesized template, as the counting gate reads it. */
export interface StackTemplate {
  readonly stack: string;
  readonly template: Record<string, unknown>;
}

/** The logical ids (`<stack>/<id>`) of every `type` resource across `templates`. */
function resourcesOfType(templates: readonly StackTemplate[], type: string): string[] {
  return templates.flatMap(({ stack, template }) => Object.entries(TemplateResourcesSchema.parse(template.Resources ?? {}))
    .filter(([, resource]) => resource.Type === type)
    .map(([logicalId]) => `${stack}/${logicalId}`));
}

/**
 * One message per counted type whose count in `templates` (one counted synth shape; the gate runs it on every
 * counted synth shape) is not its baseline, saying what to do:
 * above it, reuse the existing resource or make the new one opt-in; below it, lower the baseline.
 */
export function countedFixedCostFindings(templates: readonly StackTemplate[]): string[] {
  return COUNTED_FIXED_COSTS.flatMap(({ type, baseline, what }) => {
    const found = resourcesOfType(templates, type);
    if (found.length > baseline) {
      return [`${found.length} ${what} (${type}) in the synth, baseline ${baseline}: ${found.join(', ')} — `
        + `each bills monthly (TENETS.md, tenet 7); reuse the existing one, or make the new one opt-in behind a context flag`];
    }
    if (found.length < baseline) {
      return [`${found.length} ${what} (${type}) in the synth, below the baseline ${baseline} — `
        + 'lower `baseline` in COUNTED_FIXED_COSTS (lib/test-support/fixed-cost-rules.ts) to the new count, so it cannot grow back'];
    }
    return [];
  });
}

/**
 * A counted resource the app creates at RUN time, outside CloudFormation, so the template count above cannot see it:
 * the only role allowed the create action, the one resource pattern it may create, and the accepted cost.
 */
export interface RuntimeFixedCost {
  /** The create action that makes a billed resource (`secretsmanager:CreateSecret`). */
  readonly action: string;
  /** The logical-id fragment of the one role allowed it (`<RoleId>DefaultPolicy…`). */
  readonly role: string;
  /** What every resource of the grant must end with: the name pattern of the resources made at run time. */
  readonly resourceSuffix: string;
  readonly what: string;
}

/**
 * The create actions of the counted types ({@link COUNTED_FIXED_COSTS}): a role allowed one of them could add a
 * monthly cost the template count never sees, so every such grant in the app must be a {@link RUNTIME_FIXED_COSTS}
 * entry (an owner decision). `*` actions count too.
 */
const COUNTED_CREATE_ACTIONS: readonly string[] = ['kms:CreateKey', 'secretsmanager:CreateSecret'];

/**
 * THE registry of fixed costs made at run time (TENETS.md, tenet 7), each accepted by an owner decision:
 *
 * - One Secrets Manager secret per workspace (docs/multi-workspace.md, decision 8: per-workspace credential
 *   isolation, about $0.40 a month per workspace, reported per workspace): `voc/ws/{ws}/credentials`, created by
 *   the workspaces API when a platform admin creates a workspace (lambda/shared/platform_workspaces.py,
 *   lib/stacks/api-workspaces-lambda.ts). Its count is the number of workspaces; no other role may create a secret
 *   or a key at run time.
 */
export const RUNTIME_FIXED_COSTS: readonly RuntimeFixedCost[] = [
  { action: 'secretsmanager:CreateSecret', role: 'WorkspacesLambdaRole', resourceSuffix: ':secret:voc/ws/*',
    what: 'one credentials secret per workspace (decision 8, about $0.40 a month each)' },
];

const PolicyStatementsSchema = z.object({
  PolicyDocument: z.object({ Statement: z.array(z.looseObject({
    Effect: z.string().optional(), Action: z.union([z.string(), z.array(z.string())]).optional(), Resource: z.unknown(),
  })) }),
});
const PolicyResourceSchema = z.object({
  Type: z.enum(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']), Properties: PolicyStatementsSchema,
});
const RoleResourceSchema = z.object({
  Type: z.literal('AWS::IAM::Role'), Properties: z.object({ Policies: z.array(PolicyStatementsSchema).optional() }),
});

/** One Allow of a counted create action: `<stack>/<policy or role id>`, the action, and the resources it names. */
interface CountedCreateGrant { readonly where: string; readonly action: string; readonly resources: readonly string[] }

const grantsCountedCreate = (action: string, wanted: string): boolean => (
  action === wanted || action === '*' || action === `${wanted.split(':')[0]}:*`
);

function countedCreateGrants({ stack, template }: StackTemplate): CountedCreateGrant[] {
  return Object.entries(TemplateResourcesSchema.parse(template.Resources ?? {})).flatMap(([id, raw]) => {
    const policy = PolicyResourceSchema.safeParse(raw);
    const role = RoleResourceSchema.safeParse(raw);
    const documents = policy.success ? [policy.data.Properties] : (role.data?.Properties.Policies ?? []);
    return documents.flatMap((document) => document.PolicyDocument.Statement)
      .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow')
      .flatMap((statement) => COUNTED_CREATE_ACTIONS
        .filter((wanted) => [statement.Action ?? []].flat().some((action) => grantsCountedCreate(action, wanted)))
        .map((action) => ({
          where: `${stack}/${id}`, action,
          resources: [statement.Resource].flat().map((resource) => JSON.stringify(resource)),
        })));
  });
}

/** A resource with a `-c deploymentPrefix` (`:secret:<prefix>-voc/ws/*`) read as the unprefixed name. */
const withoutDeploymentPrefix = (resource: string): string => resource.replace(/:secret:[A-Za-z0-9]+-(?=voc\/)/, ':secret:');

const matchesRuntimeCost = (grant: CountedCreateGrant, cost: RuntimeFixedCost): boolean => (
  grant.action === cost.action && grant.where.includes(cost.role)
    // A literal ARN ends with the suffix; a joined one (account and region tokens) has it as its last string part.
    && grant.resources.length > 0
    && grant.resources.map(withoutDeploymentPrefix).every((resource) => resource.endsWith(`${cost.resourceSuffix}"`)
      || resource.endsWith(`${cost.resourceSuffix}"]]}`))
);

/**
 * One message per grant of a counted create action that is no {@link RUNTIME_FIXED_COSTS} entry, and per entry
 * whose grant is gone (lower the registry with it), across every stack of one synth shape.
 */
export function runtimeFixedCostFindings(templates: readonly StackTemplate[]): string[] {
  const grants = templates.flatMap(countedCreateGrants);
  const unlisted = grants.filter((grant) => !RUNTIME_FIXED_COSTS.some((cost) => matchesRuntimeCost(grant, cost)))
    .map((grant) => `${grant.where} may ${grant.action} on ${grant.resources.join(', ')} — a key or secret made at `
      + 'run time bills monthly (TENETS.md, tenet 7) and the template count cannot see it; reuse an existing one, '
      + 'or record the owner decision in RUNTIME_FIXED_COSTS (lib/test-support/fixed-cost-rules.ts)');
  const gone = RUNTIME_FIXED_COSTS.filter((cost) => !grants.some((grant) => matchesRuntimeCost(grant, cost)))
    .map((cost) => `RUNTIME_FIXED_COSTS lists ${cost.what} (${cost.role} ${cost.action}), and no grant makes it: `
      + 'remove the entry');
  return [...unlisted, ...gone];
}

const SNAPSTART_FINDINGS = SNAPSTART_FUNCTION_IDS.map((id) => new RegExp(`^AWS::Lambda::Function (GlobalMcp)?${id}[0-9A-F]{8}$`));

// lib/utils/waf.ts: the CLOUDFRONT ACL (VocWebSearchStack), the REGIONAL ACL and its stage association (VocApiStack).
const WAF_FINDINGS = [
  /^AWS::WAFv2::WebACL FrontendWebAcl$/,
  /^AWS::WAFv2::WebACL ApiWebAcl$/,
  /^AWS::WAFv2::WebACLAssociation ApiWebAclAssociation$/,
];

/**
 * THE registry of opt-in fixed costs (TENETS.md, tenet 7): every context flag that may add a fixed monthly cost,
 * and exactly what it adds. lib/fixed-cost-guard.test.ts synthesizes each and requires those findings and no
 * others. A new fixed-cost performance feature gets its own entry AND adds its findings to `performanceTier`.
 */
export const OPT_IN_FIXED_COSTS: Readonly<Record<string, OptInFixedCost>> = {
  // `-c snapStart=true` (lib/utils/snapstart.ts): the four cold-start-bound API Lambdas.
  snapStart: { context: { [SNAPSTART_CONTEXT_KEY]: 'true' }, expected: SNAPSTART_FINDINGS },
  // `-c enableWaf=true` (lib/utils/waf.ts): a web ACL on the SPA distribution and one on the API stage.
  enableWaf: { context: { [WAF_CONTEXT_KEY]: 'true' }, expected: WAF_FINDINGS },
  // `-c performanceTier=true` (lib/utils/performance-tier.ts): every fixed-cost opt-in at once, SnapStart and WAF.
  // (It also turns on Cognito Plus, which is billed per active user, not a fixed cost, so the gate has nothing to find.)
  performanceTier: { context: { [PERFORMANCE_TIER_CONTEXT_KEY]: 'true' }, expected: [...SNAPSTART_FINDINGS, ...WAF_FINDINGS] },
};
