/**
 * The Sources card's uploads (7.104.00, which carry over every rule of the docs card they replace): the declared size
 * is the size PUT (an image is resized first), paste is a second way in, a type or a size refused before any request
 * names the reason, and a PDF, DOCX or PPTX is hashed before its upload (required: one that cannot be hashed is not
 * uploaded), PUT with the headers the server signed (its checksum among them) and announced after it (`…/uploaded`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import {
  imageFile, pasteFiles, pasteText, stubImaging, stubOversizedImaging, stubUnreadableImage,
} from './imaging-fixtures'
import { DOCS_PATH, PROJECT, extractStub } from './product-sources-fixtures'
import ProductSourcesCard from './ProductSourcesCard'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const UPLOAD_URL = `${DOCS_PATH}/upload-url`
/** A sample PDF's bytes and their SHA-256, as hex (the declared `sha256`) and base64 (S3's checksum header). */
const PDF_TEXT = '%PDF-1.7 sample'
const PDF_SHA256_HEX = 'b5d4c2daa152f53c02621a70601b11dc5b4aecbda1cc3f5962bc5f7f491bad40'
const PDF_SHA256_BASE64 = 'tdTC2qFS9TwCYhpwYBsR3FtK7L2hzD9ZYrxff0kbrUA='

interface Declared { readonly filename: string; readonly content_type: string; readonly size_bytes: number; readonly sha256?: string }

function declared(): Declared {
  const body = sentFetchApiBody(UPLOAD_URL, 'POST')
  if (typeof body !== 'object' || body === null || !('filename' in body) || !('content_type' in body) || !('size_bytes' in body)) {
    throw new Error('no upload-url request was sent')
  }
  const { filename, content_type: contentType, size_bytes: size } = body
  if (typeof filename !== 'string' || typeof contentType !== 'string' || typeof size !== 'number') throw new Error('not an upload body')
  const sha = 'sha256' in body && typeof body.sha256 === 'string' ? { sha256: body.sha256 } : {}
  return { filename, content_type: contentType, size_bytes: size, ...sha }
}

function putBody(): Blob {
  const init = vi.mocked(fetch).mock.calls.at(0)?.[1]
  if (!(init?.body instanceof Blob)) throw new Error('the S3 PUT did not carry a Blob')
  return init.body
}

const fileInput = (): HTMLInputElement => {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return input
}

async function renderCard() {
  renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit extract={extractStub()} onAnswerQuestions={vi.fn()} />)
  await screen.findByText(/add documents, images or links/i)
}

async function upload(file: File) {
  const user = userEvent.setup({ applyAccept: false })
  await renderCard()
  await user.upload(fileInput(), file)
}

/** The card's routes, `upload-url` answering `headers` as the headers to PUT with. */
function routeUploads(headers: Readonly<Record<string, string>> = { 'Content-Type': 'x' }) {
  routeFetchApi({
    [`GET ${DOCS_PATH}`]: () => ({ docs: [] }),
    [`POST ${UPLOAD_URL}`]: () => ({ doc_id: 'doc-9', presigned_url: 'https://s3.example/put', headers }),
    [`POST ${DOCS_PATH}/doc-9/uploaded`]: () => ({ doc: { doc_id: 'doc-9', status: 'extracting' } }),
  })
}

beforeEach(() => {
  resetFetchApi()
  vi.unstubAllGlobals()
  routeUploads()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200 })))
})

