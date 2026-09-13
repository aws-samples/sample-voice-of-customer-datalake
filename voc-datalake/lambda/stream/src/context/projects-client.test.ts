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

  it.each([undefined, '', '   '])(
    'refuses a missing or blank caller subject before invocation: %j',
    async (callerSubject) => {
      const send = vi.fn<(command: InvokeCommand) => Promise<InvocationResponse>>();
      const loadProject = createProjectsLambdaLoader({ send }, 'voc-projects-api');

      await expect(loadProject('p1', [], callerSubject)).rejects.toMatchObject({
        name: 'ValidationError',
        statusCode: 400,
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('posts selected IDs with the exact caller subject and returns bounded canonical rows', async () => {
    const canonicalDocument = {
      sk: 'PRD#d2',
      document_id: 'd2',
      document_type: 'prd',
      base_title: 'Launch',
      version: 2,
      title: 'Launch (v2)',
      content: '# Launch',
    };
    const canonicalPersona = {
      sk: 'PERSONA#one',
      persona_id: 'one',
      name: 'Builder',
      tagline: 'Ships products',
      quotes: [{ text: 'Make it useful' }],
      goals_motivations: { primary_goal: 'Ship' },
      pain_points: { current_challenges: ['Delay'] },
      avatar_url: null,
    };
    const callerSubject = 'cognito-user-42';
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
        requestContext: { authorizer: { claims: { sub: callerSubject } } },
      });
      expect(JSON.stringify(event)).not.toContain('chat-stream');
      return Promise.resolve(proxyResponse(200, {
        project: {
          pk: 'PROJECT#p1',
          sk: 'META',
          project_id: 'p1',
          name: 'Launch project',
          unexpected_project_field: 'must not cross',
        },
        personas: [{
          pk: 'PROJECT#p1',
          ...canonicalPersona,
          unexpected_persona_field: 'must not cross',
        }],
        documents: [{
          pk: 'PROJECT#p1',
          ...canonicalDocument,
          unexpected_document_field: 'must not cross',
        }],
      }));
    });

    const rows = await createProjectsLambdaLoader(
      { send }, 'voc-projects-api',
    )('p1', ['d2'], callerSubject);

    expect(rows).toStrictEqual([
      { sk: 'META', name: 'Launch project' },
      canonicalPersona,
      canonicalDocument,
    ]);
  });

  it('maps a canonical Projects API 404 to NotFoundError', async () => {
    const send = vi.fn((_command: InvokeCommand) => Promise.resolve(
      proxyResponse(404, { message: 'Project not found' }),
    ));
    const loadProject = createProjectsLambdaLoader({ send }, 'voc-projects-api');

    await expect(loadProject('missing', [], 'cognito-user-42')).rejects.toMatchObject({
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

    await expect(loadProject('p1', ['large'], 'cognito-user-42')).rejects.toMatchObject({
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

    await expect(loadProject('p1', [], 'cognito-user-42')).rejects.toThrow(
      'Projects API returned an invalid project',
    );
  });
});
