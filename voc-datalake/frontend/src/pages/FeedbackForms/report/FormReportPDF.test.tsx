/** The Report's one-page PDF (7.63.00): KPIs, segments, the heatmap, themes with quotes, n and the dates, the AI part
 * labelled, never a contact detail. */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import FormReportPDF from './FormReportPDF'
import { REPORT, REPORT_FORM, SEGMENTED } from './report-fixtures'

const markup = (report = SEGMENTED) => renderToStaticMarkup(<FormReportPDF form={REPORT_FORM} report={report} />)

describe('the report PDF', () => {
  it('holds the KPIs, n and the dates', () => {
    const html = markup()
    expect(html).toContain('Example Ltd workshop')
    expect(html).toContain('9 responses · Nov 10, 2026 – Nov 18, 2026')
    expect(html).toContain('Recommend it?')
    expect(html).toContain('>33<')
  })

  it('holds the segment table with the small segments merged and withheld', () => {
    const html = markup()
    expect(html).toContain('Scores by segment')
    expect(html).toContain('QA')
    expect(html).toContain('Other (1 segment of fewer than 5)')
    expect(html).toContain('Too few responses to show their scores')
  })

  it('holds the heatmap and the themes with their real quotes, the AI part labelled', () => {
    const html = markup()
    expect(['Each part', '75%', '“Loved the labs”'].every((part) => html.includes(part))).toBe(true)
    expect(html).toContain('<strong>AI</strong> · Keep the labs, shorten the intro.')
    expect(html).toContain('Labs are the highlight (AI)')
  })

  it('never prints a contact detail, and says so', () => {
    const html = markup(REPORT)
    expect(html).not.toMatch(/@|Contact/)
    expect(html).toContain('No contact details are included.')
  })
})
