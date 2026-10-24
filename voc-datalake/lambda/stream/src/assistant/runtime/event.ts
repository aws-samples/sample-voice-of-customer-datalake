/**
 * Lambda event parsing and caller identity.
 *
 * API Gateway REST (Cognito user-pool authorizer) delivers the token claims as
 * strings under `requestContext.authorizer.claims`. `cognito:groups` arrives as
 * a single string, either bracketed and space-separated (`"[admins users]"`)
 * or comma-separated (`"admins,users"`), depending on the integration.
 *
 * Identity fails closed: no usable `sub` is an UnauthorizedError, never an
 * anonymous run.
 */
import { z } from 'zod';
import type { CallerClaims } from '../types.js';
import { UnauthorizedError } from './errors.js';

const lambdaEventSchema = z.object({
  body: z.string().nullish(),
  isBase64Encoded: z.boolean().optional(),
  headers: z.record(z.string(), z.string().optional()).nullish(),
  requestContext: z.object({
    authorizer: z.object({
      claims: z.record(z.string(), z.unknown()).optional(),
    }).loose().nullish(),
  }).loose().optional(),
}).loose();

export type LambdaEvent = z.infer<typeof lambdaEventSchema>;

export function parseLambdaEvent(raw: unknown): LambdaEvent {
  const parsed = lambdaEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** Raw body text, decoding base64 when API Gateway flagged it. */
export function getBodyText(event: LambdaEvent): string {
  const body = event.body ?? '';
  return event.isBase64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body;
}

function claimString(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Only these claims are forwarded to internal API invocations. */
export function extractCallerClaims(event: LambdaEvent): CallerClaims {
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const sub = claimString(claims, 'sub');
  if (!sub) {
    throw new UnauthorizedError('Authenticated user identity is required');
  }
  const groups = claimString(claims, 'cognito:groups');
  const username = claimString(claims, 'cognito:username');
  const email = claimString(claims, 'email');
  return {
    sub,
    ...(groups ? { 'cognito:groups': groups } : {}),
    ...(username ? { 'cognito:username': username } : {}),
    ...(email ? { email } : {}),
  };
}

/** Split the API Gateway group string into names. */
export function parseGroups(groups: string | undefined): string[] {
  if (!groups) return [];
  return groups
    .replaceAll(/[[\]]/g, ' ')
    .split(/[\s,]/)
    .filter((group) => group.length > 0);
}

export function isAdminCaller(claims: CallerClaims): boolean {
  return parseGroups(claims['cognito:groups']).includes('admins');
}
