/**
 * useProjectData with push (docs/realtime.md): a project job's end notice re-reads the jobs and the project at
 * once; a notice of another project changes nothing; the poll stays the fallback (jobsPollInterval specs).
 */
import { QueryClient } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_DATA_ARGS, projectDataApiModule, projectDataMocks, projectPayload, renderWithQueryClient,
} from './project-data-fixtures'
import { useProjectData } from './useProjectData'
import { deliverNotice, setRealtimeLive } from '../../realtime/hub'

vi.mock('../../api/projectsApi', () => projectDataApiModule())
const { getProject, getJobs, getProductContext } = projectDataMocks

const render = () => renderWithQueryClient(
  new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  () => useProjectData(PROJECT_DATA_ARGS),
)

beforeEach(() => {
  setRealtimeLive(false)
  getProject.mockResolvedValue(projectPayload([]))
  getProductContext.mockResolvedValue({ context: {} })
  getJobs.mockResolvedValue({ jobs: [] })
})
afterEach(() => {
  setRealtimeLive(false)
  vi.clearAllMocks()
})

describe('useProjectData job notices', () => {
  it('re-reads the jobs and the project on its project\'s job notice', async () => {
    render()
    await waitFor(() => { expect(getJobs).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(getProject).toHaveBeenCalledTimes(1) })
    deliverNotice({ type: 'job', job_id: 'j1', status: 'completed', project_id: 'other' })
    deliverNotice({ type: 'job', job_id: 'j1', status: 'completed', project_id: PROJECT_DATA_ARGS.id })
    await waitFor(() => { expect(getJobs).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(getProject).toHaveBeenCalledTimes(2) })
  })

  it('re-reads the jobs on a reconnect', async () => {
    render()
    await waitFor(() => { expect(getJobs).toHaveBeenCalledTimes(1) })
    setRealtimeLive(true)
    await waitFor(() => { expect(getJobs).toHaveBeenCalledTimes(2) })
  })
})
