/**
 * @fileoverview The Product tab for a viewer (`project.access.can_edit === false`).
 *
 * Every write on this tab — per-field autosave, the interview that patches the
 * context, uploads and deletes of product docs, the report job — is refused by
 * the project gate with 403. A viewer therefore gets the description and the
 * uploaded docs to read, and none of the controls that could only fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import type { ProductDoc } from '../../api/projectTypes'

const api = vi.hoisted(() => ({
  getProductContext: vi.fn(),
  updateProductContext: vi.fn(),
  listProductDocs: vi.fn(),
  deleteProductDoc: vi.fn(),
  productContextInterview: vi.fn(),
  generateProductReport: vi.fn(),
  getProductDocUploadUrl: vi.fn(),
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: api }))

const readyDoc: ProductDoc = {
  doc_id: 'doc-1',
  filename: 'brief.md',
  content_type: 'text/markdown',
  size_bytes: 2048,
  status: 'ready',
  extracted_chars: 900,
  error: null,
  created_at: new Date().toISOString(),
}

describe('ProductTab for a viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getProductContext.mockResolvedValue({ context: { ...emptyProductContext(), product_name: 'VoC' } })
    api.listProductDocs.mockResolvedValue({ docs: [readyDoc] })
  })

  it('shows the description fields disabled, so no blur can save', async () => {
    render(<ProductTab canEdit={false} projectId="proj-1" />)

    const field = await screen.findByLabelText(/product name/i)
    expect(field).toHaveValue('VoC')
    expect(field).toBeDisabled()
    expect(screen.getByLabelText(/current state/i)).toBeDisabled()
    expect(screen.getByLabelText(/target users/i)).toBeDisabled()
  })

  it('offers neither the interview, the report, nor the mode toggle', async () => {
    render(<ProductTab canEdit={false} projectId="proj-1" />)
    await screen.findByLabelText(/product name/i)

    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate report/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^both$/i })).not.toBeInTheDocument()
  })

  it('lists the uploaded docs read-only: no drop zone and no Delete', async () => {
    render(<ProductTab canEdit={false} projectId="proj-1" />)

    await waitFor(() => expect(screen.getByText('brief.md')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /drop files/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  it('never issues a write while read-only', async () => {
    render(<ProductTab canEdit={false} projectId="proj-1" />)
    await waitFor(() => expect(screen.getByText('brief.md')).toBeInTheDocument())

    expect(api.updateProductContext).not.toHaveBeenCalled()
    expect(api.deleteProductDoc).not.toHaveBeenCalled()
  })
})
