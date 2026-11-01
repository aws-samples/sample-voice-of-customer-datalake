/**
 * The fixed-cost rules (fixed-cost-rules.ts) on hand-written resources: each rule fires on the
 * shape it names, and the free look-alikes (reserved concurrency, on-demand capacity, a record set
 * in an existing zone) pass. The whole-app gate is lib/fixed-cost-guard.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { FIXED_COST_REMEDY, fixedCostFindings } from './fixed-cost-rules';

/** Findings for a one-resource template. */
const findingsFor = (Type: string, Properties: Record<string, unknown> = {}) => (
  fixedCostFindings('ProbeStack', { Resources: { Probe: { Type, Properties } } })
);

const FIXED_COST: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['a WAFv2 web ACL', 'AWS::WAFv2::WebACL', {}],
  ['a classic WAF web ACL', 'AWS::WAF::WebACL', {}],
  ['a regional WAF web ACL', 'AWS::WAFRegional::WebACL', {}],
  ['SnapStart on a function', 'AWS::Lambda::Function', { SnapStart: { ApplyOn: 'PublishedVersions' } }],
  ['provisioned concurrency on an alias', 'AWS::Lambda::Alias', { ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 } }],
  ['provisioned concurrency on a version', 'AWS::Lambda::Version', { ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 } }],
  ['a NAT gateway', 'AWS::EC2::NatGateway', {}],
  ['an EC2 instance', 'AWS::EC2::Instance', {}],
  ['an ECS service', 'AWS::ECS::Service', {}],
  ['an RDS cluster', 'AWS::RDS::DBCluster', {}],
  ['an ElastiCache cluster', 'AWS::ElastiCache::CacheCluster', {}],
  ['an OpenSearch domain', 'AWS::OpenSearchService::Domain', {}],
  ['a PROVISIONED DynamoDB table', 'AWS::DynamoDB::Table', { BillingMode: 'PROVISIONED' }],
  ['a DynamoDB table with no BillingMode (CloudFormation defaults to PROVISIONED)', 'AWS::DynamoDB::Table', {}],
  ['an on-demand table with a provisioned GSI', 'AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [{ ProvisionedThroughput: { ReadCapacityUnits: 1 } }],
  }],
  ['a Kinesis stream with no mode (PROVISIONED)', 'AWS::Kinesis::Stream', {}],
  ['a PROVISIONED Kinesis stream', 'AWS::Kinesis::Stream', { StreamModeDetails: { StreamMode: 'PROVISIONED' } }],
  ['an API Gateway stage cache', 'AWS::ApiGateway::Stage', { CacheClusterEnabled: true }],
  ['an API Gateway deployment stage cache', 'AWS::ApiGateway::Deployment', { StageDescription: { CacheClusterEnabled: true } }],
  ['a CloudFront dedicated IP', 'AWS::CloudFront::Distribution', {
    DistributionConfig: { ViewerCertificate: { SslSupportMethod: 'vip' } },
  }],
  ['a hosted zone', 'AWS::Route53::HostedZone', {}],
  ['an Elastic IP', 'AWS::EC2::EIP', {}],
  ['an interface VPC endpoint', 'AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface' }],
  ['a Gateway Load Balancer endpoint', 'AWS::EC2::VPCEndpoint', { VpcEndpointType: 'GatewayLoadBalancer' }],
  ['an MSK cluster', 'AWS::MSK::Cluster', {}],
  ['a Redshift cluster', 'AWS::Redshift::Cluster', {}],
  ['a DocumentDB cluster', 'AWS::DocDB::DBCluster', {}],
  ['a Neptune cluster', 'AWS::Neptune::DBCluster', {}],
  ['a Global Accelerator', 'AWS::GlobalAccelerator::Accelerator', {}],
  ['a DAX cluster', 'AWS::DAX::Cluster', {}],
];

const FREE: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['reserved concurrency', 'AWS::Lambda::Function', { ReservedConcurrentExecutions: 20 }],
  ['a plain function', 'AWS::Lambda::Function', {}],
  ['an alias without provisioned concurrency', 'AWS::Lambda::Alias', { Name: 'live' }],
  ['an on-demand DynamoDB table', 'AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' }],
  ['an on-demand Kinesis stream', 'AWS::Kinesis::Stream', { StreamModeDetails: { StreamMode: 'ON_DEMAND' } }],
  ['a stage without a cache', 'AWS::ApiGateway::Stage', { CacheClusterEnabled: false }],
  ['CloudFront with SNI', 'AWS::CloudFront::Distribution', {
    DistributionConfig: { ViewerCertificate: { SslSupportMethod: 'sni-only' } },
  }],
  ['a gateway VPC endpoint (the default type)', 'AWS::EC2::VPCEndpoint', {}],
  ['an explicit gateway VPC endpoint', 'AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' }],
  ['a record set in an existing zone', 'AWS::Route53::RecordSet', { HostedZoneId: 'Z0123456789EXAMPLE' }],
];

describe.each(FIXED_COST)('%s', (_label, type, properties) => {
  it('is a fixed-cost finding naming the resource and the remedy', () => {
    const [finding, ...more] = findingsFor(type, properties);
    expect(more).toStrictEqual([]);
    expect(finding?.message.startsWith(`ProbeStack/Probe (${type}): `)).toBe(true);
    expect(finding?.message.endsWith(FIXED_COST_REMEDY)).toBe(true);
  });
});

describe.each(FREE)('%s', (_label, type, properties) => {
  it('is allowed (no fixed cost)', () => {
    expect(findingsFor(type, properties)).toStrictEqual([]);
  });
});

describe('fixedCostFindings', () => {
  it('reads a template with no Resources as clean', () => {
    expect(fixedCostFindings('EmptyStack', {})).toStrictEqual([]);
  });
});
