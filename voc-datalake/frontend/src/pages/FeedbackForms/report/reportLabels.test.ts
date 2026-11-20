import { describe, expect, it } from 'vitest'
import { figureText, kpiValue, rowAveragesText, segmentChoices, segmentValueLabel, shadeStep } from './reportLabels'
import { REPORT, REPORT_FORM } from './report-fixtures'

describe('what the Report names', () => {
  it('offers every hidden field, single choice and matrix row as a segment, in the form’s order', () => {
    expect(segmentChoices(REPORT_FORM)).toStrictEqual([
      { value: 'hidden.customer', label: 'Customer' }, { value: 'hidden.event_date', label: 'Event date' },
      { value: 'q_role', label: 'Your role' }, { value: 'q_phases.labs', label: 'Each part: Labs' },
    ])
  })

  it('words a segment’s value as the form does', () => {
    expect(segmentValueLabel(REPORT_FORM, 'q_role', 'qa', 'No value', 'Other')).toBe('QA')
    expect(segmentValueLabel(REPORT_FORM, 'q_phases.labs', 'great', 'No value', 'Other')).toBe('Great')
    expect(segmentValueLabel(REPORT_FORM, 'hidden.customer', 'Example Ltd', 'No value', 'Other')).toBe('Example Ltd')
    expect(segmentValueLabel(REPORT_FORM, 'hidden.customer', '', 'No value', 'Other')).toBe('No value')
  })

  it('gives each figure its own measure', () => {
    expect([
      figureText({ type: 'nps', answered: 3, nps: -12.5 }, 'en'), figureText({ type: 'csat', answered: 3, csat: 80 }, 'en'),
      figureText({ type: 'rating', answered: 3, average: 4.25, scale_max: 5 }, 'en'),
    ]).toStrictEqual(['-13', '80%', '4.3 / 5'])
    expect([figureText(undefined, 'en'), figureText({ type: 'rating', answered: 0, average: null }, 'en')]).toStrictEqual(['—', '—'])
    expect(rowAveragesText(REPORT_FORM, 'q_phases', { type: 'matrix', answered: 2, rows: { labs: 3.5 } }, 'en')).toBe('Labs 3.5')
    expect(kpiValue(REPORT.kpis[0] ?? { id: '', type: '', answered: 0, skipped: 0, average: null }, 'en')).toBe('33')
  })

  it('shades a heatmap cell in four steps', () => {
    expect([0, 10, 25, 49, 50, 100].map(shadeStep)).toStrictEqual([0, 1, 2, 2, 3, 3])
  })
})
