/** The Report's one-page PDF (7.63.00): KPIs, segments, the heatmap, themes with quotes, n and the dates, the AI part
 * labelled, never a contact detail. */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import FormReportPDF from './FormReportPDF'
import { REPORT, REPORT_FORM, SEGMENTED, VIEW } from './report-fixtures'

const markup = (report = SEGMENTED, view = VIEW) => renderToStaticMarkup(<FormReportPDF form={REPORT_FORM} report={report} view={view} />)

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
    expect(['Other (1 segment of fewer than 5)', 'Too few responses to show their scores'].every((part) => html.includes(part))).toBe(true)
    // (Design's 5 are withheld with the small group: the totals less QA would be theirs)
    expect(html).toContain('Hidden with the small group, so its scores can&#x27;t be worked out')
  })

  it('holds the heatmap and the themes with their real quotes, the AI part labelled', () => {
    const html = markup()
    expect(['Each part', '75%', '“Loved the labs”'].every((part) => html.includes(part))).toBe(true)
    expect(html).toContain('<strong>AI</strong> · Keep the labs, shorten the intro.')
    expect(html).toContain('Labs are the highlight (AI)')
  })

  it('prints the AI summary only for the view it was made for, else which view, with no quote', () => {
    const html = markup(REPORT, { ...VIEW, hidden: { customer: 'Sample Co' } })
    expect(html).toContain('Made for another view: Last 30 days')
    expect(['Keep the labs, shorten the intro.', 'Labs are the highlight'].filter((part) => html.includes(part))).toStrictEqual([])
    // (the deterministic themes keep their own quotes)
    expect(html).toContain('“Loved the labs”')
  })

  it('never prints a contact detail, and says so', () => {
    const html = markup(REPORT)
    expect(html).not.toMatch(/@|Contact/)
    expect(html).toContain('No contact details are included.')
  })
})
