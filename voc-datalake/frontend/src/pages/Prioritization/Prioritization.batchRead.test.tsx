/**
 * @fileoverview The page reads every project's documents in ONE batch call
 * (`projectsApi.getProjectDetails` → `GET /projects?ids=…`), not one call per project,
 * and a project the batch leaves out (not viewable, deleted) costs only its own row.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import './prioritization-mock-fixtures'
import {
  loadRowsWithTeamAggregates, prioritizationMocks, resetPrioritizationPage, TWO_ROW_DOCUMENTS,
} from './prioritization-fixtures'
import { renderPrioritization } from './prioritization-render-fixtures'

const THREE_ROW_DOCUMENTS = [
  ...TWO_ROW_DOCUMENTS,
  { document_id: 'd5', document_type: 'prfaq', title: 'Feature C PR/FAQ', content: '', created_at: '2025-01-03' },
] as const

describe('Prioritization batch detail read', () => {
  beforeEach(() => {
    resetPrioritizationPage()
  })

  it('issues one detail read naming every project', async () => {
    loadRowsWithTeamAggregates(THREE_ROW_DOCUMENTS, {})

    renderPrioritization()

    expect(await screen.findByRole('button', { name: /Feature C PR\/FAQ/ })).toBeInTheDocument()
    expect(prioritizationMocks.getProjectDetails).toHaveBeenCalledTimes(1)
    expect(prioritizationMocks.getProjectDetails).toHaveBeenCalledWith(['p1', 'p2', 'p3'])
  })

  it('keeps every other project aligned when the batch omits one', async () => {
    const layout = loadRowsWithTeamAggregates(THREE_ROW_DOCUMENTS, {})
    // The middle project is not viewable any more: the server simply leaves it out.
    prioritizationMocks.getProjectDetails.mockImplementationOnce((ids: readonly string[]) => Promise.all(
      ids.filter((id) => id !== 'p2').map(async (id) => ({ project: { project_id: id }, ...await layout.getProject(id) })),
    ))

    renderPrioritization()

    expect(await screen.findByRole('button', { name: /Feature C PR\/FAQ/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Feature A PR\/FAQ/ })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Feature B PR\/FAQ/ })).toBeNull()
    })
  })
})
