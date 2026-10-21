/**
 * @fileoverview Tests for the JsonUploadModal large-file mapping path (Phase 5).
 *
 * Focused on the mapping glue — field detection → source-field dropdown →
 * threading the choice into the S3 upload. The sync (small-file) path and the
 * detection/upload internals are covered by their own unit suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JsonUploadModal from './JsonUploadModal'

const mockUploadFileToS3 = vi.fn()
vi.mock('../../api/s3Upload', () => ({
  uploadFileToS3: (...args: unknown[]) => mockUploadFileToS3(...args),
}))

const mockDetectFileFields = vi.fn()
vi.mock('./extraFieldDetection', () => ({
  detectFileFields: (...args: unknown[]) => mockDetectFileFields(...args),
}))

// Force the large-file branch regardless of the fixture's real size.
vi.mock('./jsonUploadSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jsonUploadSchema')>()
  return { ...actual, isLargeJsonFile: () => true }
})

function makeJsonFile(name = 'big.json'): File {
  const file = new File(['[{"text":"a","platform":"web"}]'], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve('[{"text":"a","platform":"web"}]') })
  return file
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

describe('JsonUploadModal — large-file mapping (Phase 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectFileFields.mockResolvedValue({ fields: ['text', 'platform', 'region'] })
    mockUploadFileToS3.mockResolvedValue({ ok: true })
  })

  it('shows the per-row source-field dropdown with detected fields after staging a large file', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<JsonUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeJsonFile())

    const select = await screen.findByLabelText(/per-row source field/i)
    expect(select).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'platform' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'region' })).toBeInTheDocument()
  })

  it('threads the chosen source field into the S3 upload', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<JsonUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeJsonFile())
    await screen.findByLabelText(/per-row source field/i)

    await user.type(screen.getByLabelText(/^source/i), 'trustpilot')
    await user.selectOptions(screen.getByLabelText(/per-row source field/i), 'platform')
    await user.click(screen.getByRole('button', { name: /upload & process/i }))

    await waitFor(() =>
      expect(mockUploadFileToS3).toHaveBeenCalledWith(expect.any(File), 'trustpilot', 'platform'),
    )
  })

  it('uploads with no source field when none is chosen', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<JsonUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeJsonFile())
    await screen.findByLabelText(/per-row source field/i)

    await user.type(screen.getByLabelText(/^source/i), 'trustpilot')
    await user.click(screen.getByRole('button', { name: /upload & process/i }))

    await waitFor(() =>
      expect(mockUploadFileToS3).toHaveBeenCalledWith(expect.any(File), 'trustpilot', undefined),
    )
  })

  it('offers no mapping dropdown when field detection yields nothing', async () => {
    mockDetectFileFields.mockResolvedValue({ fields: [] })
    const user = userEvent.setup({ applyAccept: false })
    render(<JsonUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeJsonFile())
    // The source text input appears (large-file panel), but no mapping dropdown.
    await screen.findByLabelText(/^source/i)
    expect(screen.queryByLabelText(/per-row source field/i)).not.toBeInTheDocument()
  })
})
