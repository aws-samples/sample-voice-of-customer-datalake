/**
 * Polish AI-model surface labels (verify10, Administration → AI models): "Agenci robocze" used the
 * non-masculine-personal adjective with "agenci"; the conductor was "Dyrygent" (an orchestra's)
 * while the Agents page names the same role "Planista"; "wydajność" (performance) stood for
 * capacity; "dla {{surface}}" put a nominative label after a preposition that takes the genitive.
 */
import { describe, expect, it } from 'vitest'
import settingsPl from '../../public/locales/pl/settings.json'
import agentsPl from '../../public/locales/pl/agents.json'

const { surfaces, test } = settingsPl.aiModel

describe('Polish AI-model labels', () => {
  it('agrees "agenci" with the masculine-personal plural adjective', () => {
    expect(surfaces.agent_worker.label).toBe('Agenci roboczy')
  })

  it('names the conductor the way the Agents page names that role', () => {
    expect(surfaces.agent_orchestrator.label.startsWith(agentsPl.roles.orchestrator)).toBe(true)
  })

  it('calls capacity throughput, not performance', () => {
    expect([test.status.no_capacity, test.allTitle].filter((text) => text.includes('wydajno'))).toStrictEqual([])
  })

  it('never puts a bare surface label after "dla"', () => {
    expect([test.confirm.untested, test.confirm.failed].filter((text) => text.includes('dla {{surface}}'))).toStrictEqual([])
  })
})
