/**
 * @fileoverview The agent shapes after 7.47.00: the assistant's approval cards keep their shape (no engineering fields,
 * no GitHub issue trigger, no source scope: its agent tools have none), the agent form takes `scope.sources`, an
 * engineering agent's form its GitHub issue trigger and `engineering` settings within their bounds, and the lenient
 * reads keep what the server answers of an engineering agent and its runs.
 */
import { describe, expect, it } from 'vitest'
import { createAgentArgs } from '../assistant/approvals/agentSchemas'
import { agentFormSchema, engineeringAgentFormSchema, normalizeAgent } from './agentsApi'

const SCOPE = { all: true, categories: [], subcategories: [] }
const ISSUE = { kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 }
const ENGINEERING = { connection: 'storefront', language: 'python', feedback_type: 'bug' }

describe('the assistant\'s agent shape', () => {
  it('has no engineering field, GitHub issue trigger or source scope', () => {
    expect(createAgentArgs.safeParse({ name: 'n', scope: SCOPE }).success).toBe(true)
    expect(createAgentArgs.safeParse({ name: 'n', scope: SCOPE, engineering: ENGINEERING }).success).toBe(false)
    expect(createAgentArgs.safeParse({ name: 'n', scope: SCOPE, triggers: [ISSUE] }).success).toBe(false)
    expect(createAgentArgs.safeParse({ name: 'n', scope: { ...SCOPE, sources: ['webscraper'] } }).success).toBe(false)
  })
})

describe('the agent form', () => {
  it('takes a source scope for any agent, and an issue trigger and engineering settings for an engineering one', () => {
    expect(agentFormSchema.partial().safeParse({ scope: { ...SCOPE, sources: ['github_issues'] } }).success).toBe(true)
    expect(agentFormSchema.partial().safeParse({ triggers: [ISSUE] }).success).toBe(false)
    expect(agentFormSchema.partial().safeParse({ engineering: ENGINEERING }).success).toBe(false)
    expect(engineeringAgentFormSchema.partial().safeParse({ triggers: [ISSUE], engineering: ENGINEERING }).success).toBe(true)
  })

  it('holds the issue trigger and the sources to their bounds', () => {
    const issue = (extra: object) => engineeringAgentFormSchema.partial().safeParse({ triggers: [{ ...ISSUE, ...extra }] }).success
    expect(issue({ lookback_days: 30 })).toBe(true)
    expect(issue({ lookback_days: 31 })).toBe(false)
    expect(issue({ label: 'x'.repeat(51) })).toBe(false)
    const sources = Array.from({ length: 21 }, (_v, i) => `source_${String(i)}`)
    expect(agentFormSchema.partial().safeParse({ scope: { ...SCOPE, sources } }).success).toBe(false)
  })

  it('takes the issue trigger\'s stage and required triage (7.50.00), only as the server names them', () => {
    const issue = (extra: object) => engineeringAgentFormSchema.partial().safeParse({ triggers: [{ ...ISSUE, ...extra }] }).success
    expect(issue({ stage: 'triage' })).toBe(true)
    expect(issue({ requires_triage: 'bug' })).toBe(true)
    expect(issue({ stage: 'later' })).toBe(false)
    expect(issue({ requires_triage: 'investigation' })).toBe(false)
  })
})

describe('the lenient reads', () => {
  it('keep an engineering agent\'s settings, who it runs as and its sources', () => {
    const agent = normalizeAgent({
      agent_id: 'ag_1', name: 'Bug fixer', owner_username: 'alice', engineering: ENGINEERING, triggers: [ISSUE],
      scope: { ...SCOPE, sources: ['github_issues'] },
    })
    expect(agent).toMatchObject({ engineering: ENGINEERING, owner_username: 'alice', triggers: [ISSUE] })
    expect(agent?.scope.sources).toStrictEqual(['github_issues'])
    expect(normalizeAgent({ agent_id: 'ag_2', name: 'Plain' })?.engineering).toBeNull()
  })

  it('keep the issue trigger\'s stage and required triage, so a save sends them back as they were', () => {
    const triage = { ...ISSUE, stage: 'triage' }
    const act = { ...ISSUE, requires_triage: 'feature' }
    expect(normalizeAgent({ agent_id: 'ag_3', name: 'Issue triage', engineering: ENGINEERING, triggers: [triage] })?.triggers)
      .toStrictEqual([triage])
    expect(normalizeAgent({ agent_id: 'ag_4', name: 'Feature builder', engineering: ENGINEERING, triggers: [act] })?.triggers)
      .toStrictEqual([act])
  })
})
