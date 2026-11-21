/** The leadership view's CSV (leadershipCsv.ts): the table, then the estimate's label, baselines and assumptions. */
import { describe, expect, it } from 'vitest'
import { CSV_COLUMNS, leadershipCsv } from './leadershipCsv'
import { leadershipView } from './leadership-fixtures'

const lines = () => leadershipCsv(leadershipView()).split('\r\n')

describe('leadershipCsv', () => {
  it('starts with a BOM and the header, then a row per period and the total', () => {
    const [header, october, , total] = lines()
    const quoted = CSV_COLUMNS.map((column) => `"${column}"`).join(',')
    expect(header).toBe(`\uFEFF${quoted}`)
    expect(october?.startsWith('"2026-10","4",')).toBe(true)
    expect(total?.startsWith('"total","8",')).toBe(true)
  })

  it('never lets the hours travel without the label, the baselines and the assumptions', () => {
    const text = lines().join('\n')
    expect(text).toContain('"estimate","Estimate, not a measurement"')
    expect(text).toContain('"baseline_hours_prd","10","set by an admin"')
    expect(text).toContain('"assumption","Review time is not subtracted."')
  })

  it('guards the admin note against formula injection', () => {
    expect(lines()).toContain(`"note","'=From our survey"`)
  })

  it('names no person', () => {
    expect(leadershipCsv(leadershipView())).not.toMatch(/sub-|@|updated_by/)
  })
})
