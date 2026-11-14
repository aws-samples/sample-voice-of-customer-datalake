/**
 * `propose_knowledge_refresh`: the model only proposes (a client tool: a card, never executed here), administrators
 * only, never a plan step and no MCP tool; its arguments and estimate are held to the server's own rules, read as
 * text (the runtime's id and rates, the map step's cap, the stack's languages, the MCP catalogue).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, CLIENT_TOOLS, SERVER_TOOLS } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS } from '../../plan/schema.js';
import { PLAN_STEP_WRITE_TOOLS } from '../../plan/write-requests.js';
import { clientToolLookup, fakeContext } from '../test-fixtures.js';
import {
  AGENTCORE_RATES, DRAFT_MINUTES, MAX_SHARD_CAP, REFRESH_LANGUAGES, SECONDS_PER_SHARD, STANDARD_SESSION,
  knowledgeRefreshArgsSchema, refreshEstimate, refreshGoal,
} from '../knowledge-refresh-rules.js';

const NAME = 'propose_knowledge_refresh';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
// The server's own files, from static parts only (lambda/stream/src/assistant/tools/client → lambda).
const LAMBDA = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MCP_TOOLS = join(LAMBDA, 'shared/mcp_global_tools.py');
const MCP_STEP_TOOLS = join(LAMBDA, 'shared/mcp_global_tools_steps.py');
const AGENTS_HANDLER = join(LAMBDA, 'api/agents_handler.py');
const CAPS = join(LAMBDA, 'engineering/runtime/caps.py');
const INTERFACE = join(LAMBDA, 'engineering/runtime/interface.py');
const WORKFLOW_ENGINEERING = join(LAMBDA, 'shared/workflow_engineering.py');
const AGENTCORE_STACK = join(LAMBDA, '../lib/stacks/engineering-agentcore.ts');
const TEMPLATES = join(LAMBDA, 'shared/engineering_flow_templates.json');
const TEXT = {
  'shared/mcp_global_tools.py': readFileSync(MCP_TOOLS, 'utf8'),
  'shared/mcp_global_tools_steps.py': readFileSync(MCP_STEP_TOOLS, 'utf8'),
  'api/agents_handler.py': readFileSync(AGENTS_HANDLER, 'utf8'),
  'engineering/runtime/caps.py': readFileSync(CAPS, 'utf8'),
  'engineering/runtime/interface.py': readFileSync(INTERFACE, 'utf8'),
  'shared/workflow_engineering.py': readFileSync(WORKFLOW_ENGINEERING, 'utf8'),
  '../lib/stacks/engineering-agentcore.ts': readFileSync(AGENTCORE_STACK, 'utf8'),
  'shared/engineering_flow_templates.json': readFileSync(TEMPLATES, 'utf8'),
} as const;
const read = (path: keyof typeof TEXT): string => TEXT[path];

const tool = clientToolLookup()(NAME);
const admin = fakeContext('agents', {}, { isAdmin: true });
const user = fakeContext('agents');

describe('propose_knowledge_refresh: a proposal, never an action', () => {
  it('is a client tool of the agents pack: the server has nothing to run, only a card to show', () => {
    expect({ kind: tool.kind, pack: tool.pack, risk: tool.risk }).toStrictEqual({ kind: 'client', pack: 'agents', risk: 'write' });
    expect('execute' in tool).toBe(false);
    expect(CLIENT_TOOLS.agents).toContain(NAME);
    expect(Object.values(SERVER_TOOLS).flat()).not.toContain(NAME);
  });

  it('is offered to administrators only and refused for anyone else', () => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(NAME);
    expect(tool.validate({ connection: 'acme-shop' }, user)).toStrictEqual({
      ok: false, error: `${NAME} is only available to administrators.`,
    });
    expect(tool.validate({ connection: 'acme-shop' }, admin)).toStrictEqual({ ok: true, args: { connection: 'acme-shop' } });
  });

  it('is never a plan step: only its own card may start the run', () => {
    expect(CARD_ONLY_WRITE_TOOLS).toContain(NAME);
    expect(PLAN_STEP_WRITE_TOOLS).not.toContain(NAME);
  });

  it('has no MCP tool (an MCP token never acts as an administrator)', () => {
    const catalogue = read('shared/mcp_global_tools.py') + read('shared/mcp_global_tools_steps.py');
    expect(catalogue).not.toMatch(/knowledge_refresh|engineering\/runs/);
  });

  it('gives the model the template’s estimate, the template having two agent steps and the most shards', () => {
    expect(tool.spec.toolSpec?.description).toContain('about 77 minutes and $1.50 of agent session time');
    const templates = JSON.parse(read('shared/engineering_flow_templates.json')) as {
      templates: { template_id: string; definition: { nodes: { type: string; data: { params?: { shard_cap?: number } } }[] } }[]
    };
    const understand = templates.templates.find((t) => t.template_id === 'understand-repository')?.definition.nodes ?? [];
    expect(understand.filter((node) => node.type === 'agent')).toHaveLength(2);
    expect(understand.find((node) => node.type === 'map')?.data.params?.shard_cap).toBe(MAX_SHARD_CAP);
  });

  it('tells the model it only proposes and that the run is data', () => {
    const description = tool.spec.toolSpec?.description ?? '';
    expect(description).toContain('you never start it');
    expect(description).toContain('is data');
    expect(description).toContain('Requires the user’s approval');
  });
});

describe('its arguments', () => {
  it.each<[Record<string, unknown>, boolean]>([
    [{ connection: 'acme-shop' }, true],
    [{ connection: 'acme-shop', commit: COMMIT, language: 'rust' }, true],
    [{ connection: 'acme-shop', commit: COMMIT.toUpperCase() }, true],
    [{ connection: 'acme shop' }, false],
    [{ connection: 'a'.repeat(64) }, false],
    [{ connection: 'acme-shop', commit: COMMIT.slice(0, 39) }, false],
    [{ connection: 'acme-shop', commit: 'main' }, false],
    [{ connection: 'acme-shop', language: 'cobol' }, false],
    [{ connection: 'acme-shop', workflow_id: 'wf_1' }, false],
    [{ commit: COMMIT }, false],
  ])('%o → %s', (args, expected) => {
    expect(tool.validate(args, admin).ok).toBe(expected);
  });

  it('summarises the repository and the commit, or the default branch’s head', () => {
    expect(tool.summarize({ connection: 'acme-shop', commit: COMMIT.toUpperCase() }))
      .toBe(`Refresh the knowledge pack of repository connection acme-shop at commit ${COMMIT}.`);
    expect(tool.summarize({ connection: 'acme-shop' }))
      .toBe('Refresh the knowledge pack of repository connection acme-shop at the default branch’s head.');
  });

  it('keeps the goal within the server’s limit', () => {
    const max = Number(/^MAX_RUN_GOAL = (\d+)$/m.exec(read('api/agents_handler.py'))?.[1]);
    expect(refreshGoal('a'.repeat(63)).length).toBeLessThanOrEqual(max);
  });
});

describe('the estimate', () => {
  it('is minutes for the shards and the drafting, and the coordinator’s and every agent step’s session', () => {
    expect(refreshEstimate(200, 2)).toStrictEqual({
      minutes: Math.ceil((200 * SECONDS_PER_SHARD) / 60 + DRAFT_MINUTES),
      sessions: 3,
      sessionUsdPerHour: 2 * 0.1276 + 8 * 0.0169,
      sessionUsd: (3 * (2 * 0.1276 + 8 * 0.0169) * 77) / 60,
    });
    expect([refreshEstimate(200, 2).minutes, refreshEstimate(30, 2).minutes, refreshEstimate(1, 2).minutes]).toStrictEqual([77, 20, 11]);
    expect(refreshEstimate(200, 2).sessionUsd.toFixed(2)).toBe('1.50');
  });

  it('takes the most shards for a cap off the map step’s rule, and always counts the coordinator', () => {
    for (const cap of [0, -1, 201, 2.5, Number.NaN]) expect(refreshEstimate(cap, 2)).toStrictEqual(refreshEstimate(MAX_SHARD_CAP, 2));
    expect([refreshEstimate(200, 0).sessions, refreshEstimate(200, -1).sessions, refreshEstimate(200, 1.5).sessions]).toStrictEqual([1, 1, 1]);
  });

  it('uses the runtime’s published rates, its standard session and the map step’s cap', () => {
    const caps = read('engineering/runtime/caps.py');
    expect(caps).toContain(`'vcpuHour': '${String(AGENTCORE_RATES.vcpuHour)}'`);
    expect(caps).toContain(`'gbHour': '${String(AGENTCORE_RATES.gbHour)}'`);
    expect(caps).toContain(`STANDARD_SIZE: Final = SessionSize(vcpus=${String(STANDARD_SESSION.vcpus)}, gb=${String(STANDARD_SESSION.gb)})`);
    expect(read('shared/workflow_engineering.py')).toContain(`MAX_SHARD_CAP: Final = ${String(MAX_SHARD_CAP)}`);
  });

  it('offers the languages the stack has images for, and the runtime’s connection ids', () => {
    const stack = /const IMAGE_LANGUAGES = \[([^\]]*)\]/.exec(read('../lib/stacks/engineering-agentcore.ts'))?.[1] ?? '';
    expect([...stack.matchAll(/'([^']+)'/g)].map((m) => m[1])).toStrictEqual([...REFRESH_LANGUAGES]);
    expect(read('engineering/runtime/interface.py')).toContain('MAX_ID_LENGTH: Final = 63');
    expect(knowledgeRefreshArgsSchema.safeParse({ connection: 'a'.repeat(63) }).success).toBe(true);
  });
});
