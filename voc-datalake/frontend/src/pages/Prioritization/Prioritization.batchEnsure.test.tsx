/**
 * @fileoverview Loading the page ensures every project's default row in ONE request
 * (`api.ensurePrioritizationRows` → `POST /projects/prioritization/rows` with
 * `{project_ids}`), not one request per project, and a project the batch refuses or
 * leaves out costs only its own row.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import './prioritization-mock-fixtures'
import {
  loadRowsWithTeamAggregates, prioritizationMocks, resetPrioritizationPage, TWO_ROW_DOCUMENTS,
} from './prioritization-fixtures'
import { renderPrioritization } from './prioritization-render-fixtures'

const THREE_ROW_DOCUMENTS = [
  ...TWO_ROW_DOCUMENTS,
  { document_id: 'd5', document_type: 'prfaq', title: 'Feature C PR/FAQ', content: '', created_at: '2025-01-03' },
] as const

describe('Prioritization batched row ensure', () => {
  beforeEach(() => {
    resetPrioritizationPage()
  })

  it('issues one ensure request naming every project on load', async () => {
    loadRowsWithTeamAggregates(THREE_ROW_DOCUMENTS, {})

    renderPrioritization()

    expect(await screen.findByRole('button', { name: /Feature C PR\/FAQ/ })).toBeInTheDocument()
    await waitFor(() => {
      expect(prioritizationMocks.ensurePrioritizationRows).toHaveBeenCalledTimes(1)
    })
    expect(prioritizationMocks.ensurePrioritizationRows).toHaveBeenCalledWith(['p1', 'p2', 'p3'])
  })

  it('names the one project the batch refused as too large', async () => {
    loadRowsWithTeamAggregates(THREE_ROW_DOCUMENTS, {})
    prioritizationMocks.getPrioritizationScores.mockResolvedValue({ rows: {}, scores: {}, aggregates: {} })
    prioritizationMocks.ensurePrioritizationRows.mockImplementationOnce(async (ids: readonly string[]) => {
      const kept = ids.filter((id) => id !== 'p2')
      const rows = await Promise.all(kept.map(async (id) => {
        const answer = await prioritizationMocks.createPrioritizationRow(id)
        return { project_id: id, ...(typeof answer === 'object' ? answer : {}) }
      }))
      return { success: true, rows, errors: [{ project_id: 'p2', status: 409, error: 'Too many documents' }] }
    })

    renderPrioritization()

    const alert = await screen.findByRole('alert', { name: /Some projects could not be given a row/ })
    expect(within(alert).getByText('Project 2')).toBeInTheDocument()
    expect(within(alert).queryByText('Project 1')).toBeNull()
    expect(prioritizationMocks.ensurePrioritizationRows).toHaveBeenCalledTimes(1)
  })
})
