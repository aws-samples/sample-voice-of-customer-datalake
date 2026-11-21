import { describe, expect, it } from 'vitest'
import { figureText, kpiValue, rowAveragesText, segmentChoices, segmentValueLabel, shadeStep, summaryOfView, summaryViewText } from './reportLabels'
import { REPORT, REPORT_FORM, VIEW } from './report-fixtures'

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

describe('the view an AI summary was made for', () => {
  const t = (key: string, options?: Record<string, unknown>) => `${key}${options === undefined ? '' : JSON.stringify(options)}`

  it('names its range, language, ending and hidden values in the form\'s words', () => {
    expect(summaryViewText(REPORT_FORM, { from: 'x', days: '30', language: 'pl', 'hidden.customer': 'Example Ltd', 'hidden.event_date': '2026-11-01' }, t, 'en'))
      .toBe('results.filters.days30 · Polski · Customer: Example Ltd · Event date: 2026-11-01')
    // (a summary recorded with a start time only says since when)
    expect(summaryViewText(REPORT_FORM, { from: '2026-11-01T00:00:00Z' }, t, 'en')).toMatch(/^feedbackForms:report\.ai\.since/)
  })

  it('is the report\'s summary on its own view only', () => {
    expect(summaryOfView(REPORT, VIEW)).toBe(REPORT.ai)
    expect(summaryOfView(REPORT, { ...VIEW, days: 7 })).toBeNull()
    expect(summaryOfView({ ...REPORT, ai: null }, VIEW)).toBeNull()
  })
})
