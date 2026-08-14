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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  render, screen, fireEvent, waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportPersonaModal from './ImportPersonaModal'
import { useImportModalState } from './useModalState'

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

  /**
   * Every string this section renders from the catalogue is asserted, not just the
   * two the PDF removal touched. A missing key makes t() return the key NAME, so an
   * unasserted string shows the user `importPersona.clickToUpload` and no test
   * notices — which a probe deleting each key from all eight catalogues confirmed
   * for exactly these two before they were pinned here.
   */
  it('renders the empty dropzone prompt from the catalogue', () => {
    render(<ImportPersonaModal {...defaultProps} importType="image" />)

    expect(screen.getByText('Click to upload or drag and drop')).toBeInTheDocument()
  })

  it('renders the chosen-file prompt from the catalogue', () => {
    render(
      <ImportPersonaModal {...defaultProps} importType="image" importFileName="shot.png" />,
    )

    expect(screen.getByText('shot.png')).toBeInTheDocument()
    expect(screen.getByText('Click to change file')).toBeInTheDocument()
    // Control: the two states are mutually exclusive, so asserting the second
    // without this would pass on a section that renders both at once.
    expect(screen.queryByText('Click to upload or drag and drop')).not.toBeInTheDocument()
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

/**
 * Drop and paste — the two paths the zone's own hint promised and neither of
 * which existed.
 *
 * Driven through the REAL state hook (useImportModalState) rather than a spy on
 * onFileChange, because what a reviewer of the original bug needs to see is what
 * the user sees: the filename appears, Import becomes clickable, and the request
 * that leaves has a media_type from the four types the API will accept. An
 * assertion on "onFileChange was called" would have passed on a handler that
 * fed the state something the server then 400s.
 *
 * jsdom has no image codec, so the imaging primitives are faked the same way
 * ProductDocsUpload.component.test.tsx fakes them.
 */
describe('ImportPersonaModal image input paths', () => {
  interface ImportRequest {
    readonly input_type: string
    readonly content: string
    readonly media_type: string
  }

  const submitted = vi.fn<(request: ImportRequest) => void>()

  /**
   * The modal wired to the state it really runs against, and to the same request
   * body ProjectDetail.handleImportPersona sends.
   */
  function ImportHarness() {
    const state = useImportModalState()
    return (
      <ImportPersonaModal
        importType={state.importType}
        importContent={state.importContent}
        importFileName={state.importFileName}
        importMediaType={state.importMediaType}
        isImporting={false}
        onTypeChange={state.handleTypeChange}
        onContentChange={state.setImportContent}
        onFileChange={state.handleFileChange}
        onClose={state.closeModal}
        onImport={() => submitted({
          input_type: state.importType,
          content: state.importContent,
          media_type: state.importMediaType,
        })}
      />
    )
  }

  class FakeOffscreenCanvas {
    readonly width: number
    readonly height: number

    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }

    getContext(contextId: string) {
      if (contextId !== '2d') return null
      return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }
    }

    convertToBlob(options: { type: string }): Promise<Blob> {
      // Half a byte per pixel — under the 3.75 MB cap at 1568 px, so the first
      // (PNG) rung of the ladder wins.
      const bytes = Math.round((this.width * this.height) / 2)
      return Promise.resolve(new Blob([new Uint8Array(bytes)], { type: options.type }))
    }
  }

  function stubImaging(width: number, height: number) {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({
      width, height, close: () => undefined,
    })))
  }

  /** The visible drop target — the element the handlers have to be on. */
  function dropZone(): HTMLElement {
    const zone = document.querySelector('.border-dashed')
    if (!(zone instanceof HTMLElement)) throw new Error('drop zone not found')
    return zone
  }

  function importButton(): HTMLElement {
    return screen.getByRole('button', { name: /Import Persona/i })
  }

  function dropFiles(files: readonly File[]) {
    fireEvent.drop(dropZone(), { dataTransfer: { files, types: ['Files'] } })
  }

  function pasteFiles(target: HTMLElement, files: readonly File[], kind = 'file') {
    return fireEvent.paste(target, {
      clipboardData: {
        items: files.map((file) => ({ kind, type: file.type, getAsFile: () => file })),
        files,
      },
    })
  }

  function readRequest(): ImportRequest {
    expect(submitted).toHaveBeenCalledTimes(1)
    return submitted.mock.calls[0][0]
  }

  /** Switches to the image type, which is where the dropzone lives. */
  async function openImageStep() {
    const user = userEvent.setup({ applyAccept: false })
    render(<ImportHarness />)
    await user.click(screen.getByRole('button', { name: /Screenshot or card/i }))
    return user
  }

  function imageFile(name: string, type: string, bytes: number): File {
    return new File([new Uint8Array(bytes)], name, { type })
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    submitted.mockReset()
  })

  it('selects a dropped PNG exactly as the picker does', async () => {
    // The bug: the visible zone had no onDrop, so a real DragEvent carrying a PNG
    // left the modal unchanged — no filename, Import still disabled.
    stubImaging(800, 600)
    await openImageStep()

    dropFiles([imageFile('persona-card.png', 'image/png', 1024)])

    expect(await screen.findByText('persona-card.png')).toBeInTheDocument()
    await waitFor(() => expect(importButton()).toBeEnabled())

    fireEvent.click(importButton())
    const request = readRequest()
    expect(request.input_type).toBe('image')
    // The API returns 400 before doing any work when media_type is blank or
    // outside the four Converse types — a real one has to be sent.
    expect(request.media_type).toBe('image/png')
    expect(request.content.length).toBeGreaterThan(0)
    // base64, not a data URL: the server decodes this directly.
    expect(request.content).not.toContain('data:')
  })

  it('selects a picked PNG the same way, as the control for the drop above', async () => {
    // The path that already worked must keep working — every assertion in the
    // drop test would otherwise be satisfiable by a component that only ever had
    // one entry point.
    stubImaging(800, 600)
    const user = await openImageStep()

    const input = document.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
    await user.upload(input, imageFile('picked.png', 'image/png', 1024))

    expect(await screen.findByText('picked.png')).toBeInTheDocument()
    await waitFor(() => expect(importButton()).toBeEnabled())
    fireEvent.click(importButton())
    expect(readRequest().media_type).toBe('image/png')
  })

  it('marks the zone while a drag is over it, and unmarks it on leave', async () => {
    await openImageStep()
    // Baseline: the idle zone is the neutral gray the empty state uses, so the
    // assertion below cannot pass on a zone that is always highlighted.
    expect(dropZone()).toHaveClass('border-gray-300')

    fireEvent.dragEnter(dropZone(), { dataTransfer: { files: [], types: ['Files'] } })
    expect(dropZone()).toHaveClass('border-purple-500')

    fireEvent.dragLeave(dropZone(), { dataTransfer: { files: [], types: ['Files'] } })
    expect(dropZone()).toHaveClass('border-gray-300')
  })

  it('cancels the drop so the browser does not navigate to the file', async () => {
    // Without preventDefault on drop (and on dragover) the browser's default
    // wins and OPENS the dropped file, discarding the modal entirely.
    stubImaging(800, 600)
    await openImageStep()

    const dropped = fireEvent.drop(dropZone(), {
      dataTransfer: { files: [imageFile('card.png', 'image/png', 512)], types: ['Files'] },
    })
    const draggedOver = fireEvent.dragOver(dropZone(), {
      dataTransfer: { files: [], types: ['Files'] },
    })

    // fireEvent returns false when a handler called preventDefault.
    expect(dropped).toBe(false)
    expect(draggedOver).toBe(false)
    // Settle the selection the drop started, so its state update lands inside the
    // test rather than after it (React reports an unwrapped update otherwise).
    expect(await screen.findByText('card.png')).toBeInTheDocument()
  })

  it('selects a pasted screenshot and gives the nameless bitmap a name', async () => {
    // A pasted bitmap has file.name === '', which rendered as a blank row.
    stubImaging(800, 600)
    await openImageStep()

    pasteFiles(dropZone(), [new File([new Uint8Array(2048)], '', { type: 'image/png' })])

    const name = await screen.findByText(/^pasted-.+\.png$/)
    expect(name).toBeInTheDocument()
    await waitFor(() => expect(importButton()).toBeEnabled())
    fireEvent.click(importButton())
    expect(readRequest().media_type).toBe('image/png')
  })

  it('names a pasted JPEG .jpg, the extension the rest of the app uses', async () => {
    // image/jpeg's MIME subtype is "jpeg" while this app calls the extension
    // .jpg everywhere (utils/imageInput.ts, resizeImage.ts, image_limits.py).
    // Reachable because an image already inside both limits passes through the
    // resize untouched and keeps the name given here.
    stubImaging(400, 300)
    await openImageStep()

    pasteFiles(dropZone(), [new File([new Uint8Array(512)], '', { type: 'image/jpeg' })])

    expect(await screen.findByText(/^pasted-.+\.jpg$/)).toBeInTheDocument()
    expect(screen.queryByText(/\.jpeg$/)).not.toBeInTheDocument()
  })

  it('resizes a pasted retina screenshot instead of sending it over the model limit', async () => {
    // The normal paste case. 4 MB is already past the 3.75 MB per-image Converse
    // cap, so sending the original would 400 after submission — which is why
    // every image path goes through the resize helper.
    stubImaging(3000, 2000)
    await openImageStep()

    pasteFiles(dropZone(), [new File([new Uint8Array(4_000_000)], '', { type: 'image/png' })])

    await waitFor(() => expect(importButton()).toBeEnabled())
    fireEvent.click(importButton())
    const request = readRequest()
    // 1568x1045 at the fake half-byte-per-pixel encoder.
    const bytesSent = atob(request.content).length
    expect(bytesSent).toBe(Math.round((1568 * 1045) / 2))
    expect(bytesSent).toBeLessThan(3_750_000)
    // And the media type describes the PREPARED bytes, which is what the server
    // is handed.
    expect(request.media_type).toBe('image/png')
  })

  it('refuses a dropped PDF out loud and keeps the image already chosen', async () => {
    // Silently ignoring it is indistinguishable from the bug being fixed here.
    stubImaging(800, 600)
    await openImageStep()
    dropFiles([imageFile('good.png', 'image/png', 512)])
    await screen.findByText('good.png')

    dropFiles([new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })])

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an image we can read/i)
    // The exact set the server enforces, so the two refusals name the same four.
    expect(screen.getByRole('alert')).toHaveTextContent('.gif, .jpg, .png, .webp')
    // The earlier good selection survived — a refusal must not throw work away.
    expect(screen.getByText('good.png')).toBeInTheDocument()
    expect(importButton()).toBeEnabled()
  })

  it('refuses a dropped folder, which arrives with no content type at all', async () => {
    stubImaging(800, 600)
    await openImageStep()

    // A dropped directory surfaces as an entry with an empty type.
    dropFiles([new File([], 'screenshots', { type: '' })])

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an image we can read/i)
    // Localized, not the raw empty string — "(unknown type)" rather than "()".
    expect(screen.getByRole('alert')).toHaveTextContent('unknown type')
    expect(importButton()).toBeDisabled()
  })

  it('refuses a pasted .docx and says why', async () => {
    stubImaging(800, 600)
    await openImageStep()

    pasteFiles(dropZone(), [new File(['PK'], 'persona.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })])

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an image we can read/i)
    expect(importButton()).toBeDisabled()
  })

  it('leaves a paste carrying no file completely alone', async () => {
    await openImageStep()

    const event = fireEvent.paste(dropZone(), {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
      },
    })

    // Not cancelled ⇒ an ordinary text paste still behaves like a paste, and no
    // error is invented for something that was never an image attempt.
    expect(event).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels a paste that does carry an image, as the control for the above', async () => {
    stubImaging(400, 300)
    await openImageStep()

    const event = pasteFiles(dropZone(), [
      new File([new Uint8Array(256)], '', { type: 'image/png' }),
    ])

    expect(event).toBe(false)
    expect(await screen.findByText(/^pasted-.+\.png$/)).toBeInTheDocument()
  })

  it('reads the clipboard files list when items is empty', async () => {
    // Some paste sources populate only `files`. Dropping that fallback loses
    // whole browsers, and the loss is silent.
    stubImaging(400, 300)
    await openImageStep()

    fireEvent.paste(dropZone(), {
      clipboardData: { items: [], files: [new File([new Uint8Array(256)], 'shot.png', { type: 'image/png' })] },
    })

    expect(await screen.findByText('shot.png')).toBeInTheDocument()
  })

  it('does not intercept a paste into the persona textarea', async () => {
    // The text-import path has its own paste behaviour and must stay untouched:
    // the modal-level handler is scoped to the image step, and an image-carrying
    // clipboard is not a reason to cancel a paste aimed at a textarea.
    render(<ImportHarness />)
    const textarea = screen.getByPlaceholderText(/Paste your persona description/i)

    const textPaste = fireEvent.paste(textarea, {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [] },
    })
    const imagePaste = pasteFiles(textarea, [new File([new Uint8Array(64)], '', { type: 'image/png' })])

    expect(textPaste).toBe(true)
    expect(imagePaste).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says an image is unreadable rather than failing silently', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('bad bytes'))))
    await openImageStep()

    dropFiles([imageFile('broken.png', 'image/png', 4_000_000)])

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not read that image/i)
    expect(importButton()).toBeDisabled()
  })

  it('says an image is still too large when no quality step gets it under the cap', async () => {
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }
      }

      convertToBlob(options: { type: string }): Promise<Blob> {
        const blob = new Blob([new Uint8Array(8)], { type: options.type })
        Object.defineProperty(blob, 'size', { value: 3_900_000 })
        return Promise.resolve(blob)
      }
    })
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({
      width: 4000, height: 3000, close: () => undefined,
    })))
    await openImageStep()

    dropFiles([imageFile('huge.png', 'image/png', 9_000_000)])

    expect(await screen.findByRole('alert')).toHaveTextContent(/still too large after resizing/i)
    expect(importButton()).toBeDisabled()
  })

  it('tells the user paste is a way in, from the catalogue', async () => {
    // A missing key makes t() return the key name, which is what an unasserted
    // string ships to users.
    await openImageStep()

    expect(screen.getByText('Or paste a screenshot from your clipboard')).toBeInTheDocument()
  })
})
