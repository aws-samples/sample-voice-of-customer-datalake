/**
 * The assistant stream accepts only tokens issued to the SPA's own Cognito app client (or the board
 * pool's): the same rule as lambda/shared/app_clients.py, which every Python API applies.
 *
 * API Gateway's Cognito authorizer accepts a token of ANY client of the pool, including the MCP OAuth
 * clients. The stream forwards only sub / groups / username / email to the domain APIs, so the APIs
 * cannot see the client any more: the check has to happen here, before a run starts.
 *
 * A claim set is a token when it carries `token_use`, `aud` or `client_id` (Cognito always sets
 * `token_use`, plus `aud` on an ID token and `client_id` on an access token). The issuing client must be
 * one of `APP_CLIENT_IDS` (set on every VocApiStack function, lib/utils/app-client-env.ts). Fails closed:
 * no issuing client, or no `APP_CLIENT_IDS`, refuses every token.
 */
import { UnauthorizedError } from './errors.js';

export const APP_CLIENT_IDS_ENV = 'APP_CLIENT_IDS';
const TOKEN_MARKER_CLAIMS: readonly string[] = ['token_use', 'aud', 'client_id'];

function allowedClientIds(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env[APP_CLIENT_IDS_ENV] ?? '').split(',').map((part) => part.trim()).filter(Boolean));
}

/** `client_id` (access token) or `aud` (ID token); undefined when neither is a non-empty string. */
export function issuingClient(claims: Record<string, unknown>): string | undefined {
  for (const name of ['client_id', 'aud']) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Throws UnauthorizedError (401) when the caller's token was issued to a client this API does not serve. */
export function requireAppClient(claims: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  if (!TOKEN_MARKER_CLAIMS.some((name) => name in claims)) return;
  const client = issuingClient(claims);
  if (client === undefined || !allowedClientIds(env).has(client)) {
    throw new UnauthorizedError('This sign-in is not valid for this API');
  }
}
