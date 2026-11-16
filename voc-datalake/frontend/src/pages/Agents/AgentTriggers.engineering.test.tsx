/**
 * @fileoverview The Triggers tab of an engineering agent (7.47.00): the GitHub issue trigger's fields, offered only
 * to an engineering agent and at most once, and no threshold while the scope names sources; and the draft's check
 * against the engineering agent's own bounds.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TriggersSection } from './AgentTriggers'
import { addableKinds, checkUpdate } from './agentDraft'
import type { AgentDraft } from './agentDraft'

const ISSUE = { kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 } as const

const draft = (extra: Partial<AgentDraft> = {}): AgentDraft => ({
  name: 'Bug fixer', description: '', scope: { all: true, categories: [], subcategories: [] }, instructions: '',
  personas: { fixed: [], allow_generate: true }, triggers: [], models: { orchestrator: null, worker: null, reviewer: null, persona: null },
  output: { visibility: 'private' }, workflow_id: 'wf_1', budget: { max_scheduled_runs_per_day: 1 }, ...extra,
})

describe('the triggers an agent may add', () => {
  it('offers a GitHub issue trigger to an engineering agent only, and once', () => {
    expect(addableKinds(draft(), false)).toStrictEqual(['new_reviews', 'schedule', 'threshold'])
    expect(addableKinds(draft(), true)).toStrictEqual(['github_issue', 'new_reviews', 'schedule', 'threshold'])
    expect(addableKinds(draft({ triggers: [ISSUE] }), true)).not.toContain('github_issue')
  })

  it('offers no threshold while the scope names sources', () => {
    const sourced = draft({ scope: { all: true, categories: [], subcategories: [], sources: ['github_issues'] } })
    expect(addableKinds(sourced, false)).toStrictEqual(['new_reviews', 'schedule'])
  })
})

describe('TriggersSection for an engineering agent', () => {
  it('shows the GitHub issue trigger and says when a label is mandatory and when one is missed', () => {
    renderWithQueryClient(<TriggersSection draft={draft({ triggers: [ISSUE] })} readOnly={false} onChange={vi.fn()} engineering />)
    expect(screen.getByLabelText('Label')).toHaveValue('voc-agent')
    expect(screen.getByText('On a public repository, an issue starts a run only with this label, which a maintainer adds.')).toBeInTheDocument()
    expect(screen.getByText('Issues ingested in these last days. A label added after this is missed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /GitHub issue/ })).not.toBeInTheDocument()   // (one at most)
  })

  it('edits who may start a run without the label', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithQueryClient(<TriggersSection draft={draft({ triggers: [ISSUE] })} readOnly={false} onChange={onChange} engineering />)
    await user.click(screen.getByRole('checkbox', { name: "Also issues opened by the repository's owners, members and collaborators" }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ triggers: [{ ...ISSUE, trusted_authors: true }] }))
  })

  it('warns about a threshold kept with sources', () => {
    const triggers = [{ kind: 'threshold', count: 10, per: 'category', window_days: 7 } as const]
    renderWithQueryClient(<TriggersSection readOnly={false} onChange={vi.fn()}
      draft={draft({ triggers, scope: { all: true, categories: [], subcategories: [], sources: ['webscraper'] } })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('A threshold counts every source')
  })
})

describe('the draft of an engineering agent', () => {
  it('holds its instructions to 300 characters', () => {
    expect('errors' in checkUpdate({ instructions: 'x'.repeat(301) }, true)).toBe(true)
    expect('body' in checkUpdate({ instructions: 'x'.repeat(301) }, false)).toBe(true)
  })

  it('takes up to 5 runs a day (an agents workflow\'s agent, 2)', () => {
    expect('body' in checkUpdate({ budget: { max_scheduled_runs_per_day: 5 } }, true)).toBe(true)
    expect('errors' in checkUpdate({ budget: { max_scheduled_runs_per_day: 5 } }, false)).toBe(true)
  })

  it('takes a GitHub issue trigger only for an engineering agent', () => {
    expect('body' in checkUpdate({ triggers: [ISSUE] }, true)).toBe(true)
    expect('errors' in checkUpdate({ triggers: [ISSUE] }, false)).toBe(true)
  })
})
