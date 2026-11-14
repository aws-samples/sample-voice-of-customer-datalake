/**
 * The Documents tab's list in its four sections (docs/prototype-builder.md "Part 4"): the order and counts, newest
 * first within a section, folding, each section's New (and none for a viewer), the Prototypes New disabled with its
 * reason, the keyboard, and below 1280 px the row of section buttons that leaves one section in the strip.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentList, { type SectionNewAction } from './DocumentList'
import { makeDocument } from './project-detail-fixtures'
import { at, defined } from '@test/defined'
import type { DocumentSectionId } from '../../api/documentSections'
import type { ProjectDocument } from '../../api/types'
import { formatDate } from '../../utils/dateUtils'

const DOCUMENTS: ProjectDocument[] = [
  makeDocument({ document_id: 'notes', document_type: 'research', title: 'Interview notes', created_at: '2026-05-01T00:00:00Z' }),
  makeDocument({ document_id: 'prd-1', document_type: 'prd', title: 'Launch (v1)', version: 1, created_at: '2026-01-01T00:00:00Z' }),
  makeDocument({ document_id: 'faq-1', document_type: 'prfaq', title: 'Launch FAQ (v1)', version: 1, created_at: '2026-02-01T00:00:00Z' }),
  // Edited after v2 was written: the last edit, not the creation, puts it first.
  makeDocument({
    document_id: 'prd-old', document_type: 'prd', title: 'Pricing (v1)', version: 1, created_at: '2025-06-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  }),
  makeDocument({ document_id: 'prd-2', document_type: 'prd', title: 'Launch (v2)', version: 2, created_at: '2026-03-01T00:00:00Z' }),
  makeDocument({ document_id: 'faq-2', document_type: 'prfaq', title: 'Launch FAQ (v2)', version: 2, created_at: '2026-03-02T00:00:00Z' }),
  // A type added later is a Document; a row the read filed under PR/FAQ is listed there.
  makeDocument({ document_id: 'later', document_type: 'roadmap', title: 'Roadmap', created_at: '2026-01-15T00:00:00Z' }),
  makeDocument({ document_id: 'filed', document_type: 'custom', section: 'prfaq', title: 'Filed FAQ', created_at: '2026-01-10T00:00:00Z' }),
]

function editorActions(overrides: Partial<Record<DocumentSectionId, Partial<SectionNewAction>>> = {}) {
  const action = (section: DocumentSectionId): SectionNewAction => ({ onClick: vi.fn(), ...overrides[section] })
  return { prd: action('prd'), prfaq: action('prfaq'), prototypes: action('prototypes'), documents: action('documents') }
}

function renderList(props: Partial<Parameters<typeof DocumentList>[0]> = {}) {
  const onSelectDoc = vi.fn()
  render(<DocumentList documents={DOCUMENTS} selectedDoc={null} onSelectDoc={onSelectDoc} {...props} />)
  return { onSelectDoc }
}

/** The wide column's disclosure buttons, in order (each inside its section's heading). */
const disclosures = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => within(heading).getByRole('button'))
/** What a screen reader hears of a section button ("PR/FAQ, 3 documents"; the name and count on screen are hidden from it). */
const spoken = (button: HTMLElement): string => within(button).queryByText(/, \d+ documents?$/)?.textContent ?? ''
/** The narrow row of section buttons. */
const picker = () => screen.getByRole('group', { name: 'Document sections' })
/** The titles listed under the section a button controls (empty when the list is not rendered). */
function titlesUnder(button: HTMLElement): string[] {
  const list = document.getElementById(button.getAttribute('aria-controls') ?? '')
  return list === null ? [] : Array.from(list.querySelectorAll('button p'), (p) => p.textContent)
}
/** The section block (heading, New, list) of a disclosure button. */
const sectionBlock = (button: HTMLElement) => button.closest('h2')?.parentElement?.parentElement ?? null

