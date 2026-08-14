/**
 * ImportPersonaModal — the PDF affordance must not come back.
 *
 * PDF import was offered here and could not work: nothing in this platform
 * extracts text from a PDF, so the job handed the model a placeholder sentence
 * and the model invented a persona. The button is the part of that defect a user
 * actually meets, so it is gone, and the file picker no longer says it will take
 * a PDF.
 *
 * Both halves are asserted in each test: "PDF is not rendered" is satisfied by a
 * component that renders nothing at all, so every absence check sits next to the
 * presence check for the two options that DO work.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ImportPersonaModal from './ImportPersonaModal'

const defaultProps = {
  importType: 'text' as const,
  importContent: '',
  importFileName: '',
  importMediaType: '',
  isImporting: false,
  onTypeChange: vi.fn(),
  onContentChange: vi.fn(),
  onFileChange: vi.fn(),
  onClose: vi.fn(),
  onImport: vi.fn(),
}

/** The type picker, whose buttons are the affordance under test. */
function importTypeButtons(): HTMLElement[] {
  const heading = screen.getByRole('heading', { name: 'Import From' })
  const picker = heading.parentElement?.querySelector('div')
  if (!picker) throw new Error('import type picker not found')
  return Array.from(picker.querySelectorAll('button'))
}

describe('ImportPersonaModal import type options', () => {
  it('offers image and text, and does not offer PDF', () => {
    render(<ImportPersonaModal {...defaultProps} />)

    const labels = importTypeButtons().map((b) => b.textContent ?? '')

    // Presence half — without it, "no PDF" would also pass on an empty picker.
    expect(labels.some((l) => l.includes('Image'))).toBe(true)
    expect(labels.some((l) => l.includes('Text'))).toBe(true)
    expect(importTypeButtons()).toHaveLength(2)

    // Absence half. Checked against the picker's own buttons rather than the
    // whole document, so an unrelated mention of PDF elsewhere could not mask a
    // returning button (or fake a passing test).
    expect(labels.some((l) => /pdf/i.test(l))).toBe(false)
  })

  it('renders no PDF option text anywhere in the modal', () => {
    render(<ImportPersonaModal {...defaultProps} />)

    // The locale keys (importPersona.pdf = "PDF", pdfDesc = "Upload document")
    // are intentionally still in the catalogues, so this asserts they are not
    // being READ, which is the thing that matters.
    expect(screen.queryByText('PDF')).not.toBeInTheDocument()
    expect(screen.queryByText('Upload document')).not.toBeInTheDocument()
    // Control: the two options that do work are rendered from the same catalogue.
    expect(screen.getByText('Screenshot or card')).toBeInTheDocument()
    expect(screen.getByText('Paste content')).toBeInTheDocument()
  })
})

describe('ImportPersonaModal file picker', () => {
  function fileInput(): HTMLInputElement {
    const input = document.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
    return input
  }

  it('accepts only image types and never a pdf', () => {
    render(<ImportPersonaModal {...defaultProps} importType="image" />)

    const accept = fileInput().getAttribute('accept') ?? ''

    // Presence half: an empty or missing accept attribute would trivially satisfy
    // "does not contain pdf" while letting the OS picker offer every file type.
    expect(accept).toContain('image/png')
    expect(accept).toContain('image/jpeg')
    expect(accept).toContain('image/gif')
    expect(accept).toContain('image/webp')

    expect(accept).not.toContain('pdf')
  })

  it('tells the user which image formats are accepted, not "PDF files only"', () => {
    render(<ImportPersonaModal {...defaultProps} importType="image" />)

    expect(screen.getByText('PNG, JPG, GIF, WebP')).toBeInTheDocument()
    expect(screen.queryByText('PDF files only')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Upload Image' })).toBeInTheDocument()
  })

  it('shows the text area and no file picker on the default text type', () => {
    render(<ImportPersonaModal {...defaultProps} />)

    // The default selection must still render a usable section — narrowing the
    // union would otherwise be able to leave the modal blank on open.
    expect(screen.getByRole('heading', { name: 'Paste Persona Content' })).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
