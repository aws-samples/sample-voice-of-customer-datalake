/**
 * Tests for create_project tool implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeCreateProject } from './create-project.js';

function createMockDocClient() {
  const puts: Record<string, unknown>[] = [];
  const client = {
    send: vi.fn().mockImplementation((cmd: { input?: { Item?: Record<string, unknown> } }) => {
      if (cmd?.input?.Item) puts.push(cmd.input.Item);
      return Promise.resolve({});
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  return { client, puts };
}

describe('executeCreateProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when projects table is not configured', async () => {
    const { client } = createMockDocClient();
    await expect(
      executeCreateProject(client, '', { name: 'X' }),
    ).rejects.toThrow('Projects table not configured');
  });

  it('returns invalid-input result (no throw) when name is missing', async () => {
    const { client, puts } = createMockDocClient();
    const r = await executeCreateProject(client, 'projects', {});
    expect(r.projectChange.summary).toContain('invalid input');
    expect(puts.length).toBe(0); // nothing written
  });

  it('creates a project META item with a proj_ id', async () => {
    const { client, puts } = createMockDocClient();
    const r = await executeCreateProject(client, 'projects', {
      name: 'Booking reliability',
      description: 'Fix booking acceptance sync issues.',
    });

    expect(r.projectChange.action).toBe('created');
    expect(r.projectChange.project_id).toMatch(/^proj_\d{14}$/);
    const meta = puts.find((p) => p.sk === 'META');
    expect(meta).toBeDefined();
    expect(meta?.name).toBe('Booking reliability');
    expect(meta?.gsi1pk).toBe('TYPE#PROJECT');
    // No product-context fields provided → no PRODUCT_CONTEXT item written.
    expect(puts.find((p) => p.sk === 'PRODUCT_CONTEXT')).toBeUndefined();
  });

  it('seeds a PRODUCT_CONTEXT item only with the fields actually provided', async () => {
    const { client, puts } = createMockDocClient();
    const r = await executeCreateProject(client, 'projects', {
      name: 'P',
      product_name: '강남언니',
      problem_solved: '앱 가격과 실제 가격 불일치',
      // one_liner / target_users / key_features intentionally omitted
    });

    const ctx = puts.find((p) => p.sk === 'PRODUCT_CONTEXT');
    expect(ctx).toBeDefined();
    expect(ctx?.product_name).toBe('강남언니');
    expect(ctx?.problem_solved).toBe('앱 가격과 실제 가격 불일치');
    expect(ctx?.one_liner).toBeUndefined();
    expect(ctx?.target_users).toBeUndefined();
    expect(r.projectChange.summary).toContain('product-context');
  });
});
