/**
 * "Compared with us" reflows instead of clipping (WCAG 1.4.10): a table on a wide card, a stack
 * of row cards on a narrow one (container query in rem, so 200 % text stacks too). The table
 * roles stay explicit (a changed `display` drops them in some browsers), the visible in-cell
 * labels are hidden from assistive technology, and nothing in the table may truncate or
 * carry a fixed width (verify6/v7: "posit", "Bewertung" cut at 390 px + 200 % in de).
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import CompareTable from './CompareTable'
import { normalizeRadarPage } from '../../api/radarSchema'

const { compare: COMPARE } = normalizeRadarPage({ compare: { ours_available: true, categories: [{
  category: 'delivery', theirs: { volume: 2, positive_share: 0.8, negative_share: 0.1 },
  ours: { volume: 9, positive_share: 0.5, negative_share: 0.3 }, verdict: 'they_are_better',
}] } })

const renderTable = () => renderWithQueryClient(<MemoryRouter><CompareTable compare={COMPARE} onRead={vi.fn()} /></MemoryRouter>)

/** Classes that cut text or pin a width: none may appear inside the comparison. */
const CLIPPING = /(?:^|\s)(?:truncate|line-clamp-\d|overflow-(?:x-)?(?:auto|hidden|scroll)|whitespace-nowrap|min-w-\[|w-\[|max-w-\[)/

describe('CompareTable reflow', () => {
  it('is a table from a 36rem-wide card and stacked below it, with its card as the container', () => {
    renderTable()
    const table = screen.getByRole('table')
    expect(table.className).toMatch(/(?:^|\s)block\s.*@xl:table(?:\s|$)/)
    expect(table.closest('section')?.className).toContain('@container')
    expect(screen.getAllByRole('row').at(-1)?.className).toMatch(/(?:^|\s)grid\s.*@xl:table-row/)
  })

  it('keeps row and column headers for assistive technology in both layouts', () => {
    renderTable()
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toStrictEqual(['Category', 'Them', 'Us', 'Verdict'])
    expect(screen.getByRole('rowheader').textContent).not.toBe('')
    expect(screen.getAllByRole('cell')).toHaveLength(3)
  })

  it('labels each stacked cell visibly, hidden from screen readers and from the wide table', () => {
    renderTable()
    const labels = screen.getAllByRole('cell').map((cell) => cell.querySelector('[aria-hidden="true"]'))
    expect(labels.map((label) => label?.textContent)).toStrictEqual(['Them', 'Us', 'Verdict'])
    expect(labels.every((label) => label?.className.includes('@xl:hidden') === true)).toBe(true)
  })

  it('never truncates, scrolls or fixes a width, and lets cell text wrap', () => {
    renderTable()
    const section = screen.getByRole('table').closest('section') ?? document.body
    const offenders = [section, ...section.querySelectorAll('*')].filter((el) => CLIPPING.test(el.getAttribute('class') ?? ''))
    expect(offenders.map((el) => el.getAttribute('class'))).toStrictEqual([])
    expect(within(section).getAllByRole('cell').every((cell) => /min-w-0.*break-words.*hyphens-auto/.test(cell.className))).toBe(true)
  })
})