describe('DocumentList sections', () => {
  it('shows the four sections in order with their counts, as a screen reader names them', () => {
    renderList()
    expect(disclosures().at(1)).toHaveAccessibleName('PR/FAQ, 3 documents')
    expect(disclosures().map((button) => [spoken(button), button.getAttribute('aria-expanded')])).toStrictEqual([
      ['PRD, 3 documents', 'true'],
      ['PR/FAQ, 3 documents', 'true'],
      ['Prototypes, 0 documents', 'true'],
      ['Documents, 2 documents', 'true'],
    ])
  })

  it('lists each section newest first by last edit (updated_at, else created_at)', () => {
    renderList()
    expect(disclosures().map(titlesUnder)).toStrictEqual([
      ['Pricing (v1)', 'Launch (v2)', 'Launch (v1)'],
      ['Launch FAQ (v2)', 'Launch FAQ (v1)', 'Filed FAQ'],
      [],
      ['Interview notes', 'Roadmap'],
    ])
  })

  it('shows on each row the date it sorts on: the last edit, else the creation', () => {
    renderList()
    const rowDate = (title: RegExp) => screen.getByRole('button', { name: title }).querySelector('span.text-muted')?.textContent
    expect([rowDate(/Pricing \(v1\)$/), rowDate(/Launch \(v2\)$/)]).toStrictEqual([
      formatDate('2026-04-01T00:00:00Z', 'en', '', 'short'),
      formatDate('2026-03-01T00:00:00Z', 'en', '', 'short'),
    ])
    expect(rowDate(/Pricing \(v1\)$/)).not.toBe(formatDate('2025-06-01T00:00:00Z', 'en', '', 'short'))
  })

  it('shows an empty section with its heading, a count of 0, "No documents" and its New', () => {
    renderList({ newActions: editorActions() })
    const block = defined(sectionBlock(at(disclosures(), 2, 'sections')) ?? undefined, 'the Prototypes section')
    expect([within(block).getByText('0').textContent, within(block).getByText('No documents').tagName]).toStrictEqual(['0', 'LI'])
    expect(within(block).getByRole('button', { name: 'New prototype' })).toBeEnabled()
  })

  it('folds and unfolds a section from its button (Enter and Space), every section open again on the next view', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DocumentList documents={DOCUMENTS} selectedDoc={null} onSelectDoc={vi.fn()} />)
    const faq = at(disclosures(), 1, 'sections')

    faq.focus()
    await user.keyboard('{Enter}')
    expect([faq.getAttribute('aria-expanded'), titlesUnder(faq)]).toStrictEqual(['false', []])
    await user.keyboard(' ')
    expect([faq.getAttribute('aria-expanded'), titlesUnder(faq)]).toStrictEqual(['true', ['Launch FAQ (v2)', 'Launch FAQ (v1)', 'Filed FAQ']])
    await user.click(faq)
    unmount()

    renderList()
    expect(disclosures().map((button) => button.getAttribute('aria-expanded'))).toStrictEqual(['true', 'true', 'true', 'true'])
  })

  it('selects a row and marks the selected one current', async () => {
    const user = userEvent.setup()
    const selected = DOCUMENTS[1] ?? null
    const { onSelectDoc } = renderList({ selectedDoc: selected })
    expect(screen.getByRole('button', { name: /Launch \(v1\)$/ })).toHaveAttribute('aria-current', 'true')
    await user.click(screen.getByRole('button', { name: /Interview notes$/ }))
    expect(onSelectDoc).toHaveBeenCalledWith(DOCUMENTS[0])
  })
})

