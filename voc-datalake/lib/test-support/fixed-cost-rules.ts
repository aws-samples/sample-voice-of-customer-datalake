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
import { PERFORMANCE_TIER_CONTEXT_KEY } from '../utils/performance-tier';
import { SNAPSTART_CONTEXT_KEY, SNAPSTART_FUNCTION_IDS } from '../utils/snapstart';
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

/** A resource type with a small monthly price per resource, held to a fixed count in the default synth. */
export interface CountedFixedCost {
  readonly type: string;
  /** How many the default synth (every stack together) holds today: the ceiling, and a ratchet. */
  readonly baseline: number;
  readonly what: string;
}

/**
 * Resource types billed per resource per month (TENETS.md, tenet 7), counted over every stack of the default synth
 * and of the all-features synth (lib/fixed-cost-guard.test.ts; both hold the same numbers today).
 * The count may never grow, and the gate also fails when it shrinks, so the number here is lowered in the same
 * change: the set can only get smaller.
 *
 * - `AWS::KMS::Key`: exactly ONE, the Core data key (about $1 a month), the accepted baseline. Every other
 *   encrypted resource uses it, with a narrow key-policy statement for a service principal (the alarm topic's
 *   CloudWatch grant, the schedule DLQ's EventBridge grant: lib/stacks/dlq-alarms.ts, ingestion-schedule-dlq.ts).
 * - `AWS::SecretsManager::Secret`: 3 today (about $0.40 a month each), a known baseline: the plugin-credentials
 *   secret (lib/stacks/ingestion-stack.ts) and the design-integrations and CDN signing-key secrets
 *   (lib/stacks/core-cdn.ts). A later release moves them to SSM Parameter Store (SecureString, no monthly fee) and
 *   brings this number to zero.
 *
 * The single-flag opt-in shapes (`snapStart`, `performanceTier`) are not counted: their registries above list
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
 * One message per counted type whose default-synth count is not its baseline, saying what to do:
 * above it, reuse the existing resource or make the new one opt-in; below it, lower the baseline.
 */
export function countedFixedCostFindings(templates: readonly StackTemplate[]): string[] {
  return COUNTED_FIXED_COSTS.flatMap(({ type, baseline, what }) => {
    const found = resourcesOfType(templates, type);
    if (found.length > baseline) {
      return [`${found.length} ${what} (${type}) in the default synth, baseline ${baseline}: ${found.join(', ')} — `
        + `each bills monthly (TENETS.md, tenet 7); reuse the existing one, or make the new one opt-in behind a context flag`];
    }
    if (found.length < baseline) {
      return [`${found.length} ${what} (${type}) in the default synth, below the baseline ${baseline} — `
        + 'lower `baseline` in COUNTED_FIXED_COSTS (lib/test-support/fixed-cost-rules.ts) to the new count, so it cannot grow back'];
    }
    return [];
  });
}

const SNAPSTART_FINDINGS = SNAPSTART_FUNCTION_IDS.map((id) => new RegExp(`^AWS::Lambda::Function (GlobalMcp)?${id}[0-9A-F]{8}$`));

/**
 * THE registry of opt-in fixed costs (TENETS.md, tenet 7): every context flag that may add a fixed monthly cost,
 * and exactly what it adds. lib/fixed-cost-guard.test.ts synthesizes each and requires those findings and no
 * others. A new fixed-cost performance feature gets its own entry AND adds its findings to `performanceTier`.
 */
export const OPT_IN_FIXED_COSTS: Readonly<Record<string, OptInFixedCost>> = {
  // `-c snapStart=true` (lib/utils/snapstart.ts): the four cold-start-bound API Lambdas.
  snapStart: { context: { [SNAPSTART_CONTEXT_KEY]: 'true' }, expected: SNAPSTART_FINDINGS },
  // `-c performanceTier=true` (lib/utils/performance-tier.ts): every fixed-cost performance feature; today exactly SnapStart.
  performanceTier: { context: { [PERFORMANCE_TIER_CONTEXT_KEY]: 'true' }, expected: SNAPSTART_FINDINGS },
};
