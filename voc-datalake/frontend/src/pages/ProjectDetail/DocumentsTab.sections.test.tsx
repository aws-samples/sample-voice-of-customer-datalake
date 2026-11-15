/**
 * The Documents tab's New per section (docs/prototype-builder.md "Part 4"): PRD and PR/FAQ open the document
 * wizard with their type, Prototypes the Overview card's build dialog (disabled with its reason while the project
 * has no PRD or PR/FAQ), Documents the existing New document; a viewer sees none.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient as render } from '@test/query-client'
import DocumentsTab from './DocumentsTab'
import { documentsTabStubs, makeDocument, makeProject } from './project-detail-fixtures'
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
  it('opens the PRD and PR/FAQ wizards with their type and New document from the Documents section', async () => {
    const user = userEvent.setup()
    const stubs = renderTab([research, prd])
    await user.click(screen.getByRole('button', { name: 'New PRD' }))
    await user.click(screen.getByRole('button', { name: 'New PR/FAQ' }))
    await user.click(screen.getByRole('button', { name: 'New Document' }))
    expect([stubs.onWriteDocument.mock.calls, stubs.onCreateDoc.mock.calls.length]).toStrictEqual([[['prd'], ['prfaq']], 1])
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
