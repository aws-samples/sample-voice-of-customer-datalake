import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_CLIENT_TOOLS,
  CLIENT_TOOLS,
  DESTRUCTIVE_CLIENT_TOOLS,
  PAGE_KINDS,
  packsForPage,
  SERVER_TOOLS,
  TOOL_PACKS,
  type PageKind,
} from '../contract.js';
import type { ToolsetOptions } from '../types.js';
import { buildCatalogue } from './catalogue.js';
import { selectToolset, toolGuidance } from './registry.js';
import { fakeDeps } from './test-fixtures.js';

const catalogue = buildCatalogue(fakeDeps());

function options(kind: PageKind, overrides: Partial<ToolsetOptions> = {}): ToolsetOptions {
  return { page: { kind, path: '/' }, isAdmin: false, webSearch: false, ...overrides };
}

function names(kind: PageKind, overrides: Partial<ToolsetOptions> = {}): string[] {
  return selectToolset(catalogue, options(kind, overrides)).tools.map((tool) => tool.name);
}

describe('tool catalogue', () => {
  it('implements every contract tool exactly once, in pack order then contract order', () => {
    const expected = TOOL_PACKS.flatMap((pack) => [...SERVER_TOOLS[pack], ...CLIENT_TOOLS[pack]]);
    expect(catalogue.map((tool) => tool.name)).toStrictEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('gives each tool the pack, kind and risk the contract assigns', () => {
    for (const pack of TOOL_PACKS) {
      for (const name of SERVER_TOOLS[pack]) {
        expect(catalogue.find((tool) => tool.name === name)).toMatchObject({ kind: 'server', pack });
      }
      for (const name of CLIENT_TOOLS[pack]) {
        const risk = DESTRUCTIVE_CLIENT_TOOLS.includes(name) ? 'destructive' : 'write';
        expect(catalogue.find((tool) => tool.name === name)).toMatchObject({ kind: 'client', pack, risk });
      }
    }
  });

  it('names every Bedrock spec after its tool and tells the model about approval for writes', () => {
    for (const tool of catalogue) {
      expect(tool.spec.toolSpec?.name).toBe(tool.name);
      expect(tool.kind === 'server' || (tool.spec.toolSpec?.description ?? '').includes('approval')).toBe(true);
    }
  });
});

describe('selectToolset', () => {
  it.each(PAGE_KINDS)('on %s loads core plus the page packs, deterministically', (kind) => {
    const first = selectToolset(catalogue, options(kind));
    const second = selectToolset(catalogue, options(kind));
    expect(first.bedrockTools).toStrictEqual(second.bedrockTools);
    expect(first.tools.every((tool) => first.packs.includes(tool.pack))).toBe(true);
    expect(first.packs[0]).toBe('core');
    expect([...first.byName.keys()]).toStrictEqual(first.tools.map((tool) => tool.name));
  });

  it('loads project tools on a project page and not elsewhere', () => {
    expect(names('project')).toContain('get_documents');
    expect(names('project')).toContain('update_document');
    expect(names('dashboard')).not.toContain('get_documents');
  });

  it('offers web_search only when enabled', () => {
    expect(names('dashboard')).not.toContain('web_search');
    expect(names('dashboard', { webSearch: true })).toContain('web_search');
  });

  it('drops admin-only packs for non-admins', () => {
    expect(names('settings')).not.toContain('get_brand_settings');
    expect(names('settings', { isAdmin: true })).toContain('get_brand_settings');
  });

  it('drops admin-only write tools for non-admins', () => {
    expect(names('scrapers')).toContain('list_scrapers');
    expect(names('scrapers')).not.toContain('run_scraper');
    expect(names('scrapers', { isAdmin: true })).toContain('run_scraper');
  });

  it('drops admin-only packs and write tools for non-admins even via alsoInclude', () => {
    const sneaky = names('dashboard', { alsoInclude: [...ADMIN_ONLY_CLIENT_TOOLS, 'get_categories_config'] });
    expect(sneaky.filter((name) => ADMIN_ONLY_CLIENT_TOOLS.some((admin) => admin === name))).toStrictEqual([]);
    expect(sneaky).not.toContain('get_categories_config');
  });

  it('includes tools named by the thread tail at their canonical position', () => {
    const tools = names('dashboard', { alsoInclude: ['update_document', 'web_search', 'not_a_tool'] });
    expect(tools).toContain('update_document');
    expect(tools).toContain('web_search');
    expect(tools.indexOf('web_search')).toBeLessThan(tools.indexOf('get_urgent_feedback'));
    expect(tools.indexOf('update_document')).toBeGreaterThan(tools.indexOf('get_resolved_problems'));
  });
});

describe('memory, agents and company packs', () => {
  it('offers memory recall and remember on every page', () => {
    for (const kind of PAGE_KINDS) {
      expect(names(kind)).toStrictEqual(expect.arrayContaining(['search_memory', 'remember', 'update_company_memory']));
    }
  });

  it('loads the memory pack on the memory and agent pages, the agents pack on the agents pages only', () => {
    expect(packsForPage('memory', false)).toStrictEqual(['core', 'memory']);
    expect(packsForPage('agents', false)).toStrictEqual(['core', 'agents', 'memory']);
    expect(packsForPage('agent', false)).toStrictEqual(['core', 'agents', 'memory']);
  });

  it('offers memory curation on the memory and agent pages, agents tools on the agents pages only', () => {
    expect(names('memory')).toContain('forget_memory');
    expect(names('dashboard')).not.toContain('forget_memory');
    expect(names('agent')).toContain('validate_workflow');
    expect(names('memory')).not.toContain('list_agents');
  });

  it('gives non-admins the company reads and their own context on settings, admins the company writes too', () => {
    expect(packsForPage('settings', false)).toStrictEqual(['core', 'company']);
    expect(packsForPage('settings', true)).toStrictEqual(['core', 'settings', 'company']);
  });

  it('offers non-admins the company reads and their own context, admins the company writes', () => {
    expect(names('settings')).toStrictEqual(expect.arrayContaining(['get_company_context', 'update_my_context']));
    expect(names('settings')).not.toContain('update_company_context');
    expect(names('settings', { isAdmin: true })).toContain('update_design_system');
  });

  it('keeps agent writes from non-admins but lets them run and cancel', () => {
    const user = names('agent');
    expect(user).toStrictEqual(expect.arrayContaining(['list_agents', 'run_agent', 'cancel_agent_run']));
    expect(user).not.toContain('create_agent');
    expect(user).not.toContain('update_workflow');
    expect(names('agent', { isAdmin: true })).toStrictEqual(expect.arrayContaining(['create_agent', 'update_workflow']));
  });

  it('guides workflow edits through validate_workflow', () => {
    const agentGuidance = toolGuidance(selectToolset(catalogue, options('agent', { isAdmin: true })));
    expect(agentGuidance).toContain('validate_workflow and fix every error');
    expect(agentGuidance).toContain('COMPLETE new definition');
  });

  it('guides the alignment question through conflicts and the memory scope by example', () => {
    const core = toolGuidance(selectToolset(catalogue, options('dashboard')));
    expect(core).toContain('people said X — is it now Y?');
    expect(core).toContain('"I like you to reply in short" → personal');
    expect(core).toContain('"Our customer demonstrated they xx and xx" → company');
  });
});

describe('toolGuidance', () => {
  it('is deterministic and describes only the loaded packs', () => {
    const projectSet = selectToolset(catalogue, options('project'));
    expect(toolGuidance(projectSet)).toBe(toolGuidance(selectToolset(catalogue, options('project'))));
    expect(toolGuidance(projectSet)).toContain('consult_personas');
    expect(toolGuidance(projectSet)).not.toContain('get_prioritization');
    expect(toolGuidance(projectSet)).toContain('status "executed"');
  });

  it('mentions web search only when it is offered', () => {
    expect(toolGuidance(selectToolset(catalogue, options('dashboard')))).not.toContain('web_search');
    expect(toolGuidance(selectToolset(catalogue, options('dashboard', { webSearch: true })))).toContain('web_search');
  });
});
