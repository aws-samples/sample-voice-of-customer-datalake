/**
 * What deleting (or replacing) VocCoreStack does to customer data, in both modes:
 * the default full cleanup and `-c protectData=true` for production
 * (lib/utils/data-protection.ts, docs/deployment.md "Teardown deletes everything").
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';

/** A resource's deletion policies and properties, as the teardown blocks below read them. */
const DeletionPoliciesSchema = z.object({
  DeletionPolicy: z.string().optional(),
  UpdateReplacePolicy: z.string().optional(),
  Properties: z.record(z.string(), z.unknown()),
});

/** The one `type` resource whose logical id starts with `constructId` (fails unless exactly one). */
function policyResource(template: Template, type: string, constructId: string): z.infer<typeof DeletionPoliciesSchema> {
  const entries = Object.entries(template.findResources(type))
    .filter(([logicalId]) => logicalId.startsWith(constructId));
  expect(entries, `expected exactly one ${constructId}`).toHaveLength(1);
  return DeletionPoliciesSchema.parse(itemAt(entries, 0)[1]);
}

describe('customer data: kept while the platform runs, deleted with the stack', () => {
  let template: Template;
  beforeAll(() => { template = synthCoreTemplate(); });

  const byConstructId = (type: string, constructId: string) => policyResource(template, type, constructId);
  const ALL_TABLES = [
    'FeedbackTable', 'AggregatesTable', 'ProjectsTable', 'MemoryTable', 'AgentsTable', 'RadarTable',
    'WatermarksTable', 'JobsTable', 'ConversationsTable', 'IdempotencyTable',
  ];

  it('stamps no TTL on the feedback table', () => {
    expect(byConstructId('AWS::DynamoDB::Table', 'FeedbackTable').Properties.TimeToLiveSpecification).toBeUndefined();
  });

  // DeletionPolicy Delete (teardown is a full cleanup) but UpdateReplacePolicy Retain:
  // a change that forces a REPLACEMENT must never silently delete the old data.
  const REPLACE_RETAINED_TABLES = ALL_TABLES.filter((id) => id !== 'IdempotencyTable');

  it.each(ALL_TABLES)('deletes %s with the stack', (id) => {
    expect(byConstructId('AWS::DynamoDB::Table', id).DeletionPolicy).toBe('Delete');
  });

  it.each(REPLACE_RETAINED_TABLES)('keeps the old %s if a change replaces it', (id) => {
    expect(byConstructId('AWS::DynamoDB::Table', id).UpdateReplacePolicy).toBe('Retain');
  });

  it.each([
    ['AWS::S3::Bucket', 'RawDataBucket'],
    ['AWS::KMS::Key', 'VocKmsKey'],
    ['AWS::Cognito::UserPool', 'VocUserPool'],
  ])('keeps the old %s %s if a change replaces it, and deletes it with the stack', (type, id) => {
    const resource = byConstructId(type, id);
    expect([resource.DeletionPolicy, resource.UpdateReplacePolicy]).toStrictEqual(['Delete', 'Retain']);
  });

  it.each(ALL_TABLES)('leaves %s without deletion protection', (id) => {
    expect(byConstructId('AWS::DynamoDB::Table', id).Properties.DeletionProtectionEnabled).toBeUndefined();
  });

  // The idempotency table is a Powertools cache with no recovery value.
  it.each(ALL_TABLES.filter((id) => id !== 'IdempotencyTable'))('keeps point-in-time recovery on %s', (id) => {
    expect(byConstructId('AWS::DynamoDB::Table', id).Properties.PointInTimeRecoverySpecification)
      .toStrictEqual({ PointInTimeRecoveryEnabled: true });
  });

  it('deletes the raw-data bucket with the stack, emptying it first', () => {
    const bucket = byConstructId('AWS::S3::Bucket', 'RawDataBucket');
    expect(bucket.DeletionPolicy).toBe('Delete');
    const autoDelete = Object.entries(template.findResources('Custom::S3AutoDeleteObjects'))
      .filter(([logicalId]) => logicalId.startsWith('RawDataBucket'));
    expect(autoDelete, 'the raw bucket has no autoDeleteObjects custom resource').toHaveLength(1);
  });

  it('schedules the KMS key for deletion with the stack after a 30-day pending window', () => {
    const key = byConstructId('AWS::KMS::Key', 'VocKmsKey');
    expect(key.DeletionPolicy).toBe('Delete');
    expect(key.Properties.PendingWindowInDays).toBe(30);
  });

  it('deletes the design-integrations secret with the stack', () => {
    expect(byConstructId('AWS::SecretsManager::Secret', 'DesignIntegrationsSecret').DeletionPolicy).toBe('Delete');
  });

  it('retains nothing in the core stack', () => {
    const { Resources } = z.object({ Resources: z.record(z.string(), DeletionPoliciesSchema.partial()) }).parse(template.toJSON());
    const retained = Object.entries(Resources)
      .filter(([, resource]) => resource.DeletionPolicy === 'Retain')
      .map(([logicalId]) => logicalId);
    expect(retained).toStrictEqual([]);
  });
});

describe('-c protectData=true: customer data survives stack deletion (production)', () => {
  let template: Template;
  beforeAll(() => { template = synthCoreTemplate({ protectData: 'true' }); });

  const byConstructId = (type: string, constructId: string) => policyResource(template, type, constructId);
  const DATA_TABLES = ['FeedbackTable', 'AggregatesTable', 'ProjectsTable', 'MemoryTable', 'AgentsTable', 'RadarTable', 'ConversationsTable'];

  it.each([
    ...DATA_TABLES.map((id) => ['AWS::DynamoDB::Table', id] as const),
    ['AWS::S3::Bucket', 'RawDataBucket'],
    ['AWS::KMS::Key', 'VocKmsKey'],
    ['AWS::SecretsManager::Secret', 'DesignIntegrationsSecret'],
    ['AWS::Cognito::UserPool', 'VocUserPool'],
  ] as const)('keeps %s %s on deletion and replacement, except a failed first create', (type, id) => {
    const resource = byConstructId(type, id);
    expect([resource.DeletionPolicy, resource.UpdateReplacePolicy]).toStrictEqual(['RetainExceptOnCreate', 'Retain']);
  });

  it.each(DATA_TABLES)('turns on deletion protection for %s, which also blocks a console or API delete', (id) => {
    expect(byConstructId('AWS::DynamoDB::Table', id).Properties.DeletionProtectionEnabled).toBe(true);
  });

  it('turns on deletion protection for the user pool', () => {
    expect(byConstructId('AWS::Cognito::UserPool', 'VocUserPool').Properties.DeletionProtection).toBe('ACTIVE');
  });

  it('gives the raw bucket no auto-delete provider, so neither teardown nor a rename can empty it', () => {
    const autoDelete = Object.keys(template.findResources('Custom::S3AutoDeleteObjects'))
      .filter((logicalId) => logicalId.startsWith('RawDataBucket'));
    expect(autoDelete).toStrictEqual([]);
  });

  it('still deletes the website and access-log buckets with the stack (they hold no customer data)', () => {
    expect(byConstructId('AWS::S3::Bucket', 'WebsiteBucket').DeletionPolicy).toBe('Delete');
    expect(byConstructId('AWS::S3::Bucket', 'AccessLogsBucket').DeletionPolicy).toBe('Delete');
  });
});
