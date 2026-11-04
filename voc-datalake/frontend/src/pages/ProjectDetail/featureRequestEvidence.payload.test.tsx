/**
 * Feedback-board requests as evidence (C5): the persona, research and PRD / PR/FAQ requests carry
 * them only when the box is ticked (`include_feature_requests` + `feature_request_board_ids`;
 * documents: `data_sources.feature_requests` + top-level ids), and an unticked wizard sends the
 * same body as before.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWizardWrapper } from './wizard-fixtures'
import { useProjectMutations } from './useProjectData'
import { useProjectWizardState } from './useProjectWizardState'
import type { ContextConfig } from '../../components/DataSourceWizard/types'

const api = vi.hoisted(() => ({
  generatePersonas: vi.fn<(projectId: string, body: Record<string, unknown>) => Promise<unknown>>(),
  runResearch: vi.fn<(projectId: string, body: Record<string, unknown>) => Promise<unknown>>(),
  generateDocument: vi.fn<(projectId: string, body: Record<string, unknown>) => Promise<unknown>>(),
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: api }))

/** The project wizard state and its mutations, as the page wires them. */
function useWiredWizard() {
  const wizard = useProjectWizardState()
  return { wizard, mutations: useProjectMutations({ id: 'proj_1', ...wizard, onSuccess: () => {}, onError: () => {} }) }
}

type Mutation = 'personaMut' | 'resMut' | 'docMut'

/** The body `mutation` sends with the context `change` applied. */
async function bodyOf(mutation: Mutation, change: Partial<ContextConfig>): Promise<Record<string, unknown>> {
  const { result } = renderHook(useWiredWizard, { wrapper: createWizardWrapper() })
  act(() => {
    result.current.wizard.setContextConfig((config) => ({ ...config, ...change }))
    result.current.wizard.setResearchConfig((config) => ({ ...config, question: 'Why?' }))
  })
  await act(async () => {
    await result.current.mutations[mutation].mutateAsync()
  })
  const call = { personaMut: api.generatePersonas, resMut: api.runResearch, docMut: api.generateDocument }[mutation].mock.calls[0]
  return call?.[1] ?? {}
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({ success: true, job_id: 'job_1', status: 'pending', message: '' })
})

describe('persona and research requests', () => {
  it.each<Mutation>(['personaMut', 'resMut'])('%s sends nothing about board requests while unticked', async (mutation) => {
    const body = await bodyOf(mutation, {})
    expect(body).not.toHaveProperty('include_feature_requests')
    expect(body).not.toHaveProperty('feature_request_board_ids')
  })

  it.each<Mutation>(['personaMut', 'resMut'])('%s asks for every board when none is picked', async (mutation) => {
    const body = await bodyOf(mutation, { useFeatureRequests: true })
    expect(body).toMatchObject({ include_feature_requests: true })
    expect(body).not.toHaveProperty('feature_request_board_ids')
  })

  it.each<Mutation>(['personaMut', 'resMut'])('%s narrows to the picked boards', async (mutation) => {
    const body = await bodyOf(mutation, { useFeatureRequests: true, featureRequestBoardIds: ['brd_sales', 'brd_beta'] })
    expect(body).toMatchObject({ include_feature_requests: true, feature_request_board_ids: ['brd_sales', 'brd_beta'] })
  })
})

describe('PRD / PR/FAQ requests', () => {
  it('keep the old data sources while unticked', async () => {
    const body = await bodyOf('docMut', {})
    expect(body['data_sources']).toStrictEqual({ feedback: true, personas: false, documents: false, research: false })
    expect(body).not.toHaveProperty('feature_request_board_ids')
  })

  it('name board requests as a data source with the picked boards at the top level', async () => {
    const body = await bodyOf('docMut', { useFeatureRequests: true, featureRequestBoardIds: ['brd_sales'] })
    expect(body['data_sources']).toMatchObject({ feature_requests: true })
    expect(body).toMatchObject({ feature_request_board_ids: ['brd_sales'] })
    expect(body).not.toHaveProperty('include_feature_requests')
  })
})
