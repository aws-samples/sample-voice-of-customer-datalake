/**
 * @fileoverview "Build from this PRD" (7.47.00): offered to an administrator where the engineering module is on and an
 * enabled feature engineering agent exists; it starts that agent's run with the PRD as its input and links to the run
 * monitor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { featureBuilders } from '../Agents/engineeringAgentRules'
import { normalizeAgent } from '../../api/agentsApi'
import type { Agent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/authStore')>()),
  ...(await import('@test/fetchApiRoutes')).authStoreModule(),
}))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const { default: BuildFromPrd } = await import('./BuildFromPrd')
const { engineeringModule } = await import('@test/engineeringModule')

const ENGINEERING_RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'

const agent = (id: string, feedbackType: 'bug' | 'feature_request', enabled = true) => ({
  agent_id: id, name: feedbackType === 'bug' ? 'Bug fixer' : 'Feature builder', enabled, status: 'active',
  engineering: { connection: 'storefront', language: 'python', feedback_type: feedbackType },
})

const normalized = (raw: object): Agent => {
  const parsed = normalizeAgent(raw)
  if (parsed === null) throw new Error('fixture agent did not normalise')
  return parsed
}

function renderButton(): void {
  renderWithQueryClient(<TestRouter><BuildFromPrd projectId="proj_1" documentId="prd_1" /></TestRouter>)
}

describe('featureBuilders', () => {
  it('keeps the enabled, active feature agents', () => {
    const agents = [normalized(agent('ag_a', 'feature_request')), normalized(agent('ag_b', 'bug')),
      normalized(agent('ag_c', 'feature_request', false)), normalized({ agent_id: 'ag_d', name: 'Plain', enabled: true })]
    expect(featureBuilders(agents).map((a) => a.agent_id)).toStrictEqual(['ag_a'])
  })
})

describe('BuildFromPrd', () => {
  beforeEach(() => {
    resetFetchApi()
    adminFlag.isAdmin = true
    engineeringModule.available = true
  })

  it('shows nothing without the engineering module, to a non-admin, or with no feature agent', async () => {
    routeFetchApi({ 'GET /agents': () => ({ items: [agent('ag_b', 'bug')] }) })
    renderButton()
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Build from this PRD' })).not.toBeInTheDocument() })
    engineeringModule.available = false
    adminFlag.isAdmin = false
    routeFetchApi({ 'GET /agents': () => ({ items: [agent('ag_a', 'feature_request')] }) })
    renderButton()
    expect(screen.queryByRole('button', { name: 'Build from this PRD' })).not.toBeInTheDocument()
  })

  it('starts the feature agent\'s run with the PRD and links to its run monitor', async () => {
    const user = userEvent.setup()
    routeFetchApi({
      'GET /agents': () => ({ items: [agent('ag_a', 'feature_request')] }),
      'POST /agents/ag_a/run': () => ({ run: { run_id: 'ar_0001', agent_id: 'ag_a', status: 'running', trigger: 'manual',
        kind: 'engineering', engineering_run_id: ENGINEERING_RUN } }),
    })
    renderButton()
    await user.click(await screen.findByRole('button', { name: 'Build from this PRD' }))
    expect(screen.getByText(/Feature builder starts an engineering run/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start the build' }))
    const link = await screen.findByRole('link', { name: 'Open the run monitor' })
    expect(link).toHaveAttribute('href', `/agents/engineering/${ENGINEERING_RUN}`)
    expect(sentFetchApiBody('/agents/ag_a/run', 'POST')).toStrictEqual({ prd: { project_id: 'proj_1', document_id: 'prd_1' } })
  })
})
