/**
 * The upload pane's client-side contract with the API.
 *
 * Three things here are coupled to the server and cannot be checked by reading
 * either side alone:
 *   1. `size_bytes` is signed into the presigned PUT as ContentLength, so the
 *      declared size and the body actually PUT must be the same number. Since
 *      images are now re-encoded before upload, declaring `file.size` would be
 *      wrong for every image.
 *   2. The accepted-type list has to match the boundary's, and PDF/DOCX are no
 *      longer on it.
 *   3. Paste is a second entry point into the same upload path, so it has to be
 *      driven as a paste — a picker-driven test cannot reach it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocsUpload } from './ProductDocsUpload'

const mockListProductDocs = vi.fn()
const mockCreateUploadUrl = vi.fn()
const mockDeleteProductDoc = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    createProductDocUploadUrl: (...args: unknown[]) => mockCreateUploadUrl(...args),
    deleteProductDoc: (...args: unknown[]) => mockDeleteProductDoc(...args),
  },
}))

// ── Fake imaging primitives (jsdom has no codec) ──

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
    // Half a byte per pixel — comfortably under the 3.75 MB cap at 1568 px, so
    // the first (PNG) rung wins and the declared size is a resized one.
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

// ── Runtime guards over the mock call arguments ──

interface UploadUrlBody {
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
}

function readUploadUrlBody(value: unknown): UploadUrlBody {
  if (typeof value !== 'object' || value === null
    || !('filename' in value) || typeof value.filename !== 'string'
    || !('content_type' in value) || typeof value.content_type !== 'string'
    || !('size_bytes' in value) || typeof value.size_bytes !== 'number') {
    throw new Error('createProductDocUploadUrl was not called with an upload body')
  }
  return {
    filename: value.filename,
    contentType: value.content_type,
    sizeBytes: value.size_bytes,
  }
}

function readPutBlob(value: unknown): Blob {
  if (typeof value !== 'object' || value === null || !('body' in value)
    || !(value.body instanceof Blob)) {
    throw new Error('the S3 PUT did not carry a Blob body')
  }
  return value.body
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

function imageFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(8)], name, { type })
  Object.defineProperty(file, 'size', { value: sizeBytes })
  return file
}

const dropZone = () => screen.getByText(/drop files here/i)

describe('DocsUpload', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    mockListProductDocs.mockResolvedValue({ docs: [] })
    mockCreateUploadUrl.mockResolvedValue({
      doc_id: 'doc-1',
      presigned_url: 'https://s3.example/put',
      headers: { 'Content-Type': 'image/png' },
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200 })))
  })

  it('declares exactly the number of bytes it then PUTs, for a resized image', async () => {
    // ContentLength is signed from size_bytes: declaring the source File's size
    // and PUTting the smaller resized blob makes S3 reject the upload.
    stubImaging(3000, 2000)
    const user = userEvent.setup({ applyAccept: false })
    const source = imageFile('screenshot.png', 'image/png', 4_000_000)
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), source)

    await waitFor(() => expect(mockCreateUploadUrl).toHaveBeenCalledTimes(1))
    const declared = readUploadUrlBody(mockCreateUploadUrl.mock.calls[0][1])
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    const putBody = readPutBlob(vi.mocked(fetch).mock.calls[0][1])

    expect(putBody.size).toBe(declared.sizeBytes)
    // And it is the resized size, not the original's — otherwise the assertion
    // above would hold trivially for an untouched file.
    expect(declared.sizeBytes).toBeLessThan(source.size)
  })

  it('uploads a pasted image without any file-input interaction', async () => {
    stubImaging(800, 600)
    const pasted = new File([new Uint8Array(1024)], '', { type: 'image/png' })
    render(<DocsUpload projectId="proj-1" />)
    await waitFor(() => expect(mockListProductDocs).toHaveBeenCalled())

    fireEvent.paste(dropZone(), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }],
        files: [pasted],
      },
    })

    await waitFor(() => expect(mockCreateUploadUrl).toHaveBeenCalledTimes(1))
    const declared = readUploadUrlBody(mockCreateUploadUrl.mock.calls[0][1])
    // A pasted bitmap has no name of its own, so one is synthesized.
    expect(declared.filename).toMatch(/^pasted-.+\.png$/)
    expect(declared.contentType).toBe('image/png')
    expect(declared.sizeBytes).toBe(1024)
    expect(readPutBlob(vi.mocked(fetch).mock.calls[0][1]).size).toBe(1024)
    // The picker was never touched: this path is genuinely paste-driven.
    expect(getFileInput().files?.length ?? 0).toBe(0)
  })

  it('leaves a paste that carries no image alone', async () => {
    render(<DocsUpload projectId="proj-1" />)
    await waitFor(() => expect(mockListProductDocs).toHaveBeenCalled())

    const event = fireEvent.paste(dropZone(), {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
      },
    })

    // Not cancelled ⇒ pasting text into a field inside this pane still works.
    expect(event).toBe(true)
    expect(mockCreateUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a PDF in the picker and names what is accepted instead', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' }))

    expect(await screen.findByText(/unsupported type: plan\.pdf/i)).toBeInTheDocument()
    // The exact list the API's own refusal names, so the two answers agree.
    expect(screen.getByText(/Accepted: \.gif, \.jpg, \.md, \.png, \.txt, \.webp/))
      .toBeInTheDocument()
    // Refused before the round trip — no record is created server-side.
    expect(mockCreateUploadUrl).not.toHaveBeenCalled()
  })

  it('accepts the four image types in the picker filter and does not offer PDF', async () => {
    render(<DocsUpload projectId="proj-1" />)
    // Settle the initial list before asserting, or the resolving promise updates
    // state after the test ends and React reports an unwrapped update.
    await screen.findByText(/no documents yet/i)

    const accept = getFileInput().getAttribute('accept') ?? ''

    expect(accept).toContain('image/png')
    expect(accept).toContain('image/jpeg')
    expect(accept).toContain('image/gif')
    expect(accept).toContain('image/webp')
    expect(accept).not.toContain('pdf')
    expect(accept).not.toContain('wordprocessingml')
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
    const user = userEvent.setup({ applyAccept: false })
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), imageFile('huge.png', 'image/png', 9_000_000))

    expect(await screen.findByText(/still too large after resizing/i)).toBeInTheDocument()
    expect(mockCreateUploadUrl).not.toHaveBeenCalled()
  })

  it('says an image could not be read when decoding fails', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('bad bytes'))))
    const user = userEvent.setup({ applyAccept: false })
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), imageFile('broken.png', 'image/png', 4_000_000))

    expect(await screen.findByText(/could not read that image/i)).toBeInTheDocument()
    expect(mockCreateUploadUrl).not.toHaveBeenCalled()
  })

  it('renders a failed extraction reason in red rather than the gray metadata colour', async () => {
    // `failed` was unreachable before this rung — nothing ever wrote it — so this
    // text had never actually rendered. Its containing line is text-gray-400,
    // which at 12px is ~2.5:1 on white and under the 4.5:1 WCAG 1.4.3 floor, and
    // a failure reason styled as metadata reads like metadata.
    mockListProductDocs.mockResolvedValue({
      docs: [{
        doc_id: 'doc-failed',
        filename: 'corrupt-diagram.webp',
        content_type: 'image/webp',
        size_bytes: 51_200,
        status: 'failed',
        error: 'Extraction failed: image could not be decoded',
        extracted_chars: 0,
        created_at: '2026-08-13T10:00:00+00:00',
      }],
    })
    render(<DocsUpload projectId="proj-1" />)

    const reason = await screen.findByText('Extraction failed: image could not be decoded')

    // Asserted on the element that CARRIES the text, not an ancestor: the point
    // is that the reason overrides the inherited gray, so finding red anywhere up
    // the tree would pass while the text itself stayed unreadable.
    expect(reason).toHaveClass('text-red-600')
    // The separator stays metadata-coloured — it is punctuation, not the reason.
    expect(reason.textContent).not.toContain('·')
  })

  it('resizes an image over the general file cap instead of refusing it', async () => {
    // The general 10 MiB cap used to be applied before the resize, so a 12 MB
    // screenshot was refused as "too large" even though the very next step would
    // have brought it to a few hundred KB. An image's size is not decided until
    // the ladder has run; the cap that governs it is the image cap, on the
    // PREPARED blob, and the server enforces that one itself.
    stubImaging(3000, 2000)
    const user = userEvent.setup({ applyAccept: false })
    const oversized = imageFile('big-screenshot.png', 'image/png', 12_000_000)
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), oversized)

    await waitFor(() => expect(mockCreateUploadUrl).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/too large \(>10 MB\)/i)).not.toBeInTheDocument()
    const declared = readUploadUrlBody(mockCreateUploadUrl.mock.calls[0][1])
    expect(declared.sizeBytes).toBeLessThan(oversized.size)
  })

  it('still refuses a text file over the general file cap', async () => {
    // The other half of the change: the cap was not removed, it was scoped. A
    // .md has no resize path, so nothing downstream would rescue it — and the
    // server would refuse it after the round trip.
    const user = userEvent.setup({ applyAccept: false })
    const huge = new File(['# notes'], 'handbook.md', { type: 'text/markdown' })
    Object.defineProperty(huge, 'size', { value: 12_000_000 })
    render(<DocsUpload projectId="proj-1" />)

    await user.upload(getFileInput(), huge)

    expect(await screen.findByText(/too large \(>10 MB\): handbook\.md/i)).toBeInTheDocument()
    expect(mockCreateUploadUrl).not.toHaveBeenCalled()
  })

  it('names a pasted JPEG .jpg, the extension the rest of the app uses', async () => {
    // The extension came from the MIME subtype, so image/jpeg produced
    // `pasted-….jpeg` while ALLOWED_MIME here, IMAGE_EXTENSIONS in resizeImage.ts
    // and ALLOWED_CONTENT_TYPES server-side all say `.jpg`. Reachable because an
    // image already inside both limits passes through resize untouched and keeps
    // whatever name it was given.
    stubImaging(400, 300)
    const pasted = new File([new Uint8Array(512)], '', { type: 'image/jpeg' })
    render(<DocsUpload projectId="proj-1" />)
    await waitFor(() => expect(mockListProductDocs).toHaveBeenCalled())

    fireEvent.paste(dropZone(), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/jpeg', getAsFile: () => pasted }],
        files: [pasted],
      },
    })

    await waitFor(() => expect(mockCreateUploadUrl).toHaveBeenCalledTimes(1))
    const declared = readUploadUrlBody(mockCreateUploadUrl.mock.calls[0][1])
    expect(declared.filename).toMatch(/^pasted-.+\.jpg$/)
    expect(declared.filename).not.toMatch(/\.jpeg$/)
  })

  it('opens the file picker exactly once per keyboard activation', async () => {
    // The drop zone is focusable so a keyboard user can reach it and paste. That
    // focus stop then has to be activatable, and there must be exactly ONE
    // activation path: a <label> wrapping the input can synthesize its own click
    // on the control, and a nested input's programmatic click bubbles back into
    // the wrapper's onClick. Either arrangement opens two dialogs. Counted on the
    // input's own click, which is what actually opens the picker.
    //
    // Which event activates is the ARIA APG button pattern: Enter on keydown,
    // Space on keyUP.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(clicks).toHaveBeenCalledTimes(1)

    // Space: nothing on the way down, exactly one picker on the way up. The
    // keydown still cancels its default — that is the event that scrolls the page
    // — and fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(zone, { key: ' ' })).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('opens nothing while Space is held down', async () => {
    // The reason Space belongs on keyup rather than keydown: holding the key
    // repeats keydown, so activating there opened a file dialog per repeat. This
    // is the case that makes the APG rule a real fix and not a formality.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.keyDown(zone, { key: ' ', repeat: true })
    fireEvent.keyDown(zone, { key: ' ', repeat: true })
    fireEvent.keyDown(zone, { key: ' ', repeat: true })

    expect(clicks).not.toHaveBeenCalled()

    // ...and the release still activates once, so the guard did not simply break
    // Space.
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('ignores a Space keyup this element never saw go down', async () => {
    // The other side of activating on keyup: a release with no matching keydown
    // here is not this element's gesture. It happens when focus arrives
    // mid-keypress — the keydown went somewhere else (or to the browser), and
    // only the release lands on the zone, which would open a file dialog the user
    // never asked for.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).not.toHaveBeenCalled()

    // The ordinary sequence still activates exactly once, so the guard did not
    // simply disable Space.
    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('activates once per Space press, with no arming left over', async () => {
    // A flag that is set but never cleared would leave the NEXT stray keyup armed,
    // which is the same bug with an extra step: two presses would then be three
    // pickers.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.keyUp(zone, { key: ' ' })
    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(2)

    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('disarms when focus leaves with Space still held', async () => {
    // The release then happens on whatever took focus, so the keyup that would
    // consume the flag never arrives here. Without the blur reset the zone stays
    // armed indefinitely, waiting to spend it on an unrelated Space release.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.blur(zone)
    fireEvent.keyUp(zone, { key: ' ' })

    expect(clicks).not.toHaveBeenCalled()
  })

  it('opens the file picker exactly once per pointer activation', async () => {
    // Same guarantee for the mouse, and the reason the input is a SIBLING of the
    // drop zone rather than a child: input.click() dispatches a bubbling click,
    // so a nested input would re-enter the zone's own onClick.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const clicks = vi.fn()
    getFileInput().addEventListener('click', clicks)

    fireEvent.click(screen.getByRole('button', { name: /drop files here/i }))

    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('exposes the drop zone as a button with an accessible name', async () => {
    // A focusable div with no role announces as nothing; the name comes from the
    // existing drop-zone string rather than a second one to translate.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)

    const zone = screen.getByRole('button', { name: /drop files here/i })

    expect(zone).toHaveAttribute('tabIndex', '0')
    // Not a <label>: a label's own activation behaviour is the second path this
    // restructure removes.
    expect(zone.tagName).not.toBe('LABEL')
  })

  /**
   * The drag highlight, for the containment guard this zone shares with the
   * persona dropzone.
   *
   * The guard was added to both zones but asserted only for the persona one, so
   * deleting it here left all of this suite passing — a behaviour change with no
   * test that fails when reverted, which is not how anything else in this diff is
   * argued.
   */
  it('keeps the zone marked when the drag merely moves onto its own children', async () => {
    // dragenter/dragleave fire on descendants and BUBBLE, and this zone has an
    // icon and a label inside it. Without the relatedTarget containment guard the
    // leave reported for a child unmarks a zone the pointer is still inside, and
    // the next dragover marks it again — a visible flicker of the highlight.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const zone = screen.getByRole('button', { name: /drop files here/i })
    // Read from data-drag-active rather than the border-blue-500 Tailwind class: a
    // restyle is not a behaviour change and must not fail here. Baseline included,
    // so this cannot pass on a zone that is always marked.
    expect(zone).toHaveAttribute('data-drag-active', 'false')

    fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['Files'] } })
    expect(zone).toHaveAttribute('data-drag-active', 'true')

    const child = zone.querySelector('div')
    if (!(child instanceof HTMLElement)) throw new Error('zone child not found')
    // A real MouseEvent, NOT fireEvent.dragLeave(zone, { relatedTarget: child }):
    // jsdom has no DragEvent, so testing-library builds a plain `Event` for the
    // drag family and relatedTarget is dropped on the floor — the handler would
    // see undefined and the guard could never be exercised.
    fireEvent(zone, new MouseEvent('dragleave', {
      bubbles: true, cancelable: true, relatedTarget: child,
    }))

    expect(zone).toHaveAttribute('data-drag-active', 'true')
  })

  it('unmarks the zone when the drag really does leave it', async () => {
    // Control: the guard must not be satisfiable by never unmarking at all.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const zone = screen.getByRole('button', { name: /drop files here/i })
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['Files'] } })
    expect(zone).toHaveAttribute('data-drag-active', 'true')

    fireEvent(zone, new MouseEvent('dragleave', {
      bubbles: true, cancelable: true, relatedTarget: document.body,
    }))

    expect(zone).toHaveAttribute('data-drag-active', 'false')
  })

  it('leaves a TEXT drag over the zone alone, as the control for the file drag above', async () => {
    // preventDefault on dragenter/dragover is what MAKES this a drop target, so an
    // ungated zone volunteers for a text drag it then discards silently in onDrop,
    // and paints the accept highlight for it. Ungated, the browser keeps its "you
    // cannot drop that here" cursor. Same guard, same reason, as the persona zone.
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)
    const zone = screen.getByRole('button', { name: /drop files here/i })

    const draggedOver = fireEvent.dragOver(zone, {
      dataTransfer: { types: ['text/plain'], files: [] },
    })
    const entered = fireEvent.dragEnter(zone, {
      dataTransfer: { types: ['text/plain'], files: [] },
    })

    // fireEvent returns true when NOTHING called preventDefault.
    expect(draggedOver).toBe(true)
    expect(entered).toBe(true)
    expect(zone).toHaveAttribute('data-drag-active', 'false')
  })

  it('tells the user that PDF and Word are not supported yet', async () => {
    render(<DocsUpload projectId="proj-1" />)
    await screen.findByText(/no documents yet/i)

    // "not yet" rather than silence: these used to be accepted here.
    expect(screen.getByText(/not supported yet/i)).toBeInTheDocument()
    // Same line names what IS accepted, and the two byte caps that differ.
    expect(screen.getByText(/PNG, JPEG, GIF, WebP up to 3\.5 MB/)).toBeInTheDocument()
    expect(screen.getByText(/MD, TXT up to 10 MB/)).toBeInTheDocument()
  })
})
