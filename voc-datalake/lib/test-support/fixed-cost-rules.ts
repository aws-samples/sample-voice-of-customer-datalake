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
import { isRecord } from './guards';
import { TemplateResourcesSchema } from './template-resources';

/** What every finding ends with: the tenet and the remedy. */
export const FIXED_COST_REMEDY = 'fixed monthly cost: off by default (TENETS.md, tenet 7); make it opt-in behind a context flag';

type Properties = Record<string, unknown>;

/** A rule: the reason a resource of this shape carries a fixed cost, or undefined when it does not. */
type Rule = (type: string, properties: Properties) => string | undefined;

/** Resource types that are a fixed cost by existing: `[type or type prefix ending in '::', what it is]`. */
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
  byType, snapStart, provisionedConcurrency, dynamoProvisioned, kinesisProvisioned, apiGatewayCache, cloudFrontDedicatedIp,
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
