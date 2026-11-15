/**
 * The editor's port of an engineering flow's rules gives the server's answers: every case of the shared fixture
 * (`src/test/engineeringFlows.json`, written from `lambda/shared/workflow_schema.py`) gets the same errors here.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import flows from '../../test/engineeringFlows.json'
import { engineeringParamsIssues } from './engineeringRules'
import { validateLocally } from './graphRules'

const cases = z.array(z.object({
  name: z.string(),
  definition: z.unknown(),
  errors: z.array(z.object({ message: z.string(), node_id: z.string().optional() })),
})).parse(flows)

describe('engineering flows: the editor answers as the server does', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const local = validateLocally(c.definition).map((issue) => (
      issue.node_id === undefined ? { message: issue.message } : { message: issue.message, node_id: issue.node_id }
    ))
    expect(local).toStrictEqual(c.errors)
  })
})

describe('engineeringParamsIssues', () => {
  it('passes a step with sound settings and a step kind it does not check', () => {
    expect(engineeringParamsIssues('agent', { role: 'fixer', skill_version: 'v3', budget_share: 0.5 })).toStrictEqual([])
    expect(engineeringParamsIssues('quality_gate', { reviewers: [{ name: 'quality' }, { name: 'docs', focus: 'f', advisory: true }] }))
      .toStrictEqual([])
    expect(engineeringParamsIssues('reduce', { anything: true })).toStrictEqual([])
  })

  it.each([
    ['agent', { role: 'fixer', model: '' }],
    ['agent', { role: 'fixer', budget_share: Number.POSITIVE_INFINITY }],
    ['quality_gate', { final_go_model: null }],
    ['quality_gate', { packs: [{}] }],
    ['quality_gate', { reviewers: [{ name: 'quality' }, { name: 'quality' }] }],
    ['quality_gate', { reviewers: [{ name: 'Docs', focus: 'f' }] }],
    ['quality_gate', { reviewers: [] }],
    ['board', { posters: ['hunter'], claimers: ['fixer', 'fixer'] }],
    ['memory', { mode: 'read', scope: 'team' }],
  ] as const)('refuses %s %j', (kind, params) => {
    expect(engineeringParamsIssues(kind, params)).not.toStrictEqual([])
  })
})