describe('ProductSourcesCard uploads', () => {
  it('declares exactly the number of bytes it then PUTs, for a resized image', async () => {
    stubImaging(3000, 2000)
    const source = imageFile('screenshot.png', 'image/png', 4_000_000)
    await upload(source)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    expect(putBody().size).toBe(declared().size_bytes)
    expect(declared().size_bytes).toBeLessThan(source.size)
  })

  it('hashes a PDF, PUTs it whole with the headers the server signed, and announces it, so the twin reads it', async () => {
    const signed = { 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': PDF_SHA256_BASE64 }
    routeUploads(signed)
    const pdf = new File([PDF_TEXT], 'pricing.pdf', { type: 'application/pdf' })
    await upload(pdf)
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${DOCS_PATH}/doc-9/uploaded`, expect.objectContaining({ method: 'POST' })))
    expect(declared()).toStrictEqual({ filename: 'pricing.pdf', content_type: 'application/pdf', size_bytes: pdf.size, sha256: PDF_SHA256_HEX })
    expect(putBody().size).toBe(pdf.size)
    expect(vi.mocked(fetch).mock.calls.at(0)?.[1]?.headers).toStrictEqual(signed)
  })

  it('uploads no PDF it cannot hash: the failure is the upload\'s, and nothing is declared', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'))
    await upload(new File([PDF_TEXT], 'pricing.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText('pricing.pdf: The file could not be hashed for its upload')).toBeInTheDocument()
    expect(fetchApi.mock.calls.some(([path]) => path === UPLOAD_URL)).toBe(false)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    digest.mockRestore()
  })

  it('takes a Markdown file the browser gave no type, by its extension, and announces nothing', async () => {
    await upload(new File(['# notes'], 'notes.md', { type: '' }))
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    expect(declared()).toMatchObject({ content_type: 'text/markdown' })
    expect(declared().sha256).toBeUndefined()
    expect(fetchApi.mock.calls.some(([path]) => path.endsWith('/uploaded'))).toBe(false)
  })

  it('uploads a pasted image without any file-input interaction, named for the paste', async () => {
    stubImaging(800, 600)
    await renderCard()
    pasteFiles(screen.getByRole('button', { name: /drop files here/i }), [new File([new Uint8Array(512)], '', { type: 'image/jpeg' })])
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    expect(declared().filename).toMatch(/^pasted-.+\.jpg$/)
    expect(fileInput().files?.length ?? 0).toBe(0)
  })

  it('leaves a paste that carries no image alone', async () => {
    await renderCard()
    expect(pasteText(screen.getByRole('button', { name: /drop files here/i }))).toBe(true)
    expect(fetchApi.mock.calls.some(([path]) => path === UPLOAD_URL)).toBe(false)
  })

  it('refuses an unsupported type before any request and names what is accepted', async () => {
    await upload(new File(['x'], 'sheet.xlsx', { type: 'application/vnd.ms-excel' }))
    expect(await screen.findByText(/unsupported type: sheet\.xlsx/i)).toHaveTextContent(
      'Accepted: .docx, .gif, .jpg, .md, .pdf, .png, .pptx, .txt, .webp')
    expect(fetchApi.mock.calls.some(([path]) => path === UPLOAD_URL)).toBe(false)
  })

  it('offers PDF, DOCX, PPTX, MD, TXT and the four image types in the picker', async () => {
    await renderCard()
    const accept = fileInput().getAttribute('accept') ?? ''
    for (const type of ['application/pdf', 'wordprocessingml', 'presentationml', 'image/png', 'image/webp', '.md', '.txt']) {
      expect(accept).toContain(type)
    }
  })

  it('refuses a text file over 10 MB and a PDF over 25 MB, each with its cap', async () => {
    const big = new File(['# notes'], 'handbook.md', { type: 'text/markdown' })
    Object.defineProperty(big, 'size', { value: 12_000_000 })
    const huge = new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' })
    Object.defineProperty(huge, 'size', { value: 30_000_000 })
    const user = userEvent.setup({ applyAccept: false })
    await renderCard()
    await user.upload(fileInput(), [big, huge])
    expect(await screen.findByText('Too large (over 10 MB): handbook.md')).toBeInTheDocument()
    expect(screen.getByText('Too large (over 25 MB): deck.pdf')).toBeInTheDocument()
    expect(fetchApi.mock.calls.some(([path]) => path === UPLOAD_URL)).toBe(false)
  })

  it('resizes an image over the general cap instead of refusing it', async () => {
    stubImaging(3000, 2000)
    const oversized = imageFile('big-screenshot.png', 'image/png', 12_000_000)
    await upload(oversized)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    expect(declared().size_bytes).toBeLessThan(oversized.size)
  })

  it('says an image is still too large after resizing, or could not be read', async () => {
    stubOversizedImaging()
    await upload(imageFile('huge.png', 'image/png', 9_000_000))
    expect(await screen.findByText(/still too large after resizing/i)).toBeInTheDocument()
    stubUnreadableImage()
    await userEvent.setup({ applyAccept: false }).upload(fileInput(), imageFile('broken.png', 'image/png', 4_000_000))
    expect(await screen.findByText(/could not read that image/i)).toBeInTheDocument()
  })

  it('says a failed S3 PUT with the file it was for', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403 })))
    await upload(new File(['# notes'], 'notes.md', { type: 'text/markdown' }))
    expect(await screen.findByText('notes.md: S3 PUT 403')).toBeInTheDocument()
  })
})
