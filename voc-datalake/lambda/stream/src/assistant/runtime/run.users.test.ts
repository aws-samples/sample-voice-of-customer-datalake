/**
 * User-administration writes end to end through the runtime: a valid
 * create_user ends the run with a tool_approval interrupt carrying exactly the
 * validated (trimmed) args; an existing email, the caller's own role, a failed
 * directory read or a non-admin caller is answered with an error toolResult
 * and no card.
 */
import { describe, expect, it } from 'vitest';
import { runBody } from './__fixtures__/fakes.js';
import {
  errorToolResult,
  finished,
  harness,
  lastToolCallArgs,
  lastUserContent,
  run,
  silenceConsole,
  type Harness,
} from './__fixtures__/harness.js';
import { buildCatalogue } from '../tools/catalogue.js';
import { selectToolset } from '../tools/registry.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { nth } from '../../lib/nth-fixtures.js';

silenceConsole();

const PAGE = { kind: 'settings', path: '/settings' } as const;
const ADMIN = { sub: 'admin-sub', 'cognito:groups': 'admins', 'cognito:username': 'admin-1' };
const PROPOSAL = { email: '  Jane@Example.com ', role: 'users', given_name: ' Jane ' };
const SELF_DEMOTION = { username: 'admin-1', updates: { role: 'users' } };
const ROOT = { username: 'admin-1', sub: 'admin-sub', email: 'root@example.com', groups: ['admins'] };
const JANE = { username: 'u-jane', email: 'jane@example.com', groups: ['users'] };

interface Scenario {
  /** `GET /users` answers these rows; `undefined` = the route cannot be read. */
  users?: unknown[];
  isAdmin?: boolean;
  tool?: string;
  input?: Record<string, unknown>;
}

/** A run on the Settings page whose model turn proposes one user write. */
function usersHarness({ users, isAdmin = true, tool = 'create_user', input = PROPOSAL }: Scenario): Harness {
  const catalogue = buildCatalogue(fakeDeps(users === undefined ? {} : { 'GET /users': { success: true, users } }));
  const toolset = selectToolset(catalogue, { page: PAGE, isAdmin, webSearch: false, alsoInclude: [tool] });
  return harness([{ text: 'On it.', toolUses: [{ id: 'tu_u', name: tool, input }] }, { text: 'Noted.' }], toolset);
}

const body = runBody({ forwardedProps: { page: PAGE } });

describe('create_user through the runtime', () => {
  it('ends the run with an approval interrupt for exactly the validated args', async () => {
    const events = await run(body, usersHarness({ users: [ROOT] }), ADMIN);
    expect(finished(events).outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'approval:tu_u', reason: 'tool_approval', message: 'Create user Jane@Example.com (users).', metadata: { toolName: 'create_user', risk: 'write' } }],
    });
    expect(lastToolCallArgs(events)).toStrictEqual({ email: 'Jane@Example.com', role: 'users', given_name: 'Jane' });
  });
});

describe('refusals through the runtime', () => {
  it.each<[string, Scenario, Record<string, string> | undefined, string]>([
    [
      'an existing email',
      { users: [ROOT, JANE] },
      ADMIN,
      'Error: a user with email "Jane@Example.com" already exists (username u-jane). To change them, propose update_user.',
    ],
    [
      'a non-admin caller (the tool is not even offered)',
      { users: [ROOT], isAdmin: false },
      undefined,
      'Error: unknown tool "create_user".',
    ],
    [
      'the caller\u2019s own role change',
      { users: [ROOT], tool: 'update_user', input: SELF_DEMOTION },
      ADMIN,
      'Error: you cannot change your own role or enabled state. Another administrator must do that.',
    ],
    [
      'a directory that cannot be read (nothing unverified is proposed)',
      { tool: 'update_user', input: SELF_DEMOTION },
      ADMIN,
      'Error: could not check the current state before proposing update_user (The tool failed unexpectedly. Tell the user the data '
        + 'could not be read right now.). Try again.',
    ],
  ])('%s is answered with an error result, no card, and the run completes', async (_label, scenario, claims, text) => {
    const h = usersHarness(scenario);
    const events = await run(body, h, claims);
    expect(lastUserContent(nth(h.calls, 1))).toStrictEqual(errorToolResult('tu_u', text));
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });
});
