/**
 * Test fixtures for the tool catalogue (imported by *.test.ts only).
 */
import type { BaseEvent } from '@ag-ui/core';
import type { PageContext, PageKind } from '../contract.js';
import type { AssistantRunContext, ClientToolDefinition, ServerToolDefinition } from '../types.js';
import { buildCatalogue } from './catalogue.js';
import type { ToolDeps } from './deps.js';
import type { ApiCall } from './internal-api.js';
import { ProjectAccessLedger } from './project-access.js';
import { ServiceError } from '../../lib/errors.js';

/**
 * A resolver's "nothing configured" answer (`string | undefined` contracts: no
 * avatar, no admin model override), spelled without a literal `undefined` so a
 * fake states it explicitly yet stays within unicorn/no-useless-undefined.
 */
export const UNSET: { readonly value?: string } = {};

interface RecordedCall {
  call: ApiCall;
  sub: string;
}

export interface FakeDeps extends ToolDeps {
  calls: RecordedCall[];
}

/** Deps whose invoker answers from `routes` keyed by `METHOD path`. */
export function fakeDeps(routes: Record<string, unknown> = {}, overrides: Partial<ToolDeps> = {}): FakeDeps {
  const calls: RecordedCall[] = [];
  return {
    calls,
    invoke: (call, claims) => {
      calls.push({ call, sub: claims.sub });
      const key = `${call.method} ${call.path}`;
      if (!(key in routes)) return Promise.reject(new ServiceError(`unexpected route ${key}`));
      const answer = routes[key];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    searchFeedback: () => Promise.resolve({ items: [], formatted: 'No feedback found matching the search criteria.' }),
    webSearch: () => Promise.resolve({ content: 'No web results found for this query.', webSources: [] }),
    converse: () => Promise.reject(new ServiceError('converse not stubbed')),
    // "No avatar" is spelled `undefined` by the real resolver; the fake must say it explicitly.
    resolveAvatar: () => Promise.resolve(UNSET.value),
    fallbackModelId: undefined,
    ...overrides,
  };
}

export interface FakeContext extends AssistantRunContext {
  events: BaseEvent[];
}

export function fakeContext(
  kind: PageKind = 'dashboard',
  page: Partial<PageContext> = {},
  overrides: Partial<AssistantRunContext> = {},
): FakeContext {
  const events: BaseEvent[] = [];
  const fullPage: PageContext = { kind, path: '/', ...page };
  return {
    events,
    claims: { sub: 'user-sub', 'cognito:groups': 'users' },
    isAdmin: false,
    page: fullPage,
    props: { page: fullPage },
    modelId: 'global.anthropic.claude-sonnet-5',
    emit: (event) => {
      events.push(event);
    },
    projectAccess: new ProjectAccessLedger(),
    ...overrides,
  };
}

/** The named server tool of the catalogue built over `deps`. */
export function serverTool(deps: ToolDeps, name: string): ServerToolDefinition {
  const found = buildCatalogue(deps).find((tool) => tool.name === name);
  if (found?.kind !== 'server') throw new TypeError(`no server tool ${name}`);
  return found;
}

/** Every client (write) tool of a catalogue over fake deps, by name. */
export function clientToolsByName(): Map<string, ClientToolDefinition> {
  return new Map(buildCatalogue(fakeDeps())
    .filter((tool): tool is ClientToolDefinition => tool.kind === 'client')
    .map((tool) => [tool.name, tool]));
}

/** A lookup over `clientToolsByName()` that fails loudly on an unknown name. */
export function clientToolLookup(): (name: string) => ClientToolDefinition {
  const tools = clientToolsByName();
  return (name) => {
    const found = tools.get(name);
    if (!found) throw new TypeError(`no client tool ${name}`);
    return found;
  };
}