describe('DocumentList New per section', () => {
  it('gives an editor each section\'s New, which opens that section\'s flow', async () => {
    const user = userEvent.setup()
    const actions = editorActions()
    renderList({ newActions: actions })
    for (const name of ['New PRD', 'New PR/FAQ', 'New prototype', 'New Document']) {
      await user.click(screen.getByRole('button', { name }))
    }
    expect([actions.prd, actions.prfaq, actions.prototypes, actions.documents].map((a) => vi.mocked(a.onClick).mock.calls.length))
      .toStrictEqual([1, 1, 1, 1])
  })

  it('gives a viewer no New at all', () => {
    renderList()
    expect(screen.queryAllByRole('button', { name: /^New/ })).toStrictEqual([])
  })

  it('disables the Prototypes New with its reason, said under the heading and as the button\'s description', () => {
    renderList({ newActions: editorActions({ prototypes: { disabled: true, reason: 'Create a PRD or PR/FAQ first' } }) })
    const button = screen.getByRole('button', { name: 'New prototype' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('Create a PRD or PR/FAQ first')
    expect(screen.getByText('Create a PRD or PR/FAQ first')).toBeVisible()
  })

  it('shows the section\'s status line', () => {
    renderList({ newActions: editorActions({ prototypes: { status: <p role="status">Build started</p> } }) })
    expect(screen.getByRole('status')).toHaveTextContent('Build started')
  })
})

describe('DocumentList keyboard', () => {
  it('reaches the section buttons, each heading, its New and its rows in reading order', async () => {
    const user = userEvent.setup()
    render(
      <DocumentList documents={DOCUMENTS.slice(0, 3)} selectedDoc={null} onSelectDoc={vi.fn()} newActions={editorActions()} />,
    )
    const readingOrder = [
      'PRD, 1 document', 'PR/FAQ, 1 document', 'Prototypes, 0 documents', 'Documents, 1 document',
      'PRD, 1 document', 'New PRD', 'Launch (v1)',
      'PR/FAQ, 1 document', 'New PR/FAQ', 'Launch FAQ (v1)',
      'Prototypes, 0 documents', 'New prototype',
      'Documents, 1 document', 'New Document',
    ]
    const focusedName = (): string => {
      const focused = document.activeElement
      const element = focused instanceof HTMLElement ? focused : document.body
      return element.getAttribute('aria-label') ?? element.querySelector('p')?.textContent ?? spoken(element)
    }
    for (const [step, name] of readingOrder.entries()) {
      await user.tab()
      expect(focusedName(), `Tab ${String(step + 1)}`).toBe(name)
    }
  })
})

describe('DocumentList below 1280 px', () => {
  /** The section blocks the narrow strip hides (`hidden` below xl, shown from xl). */
  const hiddenWhenNarrow = () => disclosures().map((button) => sectionBlock(button)?.classList.contains('hidden') ?? false)
  const pickerButtons = () => within(picker()).getAllByRole('button')

  it('shows a row of section buttons, only from narrow widths, in order with their counts', () => {
    renderList()
    expect(picker()).toHaveClass('xl:hidden')
    expect(pickerButtons().at(2)).toHaveAccessibleName('Prototypes, 0 documents')
    expect(pickerButtons().map(spoken)).toStrictEqual([
      'PRD, 3 documents', 'PR/FAQ, 3 documents', 'Prototypes, 0 documents', 'Documents, 2 documents',
    ])
  })

  it('holds the selected document\'s section in the strip, the others hidden there', () => {
    renderList({ selectedDoc: DOCUMENTS[0] ?? null })
    expect(pickerButtons().map((button) => button.getAttribute('aria-expanded'))).toStrictEqual(['false', 'false', 'false', 'true'])
    expect(hiddenWhenNarrow()).toStrictEqual([true, true, true, false])
  })

  it('holds the first section with documents when nothing is selected', () => {
    render(<DocumentList documents={DOCUMENTS.slice(0, 1)} selectedDoc={null} onSelectDoc={vi.fn()} />)
    expect(hiddenWhenNarrow()).toStrictEqual([true, true, true, false])
  })

  it('switches the strip to the section picked, keeping its rows even while folded in the wide column', async () => {
    const user = userEvent.setup()
    renderList({ selectedDoc: DOCUMENTS[0] ?? null })
    const faqToggle = at(disclosures(), 1, 'sections')
    await user.click(faqToggle)
    expect(titlesUnder(faqToggle)).toStrictEqual([])

    const faqButton = within(picker()).getByRole('button', { name: 'PR/FAQ, 3 documents' })
    faqButton.focus()
    await user.keyboard('{Enter}')
    expect([faqButton.getAttribute('aria-expanded'), faqButton.className.includes('tab-active')]).toStrictEqual(['true', true])
    expect(hiddenWhenNarrow()).toStrictEqual([true, false, true, true])
    const list = document.getElementById(faqButton.getAttribute('aria-controls') ?? '')
    expect([list?.className.includes('xl:hidden'), titlesUnder(faqButton)]).toStrictEqual([true, ['Launch FAQ (v2)', 'Launch FAQ (v1)', 'Filed FAQ']])
  })
})
