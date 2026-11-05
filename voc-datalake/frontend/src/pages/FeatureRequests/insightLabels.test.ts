import { describe, expect, it } from 'vitest'
import { fixtureBoard } from './feature-board-fixtures'
import { insightStatusLabel } from './insightLabels'

const t = (key: string) => `t:${key}`

describe('insightStatusLabel', () => {
  it("uses the first board's own label for the status", () => {
    const renamed = fixtureBoard('sales', { board_id: 'brd_a', statuses: [{ key: 'triage', label: 'In triage' }] })
    const later = fixtureBoard('sales', { board_id: 'brd_b', statuses: [{ key: 'triage', label: 'Sorting' }] })
    expect(insightStatusLabel('triage', [renamed, later], t)).toBe('In triage')
  })

  it('humanizes a status no board has', () => {
    expect(insightStatusLabel('waiting_on_customer', [fixtureBoard('sales', { board_id: 'brd_sales' })], t)).toBe('Waiting on customer')
    expect(insightStatusLabel('waiting_on_customer', [], t)).toBe('Waiting on customer')
  })
})
