/**
 * The `voc-workspaces` table (lib/stacks/core-stack.ts, docs/multi-workspace.md): the multi-workspace control
 * plane, in VocCoreStack because the sample keeps to five stacks. Pinned: the single-table keys, TTL for invites,
 * no index, and the same encryption, recovery and retention as every customer-data table.
 */
import { describe, expect, it } from 'vitest';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';

describe('the voc-workspaces table', () => {
  const template = synthCoreTemplate();
  const tables = template.findResources('AWS::DynamoDB::Table');
  const entry = Object.entries(tables).find(([id]) => id.startsWith('WorkspacesTable'));
  const props = entry?.[1].Properties;

  it('is a pk/sk table with TTL on `ttl` and no index', () => {
    expect(props?.KeySchema).toStrictEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(props?.TimeToLiveSpecification).toStrictEqual({ AttributeName: 'ttl', Enabled: true });
    expect(props?.GlobalSecondaryIndexes).toBeUndefined();
  });

  it('is on demand, under the customer-managed key, with point-in-time recovery', () => {
    expect(props?.BillingMode).toBe('PAY_PER_REQUEST');
    expect(props?.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: 'KMS' });
    expect(props?.PointInTimeRecoverySpecification).toStrictEqual({ PointInTimeRecoveryEnabled: true });
  });

  it('is kept with the stack, like the other customer-data tables', () => {
    const feedback = Object.entries(tables).find(([id]) => id.startsWith('FeedbackTable'))?.[1];
    expect(feedback).toBeDefined();
    expect(entry?.[1].DeletionPolicy).toBe(feedback?.DeletionPolicy);
    expect(entry?.[1].UpdateReplacePolicy).toBe(feedback?.UpdateReplacePolicy);
    expect(props?.DeletionProtectionEnabled).toBe(feedback?.Properties?.DeletionProtectionEnabled);
  });
});
