/**
 * The MCP OAuth client kinds live in three places: CLIENT_KINDS in lambda/shared/mcp_oauth_config.py (what
 * the facade registers and answers), OAUTH_CLIENT_KINDS in frontend/src/api/oauthSummarySchema.ts (the
 * strict `z.enum` the consent page and the sign-in snippets parse with, re-exported through oauthSchema.ts)
 * and McpOAuthClientKind in lib/stacks/api-mcp-oauth.ts (the Cognito clients VocApiStack creates). A kind
 * the backend adds but the SPA does not know makes the consent page refuse that client's every approval,
 * so the three lists are pinned to each other here, in order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceStringConstant } from '../test-support/cross-language-invariants';

const ROOT = join(__dirname, '..', '..');
const PYTHON_CONFIG = ['lambda', 'shared', 'mcp_oauth_config.py'];

/** CLIENT_KINDS: a tuple of `KIND_*` names, each resolved to its string constant. */
function pythonClientKinds(): string[] {
  const source = readFileSync(join(ROOT, ...PYTHON_CONFIG), 'utf8');
  const tuple = /^CLIENT_KINDS: Final\[tuple\[str, \.\.\.\]\] = \(([^)]*)\)$/m.exec(source)?.[1];
  if (tuple === undefined) throw new Error('mcp_oauth_config.py: no CLIENT_KINDS tuple');
  return tuple.split(',').map((name) => name.trim()).filter((name) => name !== '')
    .map((name) => sourceStringConstant(name, ...PYTHON_CONFIG));
}

/** The single-quoted strings of the first match group of `pattern` in `file`. */
function quotedList(file: string, pattern: RegExp): string[] {
  const list = pattern.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1];
  if (list === undefined) throw new Error(`${file}: no match for ${String(pattern)}`);
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('MCP OAuth client kinds', () => {
  const python = pythonClientKinds();

  it('reads a real list from the backend (not vacuous)', () => {
    expect(python).toContain('kiro');
    expect(python.length).toBeGreaterThanOrEqual(4);
  });

  it('the SPA schema knows exactly the backend kinds, in order', () => {
    const spa = quotedList('frontend/src/api/oauthSummarySchema.ts', /^export const OAUTH_CLIENT_KINDS = \[([^\]]*)\] as const$/m);
    expect(spa).toStrictEqual(python);
  });

  it('VocApiStack creates a client for exactly the backend kinds', () => {
    const cdk = quotedList('lib/stacks/api-mcp-oauth.ts', /^export type McpOAuthClientKind = ([^;]*);$/m);
    expect(cdk).toStrictEqual(python);
  });
});
