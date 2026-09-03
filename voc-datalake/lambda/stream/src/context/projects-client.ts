/** Canonical project reads delegated to the Python Projects API Lambda. */
import {
  InvokeCommand,
  LambdaClient,
  type InvocationResponse,
} from '@aws-sdk/client-lambda';
import { z } from 'zod';
import {
  ConfigurationError,
  NotFoundError,
  ServiceError,
  ValidationError,
} from '../lib/errors.js';

const nullableString = z.string().nullish();

const projectSchema = z.object({
  sk: z.literal('META'),
  name: nullableString,
});

const personaSchema = z.object({
  sk: z.string(),
  persona_id: nullableString,
  name: nullableString,
  tagline: nullableString,
  quotes: z.array(z.unknown()).nullish(),
  goals_motivations: z.record(z.unknown()).nullish(),
  pain_points: z.record(z.unknown()).nullish(),
  avatar_url: nullableString,
});

const projectDocumentSchema = z.object({
  sk: z.string(),
  document_id: nullableString,
  document_type: nullableString,
  title: nullableString,
  base_title: nullableString,
  version: z.number().int().positive().nullish(),
  content: nullableString,
});

const projectPayloadSchema = z.object({
  project: projectSchema,
  personas: z.array(personaSchema),
  documents: z.array(projectDocumentSchema),
});

const proxyResponseSchema = z.object({
  statusCode: z.number().int(),
  body: z.string().optional(),
});

const callerSubjectSchema = z.string().refine(
  (value) => value.trim().length > 0,
  'Authenticated user subject is required for project chat',
);
const errorBodySchema = z.object({ message: z.string().optional() }).passthrough();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type ProjectLoader = (
  projectId: string,
  selectedDocumentIds: string[],
  callerSubject?: string,
) => Promise<unknown[]>;

interface LambdaInvoker {
  send(command: InvokeCommand): Promise<InvocationResponse>;
}

function proxyEvent(
  projectId: string,
  selectedDocumentIds: string[],
  callerSubject: string,
): Record<string, unknown> {
  const path = `/projects/${encodeURIComponent(projectId)}/chat-context`;
  return {
    httpMethod: 'POST',
    path,
    resource: '/projects/{project_id}/chat-context',
    queryStringParameters: null,
    pathParameters: { project_id: projectId },
    body: JSON.stringify({ selected_document_ids: selectedDocumentIds }),
    headers: { 'Content-Type': 'application/json' },
    requestContext: {
      authorizer: { claims: { sub: callerSubject } },
      stage: 'v1',
    },
    isBase64Encoded: false,
  };
}

function parseJson(value: string, errorMessage: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ServiceError(errorMessage);
  }
}

function responseMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const parsed = errorBodySchema.safeParse(parseJson(body, 'Projects API returned invalid JSON'));
  return parsed.success ? parsed.data.message : undefined;
}

function requireSuccessfulBody(
  proxy: z.infer<typeof proxyResponseSchema>,
): string {
  if (proxy.statusCode === 404) {
    throw new NotFoundError(responseMessage(proxy.body) ?? 'Project not found');
  }
  if (proxy.statusCode === 413) {
    throw new ValidationError(
      responseMessage(proxy.body) ?? 'Selected project context is too large',
    );
  }
  if (proxy.statusCode < 200 || proxy.statusCode >= 300) {
    throw new ServiceError(responseMessage(proxy.body) ?? 'Projects API request failed');
  }
  if (!proxy.body) throw new ServiceError('Projects API returned an empty project');
  return proxy.body;
}

export function createProjectsLambdaLoader(
  client: LambdaInvoker,
  functionName: string,
): ProjectLoader {
  return async (
    projectId: string,
    selectedDocumentIds: string[],
    callerSubject?: string,
  ): Promise<unknown[]> => {
    if (!functionName) throw new ConfigurationError('Projects function not configured');

    const parsedSubject = callerSubjectSchema.safeParse(callerSubject);
    if (!parsedSubject.success) {
      throw new ValidationError(parsedSubject.error.issues[0]?.message ?? 'Invalid caller subject');
    }

    const response = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: encoder.encode(JSON.stringify(
        proxyEvent(projectId, selectedDocumentIds, parsedSubject.data),
      )),
    }));
    if (response.FunctionError) {
      throw new ServiceError('Projects API invocation failed');
    }
    if (!response.Payload) {
      throw new ServiceError('Projects API returned no response');
    }

    const proxy = proxyResponseSchema.safeParse(
      parseJson(decoder.decode(response.Payload), 'Projects API response was not JSON'),
    );
    if (!proxy.success) {
      throw new ServiceError('Projects API returned an invalid proxy response');
    }
    const body = requireSuccessfulBody(proxy.data);
    const payload = projectPayloadSchema.safeParse(
      parseJson(body, 'Projects API project body was not JSON'),
    );
    if (!payload.success) {
      throw new ServiceError('Projects API returned an invalid project');
    }
    return [payload.data.project, ...payload.data.personas, ...payload.data.documents];
  };
}

export const loadCanonicalProject = createProjectsLambdaLoader(
  new LambdaClient({}),
  process.env.PROJECTS_FUNCTION ?? '',
);
