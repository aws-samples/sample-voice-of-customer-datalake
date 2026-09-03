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
    expect(docClient.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: expect.objectContaining({
        ConditionExpression: expect.stringContaining('attribute_exists(pk)'),
        ExpressionAttributeValues: expect.objectContaining({
          ':documentId': 'doc-1',
        }),
      }),
    }));
  });

  it('reports not found when the document is deleted after lookup', async () => {
    let callCount = 0;
    const docClient = createMockDocClient(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Items: [{
            pk: 'PROJECT#proj-1',
            sk: 'DOC#doc-1',
            title: 'My Doc',
            document_id: 'doc-1',
          }],
        });
      }
      const error = new Error('gone');
      error.name = 'ConditionalCheckFailedException';
      return Promise.reject(error);
    });

    await expect(executeUpdateDocument(
      docClient,
      'projects-table',
      'proj-1',
      {
        document_id: 'doc-1',
        content: 'updated content',
        summary: 'fixed typos',
      },
    )).rejects.toThrow('Document no longer exists');

    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  it('uses provided title when updating a custom document', async () => {
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
    expect(docClient.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: expect.objectContaining({
        UpdateExpression: expect.stringContaining('title = :title'),
        ExpressionAttributeValues: expect.objectContaining({ ':title': 'New Title' }),
      }),
    }));
  });

  it.each([
    ['PRD#doc-1', undefined],
    ['PRFAQ#doc-1', 'prfaq'],
    ['DOC#doc-1', 'prd'],
  ])('refuses title changes for managed document %s', async (sk, documentType) => {
    const docClient = createMockDocClient(() => Promise.resolve({
      Items: [{
        pk: 'PROJECT#proj-1',
        sk,
        title: 'Launch (v2)',
        base_title: 'Launch',
        version: 2,
        document_id: 'doc-1',
        document_type: documentType,
      }],
    }));

    await expect(executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
      document_id: 'doc-1',
      title: 'Different series',
      content: 'content',
      summary: 'renamed',
    })).rejects.toThrow(/cannot be renamed/);

    expect(docClient.send).toHaveBeenCalledTimes(1);
  });
});

describe('executeCreateDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ConfigurationError when projects table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      executeCreateDocument(docClient, '', 'proj-1', {
        title: 'New document',
        content: 'content',
        document_type: 'custom',
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
      title: 'New document',
      content: '# Custom notes',
      document_type: 'custom',
    });

    expect(result.content).toContain('Successfully created');
    expect(result.content).toContain('CUSTOM');
    expect(result.content).toContain('New document');
    expect(result.documentChange.action).toBe('created');
    expect(result.documentChange.title).toBe('New document');
    expect(result.documentChange.document_id).toMatch(/^doc_/);
    expect(docClient.send).toHaveBeenCalledTimes(1);
    expect(docClient.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        TransactItems: expect.arrayContaining([
          expect.objectContaining({ Put: expect.objectContaining({ Item: expect.any(Object) }) }),
          expect.objectContaining({
            Update: expect.objectContaining({
              ConditionExpression: expect.stringContaining('#status <> :deletingStatus'),
              ExpressionAttributeNames: {
                '#deleting': 'deletion_started_at',
                '#status': 'status',
              },
              ExpressionAttributeValues: expect.objectContaining({
                ':deletingStatus': 'deleting',
                ':deletedStatus': 'deleted',
              }),
            }),
          }),
        ]),
      }),
    }));
  });

  it('accepts custom documents and refuses managed PRD types', async () => {
    const customClient = createMockDocClient(() => Promise.resolve({}));
    const custom = await executeCreateDocument(customClient, 'projects-table', 'proj-1', {
      title: 'Notes',
      content: 'content',
      document_type: 'custom',
    });
    const managed = await executeCreateDocument(
      createMockDocClient(() => Promise.resolve({})),
      'projects-table',
      'proj-1',
      { title: 'Spec', content: 'content', document_type: 'prd' },
    );

    expect(custom.documentChange.action).toBe('created');
    expect(managed.content).toContain('Invalid input');
  });
});

describe('executeUpdateDocument prototype boundary', () => {
  it.each([
    {
      name: 'canonical prototype type',
      sk: 'DOC#prototype-1',
      documentType: 'prototype',
    },
    {
      name: 'legacy prototype sort key',
      sk: 'PROTOTYPE#prototype-1',
      documentType: undefined,
    },
  ])('rejects a $name before UpdateCommand', async ({ sk, documentType }) => {
    const docClient = createMockDocClient(() => Promise.resolve({
      Items: [{
        pk: 'PROJECT#proj-1',
        sk,
        document_id: 'prototype-1',
        document_type: documentType,
        title: 'Prototype',
      }],
    }));

    await expect(executeUpdateDocument(docClient, 'projects-table', 'proj-1', {
      document_id: 'prototype-1',
      content: '<html>changed</html>',
      summary: 'changed prototype',
    })).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/prototype revision workflow/i),
      statusCode: 400,
    });

    expect(docClient.send).toHaveBeenCalledTimes(1);
  });
});
