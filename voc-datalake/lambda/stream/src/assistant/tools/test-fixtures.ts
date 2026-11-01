/**
 * Test fixtures for the tool catalogue (imported by *.test.ts only).
 */
import type { BaseEvent } from '@ag-ui/core';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
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
/** The same for a row reader's "no such row". */
export const UNSET_ROW: { readonly value?: Record<string, unknown> } = {};

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
    searchAppStore: () => Promise.resolve([]),
    // Found, without details: a connector test that does not stub the store sees no extra card text.
    lookupStoreApp: () => Promise.resolve({ status: 'found', app: { name: '', developer: '' } }),
    readSourceRun: () => Promise.resolve(UNSET_ROW.value),
    // A fixed clock and an instant pause: a polling tool's loop runs without real waits.
    nowMs: () => 1_000_000,
    sleep: () => Promise.resolve(),
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

/** Every client (write) tool of a catalogue over `deps` (fake by default), by name. */
export function clientToolsByName(deps: ToolDeps = fakeDeps()): Map<string, ClientToolDefinition> {
  return new Map(buildCatalogue(deps)
    .filter((tool): tool is ClientToolDefinition => tool.kind === 'client')
    .map((tool) => [tool.name, tool]));
}

/** A lookup over `clientToolsByName(deps)` that fails loudly on an unknown name. */
export function clientToolLookup(deps: ToolDeps = fakeDeps()): (name: string) => ClientToolDefinition {
  const tools = clientToolsByName(deps);
  return (name) => {
    const found = tools.get(name);
    if (!found) throw new TypeError(`no client tool ${name}`);
    return found;
  };
}

/** A non-streaming Converse answer with this text (consult_personas, the persona round); optional thinking first. */
export function converseAnswer(text: string, reasoning?: string): ConverseCommandOutput {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [...(reasoning === undefined ? [] : [{ reasoningContent: { reasoningText: { text: reasoning } } }]), { text }],
      },
    },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
    $metadata: {},
  };
}
