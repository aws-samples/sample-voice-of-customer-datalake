import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import { ZodError } from 'zod'
import { ADMIN_ONLY_CLIENT_TOOLS, CLIENT_TOOLS, DESTRUCTIVE_CLIENT_TOOLS } from '../contract'
import { getWriteTool, listWriteTools, toolTitleKey } from './registry'
import type { ClientToolName } from '../contract'

const ALL_CLIENT_TOOLS: ClientToolName[] = Object.values(CLIENT_TOOLS).flat()

const P = 'proj_20260101120000'
const LONG = (n: number) => 'x'.repeat(n)
/** A minimal valid `voc-workflow/1` definition (shape only — graph rules are the Lambda's). */
const WF = {
  schema: 'voc-workflow/1',
  name: 'Mini',
  nodes: [
    { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
    { id: 'e', type: 'end', position: { x: 0, y: 100 }, data: { title: 'End', params: { status: 'completed' } } },
  ],
  edges: [{ id: 'e1', source: 's', target: 'e' }],
  loops: [],
}

/** One valid args object per tool, and invalid variants that must be rejected. */
const CASES: Record<ClientToolName, { good: unknown[]; bad: unknown[] }> = {
  create_project: {
    good: [{ name: 'Onboarding' }, { name: 'A', description: LONG(2000) }],
    bad: [{}, { name: '' }, { name: LONG(201) }, { name: 'x', description: LONG(2001) }, { name: 'x', extra: 1 }],
  },
  set_problem_resolved: {
    good: [{ problem_key: 'delivery|late', resolved: true }],
    bad: [{ problem_key: 'k' }, { problem_key: LONG(301), resolved: false }, { problem_key: 'k', resolved: 'yes' }],
  },
  set_feedback_category: {
    good: [{ feedback_id: 'fb_1', category: 'delivery' }, { feedback_id: 'fb_1', category: 'delivery', subcategory: 'late_delivery' }],
    bad: [
      { feedback_id: 'fb_1' },
      { feedback_id: '../users', category: 'delivery' },
      { feedback_id: 'fb_1', category: LONG(65) },
      { feedback_id: 'fb_1', category: '' },
      { feedback_id: 'fb_1', category: 'delivery', subcategory: '' },
      { feedback_id: 'fb_1', category: 'delivery', extra: 1 },
    ],
  },
  update_document: {
    good: [{ project_id: P, document_id: 'prd_1', content: 'new', change_summary: 'tighten' }],
    bad: [
      { project_id: P, document_id: 'prd_1', content: 'x' },
      { project_id: P, document_id: '../users', content: 'x', change_summary: '' },
      { project_id: P, document_id: 'd', content: LONG(200_001), change_summary: '' },
      { project_id: P, document_id: 'd', content: 'x', change_summary: LONG(501) },
    ],
  },
  create_document: {
    good: [{ project_id: P, title: 'Notes', content: 'x' }],
    bad: [{ project_id: P, title: '', content: 'x' }, { title: 'x', content: 'x' }, { project_id: P, title: 'Notes', content: '' }],
  },
  delete_document: {
    good: [{ project_id: P, document_id: 'doc_1', reason: 'duplicate' }],
    bad: [{ project_id: P, document_id: 'doc_1' }, { project_id: P, document_id: 'a/b', reason: '' }],
  },
  update_persona: {
    good: [
      { project_id: P, persona_id: 'persona_1', updates: { tagline: 'Busy parent' } },
      { project_id: P, persona_id: 'persona_1', updates: { identity: { bio: 'b' }, quotes: [{ text: 'q' }] } },
    ],
    bad: [
      { project_id: P, persona_id: 'persona_1', updates: {} },
      { project_id: P, persona_id: 'persona_1', updates: { avatar_url: 'https://evil.example/x.png' } },
      { project_id: P, persona_id: 'persona_1', updates: { research_notes: [] } },
      { project_id: P, persona_id: 'persona_1', updates: { identity: { unknown: 'x' } } },
      { project_id: P, persona_id: 'persona_1', updates: { confidence: 'certain' } },
    ],
  },
  add_persona_note: {
    good: [{ project_id: P, persona_id: 'persona_1', text: 'Interviewed 3 users' }],
    bad: [{ project_id: P, persona_id: 'persona_1', text: '' }, { project_id: P, persona_id: 'persona_1', text: LONG(2001) }],
  },
  update_project: {
    good: [{ project_id: P, name: 'Renamed' }, { project_id: P, description: '' }],
    bad: [{ project_id: P }, { project_id: P, name: LONG(201) }],
  },
  update_product_context: {
    good: [{ project_id: P, updates: { one_liner: 'x', current_state: 'beta' } }],
    bad: [
      { project_id: P, updates: {} },
      { project_id: P, updates: { one_liner: LONG(201) } },
      { project_id: P, updates: { current_state: 'launched' } },
      { project_id: P, updates: { invented_field: 'x' } },
    ],
  },
  start_research: {
    good: [{ project_id: P, question: 'Why churn?' }, { project_id: P, question: 'q', persona_ids: ['p1'], use_web_search: true }],
    bad: [{ project_id: P, question: '' }, { project_id: P, question: 'q', persona_ids: Array.from({ length: 21 }, (_, i) => `p${i}`) }],
  },
  generate_document: {
    good: [{ project_id: P, doc_type: 'prd', title: 'T', feature_idea: 'Idea' }],
    bad: [{ project_id: P, doc_type: 'onepager', title: 'T', feature_idea: 'I' }, { project_id: P, doc_type: 'prd', title: 'T', feature_idea: LONG(4001) }],
  },
  generate_personas: {
    good: [{ project_id: P, persona_count: 1 }, { project_id: P, persona_count: 8, custom_instructions: 'B2B' }],
    bad: [{ project_id: P, persona_count: 0 }, { project_id: P, persona_count: 9 }, { project_id: P, persona_count: 2.5 }],
  },
  merge_documents: {
    good: [{ project_id: P, output_type: 'custom', title: 'M', instructions: 'Combine', document_ids: ['a', 'b'] }],
    bad: [
      { project_id: P, output_type: 'custom', title: 'M', instructions: 'Combine', document_ids: ['a'] },
      { project_id: P, output_type: 'custom', title: 'M', instructions: 'C', document_ids: Array.from({ length: 11 }, (_, i) => `d${i}`) },
    ],
  },
  update_feedback_form: {
    good: [{ form_id: 'form_1', updates: { enabled: false } }, { form_id: 'form_1', updates: { question: 'How was it?', rating_type: 'emoji' } }],
    bad: [
      { form_id: 'form_1', updates: {} },
      { form_id: 'form_1', updates: { theme: { primary_color: 'red' } } },
      { form_id: 'form_1', updates: { project_id: 'proj_x' } },
      { form_id: 'form_1', updates: { custom_fields: [] } },
    ],
  },
  run_scraper: {
    good: [{ scraper_id: 'scraper_1' }],
    bad: [{}, { scraper_id: 'a?b' }],
  },
  save_brand_settings: {
    good: [{ brand_name: 'Acme' }, { hashtags: ['#acme'], urls_to_track: ['https://acme.example'] }],
    bad: [{}, { brand_handles: [''] }, { hashtags: Array.from({ length: 51 }, () => '#x') }, { brand_name: 'x', other: 1 }],
  },
  // ── Memory ──
  remember: {
    good: [
      { scope: 'personal', statement: 'Reply in short', kind: 'working_style' },
      { scope: 'company', statement: 'Q3 focus is returns', kind: 'objective', retention: 'dated', expires_at: '2026-12-31' },
    ],
    bad: [
      { scope: 'team', statement: 'x', kind: 'other' },
      { scope: 'personal', statement: LONG(501), kind: 'other' },
      { scope: 'personal', statement: 'x', kind: 'other', retention: 'dated' },
      { scope: 'personal', statement: 'x', kind: 'other', expires_at: '2026-12-31' },
      { scope: 'personal', statement: 'x', kind: 'other', expires_at: '31/12/2026', retention: 'dated' },
    ],
  },
  update_company_memory: {
    good: [{ memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', supporters: 3, reason: 'changed' }],
    bad: [
      { memory_id: 'mem_1', previous_statement: 'A', statement: 'A', kind: 'product', reason: 'r' },
      { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product' },
      { memory_id: 'a/b', previous_statement: 'A', statement: 'B', kind: 'product', reason: 'r' },
      { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', reason: 'r', supporters: -1 },
    ],
  },
  forget_memory: {
    good: [{ memory_id: 'mem_1', statement: 'A', reason: 'wrong' }],
    bad: [{ memory_id: 'mem_1', statement: 'A' }, { memory_id: 'mem_1', statement: 'A', reason: LONG(501) }],
  },
  confirm_memory: {
    good: [{ memory_id: 'mem_1', statement: 'A' }],
    bad: [{ memory_id: 'mem_1' }, { memory_id: 'mem_1', statement: 'A', extra: 1 }],
  },
  merge_memories: {
    good: [{ memory_ids: ['mem_1', 'mem_2'], statement: 'Merged' }],
    bad: [
      { memory_ids: ['mem_1'], statement: 'M' },
      { memory_ids: ['mem_1', 'mem_1'], statement: 'M' },
      { memory_ids: Array.from({ length: 11 }, (_, i) => `mem_${i}`), statement: 'M' },
    ],
  },
  resolve_memory_conflict: {
    good: [
      { memory_id: 'mem_1', action: 'keep_both' },
      { memory_id: 'mem_1', action: 'keep', winner_id: 'mem_2' },
      { memory_id: 'mem_1', action: 'replace', winner_id: 'mem_2', statement: 'New' },
      { memory_id: 'mem_1', action: 'merge', statement: 'Both' },
    ],
    bad: [
      { memory_id: 'mem_1', action: 'keep' },
      { memory_id: 'mem_1', action: 'merge' },
      { memory_id: 'mem_1', action: 'keep_both', winner_id: 'mem_2' },
      { memory_id: 'mem_1', action: 'delete' },
    ],
  },
  // ── Autonomous agents ──
  create_agent: {
    good: [
      { name: 'Delivery watcher', scope: { all: true, categories: [], subcategories: [] } },
      {
        name: 'A', scope: { all: false, categories: ['delivery'], subcategories: [] },
        triggers: [{ kind: 'schedule', every: 'cron', cron: '0 6 * * *', timezone: 'UTC' }],
        budget: { max_model_calls_per_run: 1000 }, models: { worker: null },
      },
    ],
    bad: [
      { name: 'A' },
      { name: 'A', scope: { all: false, categories: [], subcategories: [] } },
      { name: 'A', scope: { all: true, categories: [], subcategories: [] }, triggers: [{ kind: 'schedule', every: '24h', cron: '* * * * *', timezone: 'UTC' }] },
      { name: 'A', scope: { all: true, categories: [], subcategories: [] }, budget: { max_scheduled_runs_per_day: 3 } },
      { name: 'A', scope: { all: true, categories: [], subcategories: [] }, enabled: true },
    ],
  },
  update_agent: {
    good: [{ agent_id: 'ag_1', updates: { instructions: 'Focus on returns' }, change_summary: 'focus' }],
    bad: [
      { agent_id: 'ag_1', updates: {}, change_summary: 's' },
      { agent_id: 'ag_1', updates: { owner_sub: 'x' }, change_summary: 's' },
      { agent_id: 'ag_1', updates: { name: 'x' } },
    ],
  },
  enable_agent: { good: [{ agent_id: 'ag_1' }], bad: [{}, { agent_id: 'a?b' }] },
  disable_agent: { good: [{ agent_id: 'ag_1' }], bad: [{}, { agent_id: 'ag_1', extra: 1 }] },
  run_agent: { good: [{ agent_id: 'ag_1' }], bad: [{}, { agent_id: '' }] },
  cancel_agent_run: {
    good: [{ agent_id: 'ag_1', run_id: 'ar_1' }],
    bad: [{ agent_id: 'ag_1' }, { agent_id: 'ag_1', run_id: '../x' }],
  },
  create_workflow: {
    good: [{ definition: WF }],
    bad: [
      { definition: { ...WF, schema: 'voc-workflow/2' } },
      { definition: { ...WF, nodes: [] } },
      { definition: { ...WF, loops: [{ node_ids: ['s'], until: 'review_pass', max_rounds: 6 }] } },
      { definition: { ...WF, nodes: [{ ...WF.nodes[0], type: 'teleport' }] } },
    ],
  },
  update_workflow: {
    good: [{ workflow_id: 'wf_1', expected_revision: 2, definition: WF, change_summary: 'add review' }],
    bad: [
      { workflow_id: 'wf_1', expected_revision: 0, definition: WF, change_summary: 's' },
      { workflow_id: 'wf_1', expected_revision: 2, definition: WF },
      { workflow_id: 'wf_1', expected_revision: 2, definition: { ...WF, edges: undefined }, change_summary: 's' },
    ],
  },
  duplicate_workflow: {
    good: [{ workflow_id: 'wf_default' }, { workflow_id: 'wf_default', name: 'Copy' }],
    bad: [{}, { workflow_id: 'wf_default', name: '' }, { workflow_id: 'wf_default', name: LONG(201) }],
  },
  // ── Company context ──
  update_company_context: {
    good: [{ vision: '# Vision' }, { objectives: [{ title: 'Grow', description: '', horizon: 'date', due: '2026-12-31' }] }],
    bad: [
      {},
      { objectives: [{ title: 'Grow', description: '', horizon: 'date' }] },
      { vision: LONG(20_001) },
      { objectives: Array.from({ length: 51 }, () => ({ title: 't', description: '', horizon: 'long' })) },
    ],
  },
  update_my_context: {
    good: [{ objectives: [] }, { objectives: [{ title: 'NPS', description: '', kpis: [{ name: 'NPS', target: 40 }, { name: 'CSAT', target: '4.5', unit: '/5' }] }] }],
    bad: [
      {},
      { objectives: [{ title: 'NPS', description: '' }] },
      { objectives: [{ title: 'NPS', description: '', kpis: Array.from({ length: 11 }, () => ({ name: 'k', target: 1 })) }] },
    ],
  },
  update_design_system: {
    good: [{ guidelines: 'Use tokens' }, { tokens: { colors: [{ name: 'primary', value: '#7B3FE4' }], typography: [{ role: 'body', family: 'Inter', weight: 400 }] } }],
    bad: [{}, { tokens: { colors: [] } }, { tokens: { colors: [], typography: [], logo: 'x' } }, { logo_url: 'https://x' }],
  },
}

const translate = (key: string, options?: Record<string, unknown>) => `${key}${options ? JSON.stringify(options) : ''}`

describe('write-tool registry', () => {
  it('has exactly one definition per contract client tool', () => {
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(listWriteTools().map((d) => d.name).sort(byName)).toStrictEqual([...ALL_CLIENT_TOOLS].sort(byName))
    for (const name of ALL_CLIENT_TOOLS) expect(getWriteTool(name)?.name).toBe(name)
  })

  it('returns undefined for server tools and unknown names', () => {
    expect(getWriteTool('search_feedback')).toBeUndefined()
    expect(getWriteTool('drop_tables')).toBeUndefined()
  })

  it('derives risk and adminOnly from the contract lists', () => {
    for (const name of ALL_CLIENT_TOOLS) {
      const def = getWriteTool(name)
      expect(def?.risk).toBe(DESTRUCTIVE_CLIENT_TOOLS.includes(name) ? 'destructive' : 'write')
      expect(def?.adminOnly).toBe(ADMIN_ONLY_CLIENT_TOOLS.includes(name))
    }
  })

  it.each(ALL_CLIENT_TOOLS)('%s accepts its good cases and rejects its bad ones', (name) => {
    const def = getWriteTool(name)
    for (const args of CASES[name].good) expect(def?.argsSchema.safeParse(args).success, JSON.stringify(args)).toBe(true)
    for (const args of CASES[name].bad) expect(def?.argsSchema.safeParse(args).success, JSON.stringify(args)).toBe(false)
  })

  it('falls back to the static title for invalid args, and uses args when valid', () => {
    const def = getWriteTool('create_project')
    expect(def?.title({ nope: true }, translate)).toBe(toolTitleKey('create_project'))
    expect(def?.title({ name: 'Acme' }, translate)).toContain('"name":"Acme"')
  })

  it('refuses to execute with invalid args (the erased execute re-validates)', async () => {
    const def = getWriteTool('run_scraper')
    await expect(def?.execute({ scraper_id: '../x' }, { queryClient: new QueryClient(), page: { kind: 'scrapers', path: '/scrapers' } }))
      .rejects.toThrow(ZodError)
  })

  it('has a translated title for every tool in every locale', () => {
    const localesDir = join(process.cwd(), 'public', 'locales')
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'zh']) {
      const json: unknown = JSON.parse(readFileSync(join(localesDir, locale, 'assistantTools.json'), 'utf-8'))
      const tools = typeof json === 'object' && json !== null && 'tools' in json ? json.tools : undefined
      for (const name of ALL_CLIENT_TOOLS) {
        const entry: unknown = typeof tools === 'object' && tools !== null ? Object.entries(tools).find(([k]) => k === name)?.[1] : undefined
        expect(typeof entry === 'object' && entry !== null && 'title' in entry && typeof entry.title === 'string', `${locale}:${name}`).toBe(true)
      }
    }
  })
})
