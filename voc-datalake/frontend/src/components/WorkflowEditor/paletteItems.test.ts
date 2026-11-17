/**
 * @fileoverview The palette's items (7.52.00 C2; docs/ux part 5 §5.5): an engineering flow's sections by kind, each
 * item a block whose drop gives a valid step (the rules the server and engineeringRules.ts hold, the parity fixture's),
 * Registry cards and gate packs as items where they are read, a flow that calls this one offered off with why, the
 * block surviving its trip through the drag's JSON, and Enter adding an item after the selected step, connected.
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { WORKFLOW_SCHEMA_V2 } from '@stream/assistant/tools/agent-limits'
import { addBlock, addBlockAfter, parseBlock, starterDefinition } from './model'
import { engineeringParamsIssues } from './engineeringRules'
import { filterSections, paletteSections } from './paletteItems'
import type { GatesView, RegistryCard } from '../../api/flowSetupApi'
import type { WorkflowSummary } from '../../api/workflowsApi'
import type { PaletteSources } from './paletteItems'

const t = i18n.getFixedT('en', 'agents')

const CARD: RegistryCard = {
  kind: 'card', id: 'fixer-careful', version: 2, base_role: 'fixer', title: 'Careful fixer', purpose: '', launchable: true,
  template: null, skill: { source: 'store', label: 'fixer@x/2', connection: null, version: 2, status: null, provenance: null, template_version: 3, template_newer: false },
  model: 'global.anthropic.claude-sonnet-5-5', tools: [], harness: 'converse', broker_ops: [], caps: {}, inputs: [], outputs: [], evals: [],
  scorecard: null, spend: null,
  node: { type: 'agent', data: { title: 'Careful fixer', params: { role: 'fixer', skill_version: 'v2', model: 'global.anthropic.claude-sonnet-5-5', card: 'fixer-careful@v2' } } },
}
const GATES: GatesView = {
  packs: [{ id: 'python', name: 'Python', languages: ['python'], image: {}, network: [], tools: [], steps: [], briefs: [], recorded: null }],
  aliases: {}, own_gate: { file: '' }, briefs: [], defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' }, stops: [], connection: null,
}
const flow = (id: string, name: string): WorkflowSummary => ({
  workflow_id: id, slug: '', name, description: '', revision: 3, derived_from: null, builtin: false, updated_at: null,
  updated_by_username: null, status: 'active', kind: 'engineering', monthly_budget_usd: null,
})
const SOURCES: PaletteSources = {
  cards: [CARD], gates: GATES, flows: [flow('wf_aaaaaaaaaaaa', 'Issue triage'), flow('wf_bbbbbbbbbbbb', 'Release'), flow('wf_cccccccccccc', 'This flow')],
  workflowId: 'wf_cccccccccccc', usedBy: { automations: [], flows: [{ workflow_id: 'wf_bbbbbbbbbbbb', name: 'Release', revision: 1 }] },
}
const sections = () => paletteSections(t, WORKFLOW_SCHEMA_V2, SOURCES)
const items = () => sections().flatMap((section) => section.items)

describe('an engineering flow\'s palette', () => {
  it('groups its items by kind, the Registry\'s cards and the gate packs among them', () => {
    expect(sections().map((section) => section.id)).toStrictEqual(['startEnd', 'agents', 'gates', 'flows', 'platform'])
    expect(items().map((item) => item.label)).toContain('Careful fixer')
    expect(items().map((item) => item.label)).toContain('Python')
  })

  it('makes every item a step its rules accept, a call of a flow at its revision included', () => {
    const refused = items().filter((item) => engineeringParamsIssues(item.block.type, item.block.params ?? {}).length > 0)
    expect(refused.map((item) => item.key)).toStrictEqual([])
  })

  it('offers no call of this flow, and one of a flow that calls it off, saying why', () => {
    const flows = sections().find((section) => section.id === 'flows')?.items ?? []
    expect(flows.map((item) => [item.label, item.disabledReason])).toStrictEqual([
      ['Issue triage', null], ['Release', 'It calls this flow: calling it from here would make a cycle.'],
    ])
  })

  it('finds items by name, accents and case aside', () => {
    expect(filterSections(sections(), 'CAREFUL').flatMap((section) => section.items.map((item) => item.label))).toStrictEqual(['Careful fixer'])
  })
})

describe('a dropped or added block', () => {
  it('survives its trip through the drag\'s JSON, and anything else is no block', () => {
    const block = items().find((item) => item.key === 'card:fixer-careful')?.block
    expect(parseBlock(JSON.stringify(block))).toStrictEqual(block)
    expect([parseBlock('not json'), parseBlock('{"type":"nope","title":"x"}'), parseBlock('{"type":"agent","title":""}')]).toStrictEqual([null, null, null])
  })

  it('adds after the selected step (Enter), connected from it, and below the graph with nothing selected', () => {
    const start = starterDefinition({ name: 'Flow', start: 'Start', end: 'End' }, WORKFLOW_SCHEMA_V2)
    const after = addBlockAfter(start, { type: 'agent', title: 'Fix', params: { role: 'fixer' } }, 'start')
    expect(after.definition.edges.filter((edge) => edge.source === 'start').map((edge) => edge.target)).toStrictEqual(['end', after.nodeId])
    const below = addBlockAfter(start, { type: 'map', title: 'Shard' }, null)
    expect(below.definition.edges).toStrictEqual(start.edges)
    expect(addBlock(start, { type: 'map', title: 'Shard', params: { shard_cap: 5 } }, { x: 0, y: 0 }).definition.nodes.at(-1)?.data.params)
      .toStrictEqual({ shard_by: 'packages', shard_cap: 5 })
  })
})
