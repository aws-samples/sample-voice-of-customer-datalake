/**
 * Tests for update_document and create_document tool implementations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeUpdateDocument, executeCreateDocument } from './update-document.js';

function createMockDocClient(sendImpl?: (...args: unknown[]) => Promise<unknown>) {
  return {
    send: vi.fn().mockImplementation(sendImpl ?? (() => Promise.resolve({ Items: [] }))),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

describe('executeUpdateDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ConfigurationError when projects table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      executeUpdateDocument(docClient, '', 'proj-1', {
        document_id: 'doc-1',
        content: 'new content',
        summary: 'updated',
      }),
    ).rejects.toThrow('Projects table not configured');
  });

  it('returns validation error for invalid input', async () => {
    const docClient = createMockDocClient();
    const result = await executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
      document_id: '',
      content: '',
      summary: '',
    });
    expect(result.content).toContain('Invalid input');
  });

  it('throws NotFoundError when document does not exist', async () => {
    const docClient = createMockDocClient(() => Promise.resolve({ Items: [] }));
    await expect(
      executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
        document_id: 'nonexistent',
        content: 'new content',
        summary: 'updated',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('updates document and returns success result', async () => {
    let callCount = 0;
    const docClient = createMockDocClient(() => {
      callCount++;
      if (callCount === 1) {
        // Query to find document
        return Promise.resolve({
          Items: [{ pk: 'PROJECT#proj-1', sk: 'DOC#doc-1', title: 'My Doc', document_id: 'doc-1' }],
        });
      }
      // UpdateCommand
      return Promise.resolve({});
    });

    const result = await executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
      document_id: 'doc-1',
      content: 'updated content',
      summary: 'fixed typos',
    });

    expect(result.content).toContain('Successfully updated');
    expect(result.content).toContain('My Doc');
    expect(result.documentChange.action).toBe('updated');
    expect(result.documentChange.document_id).toBe('doc-1');
    expect(result.documentChange.summary).toBe('fixed typos');
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  it('uses provided title when updating', async () => {
    let callCount = 0;
    const docClient = createMockDocClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Items: [{ pk: 'PROJECT#proj-1', sk: 'DOC#doc-1', title: 'Old Title', document_id: 'doc-1' }],
        });
      }
      return Promise.resolve({});
    });

    const result = await executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
      document_id: 'doc-1',
      title: 'New Title',
      content: 'content',
      summary: 'renamed',
    });

    expect(result.documentChange.title).toBe('New Title');
  });
});

describe('executeCreateDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ConfigurationError when projects table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      executeCreateDocument(docClient, '', 'proj-1', {
        title: 'New PRD',
        content: 'content',
        document_type: 'prd',
      }),
    ).rejects.toThrow('Projects table not configured');
  });

  it('returns validation error for invalid input', async () => {
    const docClient = createMockDocClient();
    const result = await executeCreateDocument(docClient, 'projects-table', 'proj-1', {
      title: '',
      content: '',
      document_type: 'invalid',
    });
    expect(result.content).toContain('Invalid input');
  });

  it('creates document and returns success result', async () => {
    const docClient = createMockDocClient(() => Promise.resolve({}));

    const result = await executeCreateDocument(docClient, 'projects-table', 'proj-1', {
      title: 'New PRD',
      content: '# Product Requirements',
      document_type: 'prd',
    });

    expect(result.content).toContain('Successfully created');
    expect(result.content).toContain('PRD');
    expect(result.content).toContain('New PRD');
    expect(result.documentChange.action).toBe('created');
    expect(result.documentChange.title).toBe('New PRD');
    expect(result.documentChange.document_id).toMatch(/^doc_/);
    // PutCommand + UpdateCommand (increment count)
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  it('accepts all valid document types', async () => {
    for (const docType of ['prd', 'prfaq', 'custom'] as const) {
      const docClient = createMockDocClient(() => Promise.resolve({}));
      const result = await executeCreateDocument(docClient, 'projects-table', 'proj-1', {
        title: `Test ${docType}`,
        content: 'content',
        document_type: docType,
      });
      expect(result.documentChange.action).toBe('created');
    }
  });
});
