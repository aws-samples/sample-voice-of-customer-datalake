import { InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createProjectsLambdaLoader } from './projects-client.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function proxyResponse(statusCode: number, body: unknown): InvocationResponse {
  return {
    StatusCode: 200,
    Payload: encoder.encode(JSON.stringify({
      statusCode,
      body: JSON.stringify(body),
    })),
  };
}

describe('createProjectsLambdaLoader', () => {
  it('fails before invoking when the projects function is not configured', async () => {
    const send = vi.fn<(command: InvokeCommand) => Promise<InvocationResponse>>();
    const loadProject = createProjectsLambdaLoader({ send }, '');

    await expect(loadProject('p1', [])).rejects.toThrow(
      'Projects function not configured',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('posts selected IDs and returns only the bounded canonical row shape', async () => {
    const canonicalDocument = {
      sk: 'PRD#d2',
      document_id: 'd2',
      document_type: 'prd',
      base_title: 'Launch',
      version: 2,
      title: 'Launch (v2)',
      content: '# Launch',
    };
    const send = vi.fn((command: InvokeCommand): Promise<InvocationResponse> => {
      expect(command.input.FunctionName).toBe('voc-projects-api');
      expect(command.input.InvocationType).toBe('RequestResponse');
      const payload = command.input.Payload;
      if (!(payload instanceof Uint8Array)) throw new Error('Expected byte payload');
      const event: unknown = JSON.parse(decoder.decode(payload));
      expect(event).toMatchObject({
        httpMethod: 'POST',
        path: '/projects/p1/chat-context',
        pathParameters: { project_id: 'p1' },
        body: JSON.stringify({ selected_document_ids: ['d2'] }),
        requestContext: { authorizer: { claims: { sub: 'chat-stream' } } },
      });
      return Promise.resolve(proxyResponse(200, {
        project: { pk: 'PROJECT#p1', sk: 'META', project_id: 'p1' },
        personas: [{ pk: 'PROJECT#p1', sk: 'PERSONA#one', persona_id: 'one' }],
        documents: [{ ...canonicalDocument, unexpected_blob: 'must not cross' }],
      }));
    });

    const rows = await createProjectsLambdaLoader(
      { send }, 'voc-projects-api',
    )('p1', ['d2']);

    expect(rows).toStrictEqual([
      { pk: 'PROJECT#p1', sk: 'META', project_id: 'p1' },
      { pk: 'PROJECT#p1', sk: 'PERSONA#one', persona_id: 'one' },
      canonicalDocument,
    ]);
  });

  it('maps a canonical Projects API 404 to NotFoundError', async () => {
    const send = vi.fn((_command: InvokeCommand) => Promise.resolve(
      proxyResponse(404, { message: 'Project not found' }),
    ));
    const loadProject = createProjectsLambdaLoader({ send }, 'voc-projects-api');

    await expect(loadProject('missing', [])).rejects.toMatchObject({
      name: 'NotFoundError',
      message: 'Project not found',
      statusCode: 404,
    });
  });

  it('maps an oversized context response to an actionable validation error', async () => {
    const send = vi.fn((_command: InvokeCommand) => Promise.resolve(
      proxyResponse(413, { message: 'Select fewer or smaller documents.' }),
    ));
    const loadProject = createProjectsLambdaLoader({ send }, 'voc-projects-api');

    await expect(loadProject('p1', ['large'])).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Select fewer or smaller documents.',
      statusCode: 400,
    });
  });

  it('rejects malformed successful project payloads at the Zod boundary', async () => {
    const send = vi.fn((_command: InvokeCommand) => Promise.resolve(
      proxyResponse(200, { project: 'not-an-object', documents: [] }),
    ));
    const loadProject = createProjectsLambdaLoader({ send }, 'voc-projects-api');

    await expect(loadProject('p1', [])).rejects.toThrow(
      'Projects API returned an invalid project',
    );
  });
});
