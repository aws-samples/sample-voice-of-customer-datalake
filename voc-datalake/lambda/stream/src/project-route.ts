/**
 * Event parsing and authenticated project-route identity helpers.
 */
import { z } from 'zod';
import { ValidationError } from './lib/errors.js';

const lambdaEventSchema = z.object({
  body: z.string().optional(),
  rawPath: z.string().optional(),
  path: z.string().optional(),
  requestContext: z.object({
    http: z.object({ path: z.string().optional(), method: z.string().optional() }).optional(),
    resourcePath: z.string().optional(),
    authorizer: z.object({ claims: z.record(z.string()).optional() }).optional(),
  }).optional(),
  headers: z.record(z.string()).optional(),
  resource: z.string().optional(),
}).passthrough();

export type LambdaEvent = z.infer<typeof lambdaEventSchema>;

function getPath(event: LambdaEvent): string {
  return (
    event.rawPath
    ?? event.requestContext?.http?.path
    ?? event.path
    ?? event.resource
    ?? ''
  );
}

function extractProjectId(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  const projectsIndex = parts.indexOf('projects');
  return projectsIndex >= 0 && projectsIndex + 1 < parts.length
    ? parts[projectsIndex + 1]
    : null;
}

export function parseLambdaEvent(raw: unknown): LambdaEvent {
  const parsed = lambdaEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function resolveProjectId(
  event: LambdaEvent,
  requestedProjectId: string | undefined,
): string | null {
  return requestedProjectId ?? extractProjectId(getPath(event));
}

export function requireProjectCallerSubject(event: LambdaEvent): string {
  const subject = event.requestContext?.authorizer?.claims?.sub;
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new ValidationError('Authenticated user subject is required for project chat');
  }
  return subject;
}
