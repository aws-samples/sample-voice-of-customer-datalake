/**
 * @fileoverview The run page's models (7.58.00): the header says the model chosen for every role of the run at its
 * start (nothing when each role ran its own), and each agent says the model its launch asked for by short name with its
 * harness ("Opus 5.5 · Kiro"; a dash when it names none), on the Cost tab, a step's lanes and a session's header.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestRouter } from '@test/TestRouter'
import fixture from '@test/engineeringRunWorkspace.json'
import { parseOverview } from '../../../api/engineeringRunsApi'
import { useModelChoiceText } from '../modelChoiceText'
import { CostTab } from './CostTab'
import { RunHeader } from './RunHeader'
import type { AgentModel } from '../modelChoiceText'
import type { EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'

const ANSWER = fixture.overview.answer

function overviewWith(models: unknown, agents: Record<string, Record<string, unknown>> = {}) {
  return parseOverview({
    ...ANSWER, run: { ...ANSWER.run, models },
    agents: ANSWER.agents.map((agent) => ({ ...agent, ...agents[agent.agent] })),
  })
}

/** The overview's agent of that id (the fixture's: every spec here names one it has). */
function agentOf(overview: EngineeringOverview, id: string): EngineeringAgent {
  const found = overview.agents.find((agent) => agent.agent === id)
  if (found === undefined) throw new Error(`the fixture has no ${id}`)
  return found
}

function Said({ agent }: Readonly<{ agent: AgentModel }>) {
  const text = useModelChoiceText()
  return <span>{text.agent(agent) ?? 'none'}</span>
}

describe('the run page: its models', () => {
  it('says the model chosen for every role of the run, and nothing when each role ran its own', () => {
    const { unmount } = render(<TestRouter><RunHeader overview={overviewWith({ choice: 'opus', roles: { fixer: 'haiku' } })} controls={null} /></TestRouter>)
    expect(screen.getByText('Model for this run: Opus 5.5 (every role)')).toBeInTheDocument()
    unmount()
    render(<TestRouter><RunHeader overview={overviewWith(undefined)} controls={null} /></TestRouter>)
    expect(screen.queryByText(/Model for this run/)).not.toBeInTheDocument()
  })

  it('says another id as it is', () => {
    render(<TestRouter><RunHeader overview={overviewWith({ choice: 'claude-sonnet-5.5', roles: {} })} controls={null} /></TestRouter>)
    expect(screen.getByText('Model for this run: claude-sonnet-5.5 (every role)')).toBeInTheDocument()
  })

  it('says each agent\'s model with its harness, and nothing for one whose launch named none', () => {
    render(<>
      <Said agent={{ model: 'claude-opus-5.5', harness: 'kiro' }} />
      <Said agent={{ model: 'auto', harness: 'kiro' }} />
      <Said agent={{ model: 'claude-sonnet-5.5', harness: 'kiro' }} />
      <Said agent={{ model: 'global.anthropic.claude-haiku-5-5', harness: 'native' }} />
      <Said agent={{ model: null, harness: 'native' }} />
    </>)
    expect(screen.getAllByText(/./).map((node) => node.textContent)).toStrictEqual(
      ['Opus 5.5 · Kiro', 'Auto · Kiro', 'Sonnet 5.5 · Kiro', 'Haiku 5.5 · native', 'none'])
  })

  it('shows the agent\'s model, harness and id on its Cost tab, and a dash for none', () => {
    const overview = overviewWith(undefined, {
      'fixer-3': { model: 'claude-opus-5.5', harness: 'kiro', model_choice: 'opus' },
      'gate-runner-4': { model: null, harness: 'kiro' },
    })
    const fixer = agentOf(overview, 'fixer-3')
    const gate = agentOf(overview, 'gate-runner-4')
    const { unmount } = render(<CostTab agent={fixer} agents={overview.agents} readAt={0} />)
    expect(screen.getByText('Opus 5.5 · Kiro (claude-opus-5.5)')).toBeInTheDocument()
    unmount()
    render(<CostTab agent={gate} agents={overview.agents} readAt={0} />)
    expect(screen.getByText('Model').nextElementSibling).toHaveTextContent('—')
  })

  it('reads the server\'s run (the shared fixture) with no model of its own and its agents native, with no choice', () => {
    const overview = parseOverview(ANSWER)
    expect(overview.run.models).toStrictEqual({ choice: null, roles: {} })
    expect(overview.agents.every((agent) => agent.harness === 'native' && agent.model_choice === null)).toBe(true)
  })
})
