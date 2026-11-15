/**
 * The Documents tab's New per section (docs/prototype-builder.md "Part 4"): PRD and PR/FAQ a menu ("Blank": the
 * blank draft; "With the wizard": the document wizard with their type), Prototypes the Overview card's build dialog
 * (disabled with its reason while the project has no PRD or PR/FAQ), Documents a blank document at once (busy while
 * it is created, its failure said); a viewer sees none.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient as render } from '@test/query-client'
import DocumentsTab from './DocumentsTab'
import { blankStubs, documentsTabStubs, makeDocument, makeProject } from './project-detail-fixtures'
import { VIEWER_ACCESS } from './projectAccess-fixtures'
import type { ProjectDocument } from '../../api/types'

const NEEDS_DOCS = 'Create a PRD or a PR/FAQ first to enable prototype build'
const project = makeProject({ project_id: 'proj-1' })
const research = makeDocument({ document_id: 'r1', document_type: 'research', title: 'Notes', created_at: '2026-01-01T00:00:00Z' })
const prd = makeDocument({ document_id: 'p1', document_type: 'prd', title: 'Launch (v1)', version: 1, created_at: '2026-01-02T00:00:00Z' })

function renderTab(documents: ProjectDocument[], overrides: Partial<Parameters<typeof DocumentsTab>[0]> = {}) {
  const stubs = documentsTabStubs()
  render(
    <MemoryRouter>
      <DocumentsTab project={project} documents={documents} selectedDoc={null} onSelectDoc={vi.fn()} {...stubs} {...overrides} />
    </MemoryRouter>,
  )
  return stubs
}

describe('DocumentsTab New per section', () => {
  it('makes the PRD and PR/FAQ New a menu: Blank and With the wizard, each described', async () => {
    const user = userEvent.setup()
    renderTab([research, prd])
    const newPrd = screen.getByRole('button', { name: 'New PRD' })
    expect(newPrd).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(newPrd)
    const menu = screen.getByRole('menu', { name: 'New PRD' })
    const blank = within(menu).getByRole('menuitem', { name: 'Blank' })
    expect(blank).toHaveAccessibleDescription('An empty PRD from its outline: you name it and write it on the page.')
    expect(within(menu).getByRole('menuitem', { name: 'With the wizard' }))
      .toHaveAccessibleDescription('Choose the evidence and answer the guided questions first.')
    expect(blank).toHaveFocus()
  })

  it('starts the blank draft or the wizard with the section\'s type, and closes the menu back on New', async () => {
    const user = userEvent.setup()
    const stubs = renderTab([research, prd])
    await user.click(screen.getByRole('button', { name: 'New PRD' }))
    await user.click(screen.getByRole('menuitem', { name: 'Blank' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New PR/FAQ' }))
    await user.click(screen.getByRole('menuitem', { name: 'With the wizard' }))
    expect([stubs.blank.startManaged.mock.calls, stubs.onWriteDocument.mock.calls]).toStrictEqual([[['prd']], [['prfaq']]])
  })

  it('opens the menu from the keyboard and Escape puts focus back on New, starting nothing', async () => {
    const user = userEvent.setup()
    const stubs = renderTab([research, prd])
    const newPrfaq = screen.getByRole('button', { name: 'New PR/FAQ' })
    newPrfaq.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Blank' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'With the wizard' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect([screen.queryByRole('menu'), document.activeElement === newPrfaq]).toStrictEqual([null, true])
    expect([stubs.blank.startManaged, stubs.onWriteDocument].map((spy) => spy.mock.calls.length)).toStrictEqual([0, 0])
  })

  it('creates a blank document at once from the Documents New: no menu, no dialog', async () => {
    const user = userEvent.setup()
    const stubs = renderTab([research, prd])
    const newDocument = screen.getByRole('button', { name: 'New Document' })
    expect(newDocument).not.toHaveAttribute('aria-haspopup')
    await user.click(newDocument)
    expect([stubs.blank.startCustom.mock.calls.length, screen.queryByRole('dialog'), screen.queryByRole('menu')])
      .toStrictEqual([1, null, null])
  })

  it('keeps the Documents New disabled while the blank document is created', () => {
    renderTab([research], { blank: blankStubs({ creatingCustom: true }) })
    expect(screen.getByRole('button', { name: 'New Document' })).toBeDisabled()
  })

  it('says under the Documents section that a blank document could not be created', () => {
    renderTab([research], { blank: blankStubs({ customFailed: true }) })
    expect(screen.getByText('The document could not be created. Try again.')).toHaveAttribute('role', 'status')
  })

  it('disables the Prototypes New with its reason while the project has no PRD or PR/FAQ', () => {
    renderTab([research])
    const button = screen.getByRole('button', { name: 'New prototype' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(NEEDS_DOCS)
  })

  it('opens the build dialog from the Prototypes New once there is a PRD, starting nothing', async () => {
    const user = userEvent.setup()
    renderTab([research, prd])
    const button = screen.getByRole('button', { name: 'New prototype' })
    expect([button.hasAttribute('disabled'), screen.queryByText(NEEDS_DOCS)]).toStrictEqual([false, null])
    await user.click(button)
    expect(await screen.findByTestId('prototype-build-wizard')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Build Prototype' })).toBeInTheDocument()
  })

  it('follows the server\'s methodology when it says the build is blocked', () => {
    renderTab([research, prd], {
      methodology: { order: ['prototype'], steps: { prototype: { missing: ['prd'], count: 0, blocked: true } } },
    })
    expect(screen.getByRole('button', { name: 'New prototype' })).toBeDisabled()
  })

  it('gives a viewer no New in any section', () => {
    renderTab([research, prd], { project: { ...project, access: VIEWER_ACCESS } })
    expect(screen.queryAllByRole('button', { name: /^New/ })).toStrictEqual([])
  })
})
