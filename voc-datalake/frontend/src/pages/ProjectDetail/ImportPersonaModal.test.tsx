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

/**
 * Each option is identified by its accessible name — the label and description
 * the user actually reads — rather than by walking the DOM from the heading. A
 * selector like `heading.parentElement.querySelector('div')` breaks the moment
 * anyone adds a wrapper, which would report the PDF button as gone for a reason
 * that has nothing to do with the PDF button.
 */
const OPTION_NAMES = {
  image: /Screenshot or card/i,
  text: /Paste content/i,
  pdf: /pdf|Upload document/i,
} as const

describe('ImportPersonaModal import type options', () => {
  it('offers image and text, and does not offer PDF', () => {
    render(<ImportPersonaModal {...defaultProps} />)

    // Presence half — without it, "no PDF" would also pass on a picker that
    // rendered nothing at all.
    expect(screen.getByRole('button', { name: OPTION_NAMES.image })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: OPTION_NAMES.text })).toBeInTheDocument()

    // Absence half, scoped to buttons: an unrelated mention of PDF in prose
    // cannot mask a returning button, and cannot fake a passing test either.
    expect(screen.queryByRole('button', { name: OPTION_NAMES.pdf })).not.toBeInTheDocument()
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

  it('keeps Import disabled for whitespace-only content, as the server would', () => {
    // The API refuses blank content before it creates a job, so the button has to
    // use the same predicate. `=== ''` did not: a spacebar press enabled Import and
    // the user's first feedback was a 400 telling them there was nothing to read.
    // An expression, not a string attribute: JSX does not process escapes, so
    // importContent="\n" would be a literal backslash-n and NOT whitespace —
    // the test would pass against a button that ignores whitespace entirely.
    render(<ImportPersonaModal {...defaultProps} importContent={'   \n\t '} />)

    expect(screen.getByRole('button', { name: /Import Persona/i })).toBeDisabled()
  })

  it('enables Import once there is real content', () => {
    // Control: without it, "disabled on whitespace" also passes on a button that
    // is disabled always.
    render(<ImportPersonaModal {...defaultProps} importContent="Name: Sarah Chen" />)

    expect(screen.getByRole('button', { name: /Import Persona/i })).toBeEnabled()
  })

  it('shows the text area and no file picker on the default text type', () => {
    render(<ImportPersonaModal {...defaultProps} />)

    // The default selection must still render a usable section — narrowing the
    // union would otherwise be able to leave the modal blank on open.
    expect(screen.getByRole('heading', { name: 'Paste Persona Content' })).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
